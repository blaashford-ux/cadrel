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
  studios: {
    get: () => studioCall('shell:studios:get'),
    setActive: (id) => studioCall('shell:studios:setActive', id),
    enableManager: (on) => studioCall('shell:studios:enableManager', on),
    create: (name) => studioCall('shell:studios:create', name),
    rename: (id, name) => studioCall('shell:studios:rename', id, name),
    remove: (id) => studioCall('shell:studios:remove', id),
    provision: (id, details) => studioCall('shell:studios:provision', id, details),
    upgrade: (id, apiToken) => studioCall('shell:studios:upgrade', id, apiToken),
    forgetToken: (id) => studioCall('shell:studios:forgetToken', id),
    people: (id) => studioCall('shell:studios:people', id),
    createInvite: (id, invite) => studioCall('shell:studios:createInvite', id, invite),
    revokeInvite: (id, inviteId) => studioCall('shell:studios:revokeInvite', id, inviteId),
    removeMember: (id, memberId) => studioCall('shell:studios:removeMember', id, memberId),
    join: (link, details) => studioCall('shell:studios:join', link, details),
    backup: (id) => studioCall('shell:studios:backup', id),
    onChange: (cb) => {
      const h = (_e: unknown, v: Parameters<typeof cb>[0]) => cb(v);
      ipcRenderer.on('shell:studios', h);
      return () => ipcRenderer.removeListener('shell:studios', h);
    }
  },
  manage: {
    templates: () => studioCall('shell:manage:templates'),
    create: (o) => studioCall('shell:manage:create', o),
    addManuscript: (id, template) => studioCall('shell:manage:addManuscript', id, template),
    rename: (id, name) => studioCall('shell:manage:rename', id, name),
    archive: (id, archived) => studioCall('shell:manage:archive', id, archived),
    remove: (id) => studioCall('shell:manage:remove', id),
    duplicate: (id) => studioCall('shell:manage:duplicate', id),
    manuscript: (id) => studioCall('shell:manage:manuscript', id),
    setManuscript: (id, patch) => studioCall('shell:manage:setManuscript', id, patch),
    addMissingParts: (id) => studioCall('shell:manage:addMissingParts', id),
    open: (id) => studioCall('shell:manage:open', id),
    reveal: (id) => studioCall('shell:manage:reveal', id),
    unfiled: () => studioCall('shell:manage:unfiled'),
    adopt: (name, parentId) => studioCall('shell:manage:adopt', name, parentId)
  },
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
    folders: () => ipcRenderer.invoke('shell:prefs:folders'),
    choose: (which) => studioCall('shell:prefs:choose', which),
    reset: (which) => studioCall('shell:prefs:reset', which),
    restart: () => studioCall('shell:prefs:restart')
  },
  admin: {
    get: () => studioCall('shell:admin:get'),
    save: (change) => studioCall('shell:admin:save', change),
    fonts: () => studioCall('shell:admin:fonts'),
    fontPreview: (family) => studioCall('shell:admin:fontPreview', family)
  },
  assistants: {
    get: () => studioCall('shell:assistants:get'),
    saveKit: () => studioCall('shell:assistants:saveKit'),
    saveExtension: () => studioCall('shell:assistants:saveExtension'),
    saveChromeExtension: () => studioCall('shell:assistants:saveChromeExtension'),
    setRemote: (on) => studioCall('shell:assistants:setRemote', on),
    resetRemoteToken: () => studioCall('shell:assistants:resetRemoteToken')
  },
  market: {
    reconnect: () => studioCall('shell:market:reconnect'),
    forceDisconnect: () => studioCall('shell:market:forceDisconnect')
  },
  update: {
    check: () => studioCall('shell:update:check'),
    install: () => studioCall('shell:update:install'),
    last: () => studioCall('shell:update:last'),
    onProgress: (cb) => {
      const h = (_e: unknown, p: { received: number; total: number }) => cb(p);
      ipcRenderer.on('shell:update:progress', h);
      return () => ipcRenderer.removeListener('shell:update:progress', h);
    },
    onAvailable: (cb) => {
      const h = (_e: unknown, s: Parameters<typeof cb>[0]) => cb(s);
      ipcRenderer.on('shell:update:available', h);
      return () => ipcRenderer.removeListener('shell:update:available', h);
    }
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
