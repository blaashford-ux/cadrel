import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { DraftRecord, Prefs, Session, ThemeSource } from '../src/shared/api';
import { DraftStore } from './drafts';
import { readWithStamp, statStamp, writeBytesAtomic, writeFileAtomic } from './files';
import { sanitizeBookDetails } from '../src/shared/export/model';
import { makeExportDeps, pdfResources, setAssetsDir } from './export/deps';
import { planExport, runExport } from './export/run';
import { loadDetails, renameSidecar, saveDetails, setMarked, existingSidecar } from './export/sidecar';
import { createFile, createFolder, renameNode } from './fsops';
import { importDocxFiles } from './importDocx';
import { sidecarPathFor } from '../src/shared/export/sidecar';
import { appendFileSync, promises as fsp } from 'node:fs';
import { installMenu } from './menu';
import { openHelp } from './help';
import { registerWindowChrome, setChromeTheme } from './windowChrome';
import { confirmDelete, confirmMarkEdited, confirmOverwrite, confirmRecover, confirmUnsaved } from './prompts';
import { scanFolder } from './scan';
import type { AiServerInfo } from '../src/shared/agent/config';
import { buildKit, KIT_FOLDER, MDEDIT_BRAND, type KitBrand } from '../src/shared/agent/kit';
import { AiRemote } from './aiRemote';
import { SKILLS } from '../mcp/skills.generated';
import { makeReviews } from '../src/shared/backend/reviews';
import { nodeFs } from './nodeFs';
import { bundledFont } from '../src/shared/export/fonts';
import { listInstalledFonts } from './fonts';
import { sanitizeAppDefaults, type AppDefaults } from '../src/shared/appDefaults';
import { defaultRootFolder, effectiveDefaults, sanitizeProjectsSettings, withOpened, type ProjectsConfig } from '../src/shared/projects';
import * as projects from './projects';
import { existingFolder, SettingsStore } from './settings';
import { sanitizeThemeCustom, type ThemeCustom } from '../src/shared/theme';
import { pickInBrowser } from './pickerBrowser';
import { checkBeforeLaunch, downloadInstaller } from './update';
import { fetchLatestRelease, type UpdateInfo } from '../src/shared/update';
import type { SyncService } from '../src/shared/sync/service';
import { createDesktopSync } from './syncHost';
import { createReviewHost } from '../src/shared/review/host';
import type { ReviewSharingApi } from '../src/shared/api';

/** What the module needs from whoever hosts it: the window it lives in, its own renderer, and where its files and AI server are. */
export interface WriteHost {
  /** The window that owns Write's view (the shell window, or Write's own window when standalone). */
  getWindow(): BrowserWindow | null;
  /** Write's renderer. In the shell this is a view inside the window, not the window's own page. */
  getContents(): WebContents | null;
  /** True when Write is the whole application (it then also owns the application menu). */
  standalone: boolean;
  /** Where settings.json, drafts, shares and sync state live. Defaults to the app's userData folder. */
  dataDir?: string;
  /** Folder holding the bundled `fonts/` and `vendor/`. Defaults to the app's own `assets` folder. */
  assetsDir?: string;
  /**
   * The AI server. `file` is what AI apps launch (outside the asar when packaged). `kitServer` makes the file that goes
   * into the Claude Desktop extension (default: `file` itself, which then has to be plain JavaScript that runs under
   * Claude's own Node); a host whose server needs its own runtime passes a launcher. `brand` names the kit.
   * Default: Write's own server and the Cadrel Write brand.
   */
  mcp?: { file: string; kitServer?: () => Promise<Uint8Array>; brand?: KitBrand };
  /**
   * When set, the host owns appearance (the Cadrel shell does): the light/dark choice and the custom colours are read from
   * and written to it instead of Write's own settings, and Settings → Appearance points there.
   */
  theme?: { get(): { source: ThemeSource; custom?: ThemeCustom }; set(change: { source?: ThemeSource; custom?: ThemeCustom | null }): void };
  /** When set, Cadrel Write's own updater is off and says this (a host app updates as a whole). */
  updatesDisabledReason?: string;
}

export let settings: SettingsStore;
/** The optional online door for AI apps (off until the user turns it on). */
let aiRemote: AiRemote;
let drafts: DraftStore;
let host: WriteHost;
let dataDir = '';
const pendingFiles: string[] = [];
/** A downloaded installer to start once the app has exited (see `update:install`). */
let installerToRun: string | null = null;

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

// ---- Google Drive sync ------------------------------------------------------------------------------
// The Desktop OAuth client secret is injected when the app is built (scripts/build-electron.mjs); `MDEDIT_GOOGLE_CLIENT_SECRET`
// works for `npm run dev`. For installed apps Google does not treat it as confidential.
const GOOGLE_SECRET = process.env.MDEDIT_GOOGLE_CLIENT_SECRET_BUILD || process.env.MDEDIT_GOOGLE_CLIENT_SECRET || '';

let sync: SyncService | null = null;
let syncRoot: string | null = null;
let syncReady: Promise<SyncService> | null = null;
let stopSyncStatus: (() => void) | null = null;

/** The sync service for the current Root Folder (a new one if the Root changed), loaded and polling. */
function ensureSync(): Promise<SyncService> {
  const root = projectsRoot();
  if (!syncReady || syncRoot !== root) {
    sync?.stop();
    stopSyncStatus?.();
    syncRoot = root;
    const svc = createDesktopSync({
      userData: dataDir,
      root,
      clientSecret: GOOGLE_SECRET,
      device: os.hostname(),
      openUrl: (url) => shell.openExternal(url),
      encrypt: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : null),
      decrypt: (data) => safeStorage.decryptString(data),
      trash: (file) => shell.trashItem(file)
    });
    sync = svc;
    stopSyncStatus = svc.onSyncStatus((st) => {
      host.getContents()?.send('sync:status', st);
    });
    syncReady = svc.load().then(() => {
      svc.startPolling(120_000);
      return svc;
    });
  }
  return syncReady;
}

/**
 * How an AI app launches the MCP server. The installed app runs it with itself in Node mode, so users need no Node.js;
 * the file sits outside app.asar (see `asarUnpack`) because an outside program can't read inside the archive.
 */
async function aiServer(): Promise<AiServerInfo | null> {
  // Cadrel Write's own server is a plain-JavaScript file that an outside program must be able to read, so it sits outside the asar. A host's server
  // is started by the app's own runtime, which reads inside the asar, and needs its dependencies from there, so its path is used as given.
  const file = host.mcp?.file ?? path.join(app.getAppPath(), 'dist-electron', 'mcp', 'mdedit-mcp.js').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  if (!(await fsp.stat(file).catch(() => null))) return null;
  const root = path.resolve(projectsRoot());
  const args = [file, '--root', root];
  return app.isPackaged ? { root, command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' } } : { root, command: 'node', args };
}

/** Saves the AI Kit into the user's Downloads folder (replacing an earlier copy of the same files) and shows it. */
async function exportAiKit(): Promise<string> {
  const info = await aiServer();
  if (!info) throw new Error(`This build of ${host.mcp?.brand?.name ?? 'Cadrel Write'} doesn’t include the AI connection.`);
  const brand = host.mcp?.brand ?? MDEDIT_BRAND;
  const dest = path.join(app.getPath('downloads'), brand.folder);
  const files = buildKit({
    skills: SKILLS,
    server: host.mcp?.kitServer ? await host.mcp.kitServer() : await fsp.readFile(info.args[0]),
    version: app.getVersion(),
    root: info.root,
    serverPath: path.join(dest, `${brand.id}-mcp.js`),
    brand,
  });
  for (const f of files) {
    const target = path.join(dest, ...f.path.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, f.data);
  }
  shell.showItemInFolder(path.join(dest, 'README.txt'));
  return dest;
}

/** A project in the Root Folder (so the Sharing page can reach it with no folder open) or anything inside the open folder. */
function reviewPath(p: string): string {
  const full = path.resolve(p);
  const rel = path.relative(path.resolve(projectsRoot()), full);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep)) return full;
  return inRoot(p, { allowRoot: true });
}

/** Sharing for review, built on the sync service's Google sign-in. */
async function reviewHost(): Promise<ReviewSharingApi> {
  const svc = await ensureSync();
  return createReviewHost({
    fs: nodeFs,
    root: projectsRoot(),
    stateFile: path.join(dataDir, 'shares.json'),
    drive: () => svc.driveApi(),
    connected: () => svc.isConnected(),
    accessToken: () => svc.accessToken()
  });
}

/** Something on disk changed because of the user: sync soon (does nothing unless Google Drive is connected). */
const touched = () => sync?.syncSoon();
/** Channels that change the user's files: a pass follows them. */
const SYNC_TRIGGERS = new Set([
  'fs:writeFile', 'fs:createFile', 'fs:importDocx', 'fs:createFolder', 'fs:renameNode', 'fs:trashNode', 'export:saveDetails', 'export:setMarked', 'export:relink',
  'projects:create', 'projects:update', 'projects:rename', 'projects:duplicate', 'projects:delete', 'projects:convert', 'projects:progress', 'projects:addMissing'
]);

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

/** The book fields the enclosing project sets itself (so the book dialogs can say where each value comes from). */
async function projectFieldsFor(file: string): Promise<string[]> {
  const dir = await projectDirOf(file);
  const meta = dir ? await projects.readMeta(dir) : null;
  return meta ? Object.keys(meta.overrides.book) : [];
}

const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);

/** Files with unsaved edits in the renderer. Reported by the renderer. */
let dirtyFiles: string[] = [];

function setTheme(theme: ThemeSource): void {
  if (host.theme) return host.theme.set({ source: theme });
  nativeTheme.themeSource = theme;
  settings.update((s) => {
    s.theme = theme;
  });
}

function registerIpc(): void {
  const winOf = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
  /** `ipcMain.handle` that also nudges Google Drive sync after the handlers that change the user's files. */
  const handle = (channel: string, listener: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, async (e, ...args) => {
      const result = await listener(e, ...args);
      if (SYNC_TRIGGERS.has(channel)) touched();
      return result;
    });

  handle('dialog:pickFolder', async (e) => {
    const win = winOf(e);
    const opts = { properties: ['openDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : path.resolve(res.filePaths[0]);
  });
  handle('settings:getLastFolder', () => existingFolder(settings.get().lastFolder));
  handle('fs:scanFolder', async (_e, root: string) => {
    const tree = await scanFolder(path.resolve(root));
    openRoot = path.resolve(root);
    settings.update((s) => {
      s.lastFolder = openRoot!;
    });
    return tree;
  });
  handle('fs:readFile', (_e, p: string) => readWithStamp(inRoot(p)));
  const reviews = makeReviews(nodeFs);
  handle('review:list', (_e, project: string) => reviews.list(reviewPath(project)));
  handle('review:delete', (_e, project: string, id: string) => reviews.remove(reviewPath(project), id));
  handle('ai:server', aiServer);
  handle('ai:exportKit', exportAiKit);
  handle('ai:remote:get', () => aiRemote.status());
  handle('ai:remote:set', (_e, enabled: boolean) => aiRemote.setEnabled(enabled === true));
  handle('ai:remote:reset', () => aiRemote.resetToken());
  handle('review:save', (_e, project: string, id: string, text: string) => reviews.save(reviewPath(project), id, text));
  handle('fs:statFile', (_e, p: string) => statStamp(inRoot(p)));
  handle('fs:writeFile', (_e, p: string, content: string) => {
    const full = inRoot(p);
    if (!isMarkdown(full)) throw new Error('Refusing to write a non-Markdown file');
    return writeFileAtomic(full, content);
  });
  handle('fs:createFile', (_e, dir: string, name: string, content?: string) =>
    createFile(inRoot(dir, { allowRoot: true }), name, content)
  );
  handle('fs:importDocx', async (e, dir: string) => {
    const target = inRoot(dir, { allowRoot: true });
    const win = winOf(e);
    const opts = { title: 'Import Word documents', properties: ['openFile' as const, 'multiSelections' as const], filters: [{ name: 'Word documents', extensions: ['docx'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return importDocxFiles(target, res.filePaths);
  });
  handle('fs:createFolder', (_e, dir: string, name: string) =>
    createFolder(inRoot(dir, { allowRoot: true }), name)
  );
  handle('fs:renameNode', async (_e, p: string, newName: string) => {
    const from = inRoot(p);
    const to = await renameNode(from, newName);
    if (isMarkdown(from)) await renameSidecar(from, to).catch(() => undefined); // export settings follow the file
    return to;
  });
  handle('fs:trashNode', async (_e, p: string) => {
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
  handle('export:getDetails', async (_e, p: string) => loadDetails(mdPath(p), await defaultsFor(mdPath(p)), await projectFieldsFor(mdPath(p))));
  handle('export:saveDetails', async (_e, p: string, details: unknown, overrides?: unknown) =>
    saveDetails(
      mdPath(p),
      sanitizeBookDetails(details),
      Array.isArray(overrides) ? overrides.filter((x): x is string => typeof x === 'string') : undefined,
      await defaultsFor(mdPath(p))
    )
  );
  handle('export:setMarked', async (_e, p: string, marked: boolean) =>
    setMarked(mdPath(p), marked === true, await defaultsFor(mdPath(p)), await projectFieldsFor(mdPath(p)))
  );
  handle('export:relink', async (_e, sidecar: string, md: string) => {
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
  handle('export:plan', (_e, p: string, unsaved?: unknown) =>
    planExport(mdPath(p), exportDeps(), unsaved ? sanitizeBookDetails(unsaved) : undefined)
  );
  handle('export:run', async (e, p: string) => {
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
  handle('export:open', (_e, p: string) => (exportedFiles.has(path.resolve(p)) ? shell.openPath(path.resolve(p)) : Promise.resolve('Not an exported file')));
  handle('report:save', async (e, kind: string, suggested: string, html: string) => {
    if ((kind !== 'html' && kind !== 'pdf') || typeof html !== 'string' || typeof suggested !== 'string') throw new Error('Bad report request');
    const win = winOf(e);
    const base = path.basename(suggested).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'Analysis';
    const name = base.replace(/\.(html?|pdf)$/i, '') + (kind === 'pdf' ? '.pdf' : '.html');
    const opts = {
      defaultPath: path.join(openRoot ?? app.getPath('documents'), name),
      filters: kind === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Web page', extensions: ['html'] }]
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    if (kind === 'html') {
      await fsp.writeFile(res.filePath, html, 'utf8');
      return res.filePath;
    }
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdedit-report-'));
    const printer = new BrowserWindow({ show: false, width: 1000, height: 1400, webPreferences: { sandbox: true, contextIsolation: true, javascript: false, spellcheck: false } });
    try {
      const page = path.join(tmp, 'report.html');
      await fsp.writeFile(page, html, 'utf8');
      await printer.loadFile(page);
      const pdf = await printer.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
      await fsp.writeFile(res.filePath, pdf);
      return res.filePath;
    } finally {
      if (!printer.isDestroyed()) printer.destroy();
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  handle('fonts:installed', () => listInstalledFonts());
  handle('fonts:preview', async (_e, family: string) => {
    const b = bundledFont(String(family));
    if (!b) return null;
    const data = await fsp.readFile(path.join(pdfResources().fontsDir, b.slug, 'Regular.ttf')).catch(() => null);
    return data ? `data:font/ttf;base64,${data.toString('base64')}` : null;
  });
  handle('export:pickCover', async (e) => {
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
  handle('projects:config', config);
  handle('projects:setConfig', async (_e, patch: Record<string, unknown>) => {
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
  handle('projects:list', () => projects.listProjects(projectsRoot()));
  handle('projects:create', async (_e, name: string, templateId: string) => {
    const template = settings.projects().templates.find((t) => t.id === templateId);
    if (!template) throw new Error('That template no longer exists.');
    return projects.createProject(projectsRoot(), String(name), template, { app: settings.appDefaults() });
  });
  handle('projects:meta', (_e, p: string) => (path.isAbsolute(p) ? projects.readMeta(path.resolve(p)) : null)); // read-only, any folder
  handle('projects:update', (_e, p: string, patch: Record<string, unknown>) => projects.updateMeta(projectPath(p), patch as never));
  handle('projects:rename', async (_e, p: string, name: string) => {
    const from = projectPath(p);
    const to = await projects.renameProject(from, String(name));
    if (openRoot && (openRoot === from || openRoot.startsWith(from + path.sep))) openRoot = to + openRoot.slice(from.length);
    return to;
  });
  handle('projects:duplicate', (_e, p: string, name: string) => projects.duplicateProject(projectPath(p), String(name)));
  handle('projects:delete', (_e, p: string) => projects.deleteProject(projectPath(p), (x) => shell.trashItem(x)));
  handle('projects:convert', (_e, p: string) => projects.convertToProject(projectPath(p)));
  handle('projects:addMissing', (_e, p: string, templateId: string) => {
    const t = settings.projects().templates.find((x) => x.id === templateId);
    if (!t) throw new Error('That template no longer exists.');
    return projects.addMissingTemplateParts(projectPath(p), t);
  });
  handle('projects:progress', (_e, p: string) => projects.recordProgress(projectPath(p)));
  handle('projects:move', async (_e, newRoot: string) => {
    if (typeof newRoot !== 'string' || !path.isAbsolute(newRoot)) throw new Error('Choose a full folder path.');
    return projects.moveProjects(projectsRoot(), path.resolve(newRoot));
  });
  ipcMain.on('projects:setLast', (_e, p: string | null) => {
    settings.update((s) => {
      const cur = settings.projects();
      s.projects = { ...cur, lastProject: typeof p === 'string' ? p : null, recentProjects: withOpened(cur.recentProjects, typeof p === 'string' ? p : null) };
    });
  });

  handle('app:getDefaults', () => settings.appDefaults());
  handle('app:setDefaults', (_e, raw: unknown) => {
    const next = sanitizeAppDefaults(raw);
    settings.update((s) => {
      s.appDefaults = next;
    });
    return next;
  });
  handle('prefs:get', () => {
    const prefs = settings.get().prefs ?? {};
    if (!host.theme) return prefs;
    const { themeCustom: _own, ...rest } = prefs;
    const custom = host.theme.get().custom;
    return { ...rest, ...(custom ? { themeCustom: custom } : {}), themeManaged: true };
  });
  ipcMain.on('prefs:set', (_e, patch: Partial<Prefs>) => {
    if (typeof patch?.sidebarWidth === 'number' && Number.isFinite(patch.sidebarWidth)) {
      settings.update((s) => {
        s.prefs = { ...s.prefs, sidebarWidth: patch.sidebarWidth };
      });
    }
    if (patch && 'themeCustom' in patch) {
      const themeCustom = sanitizeThemeCustom(patch.themeCustom);
      if (host.theme) return void host.theme.set({ custom: themeCustom ?? null });
      settings.update((s) => {
        const { themeCustom: _old, ...rest } = s.prefs ?? {};
        s.prefs = themeCustom ? { ...rest, themeCustom } : rest;
      });
      setChromeTheme(themeCustom); // the title-bar buttons and the window background follow the custom colours
    }
  });
  handle('session:get', (_e, folder: string) => settings.get().sessions?.[folder] ?? null);
  ipcMain.on('session:save', (_e, folder: string, session: Session) => {
    if (typeof folder === 'string' && session && Array.isArray(session.tabs)) settings.setSession(folder, session);
  });

  // Markdown files named on the command line (double-click / "Open with") are queued here until the
  // renderer collects them, so none are lost if they arrive before the UI is ready.
  handle('app:takeLaunchFiles', async () => {
    const files = pendingFiles.splice(0);
    const ok: string[] = [];
    for (const f of files) if (await fsp.stat(f).then((st) => st.isFile(), () => false)) ok.push(f);
    return ok;
  });

  handle('drafts:save', (_e, d: DraftRecord) => drafts.save(d));
  handle('drafts:clear', (_e, file: string) => drafts.clear(file));
  handle('drafts:list', () => drafts.list());

  handle('dialog:confirmUnsaved', (e, name: string) => confirmUnsaved(winOf(e), name));
  handle('dialog:confirmOverwrite', (e, name: string) => confirmOverwrite(winOf(e), name));
  handle('dialog:confirmDelete', (e, name: string, kind: 'file' | 'folder' | 'chapter', unsaved: boolean) =>
    confirmDelete(winOf(e), name, kind, unsaved)
  );
  handle('dialog:confirmRecover', (e, name: string) => confirmRecover(winOf(e), name));
  handle('dialog:confirmMarkEdited', (e, title: string) => confirmMarkEdited(winOf(e), title));
  // --- Google Drive sync ---
  handle('review:shareStatus', async (_e, project: string) => (await reviewHost()).getShareStatus(reviewPath(project)));
  handle('review:invite', async (_e, project: string, name: string, chapters?: { keys: string[]; level: number } | null, role?: 'edit') =>
    (await reviewHost()).inviteReviewer(reviewPath(project), name, chapters, role === 'edit' ? 'edit' : undefined)
  );
  handle('review:shareChapters', async (_e, project: string, level: number) => (await reviewHost()).getShareChapters(reviewPath(project), level));
  handle('review:revoke', async (_e, project: string, id: string) => (await reviewHost()).revokeReviewer(reviewPath(project), id));
  handle('review:exchange', async (_e, project: string) => (await reviewHost()).exchangeReviews(reviewPath(project)));
  handle('review:listShares', async () => (await reviewHost()).listShares());
  handle('review:stop', async (_e, project: string) => (await reviewHost()).stopSharing(reviewPath(project)));
  handle('review:listShared', async () => (await reviewHost()).listShared());
  handle('review:pickerToken', async () => (await reviewHost()).pickerToken());
  handle('review:pickInBrowser', (_e, url: unknown) => pickInBrowser(String(url), (u) => shell.openExternal(u)));
  handle('review:join', async (_e, link: string, name: string) => (await reviewHost()).joinReview(link, name));
  // ---- Updating from the latest GitHub release ----
  handle('update:version', () => app.getVersion());
  handle('update:check', () => {
    if (host.updatesDisabledReason) throw new Error(host.updatesDisabledReason);
    return fetchLatestRelease(fetch, 'windows', app.getVersion());
  });
  handle('update:install', async (e, info: UpdateInfo) => {
    if (host.updatesDisabledReason) throw new Error(host.updatesDisabledReason);
    const file = await downloadInstaller(info, {
      fetchFn: fetch,
      dir: path.join(os.tmpdir(), 'mdedit-update'),
      onProgress: (p) => {
        if (!e.sender.isDestroyed()) e.sender.send('update:progress', p);
      }
    });
    // Read it back once more right before running it: waits out any antivirus scan, and refuses a file that has changed.
    try {
      updateLog(`downloaded ${path.basename(file)}: ${await checkBeforeLaunch(file)}`);
    } catch (err) {
      updateLog(`not run: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    // Start the installer only after we have exited (so no file is in use). Quitting goes through the usual
    // unsaved-changes prompt; if the user cancels that, `guardClose` clears this again.
    installerToRun = file;
    app.quit();
  });
  handle('sync:status', async () => (await ensureSync()).getSyncStatus());
  handle('sync:connect', async () => (await ensureSync()).connectSync());
  handle('sync:now', async () => (await ensureSync()).syncNow());
  handle('sync:confirm', async () => (await ensureSync()).confirmDeletes());
  handle('sync:disconnect', async () => (await ensureSync()).disconnectSync());

  ipcMain.on('app:setDirtyFiles', (_e, names: string[]) => {
    dirtyFiles = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
  });
}


// ---- hosting ---------------------------------------------------------------------------

/** One line per update step in <data folder>\update.log, so a failed update can be diagnosed afterwards. */
export function updateLog(line: string): void {
  try {
    appendFileSync(path.join(dataDir, 'update.log'), `${new Date().toISOString()} v${app.getVersion()} ${line}\n`);
  } catch {
    /* logging must never get in the way of updating */
  }
}

export interface WriteModule {
  queueFile(file: string): void;
  /** Does the editor hold unsaved edits? */
  hasUnsaved(): boolean;
  /** The projects in the Root Folder (for a host's overview). */
  listProjects(): ReturnType<typeof projects.listProjects>;
  /** Asks the editor to resolve unsaved edits (save / discard / cancel). Resolves true if the window may close. */
  requestClose(): Promise<boolean>;
  /** Wires up what belongs to Write's page: F1 opens Help, and coming back to the window syncs. */
  attach(contents: WebContents, win: BrowserWindow): void;
  /** The host changed the colours: tell the page and recolour the window chrome. */
  themeChanged(custom: ThemeCustom | undefined): void;
  /** The sync service, if Google Drive sync was ever started (for a final pass on quit). */
  syncService(): SyncService | null;
  /** A downloaded installer to run once the app has exited, if the user chose to update. */
  takeInstaller(): string | null;
  flush(): Promise<void>;
  stop(): void;
}

/** Closing with unsaved tabs asks the renderer to resolve them first. */
function requestClose(): Promise<boolean> {
  const contents = host.getContents();
  if (dirtyFiles.length === 0 || !contents || contents.isDestroyed() || contents.isCrashed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    ipcMain.once('app:closeDecision', (_e, ok: boolean) => {
      if (ok !== true) installerToRun = null; // the user backed out of closing, so an update in progress is off
      resolve(ok === true);
    });
    contents.send('app:closeRequested');
  });
}

/** Loads Write's settings and registers its IPC, menu and window-chrome handlers for the given host. Call once. */
export async function createWriteModule(h: WriteHost): Promise<WriteModule> {
  host = h;
  dataDir = h.dataDir ?? app.getPath('userData');
  if (h.assetsDir) setAssetsDir(h.assetsDir);
  settings = new SettingsStore(path.join(dataDir, 'settings.json'));
  aiRemote = new AiRemote({ file: path.join(dataDir, 'ai-remote.json'), fs: nodeFs, root: () => projectsRoot(), version: app.getVersion() });
  await settings.load();
  drafts = new DraftStore(path.join(dataDir, 'drafts'));
  nativeTheme.themeSource = h.theme ? h.theme.get().source : settings.get().theme ?? 'system';
  setChromeTheme(h.theme ? h.theme.get().custom : settings.get().prefs?.themeCustom);

  registerIpc();
  void aiRemote.load(); // comes back up only if the user left it on
  registerWindowChrome(() => host.getWindow(), () => host.getContents());
  installMenu(
    { get: () => (host.theme ? host.theme.get().source : settings.get().theme ?? 'system'), set: setTheme },
    { getContents: () => host.getContents(), asApplicationMenu: host.standalone }
  );
  void ensureSync().then((svc) => svc.syncNow()); // does nothing unless Google Drive is connected
  return {
    queueFile,
    hasUnsaved: () => dirtyFiles.length > 0,
    listProjects: () => projects.listProjects(projectsRoot()),
    requestClose,
    themeChanged(custom) {
      setChromeTheme(custom);
      const c = host.getContents();
      if (c && !c.isDestroyed()) c.send('theme:custom', custom);
    },
    attach(contents, win) {
      contents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'F1' && !input.control && !input.alt && !input.shift) {
          e.preventDefault();
          openHelp();
        }
      });
      win.on('focus', () => sync?.syncSoon(1000)); // edits made elsewhere (another device) show up when you come back
    },
    syncService: () => sync,
    takeInstaller: () => installerToRun,
    flush: () => settings.flush(),
    stop: () => void aiRemote.stop()
  };
}
