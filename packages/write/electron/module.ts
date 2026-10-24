import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type WebContents } from 'electron';
import path from 'node:path';
import type { DraftRecord, Prefs, Session, ThemeSource } from '../src/shared/api';
import { DraftStore } from './drafts';
import { readWithStamp, statStamp, writeBytesAtomic, writeFileAtomic } from './files';
import { sanitizeBookDetails } from '../src/shared/export/model';
import { makeExportDeps, pdfResources } from './export/deps';
import { planExport, runExport } from './export/run';
import { loadDetails, renameSidecar, saveDetails, setMarked, existingSidecar } from './export/sidecar';
import { createFile, createFolder, renameNode } from './fsops';
import { sidecarPathFor } from '../src/shared/export/sidecar';
import { promises as fsp } from 'node:fs';
import { installMenu } from './menu';
import { registerWindowChrome } from './windowChrome';
import { confirmDelete, confirmOverwrite, confirmRecover, confirmUnsaved } from './prompts';
import { scanFolder } from './scan';
import { bundledFont } from '../src/shared/export/fonts';
import { listInstalledFonts } from './fonts';
import { sanitizeAppDefaults, type AppDefaults } from '../src/shared/appDefaults';
import { defaultRootFolder, effectiveDefaults, sanitizeProjectsSettings, type ProjectsConfig } from '../src/shared/projects';
import * as projects from './projects';
import { existingFolder, SettingsStore } from './settings';

/** What the module needs from whoever hosts it: the window it lives in and its own renderer. */
export interface WriteHost {
  /** The window that owns Write's view (the shell window, or Write's own window when standalone). */
  getWindow(): BrowserWindow | null;
  /** Write's renderer. In the shell this is a view inside the window, not the window's own page. */
  getContents(): WebContents | null;
  /** True when Write is the whole application (it then also owns the application menu). */
  standalone: boolean;
}

export const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
let drafts: DraftStore;
let host: WriteHost;
const pendingFiles: string[] = [];

export function queueFile(file: string): void {
  if (!pendingFiles.includes(file)) pendingFiles.push(file);
  const win = host?.getWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    host.getContents()?.send('app:launchFiles');
  }
}

// Paths the renderer may read/write: only inside the folder the user picked.
let openRoot: string | null = null;

function inRoot(p: string, opts: { allowRoot?: boolean } = {}): string {
  if (!openRoot) throw new Error('No folder is open');
  const full = path.resolve(p);
  const rel = path.relative(openRoot, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the opened folder');
  if (rel === '' && !opts.allowRoot) throw new Error('Refusing to operate on the root folder itself');
  return full;
}

const projectsRoot = () => settings.projects().rootFolder ?? defaultRootFolder(app.getPath('home'));
const dirExists = (p: string) => fsp.stat(p).then((st) => st.isDirectory(), () => false);

/** A path that is a direct child of the Root Folder (a project), or the folder currently open. */
function projectPath(p: string): string {
  const full = path.resolve(p);
  const root = path.resolve(projectsRoot());
  const rel = path.relative(root, full);
  const direct = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
  if (!direct && !(openRoot && full === openRoot)) throw new Error('That is not a project in the Root Folder');
  return full;
}

/** The nearest folder at or above `file` that is a project (looks up to 10 levels), or null. */
async function projectDirOf(file: string): Promise<string | null> {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 10; i++) {
    if (await projects.isProject(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** App defaults, with the enclosing project's own settings laid over them (the cascade: app < template < project). */
async function defaultsFor(file: string): Promise<AppDefaults> {
  const app = settings.appDefaults();
  const dir = await projectDirOf(file);
  const meta = dir ? await projects.readMeta(dir) : null;
  return effectiveDefaults(app, meta);
}

const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);

/** Files with unsaved edits in the renderer. Reported by the renderer. */
let dirtyFiles: string[] = [];

function setTheme(theme: ThemeSource): void {
  nativeTheme.themeSource = theme;
  settings.update((s) => {
    s.theme = theme;
  });
}

function registerIpc(): void {
  const winOf = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('dialog:pickFolder', async (e) => {
    const win = winOf(e);
    const opts = { properties: ['openDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : path.resolve(res.filePaths[0]);
  });
  ipcMain.handle('settings:getLastFolder', () => existingFolder(settings.get().lastFolder));
  ipcMain.handle('fs:scanFolder', async (_e, root: string) => {
    const tree = await scanFolder(path.resolve(root));
    openRoot = path.resolve(root);
    settings.update((s) => {
      s.lastFolder = openRoot!;
    });
    return tree;
  });
  ipcMain.handle('fs:readFile', (_e, p: string) => readWithStamp(inRoot(p)));
  ipcMain.handle('fs:statFile', (_e, p: string) => statStamp(inRoot(p)));
  ipcMain.handle('fs:writeFile', (_e, p: string, content: string) => {
    const full = inRoot(p);
    if (!isMarkdown(full)) throw new Error('Refusing to write a non-Markdown file');
    return writeFileAtomic(full, content);
  });
  ipcMain.handle('fs:createFile', (_e, dir: string, name: string, content?: string) =>
    createFile(inRoot(dir, { allowRoot: true }), name, content)
  );
  ipcMain.handle('fs:createFolder', (_e, dir: string, name: string) =>
    createFolder(inRoot(dir, { allowRoot: true }), name)
  );
  ipcMain.handle('fs:renameNode', async (_e, p: string, newName: string) => {
    const from = inRoot(p);
    const to = await renameNode(from, newName);
    if (isMarkdown(from)) await renameSidecar(from, to).catch(() => undefined); // export settings follow the file
    return to;
  });
  ipcMain.handle('fs:trashNode', async (_e, p: string) => {
    const full = inRoot(p);
    await shell.trashItem(full);
    if (isMarkdown(full)) {
      const sidecar = await existingSidecar(full);
      if (sidecar) await shell.trashItem(sidecar).catch(() => undefined);
    }
  });

  // --- export: book details ---
  const mdPath = (p: string) => {
    const full = inRoot(p);
    if (!isMarkdown(full)) throw new Error('Only Markdown files can be exported');
    return full;
  };
  ipcMain.handle('export:getDetails', async (_e, p: string) => loadDetails(mdPath(p), await defaultsFor(mdPath(p))));
  ipcMain.handle('export:saveDetails', (_e, p: string, details: unknown) => saveDetails(mdPath(p), details as never));
  ipcMain.handle('export:setMarked', async (_e, p: string, marked: boolean) => setMarked(mdPath(p), marked === true, await defaultsFor(mdPath(p))));
  ipcMain.handle('export:relink', async (_e, sidecar: string, md: string) => {
    const from = inRoot(sidecar);
    const target = sidecarPathFor(mdPath(md));
    if (!from.toLowerCase().endsWith('.export.json')) throw new Error('Not an export-settings file');
    try {
      await fsp.lstat(target);
      throw new Error('That file already has export settings.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await fsp.rename(from, target);
  });
  // --- export ---
  const exportDeps = () => makeExportDeps(undefined, (file) => defaultsFor(file));
  let exportAbort: AbortController | null = null;
  const exportedFiles = new Set<string>(); // only files produced by an export may be revealed/opened
  ipcMain.handle('export:plan', (_e, p: string, unsaved?: unknown) =>
    planExport(mdPath(p), exportDeps(), unsaved ? sanitizeBookDetails(unsaved) : undefined)
  );
  ipcMain.handle('export:run', async (e, p: string) => {
    const file = mdPath(p);
    if (exportAbort) return { ok: false, errors: ['Another export is already running.'], warnings: [], outputs: [] };
    exportAbort = new AbortController();
    try {
      const result = await runExport(file, exportDeps(), (prog) => e.sender.send('export:progress', prog), exportAbort.signal);
      result.outputs.forEach((o) => exportedFiles.add(path.resolve(o.path)));
      return result;
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], outputs: [] };
    } finally {
      exportAbort = null;
    }
  });
  ipcMain.on('export:cancel', () => exportAbort?.abort());
  ipcMain.on('export:reveal', (_e, p: string) => {
    if (exportedFiles.has(path.resolve(p))) shell.showItemInFolder(path.resolve(p));
  });
  ipcMain.handle('export:open', (_e, p: string) => (exportedFiles.has(path.resolve(p)) ? shell.openPath(path.resolve(p)) : Promise.resolve('Not an exported file')));
  ipcMain.handle('fonts:installed', () => listInstalledFonts());
  ipcMain.handle('fonts:preview', async (_e, family: string) => {
    const b = bundledFont(String(family));
    if (!b) return null;
    const data = await fsp.readFile(path.join(pdfResources().fontsDir, b.slug, 'Regular.ttf')).catch(() => null);
    return data ? `data:font/ttf;base64,${data.toString('base64')}` : null;
  });
  ipcMain.handle('export:pickCover', async (e) => {
    const win = winOf(e);
    const opts = { properties: ['openFile' as const], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  ipcMain.on('shell:reveal', (_e, p: string) => {
    try {
      shell.showItemInFolder(inRoot(p, { allowRoot: true }));
    } catch {
      // ignore bad paths
    }
  });

  // --- projects ---
  const config = async (): Promise<ProjectsConfig> => ({ ...settings.projects(), root: projectsRoot(), defaultRoot: defaultRootFolder(app.getPath('home')), rootExists: await dirExists(projectsRoot()) });
  ipcMain.handle('projects:config', config);
  ipcMain.handle('projects:setConfig', async (_e, patch: Record<string, unknown>) => {
    const next = sanitizeProjectsSettings({ ...settings.projects(), ...(patch && typeof patch === 'object' ? patch : {}) });
    if (next.rootFolder) {
      if (!path.isAbsolute(next.rootFolder)) throw new Error('The Root Folder must be a full path.');
      await fsp.mkdir(next.rootFolder, { recursive: true });
    }
    settings.update((s) => {
      s.projects = next;
    });
    return config();
  });
  ipcMain.handle('projects:list', () => projects.listProjects(projectsRoot()));
  ipcMain.handle('projects:create', async (_e, name: string, templateId: string) => {
    const template = settings.projects().templates.find((t) => t.id === templateId);
    if (!template) throw new Error('That template no longer exists.');
    return projects.createProject(projectsRoot(), String(name), template);
  });
  ipcMain.handle('projects:meta', (_e, p: string) => (path.isAbsolute(p) ? projects.readMeta(path.resolve(p)) : null)); // read-only, any folder
  ipcMain.handle('projects:update', (_e, p: string, patch: Record<string, unknown>) => projects.updateMeta(projectPath(p), patch as never));
  ipcMain.handle('projects:rename', async (_e, p: string, name: string) => {
    const from = projectPath(p);
    const to = await projects.renameProject(from, String(name));
    if (openRoot && (openRoot === from || openRoot.startsWith(from + path.sep))) openRoot = to + openRoot.slice(from.length);
    return to;
  });
  ipcMain.handle('projects:duplicate', (_e, p: string, name: string) => projects.duplicateProject(projectPath(p), String(name)));
  ipcMain.handle('projects:delete', (_e, p: string) => projects.deleteProject(projectPath(p), (x) => shell.trashItem(x)));
  ipcMain.handle('projects:convert', (_e, p: string) => projects.convertToProject(projectPath(p)));
  ipcMain.handle('projects:addMissing', (_e, p: string, templateId: string) => {
    const t = settings.projects().templates.find((x) => x.id === templateId);
    if (!t) throw new Error('That template no longer exists.');
    return projects.addMissingTemplateParts(projectPath(p), t);
  });
  ipcMain.handle('projects:progress', (_e, p: string) => projects.recordProgress(projectPath(p)));
  ipcMain.handle('projects:move', async (_e, newRoot: string) => {
    if (typeof newRoot !== 'string' || !path.isAbsolute(newRoot)) throw new Error('Choose a full folder path.');
    return projects.moveProjects(projectsRoot(), path.resolve(newRoot));
  });
  ipcMain.on('projects:setLast', (_e, p: string | null) => {
    settings.update((s) => {
      s.projects = { ...settings.projects(), lastProject: typeof p === 'string' ? p : null };
    });
  });

  ipcMain.handle('app:getDefaults', () => settings.appDefaults());
  ipcMain.handle('app:setDefaults', (_e, raw: unknown) => {
    const next = sanitizeAppDefaults(raw);
    settings.update((s) => {
      s.appDefaults = next;
    });
    return next;
  });
  ipcMain.handle('prefs:get', () => settings.get().prefs ?? {});
  ipcMain.on('prefs:set', (_e, patch: Partial<Prefs>) => {
    if (typeof patch?.sidebarWidth === 'number' && Number.isFinite(patch.sidebarWidth)) {
      settings.update((s) => {
        s.prefs = { ...s.prefs, sidebarWidth: patch.sidebarWidth };
      });
    }
  });
  ipcMain.handle('session:get', (_e, folder: string) => settings.get().sessions?.[folder] ?? null);
  ipcMain.on('session:save', (_e, folder: string, session: Session) => {
    if (typeof folder === 'string' && session && Array.isArray(session.tabs)) settings.setSession(folder, session);
  });

  // Markdown files named on the command line (double-click / "Open with") are queued here until the
  // renderer collects them, so none are lost if they arrive before the UI is ready.
  ipcMain.handle('app:takeLaunchFiles', async () => {
    const files = pendingFiles.splice(0);
    const ok: string[] = [];
    for (const f of files) if (await fsp.stat(f).then((st) => st.isFile(), () => false)) ok.push(f);
    return ok;
  });

  ipcMain.handle('drafts:save', (_e, d: DraftRecord) => drafts.save(d));
  ipcMain.handle('drafts:clear', (_e, file: string) => drafts.clear(file));
  ipcMain.handle('drafts:list', () => drafts.list());

  ipcMain.handle('dialog:confirmUnsaved', (e, name: string) => confirmUnsaved(winOf(e), name));
  ipcMain.handle('dialog:confirmOverwrite', (e, name: string) => confirmOverwrite(winOf(e), name));
  ipcMain.handle('dialog:confirmDelete', (e, name: string, kind: 'file' | 'folder' | 'chapter', unsaved: boolean) =>
    confirmDelete(winOf(e), name, kind, unsaved)
  );
  ipcMain.handle('dialog:confirmRecover', (e, name: string) => confirmRecover(winOf(e), name));
  ipcMain.on('app:setDirtyFiles', (_e, names: string[]) => {
    dirtyFiles = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
  });
}


// ---- hosting ---------------------------------------------------------------------------

export interface WriteModule {
  queueFile(file: string): void;
  /** Does the editor hold unsaved edits? */
  hasUnsaved(): boolean;
  /** Asks the editor to resolve unsaved edits (save / discard / cancel). Resolves true if the window may close. */
  requestClose(): Promise<boolean>;
  flush(): Promise<void>;
}

/** Closing with unsaved tabs asks the renderer to resolve them first. */
function requestClose(): Promise<boolean> {
  const contents = host.getContents();
  if (dirtyFiles.length === 0 || !contents || contents.isDestroyed() || contents.isCrashed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    ipcMain.once('app:closeDecision', (_e, ok: boolean) => resolve(ok === true));
    contents.send('app:closeRequested');
  });
}

/** Loads Write's settings and registers its IPC, menu and window-chrome handlers for the given host. Call once. */
export async function createWriteModule(h: WriteHost): Promise<WriteModule> {
  host = h;
  await settings.load();
  drafts = new DraftStore(path.join(app.getPath('userData'), 'drafts'));
  nativeTheme.themeSource = settings.get().theme ?? 'system';

  registerIpc();
  registerWindowChrome(() => host.getWindow(), () => host.getContents());
  installMenu(
    { get: () => settings.get().theme ?? 'system', set: setTheme },
    { getContents: () => host.getContents(), getWindow: () => host.getWindow(), asApplicationMenu: host.standalone }
  );
  return { queueFile, hasUnsaved: () => dirtyFiles.length > 0, requestClose, flush: () => settings.flush() };
}
