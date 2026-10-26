import type { DesktopApi, ExportApi } from '../shared/api';

const unavailable = (what: string) => () => Promise.reject(new Error(`${what} isn’t available on this device.`));
const noop = () => undefined;
const never = () => noop; // an "unsubscribe" for events that never fire here

/**
 * Inert versions of the desktop-only parts of the API. The UI checks `capabilities` before showing anything that
 * needs them, so these only exist to keep every call safe.
 */
export const desktopOnlyStubs: ExportApi & DesktopApi = {
  getBookDetails: unavailable('Export'),
  saveBookDetails: unavailable('Export'),
  setMarked: unavailable('Export'),
  relinkSidecar: unavailable('Export'),
  listInstalledFonts: async () => [],
  bundledFontPreview: async () => null,
  pickCoverImage: async () => null,
  planExport: unavailable('Export'),
  runExport: unavailable('Export'),
  cancelExport: noop,
  onExportProgress: never,
  revealOutput: noop,
  openOutput: unavailable('Export'),
  saveReport: unavailable('Saving a report'),

  pickFolder: async () => null,
  reveal: noop,
  importDocx: async () => null,
  getAiServer: async () => null,
  exportAiKit: async () => {
    throw new Error('Not available on the phone.');
  },
  getAiRemote: async () => {
    throw new Error('Not available on the phone.');
  },
  setAiRemote: async () => {
    throw new Error('Not available on the phone.');
  },
  resetAiRemoteToken: async () => {
    throw new Error('Not available on the phone.');
  },
  takeLaunchFiles: async () => [],
  onLaunchFiles: never,
  setDirtyFiles: noop,
  onCloseRequested: never,
  reportCloseDecision: noop,
  getMenu: async () => [],
  clickMenu: noop,
  windowInfo: async () => ({ platform: 'android', overlay: false, maximized: false, fullscreen: false }),
  onWindowState: never,
  windowControl: noop,
  onMenuAction: never,
};
