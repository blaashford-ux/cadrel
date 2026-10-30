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
  scope: {
    get: () => ipcRenderer.invoke('shell:scope:get'),
    set: (change) => ipcRenderer.invoke('shell:scope:set', change),
    openMenu: (at) => ipcRenderer.invoke('shell:scope:menu', at),
    onChange: (cb) => {
      const h = (_e: unknown, v: Parameters<typeof cb>[0]) => cb(v);
      ipcRenderer.on('shell:scope', h);
      return () => ipcRenderer.removeListener('shell:scope', h);
    }
  },
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
    onChange: (cb) => {
      const h = (_e: unknown, v: Parameters<typeof cb>[0]) => cb(v);
      ipcRenderer.on('shell:studios', h);
      return () => ipcRenderer.removeListener('shell:studios', h);
    }
  },
  stages: {
    views: () => studioCall('shell:stages:views'),
    options: (projectId) => studioCall('shell:stages:options', projectId),
    move: (projectId, to) => studioCall('shell:stages:move', projectId, to)
  },
  vault: {
    state: () => studioCall('shell:vault:state'),
    add: (path, comment) => studioCall('shell:vault:call', 'add', path, comment),
    checkOut: (path) => studioCall('shell:vault:call', 'checkOut', path),
    checkIn: (path, comment) => studioCall('shell:vault:call', 'checkIn', path, comment),
    undoCheckOut: (path) => studioCall('shell:vault:call', 'undoCheckOut', path),
    discardLocalChanges: (path) => studioCall('shell:vault:call', 'discardLocalChanges', path),
    getLatest: (paths, o) => studioCall('shell:vault:call', 'getLatest', paths, o),
    forceRelease: (path, reason) => studioCall('shell:vault:call', 'forceRelease', path, reason),
    history: (path) => studioCall('shell:vault:history', path),
    detail: (path) => studioCall('shell:vault:detail', path),
    addReference: (path, to, version, note) => studioCall('shell:vault:call', 'addReference', path, to, version, note),
    setReferenceVersion: (path, to, version) => studioCall('shell:vault:call', 'setReferenceVersion', path, to, version),
    removeReference: (path, to) => studioCall('shell:vault:call', 'removeReference', path, to),
    setCard: (path, fields, projectId) => studioCall('shell:vault:call', 'setCard', path, fields, projectId),
    saveVersionAs: (path, version, as) => studioCall('shell:vault:call', 'saveVersionAs', path, version, as),
    openFolder: () => studioCall('shell:vault:open')
  },
  work: {
    state: (projectId) => studioCall('shell:work:state', projectId),
    mine: () => studioCall('shell:work:mine'),
    plan: () => studioCall('shell:work:plan'),
    pulse: () => studioCall('shell:work:pulse'),
    createTask: (i) => studioCall('shell:work:call', 'createTask', i),
    updateTask: (id, patch) => studioCall('shell:work:call', 'updateTask', id, patch),
    setState: (id, state) => studioCall('shell:work:call', 'setState', id, state),
    addDependency: (id, on) => studioCall('shell:work:call', 'addDependency', id, on),
    removeDependency: (id, on) => studioCall('shell:work:call', 'removeDependency', id, on),
    requestApproval: (i) => studioCall('shell:work:call', 'requestApproval', i),
    respond: (id, response, reason) => studioCall('shell:work:call', 'respond', id, response, reason),
    withdraw: (id) => studioCall('shell:work:call', 'withdraw', id),
    recordDecision: (i) => studioCall('shell:work:call', 'record', i)
  },
  workflow: {
    state: () => studioCall('shell:workflow:state'),
    create: (i) => studioCall('shell:workflow:call', 'create', i),
    save: (id, draft) => studioCall('shell:workflow:call', 'save', id, draft),
    setDefault: (id, levels) => studioCall('shell:workflow:call', 'setDefault', id, levels),
    delete: (id) => studioCall('shell:workflow:call', 'delete', id)
  },
  people: {
    state: () => studioCall('shell:people:state'),
    createPerson: (i) => studioCall('shell:people:call', 'createPerson', i),
    updatePerson: (id, patch) => studioCall('shell:people:call', 'updatePerson', id, patch),
    setPersonActive: (id, active) => studioCall('shell:people:call', 'setPersonActive', id, active),
    createPenName: (i) => studioCall('shell:people:call', 'createPenName', i),
    setPenNamePeople: (id, personIds) => studioCall('shell:people:call', 'setPenNamePeople', id, personIds),
    createTeam: (name) => studioCall('shell:people:call', 'createTeam', name),
    renameTeam: (id, name) => studioCall('shell:people:call', 'renameTeam', id, name),
    setTeamMember: (teamId, personId, member) => studioCall('shell:people:call', 'setTeamMember', teamId, personId, member),
    deleteTeam: (id) => studioCall('shell:people:call', 'deleteTeam', id),
    createRole: (i) => studioCall('shell:people:call', 'createRole', i),
    updateRole: (id, patch) => studioCall('shell:people:call', 'updateRole', id, patch),
    resetRole: (id) => studioCall('shell:people:call', 'resetRole', id),
    deleteRole: (id, replacementId) => studioCall('shell:people:call', 'deleteRole', id, replacementId),
    acknowledgeCapabilities: (caps) => studioCall('shell:people:call', 'acknowledgeCapabilities', caps),
    grant: (i) => studioCall('shell:people:call', 'grant', i),
    revoke: (id) => studioCall('shell:people:call', 'revoke', id),
    setExpiry: (id, expiresAt) => studioCall('shell:people:call', 'setExpiry', id, expiresAt),
    explainAccess: (personId, capability, projectId) => studioCall('shell:people:explain', personId, capability, projectId),
    effectiveCapabilities: (personId, projectId) => studioCall('shell:people:effective', personId, projectId)
  },
  myBooks: {
    catalogue: () => studioCall('shell:mybooks:catalogue'),
    catalogueBook: (id) => studioCall('shell:mybooks:catalogueBook', id),
    createBook: (i) => studioCall('shell:mybooks:call', 'createBook', i),
    createSeries: (i) => studioCall('shell:mybooks:call', 'createSeries', i),
    updateBook: (id, patch) => studioCall('shell:mybooks:call', 'updateBook', id, patch),
    moveBook: (id, seriesId, position) => studioCall('shell:mybooks:call', 'moveBook', id, seriesId, position),
    addEdition: (bookId, i) => studioCall('shell:mybooks:call', 'addEdition', bookId, i),
    updateEdition: (id, patch) => studioCall('shell:mybooks:call', 'updateEdition', id, patch),
    archiveBook: (id) => studioCall('shell:mybooks:call', 'archive', 'book', id),
    deleteBook: (id) => studioCall('shell:mybooks:deleteBook', id),
    linkProject: (bookId, projectId) => studioCall('shell:mybooks:call', 'linkProject', bookId, projectId),
    addFromMarket: (asins) => studioCall('shell:mybooks:addFromMarket', asins),
    list: () => studioCall('shell:mybooks:list'),
    book: (asin) => studioCall('shell:mybooks:book', asin),
    saveMarket: (asin) => studioCall('shell:mybooks:saveMarket', asin),
    saveFinance: (asin, o) => studioCall('shell:mybooks:saveFinance', asin, o),
    saveAll: (asin, o) => studioCall('shell:mybooks:saveAll', asin, o),
    openOnAmazon: (asin) => studioCall('shell:mybooks:openOnAmazon', asin),
    openIn: (module, asin) => studioCall('shell:mybooks:openIn', module, asin)
  },
  backup: {
    make: (o) => studioCall('shell:backup:make', o),
    inspect: () => studioCall('shell:backup:inspect'),
    restoreProject: (file, project, parentId) => studioCall('shell:backup:restoreProject', file, project, parentId),
    restoreAsStudio: (file, name) => studioCall('shell:backup:restoreAsStudio', file, name),
    findMdedit: () => studioCall('shell:backup:findMdedit'),
    importMdedit: (source, o) => studioCall('shell:backup:importMdedit', source, o)
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
  mcp: {
    get: () => ipcRenderer.invoke('shell:mcp:get'),
    set: (change) => studioCall('shell:mcp:set', change)
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
    forceDisconnect: () => studioCall('shell:market:forceDisconnect'),
    freePort: () => studioCall('shell:market:freePort')
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
    unlink: (module, ref, projectId) => studioCall('studio:unlink', module, ref, projectId),
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
