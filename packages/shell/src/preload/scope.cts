import { contextBridge, ipcRenderer } from 'electron';
import type { ScopeView } from '../shared/api';

/**
 * Added to the preload of every module view (Write, Market, Finance) when the shell builds them: the Project and Book the app is showing
 * (docs/UI-MODEL.md). A module reads it and is told when it changes; it cannot change it, so the shell's page is the one place a person
 * chooses. A module run on its own (outside Cadrel) has no `cadrelScope`, and treats that as "no scope: show everything".
 */
contextBridge.exposeInMainWorld('cadrelScope', {
  get: (): Promise<ScopeView> => ipcRenderer.invoke('scope:get'),
  onChange: (cb: (scope: ScopeView) => void): (() => void) => {
    const h = (_e: unknown, v: ScopeView) => cb(v);
    ipcRenderer.on('scope:changed', h);
    return () => ipcRenderer.removeListener('scope:changed', h);
  }
});
