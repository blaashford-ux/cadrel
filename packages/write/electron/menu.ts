import { app, BrowserWindow, dialog, Menu, type MenuItem, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction, MenuNode, ThemeSource } from '../src/shared/api';

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
export function installMenu(theme: ThemeHooks): void {
  const send = (action: MenuAction) => () => {
    BrowserWindow.getFocusedWindow()?.webContents.send('menu:action', action);
  };
  const themeItem = (label: string, value: ThemeSource): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme.get() === value,
    click: () => theme.set(value)
  });

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'New Project…\tCtrl+Alt+N', click: send('new-project') },
        { label: 'Projects Home', click: send('projects-home') },
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
        { label: 'Replace…\tCtrl+H', click: send('replace') }
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
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About MDEdit',
          click: () => {
            const opts = {
              type: 'info' as const,
              title: 'About MDEdit',
              message: `MDEdit ${app.getVersion()}`,
              detail: [
                'A folder-based Markdown editor with KDP export.',
                '',
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
                '',
                'Bundled fonts: EB Garamond, Crimson Pro, Libre Baskerville (SIL Open Font License 1.1).',
                'Print layout: Paged.js (MIT).'
              ].join('\n'),
              buttons: ['OK']
            };
            const win = BrowserWindow.getFocusedWindow();
            void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(withIds(template)));
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
  const menu = Menu.getApplicationMenu();
  return menu ? describe(menu.items) : [];
}

/** Runs a menu item by id (roles included), as if it had been chosen in a native menu. */
export function invokeMenuItem(id: string, win: BrowserWindow | null): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (!item || !item.enabled || item.type === 'separator' || item.submenu) return;
  item.click(undefined as never, win ?? undefined, win?.webContents);
}
