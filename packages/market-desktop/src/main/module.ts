/**
 * Cadrel Market's application logic as a hostable module: the library service, the local capture server, the dialogs and the
 * whole IPC surface. The standalone app (index.ts) and the Cadrel shell each create it with their own window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureExtensionCopy } from './extensionCopy';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents } from 'electron';
import { Logger } from './log.js';
import type { OutlineSource } from '@cadrel/market-library';
import { AppService, type McpBrand } from './service.js';
import { CHANNELS } from '../shared/api.js';

// Tests run the real app but must not open a real browser or a real folder dialog.
export const TEST = process.env.CADREL_TEST === '1';

export interface MarketHost {
  /** The window that owns Market's view (the shell window, or Market's own window when standalone). */
  getWindow(): BrowserWindow | null;
  /** Market's renderer. In the shell this is a view inside the window. */
  getContents(): WebContents | null;
  /** Where Market keeps config.json, the pairing token and logs. The MCP server reads <dataDir>/config.json. */
  dataDir: string;
  /** Directory holding the bundled mcp.mjs. */
  codeDir: string;
  /** Directory holding the bundled browser extension (an `extension` folder). */
  resourcesDir: string;
  iconFile(): string;
  version: string;
  /** Called just before the app quits so an installer can replace its files. */
  willQuit(): void;
  /**
   * Where the library goes when the person has not chosen one (Cadrel puts it at <Cadrel folder>/Market). When set, Market needs no first-run
   * choice of folder; the person can still move it in Settings.
   */
  defaultLibrary?: () => string;
  /** When set, the self-updater is off and shows this message (the shell is updated as a whole). */
  updatesDisabledReason?: string;
  /** The MCP server's name and the Claude Desktop extension's wording. Default: Cadrel Market's. */
  mcpBrand?: McpBrand;
  /** The pen names this Studio publishes under. Imports bring in only these authors' books, and My Books shows only them. Null: no limit. */
  authorScope?: () => readonly string[] | null;
  /** Where the person's outline documents are (Cadrel finds them in the projects), so keyword suggestions can be built on one. */
  outlines?: OutlineSource;
  /** How an AI app launches the MCP server. Default: Cadrel Market's own bundled server next to the code. */
  mcpLaunch?: () => { command: string; args: string[]; env: Record<string, string>; follow?: string };
}

export interface MarketModule {
  service: AppService;
  log: Logger;
  applySettings(): void;
  /** Registers IPC, wires the events to Market's renderer and starts the capture server. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createMarketModule(host: MarketHost): MarketModule {
  const log = new Logger(path.join(host.dataDir, 'logs'));
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

  const opened: string[] = [];
  const service = new AppService({
    userData: host.dataDir,
    updatesDisabledReason: host.updatesDisabledReason,
    authorScope: host.authorScope,
    outlines: host.outlines,
    openExternal: (url) => {
      // Amazon pages, the Google Trends comparison the keyword view builds, and Reddit threads shown in the community analysis; nothing else is opened on the user's behalf
      if (!/^https:\/\/www\.amazon\.com\//.test(url) && !/^https:\/\/trends\.google\.com\/trends\/explore\?/.test(url) && !/^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments\//.test(url)) throw new Error('refusing to open ' + url);
      if (TEST) opened.push(url);
      else return shell.openExternal(url);
    },
    revealInFolder: (p) => (TEST ? undefined : shell.showItemInFolder(p)),
    version: host.version,
    iconFile: () => host.iconFile(),
    secrets: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) },
    openRelease: (url) => (TEST ? void opened.push(url) : shell.openExternal(url)),
    // Only the installed Windows app can replace itself; elsewhere "Update now" explains and offers the release page.
    launchInstaller: process.platform === 'win32' || TEST
      ? (file) => {
          if (TEST) return void opened.push(file);
          spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
          host.willQuit();
          setTimeout(() => app.quit(), 500); // the installer cannot replace files this process still has open
        }
      : undefined,
    // The server is bundled next to the app code. Installed: the app's own Node runs it. Development: the system Node.
    mcpLaunch:
      host.mcpLaunch ??
      (() => ({
        command: app.isPackaged ? process.execPath : 'node',
        args: [path.join(host.codeDir, 'mcp.mjs')],
        env: (app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) as Record<string, string>,
      })),
    mcpBrand: host.mcpBrand,
  });

  function applySettings() {
    const st = service.settings();
    if (process.platform === 'win32' || process.platform === 'darwin') app.setLoginItemSettings({ openAtLogin: st.startWithWindows, args: ['--hidden'] });
  }

  async function chooseLibrary(): Promise<boolean> {
    if (TEST && process.env.CADREL_MARKET_TEST_LIBRARY) {
      await service.setLibrary(process.env.CADREL_MARKET_TEST_LIBRARY);
      return true;
    }
    const r = await dialog.showOpenDialog(host.getWindow()!, {
      title: 'Choose the Cadrel Market library folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return false;
    await service.setLibrary(r.filePaths[0]);
    return true;
  }

  async function pickFolder(title: string): Promise<string | null> {
    if (TEST && process.env.CADREL_MARKET_TEST_FOLDER) return process.env.CADREL_MARKET_TEST_FOLDER;
    const r = await dialog.showOpenDialog(host.getWindow()!, { title, properties: ['openDirectory', 'createDirectory'] });
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
    const name = `cadrel-market-data-${new Date().toISOString().slice(0, 10)}.pack`;
    let target: string;
    if (TEST && process.env.CADREL_MARKET_TEST_EXPORT_DIR) target = path.join(process.env.CADREL_MARKET_TEST_EXPORT_DIR, name);
    else {
      const r = await dialog.showSaveDialog(host.getWindow()!, { title: 'Save the data pack', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Cadrel Market data pack', extensions: ['pack'] }] });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    return service.exportData(target, categoryKeys);
  }

  async function importData() {
    let file: string | undefined;
    if (TEST && process.env.CADREL_MARKET_TEST_PACK) file = process.env.CADREL_MARKET_TEST_PACK;
    else {
      const r = await dialog.showOpenDialog(host.getWindow()!, { title: 'Choose a Cadrel Market data pack', properties: ['openFile'], filters: [{ name: 'Cadrel Market data pack', extensions: ['pack'] }] });
      file = r.canceled ? undefined : r.filePaths[0];
    }
    return file ? service.importData(file) : null;
  }

  async function attachManuscript(asin: string) {
    let file: string | undefined;
    if (TEST && process.env.CADREL_MARKET_TEST_MANUSCRIPT) file = process.env.CADREL_MARKET_TEST_MANUSCRIPT;
    else {
      const r = await dialog.showOpenDialog(host.getWindow()!, {
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
    if (TEST && process.env.CADREL_MARKET_TEST_EXPORT_DIR) target = path.join(process.env.CADREL_MARKET_TEST_EXPORT_DIR, filename);
    else {
      const r = await dialog.showSaveDialog(host.getWindow()!, { defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: kind === 'csv' ? 'Spreadsheet (CSV)' : 'Markdown report', extensions: [kind] }] });
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
    renameCategory: (c: string, n: string) => service.renameCategory(c, n),
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
    // Opened from a copy outside the install folder, so Chrome never holds the installed files open and an update is never blocked by it.
    openExtensionFolder: async () => shell.openPath(await ensureExtensionCopy(path.join(host.resourcesDir, 'extension'), path.join(host.dataDir, 'chrome-extension'))),
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
    keywordOutlines: (c: string) => service.keywordOutlines(c),
    setKeywordOutline: (c: string, ref: { project: string; file: string } | null) => service.setKeywordOutline(c, ref),
    injectedSuggestions: (c: string) => service.injectedSuggestions(c),
    dismissInjectedSuggestion: (id: number) => service.dismissInjectedSuggestion(id),
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
    stopCommunity: () => service.stopCommunity(),
    appInfo: () => service.appInfo(),
    updateState: () => service.updateState(),
    checkForUpdates: () => service.checkForUpdates(),
    installUpdate: () => service.installUpdate(),
    openReleasePage: () => service.openReleasePage(),
    githubTokenStatus: () => service.githubTokenStatus(),
    setGithubToken: (t: string | null) => service.setGithubToken(t),
    // The capture server's port: a retry after whatever was holding it (another app, an earlier run) lets go of it, or a
    // deliberate stop to free the port right away for something else.
    reconnect: () => service.reconnect(),
    forceDisconnect: () => service.forceDisconnect(),
    freePort: () => service.freePort(),
  };

  const send = (channel: string) => () => host.getContents()?.send(channel);

  async function start(): Promise<void> {
    // Keep the Chrome extension's copy outside the install folder current (see extensionCopy.ts); not needed for anything else to start.
    void ensureExtensionCopy(path.join(host.resourcesDir, 'extension'), path.join(host.dataDir, 'chrome-extension')).catch((e) => log.warn('could not refresh the extension copy', e));
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
    service.onCapture(send('capture'));
    service.onIndex(send('index'));
    service.onText(send('text'));
    service.onMaintenance(send('maintenance'));
    applySettings();
    if (host.defaultLibrary) service.useDefaultLibrary(host.defaultLibrary());
    await service.start();
    if (service.status().serverError) log.warn('ingest server:', service.status().serverError);
  }

  return { service, log, applySettings, start, stop: () => service.stop() };
}
