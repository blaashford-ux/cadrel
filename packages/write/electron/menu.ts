import { app, BrowserWindow, Menu, type MenuItem, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { openHelp } from './help';
import type { MenuAction, MenuNode, ThemeSource } from '../src/shared/api';

/** Where the menu's actions go. Write's renderer may be a view inside a bigger window, so none of this assumes a focused window. */
interface MenuHost {
  getContents(): WebContents | null;
  /** Standalone Write also owns the application menu; inside the shell the shell does, and this menu is only drawn in Write's own view. */
  asApplicationMenu: boolean;
  /** Cadrel Reader: the short menu, with nothing for writing, sharing or exporting. */
  reader?: boolean;
}

/** The menu this module owns (drawn by the in-window menu bar). */
let current: Menu | null = null;

interface ThemeHooks {
  get(): ThemeSource;
  set(theme: ThemeSource): void;
}

/**
 * Replaces Electron's default menu. The default has View > Reload (Ctrl+R / Ctrl+Shift+R),
 * which would reload the page and silently discard unsaved edits.
 *
 * Shortcuts are shown as label hints ("\t") rather than registered accelerators: the renderer
 * already handles them, and a second registration would fire twice.
 */
export function installMenu(theme: ThemeHooks, menuHost: MenuHost): void {
  const send = (action: MenuAction) => () => {
    menuHost.getContents()?.send('menu:action', action);
  };
  const themeItem = (label: string, value: ThemeSource): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme.get() === value,
    click: () => theme.set(value)
  });

  const template: MenuItemConstructorOptions[] = menuHost.reader ? readerTemplate(send, themeItem) : [
    {
      label: '&File',
      submenu: [
        { label: 'Open Project…', click: send('projects-home') },
        { label: 'Switch Project…\tCtrl+K', click: send('switch-project') },
        { type: 'separator' },
        { label: 'New File…\tCtrl+N', click: send('new-file') },
        { label: 'New Folder…\tCtrl+Shift+N', click: send('new-folder') },
        { label: 'Open Folder…\tCtrl+O', click: send('change-folder') },
        { label: 'Refresh\tF5', click: send('refresh') },
        { type: 'separator' },
        { label: 'Project Settings…', click: send('project-settings') },
        { label: 'Project Progress…', click: send('project-progress') },
        { label: 'Export…\tCtrl+E', click: send('export') },
        { label: 'Google Drive Sync…', click: send('sync') },
        { label: 'Settings…\tCtrl+,', click: send('settings') },
        { type: 'separator' },
        { label: 'Save\tCtrl+S', click: send('save') },
        { label: 'Close Tab\tCtrl+W', click: send('close-tab') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { label: 'Undo Last Action\tCtrl+Alt+Z', click: send('undo-action') },
        { label: 'Redo Last Action\tCtrl+Alt+Y', click: send('redo-action') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…\tCtrl+F', click: send('find') },
        { label: 'Find Next\tF3', click: send('find-next') },
        { label: 'Find Previous\tShift+F3', click: send('find-prev') },
        { label: 'Replace…\tCtrl+H', click: send('replace') },
        { label: 'Go to Line…\tCtrl+G', click: send('go-to-line') }
      ]
    },
    {
      label: '&Go',
      submenu: [
        { label: 'Next Chapter\tCtrl+PgDn', click: send('next-chapter') },
        { label: 'Previous Chapter\tCtrl+PgUp', click: send('prev-chapter') },
        { type: 'separator' },
        { label: 'Next Scene Break\tCtrl+Down', click: send('next-scene') },
        { label: 'Previous Scene Break\tCtrl+Up', click: send('prev-scene') },
        { type: 'separator' },
        { label: 'Next Tab\tCtrl+Tab', click: send('next-tab') },
        { label: 'Previous Tab\tCtrl+Shift+Tab', click: send('prev-tab') }
      ]
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Theme',
          submenu: [themeItem('Match Windows', 'system'), themeItem('Light', 'light'), themeItem('Dark', 'dark')]
        },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Zone Mode\tF8', click: send('zone-mode') },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Cadrel Write Help\tF1', click: () => openHelp() },
        { type: 'separator' },
        {
          label: 'About Cadrel Write',
          click: send('about')
        }
      ]
    }
  ];
  current = Menu.buildFromTemplate(withIds(template));
  if (menuHost.asApplicationMenu) Menu.setApplicationMenu(current);
}

/** Gives every item a stable id ("m0", "m0.3", …) so the in-window menu can ask for it to be run. */
function withIds(items: MenuItemConstructorOptions[], prefix = 'm'): MenuItemConstructorOptions[] {
  return items.map((item, i) => {
    const id = `${prefix}${prefix === 'm' ? i : '.' + i}`;
    return { ...item, id, ...(Array.isArray(item.submenu) ? { submenu: withIds(item.submenu, id) } : {}) };
  });
}

/** Shortcut hints for items that rely on a built-in role rather than a "\t" label. */
const ROLE_HINTS: Record<string, string> = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  selectall: 'Ctrl+A',
  zoomin: 'Ctrl++',
  zoomout: 'Ctrl+-',
  resetzoom: 'Ctrl+0',
  togglefullscreen: 'F11',
  toggledevtools: 'Ctrl+Shift+I'
};

function describe(items: readonly MenuItem[]): MenuNode[] {
  return items
    .filter((i) => i.visible !== false)
    .map((i): MenuNode => {
      const raw = i.label ?? '';
      const [text, tab] = raw.split('\t');
      const mnemonic = /&(\w)/.exec(text)?.[1];
      const submenu = i.submenu?.items;
      return {
        id: i.id,
        label: text.replace(/&(\w)/, '$1'),
        ...(tab ? { hint: tab } : i.role && ROLE_HINTS[i.role.toLowerCase()] ? { hint: ROLE_HINTS[i.role.toLowerCase()] } : {}),
        ...(mnemonic ? { mnemonic: mnemonic.toLowerCase() } : {}),
        type: i.type === 'separator' ? 'separator' : submenu ? 'submenu' : i.type === 'checkbox' || i.type === 'radio' ? i.type : 'normal',
        ...(i.type === 'checkbox' || i.type === 'radio' ? { checked: i.checked } : {}),
        enabled: i.enabled,
        ...(submenu ? { submenu: describe(submenu) } : {})
      };
    });
}

/** The application menu as plain data. */
export function describeMenu(): MenuNode[] {
  const menu = current ?? Menu.getApplicationMenu();
  return menu ? describe(menu.items) : [];
}

/** Runs a menu item by id (roles included), as if it had been chosen in a native menu. */
export function invokeMenuItem(id: string, win: BrowserWindow | null, contents: WebContents | null = win?.webContents ?? null): void {
  const item = (current ?? Menu.getApplicationMenu())?.getMenuItemById(id);
  if (!item || !item.enabled || item.type === 'separator' || item.submenu) return;
  item.click(undefined as never, win ?? undefined, contents ?? undefined);
}

/** Cadrel Reader's menus: opening invitations and projects shared with you, reading, finding, and the look of the window. */
function readerTemplate(send: (a: MenuAction) => () => void, themeItem: (label: string, value: ThemeSource) => MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: '&File',
      submenu: [
        { label: 'Open Invitation…', click: send('open-invitation') },
        { label: 'Shared With Me…', click: send('projects-home') },
        { label: 'Switch Project…\tCtrl+K', click: send('switch-project') },
        { type: 'separator' },
        { label: 'Refresh\tF5', click: send('refresh') },
        { label: 'Google Drive Sync…', click: send('sync') },
        { label: 'Settings…\tCtrl+,', click: send('settings') },
        { type: 'separator' },
        { label: 'Close Tab\tCtrl+W', click: send('close-tab') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…\tCtrl+F', click: send('find') },
        { label: 'Find Next\tF3', click: send('find-next') },
        { label: 'Find Previous\tShift+F3', click: send('find-prev') }
      ]
    },
    {
      label: '&Go',
      submenu: [
        { label: 'Next Chapter\tCtrl+PgDn', click: send('next-chapter') },
        { label: 'Previous Chapter\tCtrl+PgUp', click: send('prev-chapter') },
        { type: 'separator' },
        { label: 'Next Scene Break\tCtrl+Down', click: send('next-scene') },
        { label: 'Previous Scene Break\tCtrl+Up', click: send('prev-scene') },
        { type: 'separator' },
        { label: 'Next Tab\tCtrl+Tab', click: send('next-tab') },
        { label: 'Previous Tab\tCtrl+Shift+Tab', click: send('prev-tab') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Theme', submenu: [themeItem('Match Windows', 'system'), themeItem('Light', 'light'), themeItem('Dark', 'dark')] },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    { label: '&Help', submenu: [{ label: 'About Cadrel Reader', click: send('about') }] }
  ];
}
