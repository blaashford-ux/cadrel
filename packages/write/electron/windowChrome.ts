import { BrowserWindow, ipcMain, nativeTheme, type BrowserWindowConstructorOptions, type WebContents } from 'electron';
import type { WindowInfo } from '../src/shared/api';
import { colorsFor, type Scheme, type ThemeCustom } from '../src/shared/theme';
import { describeMenu, invokeMenuItem } from './menu';

/** Height of the custom title bar (also the height of the OS-drawn buttons on Windows). */
export const TITLEBAR_HEIGHT = 40;

let custom: ThemeCustom | undefined;
const scheme = (): Scheme => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

/** The window colour and the title-bar button colour follow the user's custom theme colours. */
export const shellColor = () => colorsFor(scheme(), custom).shell;
const inkColor = () => colorsFor(scheme(), custom).fg;

/** Called when the custom colours are loaded or changed; recolours every open window. */
export function setChromeTheme(next: ThemeCustom | undefined): void {
  custom = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.setBackgroundColor(shellColor());
    if (usesOverlay()) win.setTitleBarOverlay(overlay());
  }
}

/** On Windows the OS draws minimise/maximise/close over our bar; elsewhere we draw them ourselves. */
const usesOverlay = () => process.platform === 'win32';

const overlay = () => ({
  color: shellColor(),
  symbolColor: inkColor(),
  height: TITLEBAR_HEIGHT
});

/** Window options for a frameless window with our own title bar. */
export function chromeOptions(): BrowserWindowConstructorOptions {
  return usesOverlay() ? { titleBarStyle: 'hidden', titleBarOverlay: overlay() } : { frame: false };
}

export function windowInfo(win: BrowserWindow | null): WindowInfo {
  return {
    platform: process.platform,
    overlay: usesOverlay(),
    maximized: !!win && !win.isDestroyed() && win.isMaximized(),
    fullscreen: !!win && !win.isDestroyed() && win.isFullScreen()
  };
}

/** Keeps the renderer told about maximise/fullscreen, and the OS buttons and background in step with the theme. */
export function watchWindow(win: BrowserWindow, getContents: () => WebContents | null = () => win.webContents): void {
  win.setMenuBarVisibility(false); // our menu bar replaces the native one; accelerators keep working
  const send = () => {
    if (!win.isDestroyed()) getContents()?.send('window:state', windowInfo(win));
  };
  win.on('maximize', send);
  win.on('unmaximize', send);
  win.on('enter-full-screen', send);
  win.on('leave-full-screen', send);
  const retheme = () => {
    if (win.isDestroyed()) return;
    win.setBackgroundColor(shellColor());
    if (usesOverlay()) win.setTitleBarOverlay(overlay());
  };
  nativeTheme.on('updated', retheme);
  win.on('closed', () => nativeTheme.removeListener('updated', retheme));
}

export function registerWindowChrome(getWindow: () => BrowserWindow | null, getContents: () => WebContents | null = () => getWindow()?.webContents ?? null): void {
  ipcMain.handle('window:info', () => windowInfo(getWindow()));
  ipcMain.on('window:control', (_e, action: string) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    else if (action === 'fullscreen') win.setFullScreen(true);
    else if (action === 'windowed') win.setFullScreen(false);
  });
  ipcMain.handle('menu:describe', () => describeMenu());
  ipcMain.on('menu:click', (_e, id: unknown) => {
    if (typeof id === 'string') invokeMenuItem(id, getWindow(), getContents());
  });
}
