/**
 * `CoreApi` over any `FsPort`: everything the editor, the project model and sync need, with the same guards and
 * behaviour as the Windows main process (electron/main.ts). The Android app uses this directly; the UI shell supplies
 * the dialogs. Paths are plain strings in the platform's style ("/" on the phone).
 */
import { sanitizeThemeCustom } from '../theme';
import type { CoreApi, UnsavedChoice } from '../api';
import { defaultAppDefaults, sanitizeAppDefaults } from '../appDefaults';
import type { FsPort } from '../fsPort';
import { makeReviews } from './reviews';
import { basename, isInside, joinPath, isMarkdownName } from '../paths';
import { sanitizeProjectsSettings, withOpened } from '../projects';
import { DraftStore } from './drafts';
import { makeFiles } from './files';
import { makeFsops } from './fsops';
import { makeProjects } from './projects';
import { scanFolder } from './scan';
import { existingFolder, SettingsStore } from './settings';
import { makeSidecars } from './sidecars';

export interface Dialogs {
  confirmUnsaved(fileName: string): Promise<UnsavedChoice>;
  confirmOverwrite(fileName: string): Promise<boolean>;
  confirmDelete(name: string, kind: 'file' | 'folder' | 'chapter', hasUnsaved: boolean): Promise<boolean>;
  confirmRecover(fileName: string): Promise<boolean>;
  confirmMarkEdited(chapterTitle: string): Promise<boolean>;
}

export interface CoreApiOptions {
  fs: FsPort;
  /** The Root Folder: every project is a folder directly inside it. Fixed on the phone. */
  rootFolder: string;
  /** Where the app's own state lives (outside the Root, so it never syncs). */
  settingsFile: string;
  draftsDir: string;
  /** Deleted items are moved here instead of being destroyed. Hidden from the Root, so deletes sync as deletes. */
  trashDir: string;
  dialogs: Dialogs;
  now?: () => Date;
}

export interface CoreBackend {
  api: CoreApi;
  /** Loads saved settings; call once before using the API. */
  load(): Promise<void>;
  /** Resolves once settings and drafts are on disk. */
  flush(): Promise<void>;
  /** Moves a file or folder into the app's trash (what delete does), for sync to use when Drive removes something. */
  trash(path: string): Promise<void>;
}

export function createCoreApi(o: CoreApiOptions): CoreBackend {
  const { fs } = o;
  const files = makeFiles(fs);
  const ops = makeFsops(fs);
  const projects = makeProjects(fs);
  const sidecars = makeSidecars(fs);
  const settings = new SettingsStore(o.settingsFile, fs);
  const drafts = new DraftStore(o.draftsDir, fs);
  const reviews = makeReviews(fs);
  const root = o.rootFolder.replace(/[\\/]+$/, '');
  let openRoot: string | null = null;

  /** Paths the UI may touch: inside the opened folder, which itself must be inside the Root. */
  function inRoot(p: string, opts: { allowRoot?: boolean } = {}): string {
    if (!openRoot) throw new Error('No folder is open');
    if (p.split(/[\\/]/).includes('..') || !isInside(p, openRoot)) throw new Error('Path is outside the opened folder');
    if (p === openRoot && !opts.allowRoot) throw new Error('Refusing to operate on the root folder itself');
    return p;
  }

  /** A direct child of the Root (a project), or the folder currently open. */
  function projectPath(p: string): string {
    const direct = p !== root && isInside(p, root) && !/[\\/]/.test(p.slice(root.length + 1)) && !p.includes('..');
    if (!direct && !(openRoot && p === openRoot)) throw new Error('That is not a project in the Root Folder');
    return p;
  }

  const config = async () => ({ ...settings.projects(), root, defaultRoot: root, rootExists: (await fs.stat(root))?.isDirectory === true });

  async function trash(p: string): Promise<void> {
    await fs.mkdir(o.trashDir, { recursive: true });
    let to = joinPath(o.trashDir, `${(o.now?.() ?? new Date()).getTime()}-${basename(p)}`);
    for (let n = 2; await fs.stat(to); n++) to = joinPath(o.trashDir, `${(o.now?.() ?? new Date()).getTime()}-${n}-${basename(p)}`);
    await fs.rename(p, to);
  }

  const api: CoreApi = {
    getLastFolder: () => existingFolder(fs, settings.get().lastFolder),
    async scanFolder(dir) {
      if (!isInside(dir, root)) throw new Error('That folder is outside the Root Folder');
      const tree = await scanFolder(fs, dir);
      openRoot = dir;
      settings.update((s) => {
        s.lastFolder = dir;
      });
      return tree;
    },
    listReviews: async (project) => reviews.list(inRoot(project, { allowRoot: true })),
    saveReview: async (project, id, text) => reviews.save(inRoot(project, { allowRoot: true }), id, text),
    deleteReview: async (project, id) => reviews.remove(inRoot(project, { allowRoot: true }), id),
    readFile: async (p) => files.readWithStamp(inRoot(p)),
    statFile: async (p) => files.statStamp(inRoot(p)),
    async writeFile(p, content) {
      const full = inRoot(p);
      if (!isMarkdownName(full)) throw new Error('Refusing to write a non-Markdown file');
      return files.writeFileAtomic(full, content);
    },
    createFile: async (dir, name, content) => ops.createFile(inRoot(dir, { allowRoot: true }), name, content),
    createFolder: async (dir, name) => ops.createFolder(inRoot(dir, { allowRoot: true }), name),
    async renameNode(p, newName) {
      const from = inRoot(p);
      const to = await ops.renameNode(from, newName);
      if (isMarkdownName(from)) await sidecars.renameSidecar(from, to).catch(() => undefined); // export settings follow the file
      return to;
    },
    async trashNode(p) {
      const full = inRoot(p);
      const sidecar = isMarkdownName(full) ? await sidecars.existingSidecar(full) : null;
      await trash(full);
      if (sidecar) await trash(sidecar).catch(() => undefined);
    },

    async getAppDefaults() {
      return settings.appDefaults();
    },
    async setAppDefaults(raw) {
      const next = sanitizeAppDefaults(raw ?? defaultAppDefaults());
      settings.update((s) => {
        s.appDefaults = next;
      });
      return next;
    },

    getProjectsConfig: config,
    async setProjectsConfig(patch) {
      // The phone's Root Folder is fixed: only templates and options change.
      const { rootFolder: _ignored, ...rest } = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
      const next = sanitizeProjectsSettings({ ...settings.projects(), ...rest, rootFolder: null });
      settings.update((s) => {
        s.projects = next;
      });
      return config();
    },
    listProjects: () => projects.listProjects(root, o.now),
    async createProject(name, templateId) {
      const template = settings.projects().templates.find((t) => t.id === templateId);
      if (!template) throw new Error('That template no longer exists.');
      return projects.createProject(root, String(name), template, { now: o.now });
    },
    getProjectMeta: async (p) => (isInside(p, root) ? projects.readMeta(p, o.now) : Promise.resolve(null)),
    updateProject: async (p, patch) => projects.updateMeta(projectPath(p), patch as never, o.now),
    async renameProject(p, name) {
      const from = projectPath(p);
      const to = await projects.renameProject(from, String(name));
      if (openRoot && isInside(openRoot, from)) openRoot = to + openRoot.slice(from.length);
      return to;
    },
    duplicateProject: async (p, name) => projects.duplicateProject(projectPath(p), String(name), { now: o.now }),
    deleteProject: async (p) => projects.deleteProject(projectPath(p), trash),
    convertFolder: async (p) => projects.convertToProject(projectPath(p), { now: o.now }),
    async addMissingTemplateParts(p, templateId) {
      const t = settings.projects().templates.find((x) => x.id === templateId);
      if (!t) throw new Error('That template no longer exists.');
      return projects.addMissingTemplateParts(projectPath(p), t);
    },
    recordProgress: async (p) => projects.recordProgress(projectPath(p), o.now),
    async moveProjects() {
      throw new Error('The Root Folder cannot be changed on this device.');
    },
    setLastProject(p) {
      settings.update((s) => {
        const cur = settings.projects();
        s.projects = { ...cur, lastProject: typeof p === 'string' ? p : null, recentProjects: withOpened(cur.recentProjects, typeof p === 'string' ? p : null) };
      });
    },

    async getPrefs() {
      return settings.get().prefs ?? {};
    },
    setPrefs(patch) {
      if (typeof patch?.sidebarWidth === 'number' && Number.isFinite(patch.sidebarWidth)) {
        settings.update((s) => {
          s.prefs = { ...s.prefs, sidebarWidth: patch.sidebarWidth };
        });
      }
      if (patch && 'themeCustom' in patch) {
        const themeCustom = sanitizeThemeCustom(patch.themeCustom);
        settings.update((s) => {
          const { themeCustom: _old, ...rest } = s.prefs ?? {};
          s.prefs = themeCustom ? { ...rest, themeCustom } : rest;
        });
      }
    },
    async getSession(folder) {
      return settings.get().sessions?.[folder] ?? null;
    },
    saveSession(folder, session) {
      if (typeof folder === 'string' && session && Array.isArray(session.tabs)) settings.setSession(folder, session);
    },

    saveDraft: (d) => drafts.save(d),
    clearDraft: (file) => drafts.clear(file),
    listDrafts: () => drafts.list(),

    confirmUnsaved: (n) => o.dialogs.confirmUnsaved(n),
    confirmOverwrite: (n) => o.dialogs.confirmOverwrite(n),
    confirmDelete: (n, k, u) => o.dialogs.confirmDelete(n, k, u),
    confirmRecover: (n) => o.dialogs.confirmRecover(n),
    confirmMarkEdited: (n) => o.dialogs.confirmMarkEdited(n),
  };

  return { api, load: () => settings.load(), flush: () => settings.flush(), trash };
}
