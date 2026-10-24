import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { Logger } from './log.js';
import { AppService } from './service.js';
import { CHANNELS } from '../shared/api.js';

// The MCP server finds this app's settings by this name, so it must not depend on the package name.
app.setName('BookScout');

const here = path.dirname(fileURLToPath(import.meta.url));
// Tests run the real app but must not open a real browser or a real folder dialog.
const TEST = process.env.BOOKSCOUT_TEST === '1';
if (process.env.BOOKSCOUT_USER_DATA) app.setPath('userData', process.env.BOOKSCOUT_USER_DATA);

const log = new Logger(path.join(app.getPath('userData'), 'logs'));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
log.info('starting', app.getVersion(), process.platform, process.versions.electron);

// One BookScout at a time: a second copy would fight over the port and the library.
if (!TEST && !app.requestSingleInstanceLock()) {
  log.info('another instance is running; exiting');
  app.quit();
}

const opened: string[] = [];
const service = new AppService({
  userData: app.getPath('userData'),
  openExternal: (url) => {
    // Amazon pages, the Google Trends comparison the keyword view builds, and Reddit threads shown in the community analysis; nothing else is opened on the user's behalf
    if (!/^https:\/\/www\.amazon\.com\//.test(url) && !/^https:\/\/trends\.google\.com\/trends\/explore\?/.test(url) && !/^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments\//.test(url)) throw new Error('refusing to open ' + url);
    if (TEST) opened.push(url);
    else return shell.openExternal(url);
  },
  revealInFolder: (p) => (TEST ? undefined : shell.showItemInFolder(p)),
  version: app.getVersion(),
  iconFile: () => iconPath(),
  secrets: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) },
  openRelease: (url) => (TEST ? void opened.push(url) : shell.openExternal(url)),
  // Only the installed Windows app can replace itself; elsewhere "Update now" explains and offers the release page.
  launchInstaller: process.platform === 'win32' || TEST
    ? (file) => {
        if (TEST) return void opened.push(file);
        spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
        quitting = true;
        setTimeout(() => app.quit(), 500); // the installer cannot replace files this process still has open
      }
    : undefined,
  // The server is bundled next to the app code. Installed: the app's own Node runs it. Development: the system Node.
  mcpLaunch: () => ({
    command: app.isPackaged ? process.execPath : 'node',
    args: [path.join(here, 'mcp.mjs')],
    env: (app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) as Record<string, string>,
  }),
});

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

const resources = () => (app.isPackaged ? process.resourcesPath : path.resolve(here, '../..'));
const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.resolve(here, '../build/icon.png'));

function applySettings() {
  const st = service.settings();
  if (process.platform === 'win32' || process.platform === 'darwin') app.setLoginItemSettings({ openAtLogin: st.startWithWindows, args: ['--hidden'] });
}

function ensureTray() {
  if (tray || TEST) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  } catch (e) {
    log.warn('no tray icon', e);
    return;
  }
  tray.setToolTip('BookScout');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open BookScout', click: () => { win?.show(); win?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win?.show(); win?.focus(); });
}

/** The application menu: the standard menus plus About, beside Window. */
function buildMenu() {
  const showAbout = () => {
    if (!win) return;
    win.show();
    win.focus();
    win.webContents.send('navigate', 'about');
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { id: 'about-menu', label: 'About', submenu: [{ id: 'about', label: 'About BookScout', click: showAbout }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    title: 'BookScout',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', (_e, d) => log.error('renderer gone', d.reason));
  win.on('close', (e) => {
    if (quitting || TEST || !service.settings().keepRunningInTray) return;
    e.preventDefault(); // keep the ingest server alive so the extension can still send pages
    ensureTray();
    win?.hide();
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(here, 'renderer', 'index.html'));
}

async function chooseLibrary(): Promise<boolean> {
  if (TEST && process.env.BOOKSCOUT_TEST_LIBRARY) {
    await service.setLibrary(process.env.BOOKSCOUT_TEST_LIBRARY);
    return true;
  }
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose the BookScout library folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return false;
  await service.setLibrary(r.filePaths[0]);
  return true;
}

async function pickFolder(title: string): Promise<string | null> {
  if (TEST && process.env.BOOKSCOUT_TEST_FOLDER) return process.env.BOOKSCOUT_TEST_FOLDER;
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

async function backupLibrary(): Promise<string | null> {
  const dir = await pickFolder('Choose an empty folder for the backup');
  return dir ? service.backupTo(dir) : null;
}

async function moveLibrary(): Promise<string | null> {
  const dir = await pickFolder('Choose an empty folder to move the library to');
  return dir ? service.moveTo(dir) : null;
}

async function exportData(categoryKeys: string[] | null) {
  const name = `bookscout-data-${new Date().toISOString().slice(0, 10)}.pack`;
  let target: string;
  if (TEST && process.env.BOOKSCOUT_TEST_EXPORT_DIR) target = path.join(process.env.BOOKSCOUT_TEST_EXPORT_DIR, name);
  else {
    const r = await dialog.showSaveDialog(win!, { title: 'Save the data pack', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'BookScout data pack', extensions: ['pack'] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  return service.exportData(target, categoryKeys);
}

async function importData() {
  let file: string | undefined;
  if (TEST && process.env.BOOKSCOUT_TEST_PACK) file = process.env.BOOKSCOUT_TEST_PACK;
  else {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a BookScout data pack', properties: ['openFile'], filters: [{ name: 'BookScout data pack', extensions: ['pack'] }] });
    file = r.canceled ? undefined : r.filePaths[0];
  }
  return file ? service.importData(file) : null;
}

/** A page of HTML as a PDF, printed by a window that is never shown. */
async function htmlToPdf(html: string): Promise<Buffer> {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await w.webContents.printToPDF({ pageSize: 'Letter', printBackground: false, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
  } finally {
    w.destroy();
  }
}

async function exportStatement(from: string, to: string, kind: 'csv' | 'pdf', payee: string | null, basis: 'paid' | 'earned' = 'paid'): Promise<string | null> {
  const testDir = TEST ? process.env.BOOKSCOUT_TEST_EXPORT_DIR : undefined;
  if (kind === 'pdf' && payee === null) {
    // one PDF per author, in a folder the user picks
    const s = service.statement(from, to, basis);
    const dir = testDir ?? (await pickFolder('Choose a folder for the statements'));
    if (!dir) return null;
    for (const p of s.payees) {
      const f = service.statementFile(from, to, 'html', p.name, basis);
      fs.writeFileSync(path.join(dir, f.filename), await htmlToPdf(f.content));
    }
    return dir;
  }
  const f = service.statementFile(from, to, kind === 'csv' ? 'csv' : 'html', payee, basis);
  let target: string;
  if (testDir) target = path.join(testDir, f.filename);
  else {
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('documents'), f.filename), filters: [{ name: kind === 'csv' ? 'Spreadsheet (CSV)' : 'PDF', extensions: [kind] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, kind === 'csv' ? f.content : await htmlToPdf(f.content));
  if (!TEST) shell.showItemInFolder(target);
  return target;
}

/** Write a generated file (CSV, or a PDF printed from HTML) where the user chooses; `many` writes one PDF per author into a chosen folder. */
async function saveGenerated(kind: 'csv' | 'pdf', make: (payee: string | null) => { filename: string; content: string }, payee: string | null, everyone: () => string[]): Promise<string | null> {
  const testDir = TEST ? process.env.BOOKSCOUT_TEST_EXPORT_DIR : undefined;
  if (kind === 'pdf' && payee === null) {
    const dir = testDir ?? (await pickFolder('Choose a folder for the statements'));
    if (!dir) return null;
    for (const name of everyone()) { const f = make(name); fs.writeFileSync(path.join(dir, f.filename), await htmlToPdf(f.content)); }
    return dir;
  }
  const f = make(payee);
  let target: string;
  if (testDir) target = path.join(testDir, f.filename);
  else {
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('documents'), f.filename), filters: [{ name: kind === 'csv' ? 'Spreadsheet (CSV)' : 'PDF', extensions: [kind] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, kind === 'csv' ? f.content : await htmlToPdf(f.content));
  if (!TEST) shell.showItemInFolder(target);
  return target;
}

const exportPayment = (number: string, kind: 'csv' | 'pdf', payee: string | null) =>
  saveGenerated(kind, (p) => service.paymentFile(number, kind === 'csv' ? 'csv' : 'html', p), payee, () => service.paymentOwed(number).payees.map((p) => p.name));
const exportRollup = (from: string, to: string, kind: 'csv' | 'pdf', payee: string | null) =>
  saveGenerated(kind, (p) => service.rollupFile(from, to, kind === 'csv' ? 'csv' : 'html', p), payee, () => service.payoutRollup(from, to).payees.filter((p) => p.due || p.owed || p.carriedIn).map((p) => p.name));

async function attachManuscript(asin: string) {
  let file: string | undefined;
  if (TEST && process.env.BOOKSCOUT_TEST_MANUSCRIPT) file = process.env.BOOKSCOUT_TEST_MANUSCRIPT;
  else {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the book file (PDF, EPUB, Word or text)',
      properties: ['openFile'],
      filters: [{ name: 'Books and documents', extensions: ['pdf', 'epub', 'docx', 'txt', 'md'] }],
    });
    file = r.canceled ? undefined : r.filePaths[0];
  }
  return file ? service.attachManuscriptPath(asin, file) : null;
}

async function exportCategory(categoryKey: string, kind: 'csv' | 'md', topN: number): Promise<string | null> {
  const { filename, content } = await service.exportContent(categoryKey, kind, topN);
  let target: string;
  if (TEST && process.env.BOOKSCOUT_TEST_EXPORT_DIR) target = path.join(process.env.BOOKSCOUT_TEST_EXPORT_DIR, filename);
  else {
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: kind === 'csv' ? 'Spreadsheet (CSV)' : 'Markdown report', extensions: [kind] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, content);
  return target;
}

const handlers: Record<string, (...a: any[]) => unknown> = {
  status: () => service.status(),
  chooseLibrary,
  setPort: (p: number) => service.setPort(p),
  token: () => service.token(),
  rotateToken: () => service.rotateToken(),
  categories: () => service.categories(),
  books: (o) => service.books(o),
  book: (a: string) => service.book(a),
  cover: (a: string) => service.cover(a),
  issues: () => service.issues(),
  queue: (o) => service.queue(o),
  openNext: (c?: string) => service.openNext(c),
  openBook: (a: string) => service.openBook(a),
  openShelf: (k: string) => service.openShelf(k),
  setQueueState: (a: string, s) => service.setQueueState(a, s),
  excludeFromCategory: (a: string, c: string) => service.excludeFromCategory(a, c),
  restoreToCategory: (a: string, c: string) => service.restoreToCategory(a, c),
  categoryExclusions: (c?: string) => service.categoryExclusions(c),
  bookLists: (a: string) => service.bookLists(a),
  removeBook: (a: string, x?: boolean) => service.removeBook(a, x),
  revealBook: (a: string) => service.revealBook(a),
  rebuild: () => service.rebuild(),
  maintenanceStatus: () => service.maintenanceStatus(),
  verifyLibrary: () => service.verifyLibrary(),
  parserHealth: () => service.parserHealth(),
  backupLibrary,
  moveLibrary,
  exportData,
  importData,
  pairingCode: () => service.pairingCode(),
  openExtensionFolder: () => shell.openPath(path.join(resources(), 'extension')),
  openLogs: async () => void (TEST ? undefined : shell.showItemInFolder(log.file)),
  settings: () => service.settings(),
  setSettings: (s) => {
    const r = service.setSettings(s);
    applySettings();
    return r;
  },
  analysis: (k: string, n: number) => service.analysis(k, n),
  exportCategory,
  successWeights: () => service.successWeights(),
  setSuccessWeights: (w) => service.setSuccessWeights(w),
  rankCategories: (n: number) => service.rankCategories(n),
  opportunityWeights: () => service.opportunityWeights(),
  setOpportunityWeights: (w) => service.setOpportunityWeights(w),
  salesCurve: () => service.salesCurve(),
  setSalesCurve: (c) => service.setSalesCurve(c),
  bookText: (a: string) => service.bookText(a),
  attachManuscript,
  attachManuscriptPath: (a: string, f: string) => service.attachManuscriptPath(a, f),
  removeText: (a: string, s) => service.removeText(a, s),
  readSample: (a: string, s?: string) => service.readSample(a, s),
  indexStatus: () => service.indexStatus(),
  buildIndex: (k: 'neural' | 'basic') => service.buildIndex(k),
  mcpConfig: () => service.mcpConfig(),
  installClaudeExtension: async () => {
    const { file } = await service.buildClaudeExtension();
    if (TEST) return (opened.push(file), { file, error: null });
    // Not opened for the user: a .mcpb is only handed to Claude Desktop where it has registered the type, and elsewhere the OS offers a list of
    // programs and Claude then attaches the file to a chat instead of installing it. Show it in its folder; the steps are on screen.
    shell.showItemInFolder(file);
    return { file, error: null };
  },
  communitySources: (c: string) => service.communitySources(c),
  addCommunitySource: (c: string, s: string) => service.addCommunitySource(c, s),
  removeCommunitySource: (c: string, s: string) => service.removeCommunitySource(c, s),
  syncCommunity: (c: string, s?: string) => service.syncCommunity(c, s),
  communityStatus: () => service.communityStatus(),
  keywordTable: (s: string, c?: string) => service.keywordTable(s, c),
  keywordLookup: (s: string, o) => service.keywordLookup(s, o),
  keywordStatus: () => service.keywordStatus(),
  keywordHistory: (c?: string) => service.keywordHistory(c),
  removeKeywordHistory: (s: string) => service.removeKeywordHistory(s),
  clearKeywordHistory: () => service.clearKeywordHistory(),
  keywordIdeas: (c: string, asin?: string) => service.keywordIdeas(c, asin),
  keywordStrings: (c: string, asin?: string) => service.keywordStrings(c, asin),
  stopKeywords: () => service.stopKeywords(),
  importTrends: (csv: string, c?: string) => service.importTrends(csv, c),
  removeTrend: (k: string) => service.removeTrend(k),
  openTrends: (t: string[]) => service.openTrends(t),
  openAmazonSearch: (k: string) => service.openAmazonSearch(k),
  communityInsights: (c: string) => service.communityInsights(c),
  openThread: (u: string) => service.openThread(u),
  ownBooks: () => service.ownBooks(),
  ownBook: (a: string) => service.ownBook(a),
  setOwnBook: (a: string, own: boolean) => service.setOwnBook(a, own),
  salesStatus: () => service.salesStatus(),
  moneyMonths: () => service.moneyMonths(),
  moneyAnalysis: (f: string, t: string) => service.moneyAnalysis(f, t),
  moneyMonth: (m: string) => service.moneyMonth(m),
  people: () => service.people(),
  savePerson: (p) => service.savePerson(p),
  deletePerson: (id: number) => service.deletePerson(id),
  bookSplit: (a: string) => service.bookSplit(a),
  allSplits: () => service.allSplits(),
  detectedAuthors: () => service.detectedAuthors(),
  setBookSplit: (a: string, s, m?: string) => service.setBookSplit(a, s, m),
  statement: (f: string, t: string, b: 'paid' | 'earned') => service.statement(f, t, b),
  payments: () => service.payments(),
  removePayment: (n: string) => service.removePayment(n),
  paymentOwed: (n: string) => service.paymentOwed(n),
  allocatePayment: (n: string) => service.allocatePayment(n),
  unallocatePayment: (n: string) => service.unallocatePayment(n),
  exportPayment,
  payoutRollup: (f: string, t: string) => service.payoutRollup(f, t),
  allocateRollup: (f: string, t: string) => service.allocateRollup(f, t),
  exportRollup,
  payouts: () => service.payouts(),
  recordPayout: (p) => service.recordPayout(p),
  deletePayout: (id: number) => service.deletePayout(id),
  exportStatement,
  setFxRate: (m: string, c: string, r: number | null) => service.setFxRate(m, c, r),
  setKenpRate: (m: string, c: string, r: number | null) => service.setKenpRate(m, c, r),
  importSales: (n: string, b: Uint8Array) => service.importSales(n, b),
  importRanks: (n: string, b: Uint8Array, a?: string) => service.importRanks(n, b, a),
  calibrationPreview: (o) => service.calibrationPreview(o),
  applyCalibration: (o) => service.applyCalibration(o),
  setKenpc: (a: string, k: number | null) => service.setKenpc(a, k),
  setKuCompletion: (s: number) => service.setKuCompletion(s),
  resetCalibration: () => service.resetCalibration(),
  clearSalesData: () => service.clearSalesData(),
  stopCommunity: () => service.stopCommunity(),
  appInfo: () => service.appInfo(),
  updateState: () => service.updateState(),
  checkForUpdates: () => service.checkForUpdates(),
  installUpdate: () => service.installUpdate(),
  openReleasePage: () => service.openReleasePage(),
  githubTokenStatus: () => service.githubTokenStatus(),
  setGithubToken: (t: string | null) => service.setGithubToken(t),
};

app.whenReady().then(async () => {
  for (const ch of CHANNELS) {
    ipcMain.handle(ch, async (_e, ...args) => {
      try {
        return await handlers[ch]!(...args);
      } catch (e) {
        log.error(`ipc ${ch} failed`, e);
        throw e;
      }
    });
  }
  if (TEST) ipcMain.handle('__opened', () => opened);
  service.onCapture(() => win?.webContents.send('capture'));
  service.onIndex(() => win?.webContents.send('index'));
  service.onText(() => win?.webContents.send('text'));
  service.onMaintenance(() => win?.webContents.send('maintenance'));
  applySettings();
  await service.start();
  if (service.status().serverError) log.warn('ingest server:', service.status().serverError);
  buildMenu();
  createWindow();
  if (process.argv.includes('--hidden') && service.settings().keepRunningInTray) {
    ensureTray();
    win?.hide();
  }
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  void service.stop().then(() => app.quit());
});
