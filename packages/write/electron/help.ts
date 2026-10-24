import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { assetsDir } from './export/deps';
import { shellColor } from './windowChrome';

let helpWindow: BrowserWindow | null = null;

/** Only `topic` values that look like a plain anchor id are passed on to the page. */
const TOPIC = /^[a-z0-9-]{1,40}$/i;

/**
 * Help → MDEdit Help. The help is a self-contained page in a window of its own, so it can sit beside the editor and be
 * navigated on its own. One window is reused: asking again focuses it (and moves it to `topic` if one is given).
 */
export function openHelp(topic?: string): void {
  const hash = topic && TOPIC.test(topic) ? topic : '';
  if (helpWindow && !helpWindow.isDestroyed()) {
    if (helpWindow.isMinimized()) helpWindow.restore();
    if (hash) void helpWindow.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + hash)}`);
    helpWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: 'MDEdit Help',
    backgroundColor: shellColor(),
    icon: path.join(assetsDir(), 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  helpWindow = win;
  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    if (helpWindow === win) helpWindow = null;
  });
  // Links to the web open in the browser; anything else that tries to leave the help page is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    if (!url.startsWith('file:') || new URL(url).pathname !== new URL(win.webContents.getURL()).pathname) e.preventDefault();
  });
  void win.loadFile(path.join(assetsDir(), 'help', 'index.html'), hash ? { hash } : undefined);
}
