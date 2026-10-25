import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CadrelApi, Page, ThemeState, UserView, WindowInfo } from '../shared/api';

/** Studio calls come back as {__error} when a rule was broken (a duplicate name, a move into itself); the page gets a normal rejection with that message. */
const studioCall = async (channel: string, ...args: unknown[]) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && typeof r === 'object' && '__error' in r) throw new Error(String((r as { __error: unknown }).__error));
  return r;
};

// Sandboxed preload (CommonJS). Everything the shell's page may do is listed here; nothing generic is exposed.
const api: CadrelApi = {
  theme: {
    get: () => ipcRenderer.invoke('shell:theme:get'),
    set: (change) => ipcRenderer.invoke('shell:theme:set', change),
    onChange: (cb) => {
      const h = (_e: unknown, t: ThemeState) => cb(t);
      ipcRenderer.on('shell:theme', h);
      return () => ipcRenderer.removeListener('shell:theme', h);
    }
  },
  user: {
    get: () => studioCall('shell:user:get'),
    update: (patch) => studioCall('shell:user:update', patch),
    attach: () => studioCall('shell:user:attach'),
    // A dropped File has no path in the page; Electron can tell the bridge where it came from.
    attachDropped: (files) => studioCall('shell:user:attachPaths', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
    chooseAvatar: () => studioCall('shell:user:chooseAvatar'),
    download: (id) => studioCall('shell:user:download', id),
    editAttachment: (id, patch) => studioCall('shell:user:editAttachment', id, patch),
    removeAttachment: (id) => studioCall('shell:user:removeAttachment', id),
    setAvatar: (id) => studioCall('shell:user:setAvatar', id),
    open: (id) => studioCall('shell:user:open', id),
    reveal: (id) => studioCall('shell:user:reveal', id),
    avatar: () => studioCall('shell:user:avatar'),
    onChange: (cb) => {
      const h = (_e: unknown, v: UserView) => cb(v);
      ipcRenderer.on('shell:user', h);
      return () => ipcRenderer.removeListener('shell:user', h);
    }
  },
  prefs: {
    folders: () => ipcRenderer.invoke('shell:prefs:folders')
  },
  studio: {
    state: () => studioCall('studio:state'),
    createProject: (o) => studioCall('studio:createProject', o),
    updateProject: (id, change) => studioCall('studio:updateProject', id, change),
    moveProject: (id, parentId, index) => studioCall('studio:moveProject', id, parentId, index),
    archiveProject: (id, archived) => studioCall('studio:archiveProject', id, archived),
    deleteProject: (id, cascade) => studioCall('studio:deleteProject', id, cascade),
    link: (projectId, module, ref) => studioCall('studio:link', projectId, module, ref),
    unlink: (module, ref) => studioCall('studio:unlink', module, ref),
    addNote: (o) => studioCall('studio:addNote', o),
    setNoteStatus: (id, status) => studioCall('studio:setNoteStatus', id, status),
    replyToNote: (id, body) => studioCall('studio:replyToNote', id, body),
    deleteNote: (id) => studioCall('studio:deleteNote', id)
  },
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
