import { contextBridge, ipcRenderer } from 'electron';

// The sandboxed preload cannot import the shared list, so it keeps its own copy; test/preload.test.ts checks the two agree.
const channels = [
  'ready', 'ownBooks', 'openBook', 'salesStatus', 'moneyMonths', 'moneyAnalysis', 'moneyMonth', 'people', 'savePerson', 'deletePerson', 'bookSplit', 'allSplits', 'detectedAuthors', 'setBookSplit', 'statement', 'payments', 'paymentOwed', 'allocatePayment', 'unallocatePayment', 'exportPayment', 'payoutRollup', 'allocateRollup', 'exportRollup', 'payouts', 'recordPayout', 'deletePayout', 'removePayment', 'exportStatement', 'setFxRate', 'setKenpRate', 'importSales', 'importRanks', 'calibrationPreview', 'applyCalibration', 'setKenpc', 'setKuCompletion', 'resetCalibration', 'clearSalesData',
];

const api: Record<string, unknown> = {};
for (const ch of channels) api[ch] = (...args: unknown[]) => ipcRenderer.invoke(`finance:${ch}`, ...args);
api.onChange = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('finance:change', h);
  return () => ipcRenderer.off('finance:change', h);
};
if (process.env.CADREL_TEST === '1') api.__opened = () => ipcRenderer.invoke('finance:__opened');

contextBridge.exposeInMainWorld('cadrelFinance', api);
