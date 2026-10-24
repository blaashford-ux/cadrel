import { contextBridge, ipcRenderer, webUtils } from 'electron';

const channels = [
  'status', 'chooseLibrary', 'setPort', 'token', 'rotateToken', 'categories', 'books', 'book', 'cover', 'issues',
  'queue', 'openNext', 'openBook', 'openShelf', 'setQueueState', 'excludeFromCategory', 'restoreToCategory', 'categoryExclusions', 'bookLists', 'removeBook', 'revealBook', 'rebuild', 'analysis', 'exportCategory', 'successWeights', 'setSuccessWeights', 'rankCategories', 'opportunityWeights', 'setOpportunityWeights', 'salesCurve', 'setSalesCurve', 'maintenanceStatus', 'verifyLibrary', 'parserHealth', 'backupLibrary', 'moveLibrary', 'exportData', 'importData', 'pairingCode', 'openExtensionFolder', 'openLogs', 'settings', 'setSettings', 'bookText', 'attachManuscript', 'attachManuscriptPath', 'removeText', 'readSample', 'indexStatus', 'buildIndex', 'mcpConfig', 'installClaudeExtension', 'appInfo', 'communitySources', 'addCommunitySource', 'removeCommunitySource', 'syncCommunity', 'communityStatus', 'stopCommunity', 'keywordTable', 'keywordLookup', 'keywordStatus', 'keywordHistory', 'removeKeywordHistory', 'clearKeywordHistory', 'keywordIdeas', 'keywordStrings', 'stopKeywords', 'importTrends', 'removeTrend', 'openTrends', 'openAmazonSearch', 'communityInsights', 'openThread', 'ownBooks', 'ownBook', 'setOwnBook', 'salesStatus', 'moneyMonths', 'moneyAnalysis', 'moneyMonth', 'people', 'savePerson', 'deletePerson', 'bookSplit', 'allSplits', 'detectedAuthors', 'setBookSplit', 'statement', 'payments', 'removePayment', 'paymentOwed', 'allocatePayment', 'unallocatePayment', 'exportPayment', 'payoutRollup', 'allocateRollup', 'exportRollup', 'payouts', 'recordPayout', 'deletePayout', 'exportStatement', 'setFxRate', 'setKenpRate', 'importSales', 'importRanks', 'calibrationPreview', 'applyCalibration', 'setKenpc', 'setKuCompletion', 'resetCalibration', 'clearSalesData', 'updateState', 'checkForUpdates', 'installUpdate', 'openReleasePage', 'githubTokenStatus', 'setGithubToken',
];

const api: Record<string, unknown> = {};
for (const ch of channels) api[ch] = (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
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
if (process.env.BOOKSCOUT_TEST === '1') api.__opened = () => ipcRenderer.invoke('__opened');

contextBridge.exposeInMainWorld('bookscout', api);
