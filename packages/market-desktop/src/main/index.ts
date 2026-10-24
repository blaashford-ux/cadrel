/**
 * Standalone entry: BookScout as a whole application, with its own window and tray. The application logic lives in
 * ./module.ts, which the Cadrel shell also hosts inside its own window.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { createMarketModule, TEST } from './module.js';

// The MCP server finds this app's settings by this name, so it must not depend on the package name.
app.setName('BookScout');

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.env.BOOKSCOUT_USER_DATA) app.setPath('userData', process.env.BOOKSCOUT_USER_DATA);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const resources = () => (app.isPackaged ? process.resourcesPath : path.resolve(here, '../..'));
const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.resolve(here, '../build/icon.png'));

const market = createMarketModule({
  getWindow: () => win,
  getContents: () => win?.webContents ?? null,
  dataDir: app.getPath('userData'),
  codeDir: here,
  resourcesDir: resources(),
  iconFile: iconPath,
  version: app.getVersion(),
  willQuit: () => {
    quitting = true;
  },
});
const { service, log } = market;
const applySettings = market.applySettings;
log.info('starting', app.getVersion(), process.platform, process.versions.electron);

// One BookScout at a time: a second copy would fight over the port and the library.
if (!TEST && !app.requestSingleInstanceLock()) {
  log.info('another instance is running; exiting');
  app.quit();
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

function ensureTray() {
  if (tray || TEST) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  } catch (e) {
    log.warn('no tray icon', e);
    return;
  }
  tray.setToolTip('BookScout');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open BookScout', click: () => { win?.show(); win?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win?.show(); win?.focus(); });
}

/** The application menu: the standard menus plus About, beside Window. */
function buildMenu() {
  const showAbout = () => {
    if (!win) return;
    win.show();
    win.focus();
    win.webContents.send('navigate', 'about');
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { id: 'about-menu', label: 'About', submenu: [{ id: 'about', label: 'About BookScout', click: showAbout }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    title: 'BookScout',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', (_e, d) => log.error('renderer gone', d.reason));
  win.on('close', (e) => {
    if (quitting || TEST || !service.settings().keepRunningInTray) return;
    e.preventDefault(); // keep the ingest server alive so the extension can still send pages
    ensureTray();
    win?.hide();
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(here, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await market.start();
  buildMenu();
  createWindow();
  if (process.argv.includes('--hidden') && service.settings().keepRunningInTray) {
    ensureTray();
    win?.hide();
  }
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  void service.stop().then(() => app.quit());
});
