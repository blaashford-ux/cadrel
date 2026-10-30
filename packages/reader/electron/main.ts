/**
 * Cadrel Reader: for reading a manuscript an author shared and giving comments and suggestions. It is Cadrel Write's module running in
 * reader mode (`reader: true`) in its own application, with its own data folder, installer and update feed.
 */
import { app, BrowserWindow, screen } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createWriteModule, settings, updateLog, type WriteModule } from '@cadrel/write/electron/module';
import { chromeOptions, shellColor, watchWindow } from '@cadrel/write/electron/windowChrome';
import type { WindowState } from '@cadrel/write/electron/settings';
import { inviteFromArgv } from './inviteArg';
import { runReaderSmokeTest } from './smokeTest';

const NAME = 'Cadrel Reader';
const SCHEME = 'cadrel-reader';

// Its own app name and data folder, so it never reads or writes Cadrel's or Cadrel Write's settings, drafts or sign-in.
app.setName(NAME);
app.setPath('userData', path.join(app.getPath('appData'), NAME));

let mainWindow: BrowserWindow | null = null;
let reader: WriteModule | null = null;
const pendingInvites: string[] = [];

function guardClose(win: BrowserWindow): void {
  win.on('close', () => saveWindowState(win));
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
  const fallback = { width: 1100, height: 780 };
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
    title: NAME,
    backgroundColor: shellColor(),
    ...chromeOptions(),
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Tells the shared preload this window is Cadrel Reader's: it then exposes Reader's capabilities, not the full app's.
      additionalArguments: ['--cadrel-reader'],
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
  reader?.attach(win.webContents, win);

  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(win), 800);
  };
  win.on('resize', later);
  win.on('move', later);

  if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5175');
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
  return win;
}

// ---- startup ---------------------------------------------------------------------------

const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));
if (process.platform === 'win32') app.setAppUserModelId('com.blaashford.cadrel.reader');

// Clicking a cadrel-reader: link opens this app (the installer registers the scheme; this covers a development run).
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(SCHEME);

const firstInstance = !!smokeArg || app.requestSingleInstanceLock();
if (!firstInstance) {
  app.quit();
} else {
  const receive = (link: string) => (reader ? reader.queueInvite(link) : void pendingInvites.push(link));
  // A second launch (clicking another invitation link) hands its link to the window that is already open.
  app.on('second-instance', (_e, argv) => {
    const link = inviteFromArgv(argv.slice(1));
    if (link) receive(link);
    else if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  // macOS delivers links through this event, possibly before ready.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (url.toLowerCase().startsWith(`${SCHEME}:`)) receive(url);
  });

  const launchLink = smokeArg ? null : inviteFromArgv(process.argv.slice(1));
  if (launchLink) pendingInvites.push(launchLink);

  app.whenReady().then(async () => {
    if (smokeArg) {
      app.exit(await runReaderSmokeTest(smokeArg.slice('--smoke-test='.length)));
      return;
    }
    reader = await createWriteModule({
      getWindow: () => mainWindow,
      getContents: () => mainWindow?.webContents ?? null,
      standalone: true,
      reader: true,
      // Shared projects arrive in <this folder>/Shared With Me. Nothing to set up on the first run.
      defaultRoot: () => path.join(app.getPath('documents'), NAME)
    });
    // A link the app was started with waits here until the window asks for it (review:takeInviteLink).
    pendingInvites.splice(0).forEach((l) => reader!.queueInvite(l));
    createWindow();
    app.on('before-quit', () => reader?.stop());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((e) => {
    // Never fail silently: a startup error would otherwise leave a running process with no window.
    console.error(`${NAME} failed to start:`, e);
    app.exit(1);
  });
}

app.on('quit', () => {
  const installerToRun = reader?.takeInstaller();
  if (!installerToRun) return;
  updateLog(`starting ${installerToRun}`);
  // Started the way a double-click starts it (through the shell); started directly it failed its own integrity check now and then.
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [installerToRun]] : [installerToRun, []];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', (e) => updateLog(`start failed: ${e.message}`)).unref();
});

app.on('before-quit', () => void reader?.flush());

app.on('window-all-closed', () => {
  void (reader?.flush() ?? Promise.resolve()).finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});
