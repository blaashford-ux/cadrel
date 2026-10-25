/**
 * The Cadrel shell: one window that hosts the modules. The shell draws the rail, Home and Dashboard itself; Write and
 * Market each live in their own view with their own preload, styles and bridge, so neither knows the other exists.
 * Both modules' main-process halves run in this process from startup (the capture server must keep listening
 * whichever page is showing).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron';
import { createWriteModule, type WriteModule } from '@cadrel/write/electron/module';
import { chromeOptions, shellColor, watchWindow, windowInfo } from '@cadrel/write/electron/windowChrome';
import { fileFromArgv } from '@cadrel/write/electron/launch';
import { createMarketModule, type MarketModule } from '@cadrel/market-desktop/src/main/module.js';
import { launcherSource, readHandshake } from '@cadrel/market-desktop/src/main/launcher.js';
import type { McpBrand } from '@cadrel/market-desktop/src/main/service.js';
import type { KitBrand } from '@cadrel/write/src/shared/agent/kit';
import { sanitizeThemeCustom, type ThemeCustom } from '@cadrel/write/src/shared/theme';
import { isModule, isPage, type AppFolders, type ModuleId, type Overview, type Page, type ThemeState, type UserView } from '../shared/api';
import { isThemeSource, marketCss, type ThemeSource } from '../shared/theme';
import { moduleBounds } from './layout';
import { marketUnavailable, summariseMarket, summariseWrite, writeUnavailable } from './overview';
import { runShellSmoke } from './smoke';
import { SettingsStore } from './settings';
import { StudioService } from './studio';
import { nodeFs } from '@cadrel/write/electron/nodeFs';
import os from 'node:os';
import { NoteError, ProjectError, UserError, type UserProfile } from '@cadrel/kernel';
import { UserStore } from '@cadrel/studio';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST = process.env.CADREL_TEST === '1';
// `Cadrel.exe --smoke-test=<file>` runs a headless self-test of the installed app and exits (see smoke.ts).
const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));

app.setName('Cadrel');
if (process.platform === 'win32') app.setAppUserModelId('com.blaashford.cadrel');
if (process.env.CADREL_USER_DATA) app.setPath('userData', process.env.CADREL_USER_DATA);

// Existing MDEdit and BookScout users keep their settings: each module keeps its original data folder. (BookScout's
// MCP server finds its config at <appData>/BookScout/config.json, so that name cannot change.)
const appData = process.env.CADREL_USER_DATA ?? app.getPath('appData');
const writeData = process.env.CADREL_USER_DATA ? path.join(appData, 'write') : path.join(appData, 'mdedit');
const marketData = process.env.CADREL_USER_DATA ? path.join(appData, 'market') : path.join(appData, 'BookScout');

let win: BrowserWindow | null = null;
let settings: SettingsStore;
let studio: StudioService;
let users: UserStore;
let userCache: UserProfile | null = null;

async function refreshUser(): Promise<UserProfile> {
  userCache = await users.read();
  return userCache;
}

async function userView(): Promise<UserView> {
  const profile = await refreshUser();
  return { profile, name: authorName(), nameIsDefault: !profile.displayName, problems: await users.verify() };
}

/** Attaches each file in turn; one that cannot be attached does not stop the rest, and the first refusal is reported after. */
async function attachAll(paths: string[]): Promise<UserView> {
  let first: unknown;
  for (const p of paths) {
    try {
      await users.attach(p);
    } catch (e) {
      first ??= e;
    }
  }
  const v = await userView();
  win?.webContents.send('shell:user', v);
  if (first) throw first;
  return v;
}
let write: WriteModule;
let market: MarketModule;
let page: Page = 'home';
let quitting = false;
const views: Partial<Record<ModuleId, WebContentsView>> = {};

// ---- appearance: one setting for the whole app --------------------------------------------------
// Light/dark follows nativeTheme (which reaches every view). The colours are the shell's to set: it paints its own page,
// tells Write (which already understands the model), and maps the same colours onto Market's differently named variables.
const themeState = (): ThemeState => ({ source: settings.get().theme ?? 'system', ...(settings.get().themeCustom ? { custom: settings.get().themeCustom } : {}) });
let marketCssKey: string | undefined;

function paintMarket(): void {
  const c = views.market?.webContents;
  if (!c || c.isDestroyed()) return;
  const old = marketCssKey;
  void c.insertCSS(marketCss(settings.get().themeCustom)).then((key) => {
    marketCssKey = key;
    if (old) void c.removeInsertedCSS(old).catch(() => undefined);
  });
}

function setTheme(change: { source?: ThemeSource; custom?: ThemeCustom | null }): ThemeState {
  settings.update((s) => {
    if (change.source !== undefined && isThemeSource(change.source)) {
      if (change.source === 'system') delete s.theme;
      else s.theme = change.source;
    }
    if (change.custom !== undefined) {
      const custom = sanitizeThemeCustom(change.custom);
      if (custom) s.themeCustom = custom;
      else delete s.themeCustom;
    }
  });
  nativeTheme.themeSource = settings.get().theme ?? 'system';
  write.themeChanged(settings.get().themeCustom);
  paintMarket();
  if (win && !win.isDestroyed()) win.webContents.send('shell:theme', themeState());
  return themeState();
}

// ---- the one MCP server --------------------------------------------------------------------
// Write's AI Kit and Market's "connect to Claude" both end up here: one server, one Claude Desktop extension, one name.
const MCP_DESCRIPTION = 'Lets Claude read your Cadrel manuscripts and leave review notes in them (it never changes your manuscript), and search your Kindle market research.';
const CADREL_MCP: McpBrand = { id: 'cadrel', name: 'Cadrel', description: MCP_DESCRIPTION, file: 'Cadrel.mcpb' };
const KIT_BRAND: KitBrand = { id: 'cadrel', name: 'Cadrel', folder: 'Cadrel AI Kit', description: MCP_DESCRIPTION };
const mcpFile = () => path.join(here, 'mcp.mjs');
/** How an AI app starts the server: the installed app's own runtime acting as Node (it carries the native modules), the system Node in development. */
const mcpLaunch = () => ({
  command: app.isPackaged ? process.execPath : 'node',
  args: [mcpFile()],
  env: (app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) as Record<string, string>
});
/**
 * The file inside the Claude Desktop extension: a small launcher that starts the server above with the installed app's runtime.
 * The server takes seconds to open the library, which Claude Desktop will not wait for, so the launcher answers the handshake first.
 * Arguments the extension's settings add (the projects folder) are passed on to the server.
 */
async function kitLauncher(): Promise<Uint8Array> {
  const launch = mcpLaunch();
  const handshake = await readHandshake(launch);
  return Buffer.from(launcherSource({ label: 'Cadrel', ...launch, handshake, logFile: path.join(marketData, 'logs', 'mcp-launcher.log') }), 'utf8');
}

/** Who a note written in the app is by: the profile's name, else the Windows user. */
const authorName = () => userCache?.displayName || os.userInfo().username || 'Me';

const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(here, 'assets', 'icon.png'));
const resourcesDir = () => (app.isPackaged ? process.resourcesPath : path.join(here, 'resources'));

// ---- the window and its views ---------------------------------------------------------------

function restoredBounds(): Partial<Electron.Rectangle> & { width: number; height: number } {
  const w = settings.get().window;
  const fallback = { width: 1280, height: 820 };
  if (!w) return fallback;
  const size = { width: Math.max(800, w.width), height: Math.max(500, w.height) };
  if (w.x === undefined || w.y === undefined) return size;
  // Only reuse the saved position if it still lands on a connected display.
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return w.x! < a.x + a.width - 50 && w.x! + size.width > a.x + 50 && w.y! >= a.y - 10 && w.y! < a.y + a.height - 50;
  });
  return visible ? { ...size, x: w.x, y: w.y } : size;
}

function saveWindowState(): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  settings.update((s) => {
    s.window = { ...b, ...(win!.isMaximized() ? { maximized: true } : {}) };
  });
}

function layout(): void {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  for (const v of Object.values(views)) v?.setBounds(moduleBounds({ width, height }));
}

/** Creates a module's view the first time it is needed. The module's main half is already running. */
function ensureView(id: ModuleId): WebContentsView {
  const existing = views[id];
  if (existing) return existing;
  const dir = path.join(here, 'modules', id);
  const view = new WebContentsView({
    webPreferences: { preload: path.join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  view.setBackgroundColor(shellColor());
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (e) => e.preventDefault());
  view.webContents.on('render-process-gone', (_e, d) => market?.log.error(`${id} renderer gone`, d.reason));
  // Market has no title bar of its own, so on Windows its tab bar must clear the window buttons and be draggable.
  if (id === 'market') {
    view.webContents.on('did-finish-load', () => {
      if (win && windowInfo(win).overlay) {
        void view.webContents.insertCSS('header.tabs{padding-right:150px;-webkit-app-region:drag}header.tabs button{-webkit-app-region:no-drag}');
      }
    });
  }
  if (id === 'market') view.webContents.on('did-finish-load', paintMarket);
  void view.webContents.loadFile(path.join(dir, 'renderer', 'index.html'));
  if (id === 'write') write.attach(view.webContents, win!);
  views[id] = view;
  win!.contentView.addChildView(view);
  view.setBounds(moduleBounds(win!.getContentBounds()));
  return view;
}

function showPage(next: Page): void {
  if (!win || win.isDestroyed()) return;
  page = next;
  for (const id of ['write', 'market'] as const) views[id]?.setVisible(false);
  if (isModule(next)) {
    const v = ensureView(next);
    v.setVisible(true);
    v.webContents.focus();
  } else {
    win.webContents.focus();
  }
  win.webContents.send('shell:page', next);
  settings.update((s) => {
    s.page = next;
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 800,
    minHeight: 500,
    title: 'Cadrel',
    backgroundColor: shellColor(),
    // Frameless with window buttons drawn by Windows. Elsewhere (development only) a normal frame.
    ...(process.platform === 'win32' ? chromeOptions() : {}),
    icon: iconPath(),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (settings.get().window?.maximized) win.maximize();
  const w = win;
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  watchWindow(w); // tells the shell's own page about maximise / fullscreen
  w.on('closed', () => {
    for (const k of Object.keys(views) as ModuleId[]) delete views[k];
    if (win === w) win = null;
  });

  // Views do not follow the window by themselves; and Write's title bar needs to hear about maximise too.
  const relayout = () => {
    layout();
    const v = views.write;
    if (v && !v.webContents.isDestroyed()) v.webContents.send('window:state', windowInfo(w));
  };
  w.on('resize', relayout);
  w.on('maximize', relayout);
  w.on('unmaximize', relayout);
  w.on('enter-full-screen', relayout);
  w.on('leave-full-screen', relayout);
  w.on('restore', relayout);
  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(saveWindowState, 800);
  };
  w.on('resize', later);
  w.on('move', later);

  // Closing with unsaved edits in Write: bring Write forward and let it ask.
  let waiting = false;
  let confirmed = false;
  w.on('close', (e) => {
    saveWindowState();
    if (confirmed || !write.hasUnsaved() || w.webContents.isCrashed()) return;
    e.preventDefault();
    if (waiting) return;
    waiting = true;
    showPage('write');
    void write.requestClose().then((ok) => {
      waiting = false;
      if (ok) {
        confirmed = true;
        w.close();
      }
    });
  });

  w.webContents.once('did-finish-load', () => showPage(settings.get().page));
  void w.loadFile(path.join(here, 'renderer', 'index.html'));
}

// ---- IPC the shell's own page may call ----------------------------------------------------------

async function overview(): Promise<Overview> {
  const [w, m] = await Promise.all([
    write.listProjects().then(summariseWrite, writeUnavailable),
    (async () => {
      const status = market.service.status();
      try {
        return summariseMarket({ status, categories: market.service.categories(), queue: market.service.queue() });
      } catch {
        // No library chosen yet, or it is being rebuilt: the module is up, it just has nothing to show.
        return summariseMarket({ status });
      }
    })().catch(marketUnavailable)
  ]);
  return { write: w, market: m };
}

function registerShellIpc(): void {
  // Only the shell's own page may drive the shell; a module's view must not be able to switch pages or read the other module.
  const fromShell = (e: Electron.IpcMainInvokeEvent) => !!win && e.sender === win.webContents;
  const guard = <A extends unknown[], R>(fn: (...a: A) => R) => (e: Electron.IpcMainInvokeEvent, ...a: A): R => {
    if (!fromShell(e)) throw new Error('not allowed');
    return fn(...a);
  };
  ipcMain.handle('shell:navigate', guard((p: unknown) => {
    if (!isPage(p)) throw new Error('unknown page');
    showPage(p);
  }));
  ipcMain.handle('shell:current', guard(() => page));
  ipcMain.handle('shell:overview', guard(() => overview()));
  // Projects and notes. A broken rule (a duplicate name, a move into itself) is told to the page as a message, not thrown through IPC.
  const studioOp = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) =>
    ipcMain.handle(channel, async (e, ...a: unknown[]) => {
      if (!fromShell(e)) throw new Error('not allowed');
      try {
        return await fn(...(a as A));
      } catch (err) {
        if (err instanceof ProjectError || err instanceof NoteError || (err instanceof Error && /^There is no project/.test(err.message))) return { __error: err.message };
        throw err;
      }
    });
  studioOp('studio:state', () => studio.state());
  studioOp('studio:createProject', async (o: Parameters<StudioService['createProject']>[0]) => ({ id: (await studio.createProject(o)).id }));
  studioOp('studio:updateProject', (id: string, c: { name?: string; kind?: string }) => studio.updateProject(id, c));
  studioOp('studio:moveProject', (id: string, parent: string | null, index?: number) => studio.moveProject(id, parent, index));
  studioOp('studio:archiveProject', (id: string, archived: boolean) => studio.archiveProject(id, archived));
  studioOp('studio:deleteProject', (id: string, cascade: boolean) => studio.deleteProject(id, cascade));
  studioOp('studio:link', (id: string, module: string, ref: string) => studio.link(id, module, ref));
  studioOp('studio:unlink', (module: string, ref: string) => studio.unlink(module, ref));
  studioOp('studio:addNote', async (o: Parameters<StudioService['addNote']>[0]) => ({ id: (await studio.addNote(o)).id }));
  studioOp('studio:setNoteStatus', (id: string, status: Parameters<StudioService['setNoteStatus']>[1]) => studio.setNoteStatus(id, status));
  studioOp('studio:replyToNote', (id: string, body: string) => studio.replyToNote(id, body));
  studioOp('studio:deleteNote', (id: string) => studio.deleteNote(id));
  // Notes on Market's records, asked for by Market's own page. The module is decided here from who is asking, never taken from the
  // page, and a page can only change notes that are on its own records.
  const fromMarket = (e: Electron.IpcMainInvokeEvent) => !!views.market && e.sender === views.market.webContents;
  const hostNotes = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R> | R) =>
    ipcMain.handle(`host:notes:${name}`, async (e, ...a: unknown[]) => {
      if (!fromMarket(e)) throw new Error('not allowed');
      return fn(...(a as A));
    });
  const rec = (v: unknown): { kind: string; id: string } => {
    const r = v as { kind?: unknown; id?: unknown };
    if (typeof r?.kind !== 'string' || typeof r.id !== 'string' || !r.kind || !r.id) throw new Error('bad record');
    return { kind: r.kind, id: r.id };
  };
  hostNotes('available', () => true);
  hostNotes('list', (r: unknown) => studio.recordNotes('market', rec(r).kind, rec(r).id));
  hostNotes('add', async (o: { kind: string; id: string; label: string; body: string; category?: string }) => ({ id: (await studio.addRecordNote({ module: 'market', ...rec(o), label: String(o.label ?? ''), body: o.body, category: o.category })).id }));
  hostNotes('status', async (id: string, status: Parameters<StudioService['setNoteStatus']>[1]) => (await studio.ownedBy('market', id), studio.setNoteStatus(id, status)));
  hostNotes('reply', async (id: string, body: string) => (await studio.ownedBy('market', id), studio.replyToNote(id, body)));
  hostNotes('remove', async (id: string) => (await studio.ownedBy('market', id), studio.deleteNote(id)));
  ipcMain.handle('shell:theme:get', guard(() => themeState()));
  ipcMain.handle('shell:theme:set', guard((change: { source?: ThemeSource; custom?: ThemeCustom | null }) => setTheme(change ?? {})));
  // The user: profile and attached files. A rule that was broken ("that is not an email") reaches the page as a message.
  const userOp = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) =>
    ipcMain.handle(channel, async (e, ...a: unknown[]) => {
      if (!fromShell(e)) throw new Error('not allowed');
      try {
        return await fn(...(a as A));
      } catch (err) {
        if (err instanceof UserError) return { __error: err.message };
        throw err;
      }
    });
  /** After a change: tell the page (so the rail's photo and the name update everywhere) and give the view back. */
  const changed = async (): Promise<UserView> => {
    const v = await userView();
    win?.webContents.send('shell:user', v);
    return v;
  };
  userOp('shell:user:get', userView);
  userOp('shell:user:update', async (patch: Parameters<UserStore['update']>[0]) => (await users.update(patch ?? {}), changed()));
  userOp('shell:user:attach', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Attach files to your profile', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || r.filePaths.length === 0) return null;
    return attachAll(r.filePaths);
  });
  userOp('shell:user:attachPaths', async (paths: unknown) => attachAll(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []));
  userOp('shell:user:editAttachment', async (id: string, patch: { note?: string; name?: string }) => (await users.editAttachment(id, patch ?? {}), changed()));
  userOp('shell:user:removeAttachment', async (id: string) => (await users.removeAttachment(id), changed()));
  userOp('shell:user:setAvatar', async (id: string | null) => (await users.setAvatar(id ?? null), changed()));
  userOp('shell:user:open', async (id: string) => {
    const p = await users.pathOf(id);
    if (!p) throw new UserError('That file is not there any more.');
    const name = (await users.read()).attachments.find((a) => a.id === id)!.name;
    // Opened from a copy named as the person knows it, so the program shows a sensible title and picks the right app by extension.
    const dir = path.join(app.getPath('temp'), 'cadrel-open', id);
    await fsp.mkdir(dir, { recursive: true });
    const copy = path.join(dir, name);
    await fsp.copyFile(p, copy);
    const err = await shell.openPath(copy);
    if (err) throw new UserError(`Could not open it: ${err}`);
  });
  userOp('shell:user:reveal', async (id: string) => {
    const p = await users.pathOf(id);
    if (!p) throw new UserError('That file is not there any more.');
    shell.showItemInFolder(p);
  });
  userOp('shell:user:avatar', async () => {
    const u = await users.read();
    const p = u.avatarId ? await users.pathOf(u.avatarId) : null;
    if (!p) return null;
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img.resize({ width: 128, quality: 'best' }).toDataURL();
  });
  ipcMain.handle('shell:prefs:folders', guard(async (): Promise<AppFolders> => {
    const w = await write.listProjects().catch(() => null);
    const m = market.service.status().libraryRoot;
    return { writeRoot: w?.root ?? null, marketLibrary: m ?? null, studioFile: path.join(app.getPath('userData'), 'studio.json'), settingsFolder: app.getPath('userData') };
  }));
  ipcMain.handle('shell:info', guard(() => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform })));
}

// ---- startup ------------------------------------------------------------------------------------

if (!TEST && !smokeArg && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    if (!write) return;
    const file = fileFromArgv(argv.slice(1), cwd);
    if (file) {
      write.queueFile(file);
      showPage('write');
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (smokeArg) {
      app.exit(await runShellSmoke(smokeArg.slice('--smoke-test='.length), here));
      return;
    }
    Menu.setApplicationMenu(null); // the default menu has View > Reload, which would silently discard unsaved edits
    settings = new SettingsStore(path.join(app.getPath('userData'), 'shell.json'));
    await settings.load();
    nativeTheme.themeSource = settings.get().theme ?? 'system';
    users = new UserStore(path.join(app.getPath('userData'), 'user'));
    await refreshUser();
    // The name used to be a setting; it belongs to the profile now.
    const legacy = settings.get().author?.trim();
    if (legacy) {
      if (!userCache?.displayName) await users.update({ displayName: legacy });
      settings.update((s) => {
        delete s.author;
      });
      await refreshUser();
    }
    studio = new StudioService({
      file: path.join(app.getPath('userData'), 'studio.json'),
      author: authorName,
      writeRoot: async () => {
        const l = await write.listProjects();
        return l.exists ? l.root : null;
      },
      fs: nodeFs
    });

    write = await createWriteModule({
      getWindow: () => win,
      getContents: () => views.write?.webContents ?? null,
      standalone: false,
      theme: { get: themeState, set: setTheme },
      dataDir: writeData,
      assetsDir: path.join(here, 'assets'),
      // One AI server for the whole suite, started with Cadrel's own runtime; the Claude Desktop extension holds a launcher for it.
      mcp: { file: mcpFile(), kitServer: kitLauncher, brand: KIT_BRAND },
      updatesDisabledReason: 'Cadrel is updated as a whole; MDEdit’s own updater is switched off here.'
    });
    market = createMarketModule({
      getWindow: () => win,
      getContents: () => views.market?.webContents ?? null,
      dataDir: marketData,
      codeDir: here,
      resourcesDir: resourcesDir(),
      iconFile: iconPath,
      version: app.getVersion(),
      willQuit: () => {
        quitting = true;
      },
      mcpLaunch,
      mcpBrand: CADREL_MCP,
      updatesDisabledReason: 'Cadrel is updated as a whole; BookScout’s own updater is switched off here.'
    });
    await market.start();
    registerShellIpc();

    const launchFile = fileFromArgv(process.argv.slice(1), process.cwd());
    if (launchFile) {
      write.queueFile(launchFile);
      settings.update((s) => {
        s.page = 'write';
      });
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((e) => {
    // Never fail silently: a startup error would otherwise leave a running process with no window.
    console.error('Cadrel failed to start:', e);
    app.exit(1);
  });
}

let finalSyncStarted = false;
app.on('before-quit', (e) => {
  quitting = true;
  void write?.flush();
  void settings?.flush();
  write?.stop();
  // Edits made in the last few seconds haven't synced to Google Drive yet: give them one pass (at most 10 s) before exiting.
  const sync = write?.syncService();
  if (!smokeArg && !finalSyncStarted && sync?.dirty) {
    finalSyncStarted = true;
    e.preventDefault();
    void Promise.race([sync.syncNow(), new Promise((resolve) => setTimeout(resolve, 10_000))]).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (smokeArg) return; // the smoke test's hidden PDF windows come and go; it exits the app itself
  void Promise.all([market?.stop(), write?.flush(), settings?.flush()]).finally(() => app.quit());
});
