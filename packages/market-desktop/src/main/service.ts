import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import {
  ArcticShift, addCommunitySource, listCommunitySources, removeCommunitySource, syncSubreddit, type CommunitySource, type SyncResult,
  copyLibrary, exportPack, importPack, parserHealth, verifyLibrary, HashingEmbedder, analyzeCovers, contentMetricsOf, getManuscripts, readSampleOcr, readSamplePage, sampleSessions, saveSampleOcr, categoryCsv, categoryReport, getWeights, reportMarkdown, setWeights, getOpportunityWeights, setOpportunityWeights, getSalesCurve, setSalesCurve, rankCategories, type OpportunityWeights, type SalesCurve, type Weights, embedPending, embeddingStatus, type Embedder,
  applyCalibration, analysisReport, monthReport, reportMonths, listPeople, savePerson, deletePerson, splitHistory, setSplit, paymentOwed, allocatePayment, unallocatePayment, allocateRollup, payoutRollup, recordPayout, deletePayout, listPayouts, rollupCsv, rollupHtml, type Payout, type PaymentOwed, type Rollup, paymentsReport, removePayment, type PaymentsReport, type StatementBasis, detectedAuthors, type DetectedAuthor, royaltyStatement, statementCsv, statementHtml, setFxRate, clearFxRate, setKenpRate, type AnalysisReport, type MonthReport, type Person, type SplitVersion, type Statement, calibrationPreview, clearSalesData, categoryUrl, clearKeywordHistory, listKeywordHistory, recordKeywordSearch, removeKeywordHistory, suggestKeywords, suggestKeywordStrings, type KeywordHistoryRow, type KeywordIdea, type KeywordString, communityInsights, resolveCategory, type CommunityInsights, getOwnBook, listOwnBooks, setOwnBook, type OwnBookRow, getCompletion, setCompletion, setKenpc, importRankFile, importSalesFile, resetCalibration, salesStatus, type CalibrationPreview, type ImportSummary, type SalesStatus,
  SUGGEST_SOURCES, importTrendsCsv, keywordTable, lookupSuggestions, removeTrend, trendsUrl, type KeywordTable, type SuggestSource,
  Library, amazonUrl, getBook, listBooks, listCategories, listExclusions, listedIn, listIssues, nextInQueue, queue,
  type BookDetail, type QueueItem, type RemovedBook,
} from '@cadrel/market-library';
import { DEFAULT_PORT, loadOrCreateToken, rotateToken, startIngestServer, type SampleLogEvent } from '@cadrel/market-server';
import { Logger } from './log.js';
import { launcherSource, readHandshake, type Handshake } from './launcher.js';
import { RELEASE_REPO, checkForUpdate, downloadInstaller, type UpdateInfo } from './updater.js';
import type { AppSettings, BookText, CommunityJob, IndexStatus, KeywordJob, KeywordLookupResult, MaintenanceStatus, IssueRow, McpSnippets, Status, TextJob } from '../shared/api.js';

interface Config {
  libraryRoot: string | null;
  port: number;
  settings: AppSettings;
}

const DEFAULT_SETTINGS: AppSettings = { keepRunningInTray: true, startWithWindows: false, suggestAmazon: true, suggestGoogle: true, suggestBing: true };

export function assertPaymentNumber(n: unknown): asserts n is string {
  if (typeof n !== 'string' || !/^\d{3,30}$/.test(n)) throw new Error('bad payment number');
}

function assertBasis(b: unknown): asserts b is StatementBasis {
  if (b !== 'paid' && b !== 'earned') throw new Error('bad statement basis');
}

function assertMonths(from: string, to: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(to) || from > to) throw new Error('bad period');
}

function assertAsin(asin: unknown): asserts asin is string {
  if (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin)) throw new Error('bad ASIN');
}

function assertSession(s: unknown): asserts s is string {
  if (typeof s !== 'string' || !/^\d{8}T\d{6}Z$/.test(s)) throw new Error('bad session id');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks whatever is listening on `port` whether it is a Cadrel Market capture server, so a bind failure can say who is
 * actually holding the port instead of just "in use". Never throws or hangs: an unreachable or non-conforming
 * responder resolves to `{ sameApp: false }` within `timeoutMs`.
 */
function probeCaptureServer(port: number, token: string, timeoutMs = 500): Promise<{ sameApp: boolean; sameToken: boolean }> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/v1/ping', timeout: timeoutMs, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(body); } catch { json = null; }
        const j = json as { ok?: unknown; app?: unknown; error?: unknown } | null;
        if (res.statusCode === 200 && j?.ok === true && j.app === 'cadrel-market') resolve({ sameApp: true, sameToken: true });
        else if (res.statusCode === 401 && j?.error === 'bad token') resolve({ sameApp: true, sameToken: false });
        else resolve({ sameApp: false, sameToken: false });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ sameApp: false, sameToken: false }); });
    req.on('error', () => resolve({ sameApp: false, sameToken: false }));
  });
}

export interface ServiceOptions {
  /** Folder for settings and the pairing token (not the library). */
  userData: string;
  /** Opens a URL in the user's browser. */
  openExternal: (url: string) => void | Promise<void>;
  revealInFolder: (p: string) => void;
  /** How an MCP client should launch the server. */
  mcpLaunch?: () => { command: string; args: string[]; env: Record<string, string> };
  /** Builds the local neural embedder; defaults to the real one. Overridable in tests. */
  /** Test hook: stands in for OCR so tests need not run the real engine. */
  ocrFactory?: () => Promise<{ recognize(image: Buffer, crop?: { left: number; top: number; width: number; height: number }): Promise<{ text: string; confidence: number }>; close(): Promise<void> }>;
  neuralEmbedder?: (cacheDir: string, onDownload: (percent: number) => void) => Promise<Embedder>;
  /** The app's version (Electron's app.getVersion()). */
  version?: string;
  /** OS-level encryption for the GitHub token (Electron's safeStorage). Without it the token is not stored at all. */
  secrets?: { available(): boolean; encrypt(s: string): Buffer; decrypt(b: Buffer): string };
  /** Runs a downloaded installer and closes the app. Not set where updating in place is unsupported. */
  launchInstaller?: (file: string) => void | Promise<void>;
  /** When set, Cadrel Market does not check its own releases and shows this instead (a host app updates as a whole). */
  updatesDisabledReason?: string;
  /** Opens a release page in the browser. */
  openRelease?: (url: string) => void | Promise<void>;
  /** Test hook: stands in for the network. */
  fetch?: typeof fetch;
  /** The app icon, shown in Claude Desktop's extension list. */
  iconFile?: () => string | null;
  /** Test hook: what the MCP server answers to `initialize`; by default it is read from the server (`--print-handshake`). */
  mcpHandshake?: () => Promise<Handshake | null>;
  /** The MCP server's name and the extension's wording. Default: Cadrel Market's. */
  mcpBrand?: McpBrand;
  /** Pause between autocomplete requests, in ms; tests set 0. */
  keywordDelayMs?: number;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string | null;
  platform: string;
  repo: string;
  dataFolder: string;
  logsFolder: string;
  libraryRoot: string | null;
  /** True where the installer can be run from inside the app. */
  canInstall: boolean;
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'launching' | 'error';
  info: UpdateInfo | null;
  progress: { done: number; total: number } | null;
  error: string | null;
}

export interface TokenStatus {
  saved: boolean;
  /** False where the system cannot encrypt the token, so it cannot be saved. */
  canSave: boolean;
  /** The token comes from the CADREL_MARKET_GITHUB_TOKEN environment variable. */
  fromEnvironment: boolean;
}

/** What the MCP server is called in settings and in the Claude Desktop extension. A host app that carries one server for several modules passes its own. */
export interface McpBrand {
  /** The server's name in settings: "cadrel-market", "cadrel". */
  id: string;
  /** Display name: "Cadrel Market", "Cadrel". */
  name: string;
  /** What the Claude Desktop extension says it does. */
  description: string;
  /** The extension file's name. */
  file: string;
}
export const MARKET_BRAND: McpBrand = {
  id: 'cadrel-market',
  name: 'Cadrel Market',
  description: 'Search and analyse the Kindle categories, books, reviews, texts and Reddit threads in your Cadrel Market library.',
  file: 'Cadrel Market.mcpb'
};

export function buildMcpSnippets(launch: { command: string; args: string[]; env: Record<string, string> }, id = 'cadrel-market'): McpSnippets {
  const entry: Record<string, unknown> = { command: launch.command, args: launch.args };
  if (Object.keys(launch.env).length) entry.env = launch.env;
  const q = (s: string) => JSON.stringify(s);
  const envFlags = Object.entries(launch.env).map(([k, v]) => `-e ${k}=${v} `).join('');
  return {
    ...launch,
    claudeDesktop: JSON.stringify({ mcpServers: { [id]: entry } }, null, 2),
    claudeCode: `claude mcp add ${id} ${envFlags}-- ${[launch.command, ...launch.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}`,
    codex: [`[mcp_servers.${id}]`, `command = ${q(launch.command)}`, `args = [${launch.args.map(q).join(', ')}]`, ...(Object.keys(launch.env).length ? [`env = { ${Object.entries(launch.env).map(([k, v]) => `${k} = ${q(v)}`).join(', ')} }`] : [])].join('\n'),
  };
}

/** All app logic that is not UI. Has no Electron imports so it can be tested in plain Node. */
export class AppService {
  private config: Config;
  private lib: Library | null = null;
  private server: Awaited<ReturnType<typeof startIngestServer>> | null = null;
  private serverError: string | null = null;
  private listeners = new Set<() => void>();
  private indexListeners = new Set<() => void>();
  private textListeners = new Set<() => void>();
  private maintListeners = new Set<() => void>();
  private maint: MaintenanceStatus = { kind: null, done: 0, total: 0, error: null, message: null };
  private pairing: { code: string; expiresAt: number } | null = null;
  private textJob: (TextJob & { promise: Promise<void> }) | null = null;
  private textError: string | null = null;
  private indexJob: Promise<void> | null = null;
  private indexProgress: IndexStatus['progress'] = null;
  private indexError: string | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private communityJob: CommunityJob | null = null;
  private communityAbort: AbortController | null = null;
  private keywordJob: KeywordJob | null = null;
  private keywordAbort: AbortController | null = null;

  constructor(private readonly opts: ServiceOptions) {
    this.config = this.readConfig();
  }

  // ---- about, and updating from the latest GitHub release -------------------------------------------------------------

  private _updateLog: Logger | null = null;
  private ulog(level: 'info' | 'warn' | 'error', ...a: unknown[]) {
    (this._updateLog ??= new Logger(path.join(this.opts.userData, 'logs'), 'updates'))[level](...a);
  }
  private update: UpdateState = { phase: 'idle', info: null, progress: null, error: null };

  appInfo(): AppInfo {
    return {
      name: 'Cadrel Market',
      version: this.opts.version ?? '0.0.0',
      electron: process.versions.electron ?? null,
      platform: `${process.platform} ${process.arch}`,
      repo: RELEASE_REPO,
      dataFolder: this.opts.userData,
      logsFolder: path.join(this.opts.userData, 'logs'),
      libraryRoot: this.config.libraryRoot,
      canInstall: !!this.opts.launchInstaller,
    };
  }

  private get tokenFileEnc() {
    return path.join(this.opts.userData, 'github-token.bin');
  }

  private githubToken(): string | null {
    const env = process.env.CADREL_MARKET_GITHUB_TOKEN?.trim();
    if (env) return env;
    try {
      const sec = this.opts.secrets;
      if (!sec?.available() || !fs.existsSync(this.tokenFileEnc)) return null;
      return sec.decrypt(fs.readFileSync(this.tokenFileEnc));
    } catch (e) {
      this.ulog('warn', 'could not read the saved GitHub token', (e as Error).message);
      return null;
    }
  }

  githubTokenStatus(): TokenStatus {
    return { saved: fs.existsSync(this.tokenFileEnc), canSave: !!this.opts.secrets?.available(), fromEnvironment: !!process.env.CADREL_MARKET_GITHUB_TOKEN?.trim() };
  }

  /** Save (or, with null, remove) a read-only GitHub token used to see releases of a private repository. */
  setGithubToken(token: string | null): TokenStatus {
    if (token === null || token.trim() === '') {
      fs.rmSync(this.tokenFileEnc, { force: true });
      this.ulog('info', 'GitHub token removed');
      return this.githubTokenStatus();
    }
    const t = token.trim();
    if (!/^[A-Za-z0-9_-]{20,255}$/.test(t)) throw new Error('That does not look like a GitHub token (letters, digits, "_" and "-" only).');
    const sec = this.opts.secrets;
    if (!sec?.available()) throw new Error('This computer cannot encrypt the token, so Cadrel Market will not store it. Set the CADREL_MARKET_GITHUB_TOKEN environment variable instead.');
    fs.mkdirSync(this.opts.userData, { recursive: true });
    fs.writeFileSync(this.tokenFileEnc, sec.encrypt(t), { mode: 0o600 });
    this.ulog('info', 'GitHub token saved (encrypted)');
    return this.githubTokenStatus();
  }

  updateState(): UpdateState {
    return { ...this.update };
  }

  /** Ask GitHub for the latest release. Never throws: problems are in the returned state. */
  async checkForUpdates(): Promise<UpdateState> {
    if (this.opts.updatesDisabledReason) {
      this.update = { phase: 'error', info: null, progress: null, error: this.opts.updatesDisabledReason };
      return this.updateState();
    }
    if (this.update.phase === 'checking' || this.update.phase === 'downloading' || this.update.phase === 'launching') return this.updateState();
    this.update = { phase: 'checking', info: this.update.info, progress: null, error: null };
    try {
      const info = await checkForUpdate(this.opts.version ?? '0.0.0', { token: this.githubToken(), fetch: this.opts.fetch });
      this.update = { phase: info.updateAvailable ? 'available' : 'current', info, progress: null, error: null };
      this.ulog('info', `checked: running ${info.current}, latest ${info.latest}${info.updateAvailable ? ' (update available)' : ''}, installer ${info.installer ? `${info.installer.name} ${info.installer.size} bytes` : 'none in release'}`);
    } catch (e) {
      this.update = { phase: 'error', info: null, progress: null, error: (e as Error).message ?? String(e) };
      this.ulog('error', 'update check failed:', this.update.error);
    }
    return this.updateState();
  }

  /** Download the installer from the release found by the last check, then run it; the app closes when it starts. */
  async installUpdate(): Promise<UpdateState> {
    const info = this.update.info;
    if (this.update.phase === 'downloading' || this.update.phase === 'launching') return this.updateState();
    if (!info?.updateAvailable || !info.installer) {
      this.update = { phase: 'error', info, progress: null, error: !info?.updateAvailable ? 'Check for updates first.' : 'This release has no Windows installer attached; open the release page instead.' };
      return this.updateState();
    }
    if (!this.opts.launchInstaller) {
      this.update = { phase: 'error', info, progress: null, error: 'Installing updates from inside the app is only available in the installed Windows app. Open the release page to download it.' };
      return this.updateState();
    }
    this.update = { phase: 'downloading', info, progress: { done: 0, total: info.installer.size }, error: null };
    try {
      const dir = path.join(this.opts.userData, 'updates');
      for (const old of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(path.join(dir, old), { force: true }); // earlier installers and partial downloads
      this.ulog('info', `downloading ${info.installer.name} (${info.installer.size} bytes)`);
      const file = await downloadInstaller(info.installer, {
        token: this.githubToken(), dir, fetch: this.opts.fetch,
        onProgress: (done, total) => void (this.update = { ...this.update, progress: { done, total } }),
      });
      this.ulog('info', `downloaded and verified ${file}; starting the installer`);
      this.update = { phase: 'launching', info, progress: null, error: null };
      await this.opts.launchInstaller(file);
    } catch (e) {
      this.update = { phase: 'error', info, progress: null, error: (e as Error).message ?? String(e) };
      this.ulog('error', 'update failed:', this.update.error);
    }
    return this.updateState();
  }

  async openReleasePage(): Promise<void> {
    const url = this.update.info?.releaseUrl;
    if (!url || !url.startsWith(`https://github.com/${RELEASE_REPO}/releases/`)) throw new Error('Check for updates first.');
    await this.opts.openRelease?.(url);
  }

  /** logs/sample-capture.log in the app's data folder: what the extension saw, what the app received, what OCR made of it. */
  private _sampleLog: Logger | null = null;
  get sampleLogFile(): string {
    return (this._sampleLog ??= new Logger(path.join(this.opts.userData, 'logs'), 'sample-capture')).file;
  }
  private slog(level: 'info' | 'warn' | 'error', source: 'extension' | 'app', asin: string | null, session: string | null, event: string, detail = ''): void {
    this.sampleLogFile;
    const who = asin ? `[${asin}${session ? ' ' + session : ''}]` : '[-]';
    this._sampleLog![level](`${who} ${source}: ${event}${detail ? ' | ' + detail : ''}`);
  }

  private get configFile() {
    return path.join(this.opts.userData, 'config.json');
  }
  private get tokenFile() {
    return path.join(this.opts.userData, 'token');
  }

  private readConfig(): Config {
    try {
      const c = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as Partial<Config>;
      return { libraryRoot: typeof c.libraryRoot === 'string' ? c.libraryRoot : null, port: Number(c.port) || DEFAULT_PORT, settings: { ...DEFAULT_SETTINGS, ...(c.settings ?? {}) } };
    } catch {
      return { libraryRoot: null, port: DEFAULT_PORT, settings: { ...DEFAULT_SETTINGS } };
    }
  }

  private saveConfig(): void {
    fs.mkdirSync(this.opts.userData, { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
  }

  async start(): Promise<void> {
    await this.stop();
    if (!this.config.libraryRoot) return;
    this.lib = Library.open(this.config.libraryRoot);
    await this.startServer();
  }

  /** How many times to try binding the port before giving up: covers the common case of a just-quit app (Cadrel Market itself, run standalone,
   * or an older build of it) still finishing its own shutdown and releasing the socket a moment later. */
  private static readonly BIND_ATTEMPTS = 3;
  private static readonly BIND_RETRY_MS = 200;

  private async startServer(): Promise<void> {
    this.serverError = null;
    for (let attempt = 1; attempt <= AppService.BIND_ATTEMPTS; attempt++) {
      try {
        this.server = await startIngestServer(
          { library: this.lib!, token: loadOrCreateToken(this.tokenFile), pairing: { redeem: (c) => this.redeemPairing(c) }, onCapture: () => {
              this.listeners.forEach((l) => l());
              this.scheduleAutoIndex();
            },
            onSamplePage: (e) => {
              this.slog(e.duplicate ? 'warn' : 'info', 'app', e.asin, e.session, e.duplicate ? 'page ignored, identical image already stored' : 'page stored', `#${e.index}, ${Math.round(e.bytes / 1024)} KB, ${e.pages} page${e.pages === 1 ? '' : 's'} in session`);
              this.textListeners.forEach((l) => l());
            },
            onSampleFinished: ({ asin, session }) => {
              this.slog('info', 'app', asin, session, 'extension finished the session', 'reading the pages');
              void this.readSample(asin, session).catch(() => {});
            },
            onSampleLog: (e: SampleLogEvent) => this.slog(e.level, e.source, e.asin, e.session, e.event, e.detail),
          },
          this.config.port,
        );
        this.serverError = null;
        return;
      } catch (e) {
        this.server = null;
        const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (busy && attempt < AppService.BIND_ATTEMPTS) {
          await delay(AppService.BIND_RETRY_MS);
          continue;
        }
        this.serverError = busy ? await this.portConflictMessage(this.config.port) : String(e);
        return;
      }
    }
  }

  /** Builds the "port in use" message, naming whoever answers there when it is safe to ask (never blocks longer than the probe timeout). */
  private async portConflictMessage(port: number): Promise<string> {
    const plain = `port ${port} is already in use`;
    try {
      const r = await probeCaptureServer(port, loadOrCreateToken(this.tokenFile));
      if (r.sameApp && r.sameToken) return `${plain} — another copy of Cadrel Market is already listening there (check its tray icon)`;
      if (r.sameApp) return `${plain} — something speaking Cadrel Market's protocol is listening there with a different pairing token; quit it, then Reconnect`;
    } catch {
      /* the probe never throws, but this stays defensive: fall through to the plain message */
    }
    return plain;
  }

  async stop(): Promise<void> {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    await this.indexJob?.catch(() => {});
    await this.server?.close();
    this.server = null;
    this.lib?.close();
    this.lib = null;
  }

  private need(): Library {
    if (!this.lib) throw new Error('no library chosen yet');
    return this.lib;
  }

  status(): Status {
    return { libraryRoot: this.config.libraryRoot, port: this.config.port, serverRunning: !!this.server, serverError: this.serverError };
  }

  /**
   * Tries the capture server again — for example after freeing the port some other program was holding it on.
   * Leaves the library open if it already is: a reconnect only needs the server back, not a full restart.
   */
  async reconnect(): Promise<Status> {
    await this.server?.close();
    this.server = null;
    if (!this.lib) {
      if (!this.config.libraryRoot) return this.status();
      this.lib = Library.open(this.config.libraryRoot);
    }
    await this.startServer();
    return this.status();
  }

  /** Stops the capture server deliberately, without closing the library, so the port is free right away for another program. Reconnect starts it again. */
  async forceDisconnect(): Promise<Status> {
    await this.server?.close();
    this.server = null;
    this.serverError = null;
    return this.status();
  }

  /** The library to use when none has been chosen: made if it is missing, and remembered. Does nothing once a library is set. Call before `start`. */
  useDefaultLibrary(root: string): void {
    if (this.config.libraryRoot) return;
    fs.mkdirSync(root, { recursive: true });
    this.config.libraryRoot = root;
    this.saveConfig();
  }

  async setLibrary(root: string): Promise<void> {
    if (typeof root !== 'string') throw new Error('bad folder');
    if (root.startsWith('\\\\') || root.startsWith('//')) throw new Error('a network share cannot be used as the library: its database needs a local disk');
    if (!path.isAbsolute(root)) throw new Error('bad folder');
    this.config.libraryRoot = root;
    this.saveConfig();
    await this.start();
  }

  async setPort(port: number): Promise<Status> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be between 1024 and 65535');
    this.config.port = port;
    this.saveConfig();
    await this.start();
    return this.status();
  }

  token(): string {
    return loadOrCreateToken(this.tokenFile);
  }

  async rotateToken(): Promise<string> {
    const t = rotateToken(this.tokenFile);
    await this.start();
    return t;
  }

  // ---- community sources: what people say in subreddits linked to a category (via Arctic Shift) ---------------------------

  communitySources(categoryKey: string): CommunitySource[] { return listCommunitySources(this.need().db, categoryKey); }

  addCommunitySource(categoryKey: string, subreddit: string): CommunitySource[] {
    const lib = this.need();
    return addCommunitySource(lib.db, lib.root, categoryKey, subreddit);
  }

  removeCommunitySource(categoryKey: string, subreddit: string): CommunitySource[] {
    if (this.communityJob) throw new Error('a sync is running; wait for it to finish');
    const lib = this.need();
    return removeCommunitySource(lib.db, lib.root, categoryKey, subreddit);
  }

  communityStatus(): CommunityJob | null { return this.communityJob; }

  /** Stop the running sync after the day being read; what was already saved stays, and syncing again carries on. */
  stopCommunity(): boolean {
    if (!this.communityJob) return false;
    this.communityJob = { ...this.communityJob, stopping: true };
    this.communityAbort?.abort();
    return true;
  }

  /**
   * Fetch the last 7 days of every subreddit linked to the category (or just one), a day at a time. Adds to what is already
   * stored, and carries on after the last saved day if an earlier sync was stopped.
   */
  async syncCommunity(categoryKey: string, subreddit?: string): Promise<SyncResult[]> {
    if (this.communityJob) throw new Error('a sync is already running');
    const lib = this.need();
    const subs = listCommunitySources(lib.db, categoryKey).map((s) => s.subreddit).filter((s) => !subreddit || s === subreddit.toLowerCase());
    if (!subs.length) throw new Error('add a subreddit first');
    const out: SyncResult[] = [];
    const abort = (this.communityAbort = new AbortController());
    this.communityJob = { categoryKey, subreddit: subs[0]!, subredditIndex: 0, subredditCount: subs.length, step: 'Starting', day: 1, days: 7, threads: 0, comments: 0, requests: 0, startedAt: Date.now(), stopping: false };
    try {
      for (const [i, sub] of subs.entries()) {
        if (abort.signal.aborted) break;
        const r = await syncSubreddit(lib.db, lib.root, sub, {
          // a long wait (the service is busy) is shown as the step, so the screen says why nothing is moving
          client: new ArcticShift({ fetch: this.opts.fetch, signal: abort.signal, onWait: (m) => { if (this.communityJob) this.communityJob = { ...this.communityJob, step: m }; } }),
          signal: abort.signal,
          onProgress: (p) => { this.communityJob = { categoryKey, subreddit: p.subreddit, subredditIndex: i, subredditCount: subs.length, step: p.step, day: p.day, days: p.days, threads: p.threads, comments: p.comments, requests: p.requests, startedAt: p.startedAt, stopping: abort.signal.aborted }; },
        });
        out.push(r);
        if (r.cancelled || r.error) break;
      }
      return out;
    } finally {
      this.communityJob = null;
      this.communityAbort = null;
    }
  }

  // ---- keywords: autocomplete from Amazon/Google/Bing, Reddit mentions, Trends imports, captured Amazon searches ---------------

  /** Everything known about a seed phrase from stored data. Makes no requests. */
  keywordTable(seed: string, categoryKey?: string): KeywordTable {
    if (typeof seed !== 'string') throw new Error('bad phrase');
    const lib = this.need();
    const subreddits = categoryKey ? listCommunitySources(lib.db, categoryKey).map((s) => s.subreddit) : undefined;
    return keywordTable(lib.db, seed, { subreddits });
  }

  keywordStatus(): KeywordJob | null { return this.keywordJob; }

  stopKeywords(): boolean {
    if (!this.keywordJob) return false;
    this.keywordJob = { ...this.keywordJob, stopping: true };
    this.keywordAbort?.abort();
    return true;
  }

  /**
   * Look a phrase up in each autocomplete source the user has switched on (from the cache when fresh), one source after
   * another from this computer, and return the combined table. A source that blocks is dropped and reported, not retried.
   */
  async keywordLookup(seed: string, o: { sources?: SuggestSource[]; force?: boolean; categoryKey?: string } = {}): Promise<KeywordLookupResult> {
    if (typeof seed !== 'string') throw new Error('bad phrase');
    if (this.keywordJob) throw new Error('a lookup is already running');
    const lib = this.need();
    const st = this.config.settings;
    const on: Record<SuggestSource, boolean> = { amazon: st.suggestAmazon, google: st.suggestGoogle, bing: st.suggestBing };
    const sources = (o.sources ?? SUGGEST_SOURCES).filter((s) => SUGGEST_SOURCES.includes(s) && on[s]);
    if (!sources.length) throw new Error('turn on at least one source in Settings');
    const abort = (this.keywordAbort = new AbortController());
    const startedAt = Date.now();
    this.keywordJob = { seed, source: sources[0]!, sourceIndex: 0, sourceCount: sources.length, done: 0, total: 27, startedAt, stopping: false };
    const ask = async (phrase: string): Promise<KeywordLookupResult['notes']> => {
      const notes: KeywordLookupResult['notes'] = [];
      for (const [i, source] of sources.entries()) {
        if (abort.signal.aborted) break;
        const r = await lookupSuggestions(lib.db, source, phrase, {
          fetch: this.opts.fetch, signal: abort.signal, force: o.force, delayMs: this.opts.keywordDelayMs,
          sleep: this.opts.keywordDelayMs === 0 ? async () => {} : undefined,
          onProgress: (done, total) => { this.keywordJob = { seed: phrase, source, sourceIndex: i, sourceCount: sources.length, done, total, startedAt, stopping: abort.signal.aborted }; },
        });
        notes.push({ source, cached: r.cached, requests: r.requests, stopped: r.stopped, fetchedAt: r.fetchedAt, count: r.suggestions.length });
      }
      return notes;
    };
    try {
      let used = seed;
      const first = await ask(seed);
      let notes = first;
      // Autocomplete only lists phrases people really type, so a very specific phrase can get nothing from every source.
      // When every source answered and none had a phrase, try the phrase with its last word dropped (never below two words).
      const nothing = (n: KeywordLookupResult['notes']) => n.length > 0 && n.every((x) => x.count === 0 && !x.stopped);
      let words = seed.trim().split(/\s+/);
      while (nothing(notes) && !abort.signal.aborted && words.length > 2) {
        words = words.slice(0, -1);
        used = words.join(' ');
        notes = await ask(used);
      }
      const fallback = used !== seed && notes.some((n) => n.count > 0) ? { requested: seed, used } : undefined;
      if (!fallback) notes = first; // the shorter phrases found nothing either: report on the phrase that was asked about
      const table = this.keywordTable(fallback ? used : seed, o.categoryKey);
      // remember the search so it can be reopened from Search History; a lookup that found nothing anywhere is not worth keeping
      if (notes.some((n) => n.count > 0)) recordKeywordSearch(lib.db, table.seed, { phrases: table.rows.length, sources: notes.filter((n) => n.count > 0).map((n) => n.source), categoryKey: this.knownCategory(o.categoryKey) });
      return { table, notes, fallback };
    } finally {
      this.keywordJob = null;
      this.keywordAbort = null;
    }
  }

  /** The searches run so far, newest first. */
  keywordHistory(categoryKey?: string): KeywordHistoryRow[] { return listKeywordHistory(this.need().db, categoryKey || null); }

  /** The key if it names a captured category, else null (a keyword search is only filed under a category that exists). */
  private knownCategory(key: unknown): string | null {
    return typeof key === 'string' && key && this.need().db.scalar('SELECT 1 FROM category WHERE key = ?', key) ? key : null;
  }

  removeKeywordHistory(seed: string): void { removeKeywordHistory(this.need().db, String(seed)); }

  clearKeywordHistory(): void { clearKeywordHistory(this.need().db); }

  /** Five phrases worth searching for a captured category, from what the library already holds (no request is made). With a book's ASIN, words already in its title, subtitle and blurb are left out too. */
  keywordIdeas(categoryKey: string, asin?: string): KeywordIdea[] {
    const lib = this.need();
    const r = resolveCategory(lib.db, String(categoryKey));
    if ('error' in r) throw new Error(r.error);
    return suggestKeywords(lib.db, r.category.key, 5, { asin: asin ? String(asin) : undefined });
  }

  /** Seven keyword strings (one per KDP keyword box, 50 characters each) for a captured category, from what the library already holds (no request is made). */
  keywordStrings(categoryKey: string, asin?: string): KeywordString[] {
    const lib = this.need();
    const r = resolveCategory(lib.db, String(categoryKey));
    if ('error' in r) throw new Error(r.error);
    return suggestKeywordStrings(lib.db, r.category.key, { asin: asin ? String(asin) : undefined });
  }

  /** Import the CSV that Google Trends' Download button saves (the renderer reads the file and passes its text). */
  importTrends(csv: string, categoryKey?: string): { keywords: string[] } {
    if (typeof csv !== 'string' || csv.length > 5_000_000) throw new Error('that file is too large to be a Trends export');
    return importTrendsCsv(this.need().db, csv, undefined, this.knownCategory(categoryKey));
  }

  removeTrend(keyword: string): void {
    removeTrend(this.need().db, String(keyword));
  }

  /** Opens Google Trends comparing up to five terms. Cadrel Market never calls Trends itself. */
  async openTrends(terms: string[]): Promise<void> {
    if (!Array.isArray(terms)) throw new Error('bad terms');
    await this.opts.openExternal(trendsUrl(terms.map(String)));
  }

  /** Opens an Amazon Kindle-store search in the browser; the extension captures it as soon as it loads, which fills the competition columns. */
  async openAmazonSearch(keyword: string): Promise<void> {
    const q = String(keyword).trim();
    if (q.length < 2 || q.length > 80) throw new Error('type a phrase of 2-80 characters');
    await this.opts.openExternal(`https://www.amazon.com/s?${new URLSearchParams({ k: q, i: 'digital-text' }).toString()}#cadrel-market-capture`);
  }

  // ---- sales calibration: the author's own KDP sales against rank, to fit the rank-to-sales curve ---------------------------

  // ---- reader community: what the linked subreddits are talking about and asking for ----------------------------------------

  communityInsights(categoryKey: string): CommunityInsights {
    const lib = this.need();
    const r = resolveCategory(lib.db, String(categoryKey));
    if ('error' in r) throw new Error(r.error);
    return communityInsights(lib.db, r.category.key);
  }

  /** Opens a Reddit thread from the analysis in the browser; only thread addresses on reddit.com are accepted. */
  async openThread(url: string): Promise<void> {
    if (typeof url !== 'string' || !/^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]{2,21}\/comments\/[a-z0-9]+\/(?:[^/\s]*\/[a-z0-9]+\/)?$/.test(url)) throw new Error('not a Reddit thread address');
    await this.opts.openExternal(url);
  }

  // ---- My Books: the user's own titles, created from imported KDP reports or flagged by hand ------------------------------

  ownBooks(): OwnBookRow[] { return listOwnBooks(this.need().db); }

  /** The book if it is in My Books (captured or not), else null. */
  ownBook(asin: string): OwnBookRow | null {
    assertAsin(asin);
    return getOwnBook(this.need().db, asin);
  }

  setOwnBook(asin: string, own: boolean): void {
    assertAsin(asin);
    const lib = this.need();
    setOwnBook(lib.db, lib.root, asin, !!own);
  }

  salesStatus(): SalesStatus { return salesStatus(this.need().db); }

  // ---- Money: analysis, month view, royalty splits and author statements -----------------------------------------------------

  moneyMonths(): string[] { return reportMonths(this.need().db); }
  moneyAnalysis(from: string, to: string): AnalysisReport { assertMonths(from, to); return analysisReport(this.need().db, { from, to }); }
  moneyMonth(month: string): MonthReport { assertMonths(month, month); return monthReport(this.need().db, month); }
  people(): Person[] { return listPeople(this.need().db); }
  savePerson(p: { id?: number; name: string; penNames?: string[] }): Person { const lib = this.need(); return savePerson(lib.db, lib.root, p); }
  deletePerson(id: number): void { const lib = this.need(); deletePerson(lib.db, lib.root, id); }
  bookSplit(asin: string): SplitVersion[] { assertAsin(asin); return splitHistory(this.need().db, asin); }
  /** Every book's split versions, for the table of books. */
  allSplits(): Record<string, SplitVersion[]> {
    const db = this.need().db;
    const out: Record<string, SplitVersion[]> = {};
    for (const r of db.prepare('SELECT DISTINCT asin FROM book_split').all() as unknown as { asin: string }[]) out[r.asin] = splitHistory(db, r.asin);
    return out;
  }
  /** Author names found on the user's books (KDP report authors and captured credits), each with the books it is on. */
  detectedAuthors(): DetectedAuthor[] { return detectedAuthors(this.need().db); }
  setBookSplit(asin: string, shares: { personId?: number; name?: string; pct: number }[], fromMonth?: string): void {
    assertAsin(asin);
    const lib = this.need();
    setSplit(lib.db, lib.root, asin, shares, fromMonth);
  }
  statement(from: string, to: string, basis: StatementBasis = 'paid'): Statement { assertMonths(from, to); assertBasis(basis); return royaltyStatement(this.need().db, { from, to }, new Date(), basis); }
  /** Payments imported from KDP payment reports, what does not reconcile, and what is unpaid. */
  payments(): PaymentsReport { return paymentsReport(this.need().db); }
  removePayment(number: string): void { if (typeof number !== 'string' || !/^\d{3,30}$/.test(number)) throw new Error('bad payment number'); const lib = this.need(); removePayment(lib.db, number); }
  /** The statement's file contents: CSV for one author or all, or the printable page of one author. */
  statementFile(from: string, to: string, kind: 'csv' | 'html', payee: string | null, basis: StatementBasis = 'paid'): { filename: string; content: string } {
    const s = this.statement(from, to, basis);
    const span = `${basis === 'paid' ? 'paid-' : 'earned-'}${from === to ? from : `${from}_to_${to}`}`;
    if (kind === 'csv') return { filename: `royalty-statement-${payee ? payee.replace(/[^A-Za-z0-9]+/g, '-') + '-' : ''}${span}.csv`, content: statementCsv(s, payee ?? undefined) };
    if (!payee) throw new Error('choose an author');
    return { filename: `royalty-statement-${payee.replace(/[^A-Za-z0-9]+/g, '-')}-${span}.pdf`, content: statementHtml(s, payee) };
  }
  /** The calculator for one payment: what each author is owed from it, after tax, and whether it has been allocated. */
  paymentOwed(number: string): PaymentOwed { assertPaymentNumber(number); return paymentOwed(this.need().db, number); }
  /** Freeze what each author is owed from a payment (allocating again replaces it). */
  allocatePayment(number: string): PaymentOwed { assertPaymentNumber(number); const lib = this.need(); return allocatePayment(lib.db, lib.root, number); }
  unallocatePayment(number: string): void { assertPaymentNumber(number); const lib = this.need(); unallocatePayment(lib.db, lib.root, number); }
  /** What to pay each author for a period, from the payments dated in it, plus what is still unpaid from before, less what has been paid out. */
  payoutRollup(from: string, to: string): Rollup { assertMonths(from, to); return payoutRollup(this.need().db, { from, to }); }
  /** Allocate every unallocated payment dated in the period; returns their numbers. */
  allocateRollup(from: string, to: string): string[] { assertMonths(from, to); const lib = this.need(); return allocateRollup(lib.db, lib.root, { from, to }); }
  payouts(): Payout[] { return listPayouts(this.need().db); }
  recordPayout(p: { payee: string; paidOn: string; usd: number; period: string; note?: string }): Payout {
    if (!p || typeof p.payee !== 'string' || typeof p.paidOn !== 'string' || typeof p.usd !== 'number' || typeof p.period !== 'string') throw new Error('bad payout');
    const lib = this.need();
    return recordPayout(lib.db, lib.root, p);
  }
  deletePayout(id: number): void { if (!Number.isInteger(id)) throw new Error('bad payout'); const lib = this.need(); deletePayout(lib.db, lib.root, id); }
  /** One payment's calculator as a file: CSV (one author or all) or the printable page of one author. */
  paymentFile(number: string, kind: 'csv' | 'html', payee: string | null): { filename: string; content: string } {
    assertPaymentNumber(number);
    const db = this.need().db;
    const o = paymentOwed(db, number);
    const m = o.payment.paidOn.slice(0, 7);
    const st = royaltyStatement(db, { from: m, to: m }, new Date(), 'paid', number);
    if (kind === 'csv') return { filename: `payment-${number}${payee ? '-' + payee.replace(/[^A-Za-z0-9]+/g, '-') : ''}.csv`, content: statementCsv(st, payee ?? undefined) };
    if (!payee) throw new Error('choose an author');
    return { filename: `payment-${number}-${payee.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`, content: statementHtml(st, payee) };
  }
  /** The roll-up as a file: CSV (one author or all) or one author's printable payout statement. */
  rollupFile(from: string, to: string, kind: 'csv' | 'html', payee: string | null): { filename: string; content: string } {
    const r = this.payoutRollup(from, to);
    const span = from === to ? from : `${from}_to_${to}`;
    if (kind === 'csv') return { filename: `payouts-${payee ? payee.replace(/[^A-Za-z0-9]+/g, '-') + '-' : ''}${span}.csv`, content: rollupCsv(r, payee ?? undefined) };
    if (!payee) throw new Error('choose an author');
    return { filename: `payout-${payee.replace(/[^A-Za-z0-9]+/g, '-')}-${span}.pdf`, content: rollupHtml(r, payee) };
  }
  setFxRate(month: string, currency: string, toUsd: number | null): void {
    const lib = this.need();
    if (toUsd === null) clearFxRate(lib.db, lib.root, month, currency);
    else setFxRate(lib.db, lib.root, month, currency, toUsd);
  }
  setKenpRate(month: string, currency: string, rate: number | null): void { const lib = this.need(); setKenpRate(lib.db, lib.root, month, currency, rate); }

  /** A KDP report (.xlsx or .csv) the user downloaded; the renderer passes the file's bytes. */
  importSales(name: string, bytes: Uint8Array): ImportSummary {
    this.checkUpload(name, bytes);
    const lib = this.need();
    return importSalesFile(lib.db, lib.root, name, bytes);
  }

  /** A rank-history file (date, rank, optionally ASIN). `asin` says which book it is for when the file has no ASIN column. */
  importRanks(name: string, bytes: Uint8Array, asin?: string): ImportSummary {
    this.checkUpload(name, bytes);
    if (asin !== undefined && asin !== '') assertAsin(asin);
    const lib = this.need();
    return importRankFile(lib.db, lib.root, name, bytes, asin || undefined);
  }

  private checkUpload(name: unknown, bytes: unknown): asserts bytes is Uint8Array {
    if (typeof name !== 'string' || !(bytes instanceof Uint8Array)) throw new Error('bad file');
    if (bytes.length > 20_000_000) throw new Error('that file is too large to be a sales report');
  }

  /** `includeKu` chooses whether estimated Kindle Unlimited borrows count as sales; by default they do when a KENP report is imported. */
  calibrationPreview(o: { includeKu?: boolean } = {}): CalibrationPreview { return calibrationPreview(this.need().db, { includeKu: typeof o?.includeKu === 'boolean' ? o.includeKu : undefined }); }

  applyCalibration(o: { includeKu?: boolean } = {}) { return applyCalibration(this.need().db, { includeKu: typeof o?.includeKu === 'boolean' ? o.includeKu : undefined }); }

  /** A book's page count in KENP (shown in its KDP Bookshelf), which turns pages read into borrows; null removes it. */
  setKenpc(asin: string, kenpc: number | null): void {
    assertAsin(asin);
    setKenpc(this.need().db, asin, kenpc === null ? null : Number(kenpc));
  }

  /** The share of a book the average borrower is assumed to read (0.1 to 1). */
  setKuCompletion(share: number): number { return setCompletion(this.need().db, Number(share)); }
  kuCompletion(): number { return getCompletion(this.need().db); }

  resetCalibration(): void { resetCalibration(this.need().db); }

  clearSalesData(): void {
    const lib = this.need();
    clearSalesData(lib.db, lib.root);
  }

  categories() { return listCategories(this.need().db); }
  books(o?: { categoryKey?: string; search?: string }) { return listBooks(this.need().db, o); }
  book(asin: string): BookDetail | null { assertAsin(asin); return getBook(this.need().db, asin); }
  issues(): IssueRow[] { return listIssues(this.need().db); }
  queue(o?: { categoryKey?: string; includeSkipped?: boolean }) { return queue(this.need().db, o); }

  /** Latest cover as a data URL, or null. */
  cover(asin: string): string | null {
    assertAsin(asin);
    const lib = this.need();
    const row = lib.db.prepare("SELECT path FROM asset WHERE asin = ? AND kind = 'cover' ORDER BY captured_at DESC LIMIT 1").get(asin) as
      | { path: string }
      | undefined;
    if (!row) return null;
    const file = path.join(lib.root, row.path);
    if (!file.startsWith(lib.root + path.sep) || !fs.existsSync(file)) return null;
    const ext = path.extname(file).slice(1);
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  async analysis(categoryKey: string, topN: number) {
    const lib = this.need();
    await analyzeCovers(lib.db, lib.root);
    return categoryReport(lib.db, categoryKey, Math.min(Math.max(Math.trunc(topN) || 10, 1), 100), undefined, lib.root);
  }

  /** File name and content for an export; the caller decides where to save it. */
  async exportContent(categoryKey: string, kind: 'csv' | 'md', topN: number): Promise<{ filename: string; content: string }> {
    const lib = this.need();
    const report = await this.analysis(categoryKey, topN);
    const slug = (report.category.name ?? report.category.key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const day = new Date().toISOString().slice(0, 10);
    return kind === 'csv'
      ? { filename: `cadrel-market-${slug}-${day}.csv`, content: '\ufeff' + categoryCsv(lib.db, report.category.key) } // BOM so Excel reads UTF-8
      : { filename: `cadrel-market-${slug}-${day}.md`, content: reportMarkdown(report) };
  }

  successWeights(): Weights {
    return getWeights(this.need().db);
  }

  setSuccessWeights(w: Weights): Weights {
    setWeights(this.need().db, w);
    return getWeights(this.need().db);
  }

  rankCategories(topN: number) {
    return rankCategories(this.need().db, Math.min(Math.max(Math.trunc(topN) || 10, 1), 100));
  }

  opportunityWeights(): OpportunityWeights {
    return getOpportunityWeights(this.need().db);
  }

  setOpportunityWeights(w: OpportunityWeights): OpportunityWeights {
    setOpportunityWeights(this.need().db, w);
    return getOpportunityWeights(this.need().db);
  }

  salesCurve(): SalesCurve {
    return getSalesCurve(this.need().db);
  }

  setSalesCurve(c: SalesCurve): SalesCurve {
    setSalesCurve(this.need().db, c);
    return getSalesCurve(this.need().db);
  }

  // ---- text: uploaded manuscripts and OCR of the free sample --------------------------------------------------

  private notifyText() {
    this.textListeners.forEach((l) => l());
  }

  onText(cb: () => void): () => void {
    this.textListeners.add(cb);
    return () => this.textListeners.delete(cb);
  }

  bookText(asin: string): BookText {
    assertAsin(asin);
    const lib = this.need();
    const sessions = sampleSessions(lib.root, asin).map((s) => ({ session: s.session, pages: s.pages.length, read: s.pages.filter((p) => p.ocr).length }));
    return {
      manuscripts: getManuscripts(lib.db, asin),
      sampleSessions: sessions,
      metrics: contentMetricsOf(lib.db, asin),
      job: this.textJob && this.textJob.asin === asin ? { asin, phase: this.textJob.phase, done: this.textJob.done, total: this.textJob.total } : null,
      error: this.textError,
    };
  }

  /** Extract a dropped or picked file and attach it as the book's manuscript. */
  async attachManuscriptPath(asin: string, filePath: string): Promise<BookText> {
    assertAsin(asin);
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('bad file path');
    const lib = this.need();
    if (this.textJob) throw new Error('another file is still being read');
    this.textError = null;
    const job: TextJob & { promise: Promise<void> } = { asin, phase: 'reading', done: 0, total: 1, promise: Promise.resolve() };
    this.textJob = job;
    this.notifyText();
    try {
      const { extractFile } = await import('@cadrel/market-text');
      const x = await extractFile(filePath);
      lib.attachText(asin, {
        source: 'upload', kind: x.kind, label: path.basename(filePath), text: x.text, chapters: x.chapters, pages: x.pages, warnings: x.warnings,
        original: { name: path.basename(filePath), data: fs.readFileSync(filePath) },
      });
    } catch (e) {
      this.textError = (e as Error).message ?? String(e);
    } finally {
      this.textJob = null;
      this.notifyText();
    }
    if (this.textError) throw new Error(this.textError);
    return this.bookText(asin);
  }

  removeText(asin: string, source: 'upload' | 'sample'): BookText {
    assertAsin(asin);
    if (source !== 'upload' && source !== 'sample') throw new Error('bad source');
    this.need().detachText(asin, source);
    this.notifyText();
    return this.bookText(asin);
  }

  /**
   * OCR the screenshots of a sample session (newest if not given), save each page's text, and attach the joined text
   * as the book's sample text. Pages already read are not read again.
   */
  async readSample(asin: string, session?: string): Promise<BookText> {
    assertAsin(asin);
    if (session !== undefined) assertSession(session);
    const lib = this.need();
    if (this.textJob) return this.bookText(asin);
    const sess = sampleSessions(lib.root, asin);
    const target = session ? sess.find((s) => s.session === session) : sess[sess.length - 1];
    if (!target || !target.pages.length) {
      this.slog('error', 'app', asin, session ?? null, 'nothing to read', 'no sample pages have been captured for this book');
      throw new Error('no sample pages have been captured for this book');
    }
    this.textError = null;
    const sid = target.session;
    this.slog('info', 'app', asin, sid, 'reading started', `${target.pages.length} page${target.pages.length === 1 ? '' : 's'}, ${target.pages.filter((p) => p.ocr).length} already read`);
    const job: TextJob & { promise: Promise<void> } = { asin, phase: 'ocr', done: 0, total: target.pages.length, promise: Promise.resolve() };
    this.textJob = job;
    this.notifyText();
    job.promise = (async () => {
      const { Ocr, assemblePages, looksLikeEndOfSample } = await import('@cadrel/market-text');
      const ocr = this.opts.ocrFactory ? await this.opts.ocrFactory() : await Ocr.create();
      try {
        for (const p of target.pages) {
          if (!p.ocr) {
            try {
              const r = await ocr.recognize(readSamplePage(lib.root, asin, target.session, p), p.crop ?? undefined);
              saveSampleOcr(lib.root, asin, target.session, p.index, r.text, r.confidence);
              const poor = r.confidence < 60 || r.text.length < 40;
              this.slog(poor ? 'warn' : 'info', 'app', asin, sid, poor ? `page ${p.index} read poorly` : `page ${p.index} read`, `confidence ${Math.round(r.confidence)}, ${r.text.length} characters${p.crop ? '' : ', no reader crop (whole screenshot read)'}`);
            } catch (e) {
              this.slog('error', 'app', asin, sid, `page ${p.index} could not be read`, (e as Error).message ?? String(e));
              throw e;
            }
          }
          job.done++;
          this.notifyText();
        }
      } finally {
        await ocr.close();
      }
      const fresh = sampleSessions(lib.root, asin).find((s) => s.session === target.session)!;
      const pages = fresh.pages.map((p) => ({ p, text: readSampleOcr(lib.root, asin, target.session, p.index) ?? '' }));
      // the reader's closing "end of sample" screen is not book text
      const end = pages.filter((x) => looksLikeEndOfSample(x.text));
      const body = pages.filter((x) => !end.includes(x));
      const confs = body.map((x) => x.p.ocr?.confidence ?? 0).filter((c) => c > 0);
      const quality = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
      const warnings: string[] = [];
      const poor = body.filter((x) => (x.p.ocr?.confidence ?? 0) < 60 || x.text.length < 40).length;
      if (poor) warnings.push(`${poor} page${poor === 1 ? '' : 's'} read poorly (low confidence or very little text); the text may have gaps.`);
      const text = assemblePages(body.map((x) => x.text));
      lib.attachText(asin, { source: 'sample', kind: 'ocr', label: target.session, text, chapters: [], pages: body.length, quality, complete: end.length > 0, warnings });
      this.slog(warnings.length || !end.length ? 'warn' : 'info', 'app', asin, sid, 'reading finished', `${body.length} book page${body.length === 1 ? '' : 's'}, ${end.length} end-of-sample screen${end.length === 1 ? '' : 's'}, quality ${quality ?? 'n/a'}, ${text.split(/\s+/).filter(Boolean).length} words${end.length ? '' : '; the closing "end of sample" screen was never captured, so the sample may be cut short'}${warnings.length ? '; ' + warnings.join(' ') : ''}`);
    })()
      .catch((e) => {
        this.textError = (e as Error).message ?? String(e);
        this.slog('error', 'app', asin, sid, 'reading failed', this.textError);
      })
      .finally(() => {
        this.textJob = null;
        this.notifyText();
      });
    await job.promise;
    if (this.textError) throw new Error(this.textError);
    return this.bookText(asin);
  }

  async openNext(categoryKey?: string): Promise<QueueItem | null> {
    const lib = this.need();
    const item = nextInQueue(lib.db, categoryKey);
    if (!item) return null;
    lib.setQueue(item.asin, 'opened');
    await this.opts.openExternal(amazonUrl(item.asin));
    return { ...item, state: 'opened' };
  }

  /** Opens a known category's Best Sellers page on Amazon (built from the stored category, never from a caller's address). */
  async openShelf(categoryKey: string): Promise<void> {
    if (typeof categoryKey !== 'string') throw new Error('bad category');
    const url = categoryUrl(this.need().db, categoryKey);
    if (!url) throw new Error('unknown category');
    await this.opts.openExternal(url);
  }

  async openBook(asin: string): Promise<void> {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('bad ASIN');
    await this.opts.openExternal(amazonUrl(asin));
  }

  setQueueState(asin: string, state: 'pending' | 'skipped' | 'opened'): void {
    assertAsin(asin);
    if (state !== 'pending' && state !== 'skipped' && state !== 'opened') throw new Error('bad state');
    this.need().setQueue(asin, state);
  }

  /** Something the analyses read changed outside a capture: tell the open window to reload (it does the same on a capture). */
  private dataChanged(): void { this.listeners.forEach((l) => l()); }

  excludeFromCategory(asin: string, categoryKey: string): void {
    assertAsin(asin);
    this.need().excludeFromCategory(asin, String(categoryKey));
    this.dataChanged();
  }

  restoreToCategory(asin: string, categoryKey: string): void {
    assertAsin(asin);
    this.need().restoreToCategory(asin, String(categoryKey));
    this.dataChanged();
  }

  categoryExclusions(categoryKey?: string) { return listExclusions(this.need().db, categoryKey ? String(categoryKey) : undefined); }

  bookLists(asin: string) { assertAsin(asin); return listedIn(this.need().db, asin); }

  /** Delete a mistakenly captured book and clear what was derived from it; the open window reloads its analyses. */
  removeBook(asin: string, alsoExclude = false): RemovedBook {
    assertAsin(asin);
    const r = this.need().removeBook(asin, { alsoExclude: !!alsoExclude });
    this.dataChanged();
    return r;
  }

  revealBook(asin: string): void {
    assertAsin(asin);
    const d = this.book(asin);
    if (d) this.opts.revealInFolder(path.join(this.need().root, d.rawDir));
  }

  // ---- maintenance: rebuild, verify, backup, move --------------------------------------------------------------

  maintenanceStatus(): MaintenanceStatus {
    return { ...this.maint };
  }

  onMaintenance(cb: () => void): () => void {
    this.maintListeners.add(cb);
    return () => this.maintListeners.delete(cb);
  }

  private async job<T>(kind: 'rebuild' | 'backup' | 'move' | 'export' | 'import', run: (progress: (done: number, total: number) => void) => Promise<{ result: T; message: string }>): Promise<T> {
    if (this.maint.kind) throw new Error(`another job is running (${this.maint.kind})`);
    const notify = () => this.maintListeners.forEach((l) => l());
    this.maint = { kind, done: 0, total: 0, error: null, message: null };
    notify();
    try {
      const { result, message } = await run((done, total) => {
        this.maint = { ...this.maint, done, total };
        notify();
      });
      this.maint = { kind: null, done: 0, total: 0, error: null, message };
      return result;
    } catch (e) {
      this.maint = { kind: null, done: 0, total: 0, error: (e as Error).message ?? String(e), message: null };
      throw e;
    } finally {
      notify();
    }
  }

  /** Re-read every stored page with the current parsers and rebuild the index. */
  async rebuild(): Promise<{ detail: number; list: number; search: number }> {
    const lib = this.need();
    return this.job('rebuild', async (progress) => {
      const r = await lib.rebuildAsync(progress);
      this.textListeners.forEach((l) => l());
      return { result: r, message: `Re-read ${r.detail} book page${r.detail === 1 ? '' : 's'} ${r.list} list page${r.list === 1 ? '' : 's'} and ${r.search} search page${r.search === 1 ? '' : 's'}` };
    });
  }

  verifyLibrary() {
    return verifyLibrary(this.need().db, this.need().root);
  }

  parserHealth() {
    return parserHealth(this.need().db);
  }

  /** Copy the library into an empty folder. */
  async backupTo(dest: string, opts: { includeModels?: boolean } = {}): Promise<string> {
    const lib = this.need();
    return this.job('backup', async (progress) => {
      const r = await copyLibrary(lib.db, lib.root, dest, { includeModels: opts.includeModels, onProgress: (p) => progress(p.files, p.totalFiles) });
      return { result: dest, message: `Backed up ${r.files.toLocaleString()} files to ${dest}` };
    });
  }

  /** Write the chosen categories (or the whole library, when `categoryKeys` is null) to a data pack file others can import. */
  async exportData(file: string, categoryKeys: string[] | null): Promise<string> {
    const lib = this.need();
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('bad file');
    if (categoryKeys !== null && (!Array.isArray(categoryKeys) || categoryKeys.some((k) => typeof k !== 'string'))) throw new Error('bad categories');
    return this.job('export', async (progress) => {
      const m = await exportPack(lib, file, { categoryKeys, onProgress: (p) => progress(p.done, p.total) });
      const c = m.counts;
      const n = (x: number, one: string, many = one + 's') => `${x.toLocaleString()} ${x === 1 ? one : many}`;
      const parts = [n(c.books, 'book page'), n(c.lists, 'list page'), ...(c.searches ? [n(c.searches, 'search page')] : []), n(c.covers, 'cover')];
      if (m.extra?.subreddits.length) parts.push(n(m.extra.subreddits.length, 'subreddit'));
      if (m.extra?.keywordSeeds) parts.push(n(m.extra.keywordSeeds, 'keyword search', 'keyword searches'));
      return { result: file, message: `Exported ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)} to ${file}` };
    });
  }

  /** Add the contents of a data pack to the library. Pages already there are kept. */
  async importData(file: string): Promise<{ added: number; alreadyHad: number; skipped: number }> {
    const lib = this.need();
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('bad file');
    const r = await this.job('import', async (progress) => {
      const r = await importPack(lib, file, (p) => progress(p.done, p.total));
      this.listeners.forEach((l) => l());
      const a = r.added, x = r.extra;
      const added = a.books + a.lists + a.searches + x.posts + x.comments + x.keywordSeeds;
      const n = (v: number, one: string, many = one + 's') => `${v.toLocaleString()} ${v === 1 ? one : many}`;
      const parts = [n(a.books, 'book page'), n(a.lists, 'list page'), n(a.searches, 'search page'), n(a.covers, 'cover')];
      if (x.posts || x.comments) parts.push(`${n(x.posts, 'thread')} and ${n(x.comments, 'comment')} from ${n(x.subreddits, 'subreddit')}`);
      if (x.keywordSeeds) parts.push(n(x.keywordSeeds, 'keyword search', 'keyword searches'));
      if (x.exclusions) parts.push(n(x.exclusions, 'removed book'));
      return {
        result: { added, alreadyHad: r.alreadyHad, skipped: r.skipped },
        message: `Imported ${parts.join(', ')}${r.alreadyHad ? `; ${r.alreadyHad.toLocaleString()} files were already in the library` : ''}${r.skipped ? `; ${r.skipped.toLocaleString()} could not be read` : ''}`,
      };
    });
    this.scheduleAutoIndex();
    return r;
  }

  /** Copy the library (with its models) to a new folder and continue from the copy. The old folder is left as it was. */
  async moveTo(dest: string): Promise<string> {
    const lib = this.need();
    const from = lib.root;
    await this.job('move', async (progress) => {
      const r = await copyLibrary(lib.db, from, dest, { includeModels: true, onProgress: (p) => progress(p.files, p.totalFiles) });
      return { result: undefined, message: `Copied ${r.files.toLocaleString()} files. Now using ${dest}; the old folder was not deleted.` };
    });
    await this.setLibrary(dest);
    return dest;
  }

  // ---- pairing the extension ----------------------------------------------------------------------------------

  pairingCode(): { code: string; expiresAt: number } {
    this.pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + 120_000 };
    return { ...this.pairing };
  }

  private redeemPairing(code: string): string | null {
    const p = this.pairing;
    if (!p || Date.now() > p.expiresAt) return null;
    const a = crypto.createHash('sha256').update(code).digest();
    const b = crypto.createHash('sha256').update(p.code).digest();
    if (!crypto.timingSafeEqual(a, b)) return null;
    this.pairing = null; // single use
    return this.token();
  }

  // ---- settings ------------------------------------------------------------------------------------------------

  settings(): AppSettings {
    return { ...this.config.settings };
  }

  setSettings(s: Partial<AppSettings>): AppSettings {
    for (const k of Object.keys(s)) if (!(k in DEFAULT_SETTINGS)) throw new Error(`unknown setting ${k}`);
    this.config.settings = { ...this.config.settings, ...Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'boolean')) } as AppSettings;
    this.saveConfig();
    return this.settings();
  }

  private get modelsDir() {
    return path.join(this.need().root, 'models');
  }

  private async neural(onDownload: (p: number) => void): Promise<Embedder> {
    if (this.opts.neuralEmbedder) return this.opts.neuralEmbedder(this.modelsDir, onDownload);
    const { TransformersEmbedder } = await import('@cadrel/market-embedder');
    const e = new TransformersEmbedder({ cacheDir: this.modelsDir, onProgress: (p) => onDownload(p.percent) });
    await e.prepare();
    return e;
  }

  private async modelDownloaded(): Promise<boolean> {
    if (this.opts.neuralEmbedder) return false;
    try {
      return (await import('@cadrel/market-embedder')).isModelCached(this.modelsDir);
    } catch {
      return false;
    }
  }

  async indexStatus(): Promise<IndexStatus> {
    const e = embeddingStatus(this.need().db);
    return { ...e, modelDownloaded: await this.modelDownloaded(), running: !!this.indexJob, progress: this.indexProgress, error: this.indexError };
  }

  /** Embed every chunk that lacks a vector. One job at a time; progress and errors are reported through indexStatus. */
  buildIndex(kind: 'neural' | 'basic'): Promise<IndexStatus> {
    const lib = this.need();
    if (!this.indexJob) {
      this.indexError = null;
      const notify = () => this.indexListeners.forEach((l) => l());
      this.indexJob = (async () => {
        try {
          let emb: Embedder;
          if (kind === 'basic') emb = new HashingEmbedder();
          else {
            this.indexProgress = { phase: 'download', done: 0, total: 100 };
            notify();
            emb = await this.neural((percent) => {
              this.indexProgress = { phase: 'download', done: percent, total: 100 };
              notify();
            });
          }
          await embedPending(lib.db, emb, {
            onProgress: (p) => {
              this.indexProgress = { phase: 'embed', done: p.done, total: p.total };
              notify();
            },
          });
        } catch (e) {
          this.indexError = (e as Error).message ?? String(e);
        } finally {
          this.indexProgress = null;
          this.indexJob = null;
          notify();
        }
      })();
    }
    return this.indexJob.then(() => this.indexStatus());
  }

  /** After a capture, keep an existing index current without the user asking. */
  private scheduleAutoIndex(): void {
    if (!this.lib || this.indexJob) return;
    const model = this.lib.db.scalar<string>("SELECT value FROM kv WHERE key = 'embedding_model'");
    if (!model) return; // the user has not built an index yet
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      if (!this.lib) return;
      void this.buildIndex(model.startsWith('hashing') ? 'basic' : 'neural');
    }, 1500);
  }

  mcpConfig(): McpSnippets {
    const root = this.need().root;
    const base = this.opts.mcpLaunch?.() ?? { command: 'node', args: [path.resolve('packages/market-mcp/dist/main.mjs')], env: {} };
    return buildMcpSnippets({ ...base, args: [...base.args, '--library', root] }, (this.opts.mcpBrand ?? MARKET_BRAND).id);
  }

  /**
   * A Claude Desktop extension (.mcpb) that starts this app's MCP server, so it can be installed by opening the file
   * instead of editing claude_desktop_config.json. The bundle holds no server code: its launcher starts the installed
   * app's own runtime (which already has the database, vector search and OCR libraries) on this library, and passes
   * stdio through. It therefore points at this install; install again if Cadrel Market is moved.
   */
  async buildClaudeExtension(): Promise<{ file: string; earlyHandshake: boolean }> {
    const c = this.mcpConfig();
    // Claude Desktop wants the handshake answered within a fraction of a second; the server takes longer than that to start, so the launcher
    // answers it from what the server itself reports and hands over when the server is ready (see launcher.ts)
    const handshake = await (this.opts.mcpHandshake ? this.opts.mcpHandshake() : readHandshake(c));
    const brand = this.opts.mcpBrand ?? MARKET_BRAND;
    const launcher = launcherSource({ label: brand.name, command: c.command, args: c.args, env: c.env, handshake, logFile: path.join(this.opts.userData, 'logs', 'mcp-launcher.log') });
    const manifest = {
      manifest_version: '0.2',
      name: brand.id,
      display_name: brand.name,
      version: /^\d+\.\d+\.\d+/.test(this.opts.version ?? '') ? this.opts.version : '0.0.0',
      description: brand.description,
      author: { name: brand.name },
      icon: 'icon.png',
      server: { type: 'node', entry_point: 'server/launch.js', mcp_config: { command: 'node', args: ['${__dirname}/server/launch.js'] } },
      compatibility: { platforms: [process.platform] },
    };
    const files: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'server/launch.js': strToU8(launcher) };
    const icon = this.opts.iconFile?.();
    if (icon && fs.existsSync(icon)) files['icon.png'] = new Uint8Array(fs.readFileSync(icon));
    else delete (manifest as { icon?: string }).icon, (files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2)));
    fs.mkdirSync(this.opts.userData, { recursive: true });
    const file = path.join(this.opts.userData, brand.file);
    fs.writeFileSync(file, zipSync(files, { level: 9 }));
    return { file, earlyHandshake: handshake !== null };
  }

  onIndex(cb: () => void): () => void {
    this.indexListeners.add(cb);
    return () => this.indexListeners.delete(cb);
  }

  onCapture(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Raw (scrubbed) HTML of a book's newest capture; for a "view source" panel later. */
  rawHtml(asin: string): string | null {
    const d = this.book(asin);
    return d ? zlib.gunzipSync(fs.readFileSync(path.join(this.need().root, d.rawDir, 'page.html.gz'))).toString('utf8') : null;
  }
}
