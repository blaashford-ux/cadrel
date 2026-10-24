import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from 'electron';
import path from 'node:path';
import type { DraftRecord, Prefs, Session, ThemeSource } from '../src/shared/api';
import { DraftStore } from './drafts';
import { readWithStamp, statStamp, writeBytesAtomic, writeFileAtomic } from './files';
import { sanitizeBookDetails } from '../src/shared/export/model';
import { makeExportDeps, pdfResources } from './export/deps';
import { planExport, runExport } from './export/run';
import { fileFromArgv } from './launch';
import { runSmokeTest } from './smokeTest';
import { loadDetails, renameSidecar, saveDetails, setMarked, existingSidecar } from './export/sidecar';
import { createFile, createFolder, renameNode } from './fsops';
import { sidecarPathFor } from '../src/shared/export/sidecar';
import { promises as fsp } from 'node:fs';
import { installMenu } from './menu';
import { chromeOptions, registerWindowChrome, shellColor, watchWindow } from './windowChrome';
import { confirmDelete, confirmOverwrite, confirmRecover, confirmUnsaved } from './prompts';
import { scanFolder } from './scan';
import { bundledFont } from '../src/shared/export/fonts';
import { listInstalledFonts } from './fonts';
import { sanitizeAppDefaults, type AppDefaults } from '../src/shared/appDefaults';
import { defaultRootFolder, effectiveDefaults, sanitizeProjectsSettings, type ProjectsConfig } from '../src/shared/projects';
import * as projects from './projects';
import { existingFolder, SettingsStore, type WindowState } from './settings';

const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
let drafts: DraftStore;
let mainWindow: BrowserWindow | null = null;
let smokeMode = false;
const pendingFiles: string[] = [];

function queueFile(file: string): void {
  if (!pendingFiles.includes(file)) pendingFiles.push(file);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('app:launchFiles');
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

/** Closing (X button, Alt+F4, quit) with unsaved tabs asks the renderer to resolve them first. */
function guardClose(win: BrowserWindow): void {
  let waiting = false;
  let confirmed = false;
  win.on('close', (e) => {
    saveWindowState(win);
    if (confirmed || dirtyFiles.length === 0 || win.webContents.isCrashed()) return;
    e.preventDefault();
    if (waiting) return;
    waiting = true;
    ipcMain.once('app:closeDecision', (_e, ok: boolean) => {
      waiting = false;
      if (ok === true) {
        confirmed = true;
        win.close();
      }
    });
    win.webContents.send('app:closeRequested');
  });
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const b = win.getNormalBounds();
  const state: WindowState = { ...b, ...(win.isMaximized() ? { maximized: true } : {}) };
  settings.update((s) => {
    s.window = state;
  });
}

/** Saved bounds, but only if they still land on a connected display. */
function restoredBounds(): Partial<Electron.Rectangle> & { width: number; height: number } {
  const w = settings.get().window;
  const fallback = { width: 1200, height: 800 };
  if (!w) return fallback;
  const size = { width: Math.max(600, w.width), height: Math.max(400, w.height) };
  if (w.x === undefined || w.y === undefined) return size;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return w.x! < a.x + a.width - 50 && w.x! + size.width > a.x + 50 && w.y! >= a.y - 10 && w.y! < a.y + a.height - 50;
  });
  return visible ? { ...size, x: w.x, y: w.y } : size;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...restoredBounds(),
    title: 'MDEdit',
    // match the app's shell colour so there is no white flash while the page loads
    backgroundColor: shellColor(),
    ...chromeOptions(),
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (settings.get().window?.maximized) win.maximize();
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  guardClose(win);
  watchWindow(win);

  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(win), 800);
  };
  win.on('resize', later);
  win.on('move', later);

  if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
  return win;
}

// ---- startup ---------------------------------------------------------------------------

const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));
smokeMode = !!smokeArg;
if (process.platform === 'win32') app.setAppUserModelId('com.blaashford.mdedit');

// One window per user: a second launch (e.g. double-clicking another .md) hands its file to the first.
const firstInstance = smokeMode || app.requestSingleInstanceLock();
if (!firstInstance) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const file = fileFromArgv(argv.slice(1), cwd);
    if (file) queueFile(file);
    else if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  // macOS: Finder / "Open With" delivers files through this event, possibly before ready.
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (/\.(md|markdown)$/i.test(file)) queueFile(file);
  });

  const launchFile = smokeMode ? null : fileFromArgv(process.argv.slice(1), process.cwd());
  if (launchFile) pendingFiles.push(launchFile);

  app.whenReady().then(async () => {
    if (smokeArg) {
      const code = await runSmokeTest(smokeArg.slice('--smoke-test='.length));
      app.exit(code);
      return;
    }
    await settings.load();
    drafts = new DraftStore(path.join(app.getPath('userData'), 'drafts'));
    nativeTheme.themeSource = settings.get().theme ?? 'system';

    registerIpc();
    registerWindowChrome(() => mainWindow);
    installMenu({ get: () => settings.get().theme ?? 'system', set: setTheme });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((e) => {
    // Never fail silently: a startup error would otherwise leave a running process with no window.
    console.error('MDEdit failed to start:', e);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  if (!smokeMode) void settings.flush();
});

app.on('window-all-closed', () => {
  if (smokeMode) return; // the hidden render windows used for the PDF are closed one by one
  void settings.flush().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});
