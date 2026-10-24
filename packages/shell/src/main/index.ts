/**
 * The Cadrel shell: one window that hosts the modules. The shell draws the rail, Home and Dashboard itself; Write and
 * Market each live in their own view with their own preload, styles and bridge, so neither knows the other exists.
 * Both modules' main-process halves run in this process from startup (the capture server must keep listening
 * whichever page is showing).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, WebContentsView, ipcMain, screen } from 'electron';
import { createWriteModule, type WriteModule } from '@cadrel/write/electron/module';
import { chromeOptions, shellColor, watchWindow, windowInfo } from '@cadrel/write/electron/windowChrome';
import { fileFromArgv } from '@cadrel/write/electron/launch';
import { createMarketModule, type MarketModule } from '@cadrel/market-desktop/src/main/module.js';
import { isModule, isPage, type ModuleId, type Overview, type Page } from '../shared/api';
import { moduleBounds } from './layout';
import { marketUnavailable, summariseMarket, summariseWrite, writeUnavailable } from './overview';
import { SettingsStore } from './settings';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST = process.env.CADREL_TEST === '1';

app.setName('Cadrel');
if (process.env.CADREL_USER_DATA) app.setPath('userData', process.env.CADREL_USER_DATA);

// Existing MDEdit and BookScout users keep their settings: each module keeps its original data folder. (BookScout's
// MCP server finds its config at <appData>/BookScout/config.json, so that name cannot change.)
const appData = process.env.CADREL_USER_DATA ?? app.getPath('appData');
const writeData = process.env.CADREL_USER_DATA ? path.join(appData, 'write') : path.join(appData, 'mdedit');
const marketData = process.env.CADREL_USER_DATA ? path.join(appData, 'market') : path.join(appData, 'BookScout');

let win: BrowserWindow | null = null;
let settings: SettingsStore;
let write: WriteModule;
let market: MarketModule;
let page: Page = 'home';
let quitting = false;
const views: Partial<Record<ModuleId, WebContentsView>> = {};

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
  void view.webContents.loadFile(path.join(dir, 'renderer', 'index.html'));
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
  ipcMain.handle('shell:info', guard(() => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform })));
}

// ---- startup ------------------------------------------------------------------------------------

if (!TEST && !app.requestSingleInstanceLock()) {
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
    Menu.setApplicationMenu(null); // the default menu has View > Reload, which would silently discard unsaved edits
    settings = new SettingsStore(path.join(app.getPath('userData'), 'shell.json'));
    await settings.load();

    write = await createWriteModule({
      getWindow: () => win,
      getContents: () => views.write?.webContents ?? null,
      standalone: false,
      dataDir: writeData,
      assetsDir: path.join(here, 'assets')
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

app.on('before-quit', () => {
  quitting = true;
  void write?.flush();
  void settings?.flush();
});

app.on('window-all-closed', () => {
  void Promise.all([market?.stop(), write?.flush(), settings?.flush()]).finally(() => app.quit());
});
