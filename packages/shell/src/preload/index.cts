import { contextBridge, ipcRenderer } from 'electron';
import type { CadrelApi, Page, WindowInfo } from '../shared/api';

// Sandboxed preload (CommonJS). Everything the shell's page may do is listed here; nothing generic is exposed.
const api: CadrelApi = {
  navigate: (page) => ipcRenderer.invoke('shell:navigate', page),
  current: () => ipcRenderer.invoke('shell:current'),
  onPage: (cb) => {
    const h = (_e: unknown, p: Page) => cb(p);
    ipcRenderer.on('shell:page', h);
    return () => ipcRenderer.removeListener('shell:page', h);
  },
  overview: () => ipcRenderer.invoke('shell:overview'),
  info: () => ipcRenderer.invoke('shell:info'),
  // The window buttons use the same handlers Write's title bar does.
  windowInfo: () => ipcRenderer.invoke('window:info'),
  windowControl: (action) => ipcRenderer.send('window:control', action),
  onWindowState: (cb) => {
    const h = (_e: unknown, info: WindowInfo) => cb(info);
    ipcRenderer.on('window:state', h);
    return () => ipcRenderer.removeListener('window:state', h);
  }
};

contextBridge.exposeInMainWorld('cadrel', api);
