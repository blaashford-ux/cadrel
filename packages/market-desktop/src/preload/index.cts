import { contextBridge, ipcRenderer, webUtils } from 'electron';

const channels = [
  'status', 'chooseLibrary', 'setPort', 'token', 'rotateToken', 'categories', 'books', 'book', 'cover', 'issues',
  'queue', 'openNext', 'openBook', 'openShelf', 'setQueueState', 'excludeFromCategory', 'restoreToCategory', 'renameCategory', 'categoryExclusions', 'bookLists', 'removeBook', 'revealBook', 'rebuild', 'analysis', 'exportCategory', 'successWeights', 'setSuccessWeights', 'rankCategories', 'opportunityWeights', 'setOpportunityWeights', 'salesCurve', 'setSalesCurve', 'maintenanceStatus', 'verifyLibrary', 'parserHealth', 'backupLibrary', 'moveLibrary', 'exportData', 'importData', 'pairingCode', 'openExtensionFolder', 'openLogs', 'settings', 'setSettings', 'bookText', 'attachManuscript', 'attachManuscriptPath', 'removeText', 'readSample', 'indexStatus', 'buildIndex', 'mcpConfig', 'installClaudeExtension', 'appInfo', 'communitySources', 'addCommunitySource', 'removeCommunitySource', 'syncCommunity', 'communityStatus', 'stopCommunity', 'keywordTable', 'keywordLookup', 'keywordStatus', 'keywordHistory', 'removeKeywordHistory', 'clearKeywordHistory', 'keywordIdeas', 'keywordStrings', 'keywordOutlines', 'setKeywordOutline', 'injectedSuggestions', 'dismissInjectedSuggestion', 'stopKeywords', 'importTrends', 'removeTrend', 'openTrends', 'openAmazonSearch', 'communityInsights', 'openThread', 'ownBooks', 'ownBook', 'setOwnBook', 'updateState', 'checkForUpdates', 'installUpdate', 'openReleasePage', 'githubTokenStatus', 'setGithubToken', 'reconnect', 'forceDisconnect', 'freePort',
];

const api: Record<string, unknown> = {};
for (const ch of channels) api[ch] = (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
// Notes on a record, when Cadrel hosts this page: its shell keeps them with the studio's projects. A standalone Cadrel Market
// has no such handler, so `available` says no and the page shows no Notes button.
const host = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(`host:notes:${ch}`, ...args);
api.hostNotes = {
  available: () => ipcRenderer.invoke('host:notes:available').then(() => true, () => false),
  list: host('list'),
  add: host('add'),
  setStatus: host('status'),
  reply: host('reply'),
  remove: host('remove')
};
api.onCapture = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('capture', h);
  return () => ipcRenderer.off('capture', h);
};
api.onNavigate = (cb: (page: string) => void) => {
  const h = (_e: unknown, page: string) => cb(page);
  ipcRenderer.on('navigate', h);
  return () => ipcRenderer.off('navigate', h);
};
api.onMaintenance = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('maintenance', h);
  return () => ipcRenderer.off('maintenance', h);
};
api.onText = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('text', h);
  return () => ipcRenderer.off('text', h);
};
// A dropped File object has no path in the page; the preload can ask Electron for it.
api.pathForFile = (f: File) => webUtils.getPathForFile(f);
api.onIndex = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('index', h);
  return () => ipcRenderer.off('index', h);
};
if (process.env.CADREL_TEST === '1') api.__opened = () => ipcRenderer.invoke('__opened');

contextBridge.exposeInMainWorld('cadrelMarket', api);
