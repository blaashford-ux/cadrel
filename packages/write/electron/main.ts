/**
 * Standalone entry: Write as a whole application, with its own window. Everything the editor does lives in
 * ./module.ts, which the Cadrel shell also hosts inside its own window.
 */
import { app, BrowserWindow, screen } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileFromArgv } from './launch';
import { runSmokeTest } from './smokeTest';
import { chromeOptions, shellColor, watchWindow } from './windowChrome';
import { createWriteModule, settings, updateLog, type WriteModule } from './module';
import type { WindowState } from './settings';

let mainWindow: BrowserWindow | null = null;
let smokeMode = false;
let write: WriteModule | null = null;
const pendingLaunch: string[] = [];

/** Closing (X button, Alt+F4, quit) with unsaved tabs asks the renderer to resolve them first. */
function guardClose(win: BrowserWindow): void {
  let waiting = false;
  let confirmed = false;
  win.on('close', (e) => {
    saveWindowState(win);
    if (confirmed || !write || !write.hasUnsaved() || win.webContents.isCrashed()) return;
    e.preventDefault();
    if (waiting) return;
    waiting = true;
    void write.requestClose().then((ok) => {
      waiting = false;
      if (ok) {
        confirmed = true;
        win.close();
      }
    });
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
  write?.attach(win.webContents, win);

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
  const open = (file: string) => (write ? write.queueFile(file) : void pendingLaunch.push(file));
  app.on('second-instance', (_e, argv, cwd) => {
    const file = fileFromArgv(argv.slice(1), cwd);
    if (file) open(file);
    else if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  // macOS: Finder / "Open With" delivers files through this event, possibly before ready.
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (/\.(md|markdown)$/i.test(file)) open(file);
  });

  const launchFile = smokeMode ? null : fileFromArgv(process.argv.slice(1), process.cwd());
  if (launchFile) pendingLaunch.push(launchFile);

  app.whenReady().then(async () => {
    if (smokeArg) {
      const code = await runSmokeTest(smokeArg.slice('--smoke-test='.length));
      app.exit(code);
      return;
    }
    write = await createWriteModule({ getWindow: () => mainWindow, getContents: () => mainWindow?.webContents ?? null, standalone: true });
    // Files named on the command line wait here until the renderer collects them (see app:takeLaunchFiles).
    pendingLaunch.splice(0).forEach((f) => write!.queueFile(f));
    createWindow();
    app.on('before-quit', () => write?.stop());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((e) => {
    // Never fail silently: a startup error would otherwise leave a running process with no window.
    console.error('MDEdit failed to start:', e);
    app.exit(1);
  });
}

app.on('quit', () => {
  const installerToRun = write?.takeInstaller();
  if (!installerToRun) return;
  updateLog(`starting ${installerToRun}`);
  // Started the way a double-click starts it (through the shell). Started directly from here it failed its own
  // integrity check now and then, while the same file run by hand was fine.
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [installerToRun]] : [installerToRun, []];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', (e) => updateLog(`start failed: ${e.message}`)).unref();
});

let finalSyncStarted = false;
app.on('before-quit', (e) => {
  if (!smokeMode) void write?.flush();
  // Edits made in the last few seconds haven't synced yet: give them one pass (at most 10 s) before exiting.
  const sync = write?.syncService();
  if (!smokeMode && !finalSyncStarted && sync?.dirty) {
    finalSyncStarted = true;
    e.preventDefault();
    void Promise.race([sync.syncNow(), new Promise((resolve) => setTimeout(resolve, 10_000))]).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (smokeMode) return; // the hidden render windows used for the PDF are closed one by one
  void (write?.flush() ?? Promise.resolve()).finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});
