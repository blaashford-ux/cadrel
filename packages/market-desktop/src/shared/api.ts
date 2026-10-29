import type { ContentMetrics } from '@cadrel/market-core';
import type { HealthRow, VerifyReport } from '@cadrel/market-library';
import type { Exclusion, RemovedBook, KeywordHistoryRow, KeywordIdea, KeywordString, InjectedSuggestion, OutlineRef, CommunityInsights, ThreadRef, OwnBookRow, CalibrationPreview, Calibration, ImportSummary, SalesStatus, KuBook, CommunitySource, SyncResult, KeywordTable, KeywordRow, SearchCompetition, SuggestSource } from '@cadrel/market-library';
import type { Payout, PaymentOwed, Rollup, AnalysisReport, DetectedAuthor, MonthReport, PaymentsReport, BookPayments, Person, SplitVersion, Statement, StatementBasis } from '@cadrel/market-library';
import type { BookDetail, BookRow, CategoryReport, CategorySummary, ManuscriptRow, QueueItem, SampleSession, Weights, Opportunity, OpportunityWeights, SalesCurve } from '@cadrel/market-library';

export type { Exclusion, RemovedBook, KeywordHistoryRow, KeywordIdea, KeywordString, InjectedSuggestion, OutlineRef, CommunityInsights, ThreadRef, OwnBookRow, CalibrationPreview, Calibration, ImportSummary, SalesStatus, KuBook, CommunitySource, SyncResult, KeywordTable, KeywordRow, SearchCompetition, SuggestSource };
export type { Payout, PaymentOwed, Rollup, AnalysisReport, DetectedAuthor, MonthReport, PaymentsReport, BookPayments, Person, SplitVersion, Statement, StatementBasis };
export type { HealthRow, VerifyReport, ContentMetrics, BookDetail, BookRow, CategoryReport, CategorySummary, ManuscriptRow, QueueItem, SampleSession, Weights, Opportunity, OpportunityWeights, SalesCurve };

export interface Status {
  libraryRoot: string | null;
  port: number;
  serverRunning: boolean;
  serverError: string | null;
  /** The program holding the port when the capture server could not start because of it, if that could be found out. */
  portHolder: { pid: number; name: string } | null;
}

export interface IndexStatus {
  chunks: number;
  embedded: number;
  /** Id of the embedding model the stored vectors came from, or null if none yet. */
  model: string | null;
  vectorSearch: boolean;
  modelDownloaded: boolean;
  running: boolean;
  progress: { phase: 'download' | 'embed'; done: number; total: number } | null;
  error: string | null;
}

/** A running community sync, for the progress display. */
export interface CommunityJob {
  categoryKey: string;
  subreddit: string;
  /** Which of the category's subreddits this is (0-based) out of how many. */
  subredditIndex: number;
  subredditCount: number;
  step: string;
  /** The day of the week being read (1-based) of `days`. */
  day: number;
  days: number;
  /** Kept so far in this run. */
  threads: number;
  comments: number;
  requests: number;
  startedAt: number;
  stopping: boolean;
}

/** A running autocomplete lookup, for the progress display. */
export interface KeywordJob {
  seed: string;
  source: SuggestSource;
  sourceIndex: number;
  sourceCount: number;
  done: number;
  total: number;
  startedAt: number;
  stopping: boolean;
}

export interface KeywordLookupResult {
  table: KeywordTable;
  /** One note per source asked: whether it came from the cache, and why it stopped early if it did. */
  notes: { source: SuggestSource; cached: boolean; requests: number; stopped: string | null; fetchedAt: string; count: number }[];
  /** Set when no source had suggestions for the phrase asked about, so a shorter one was looked up and `table` is for that. */
  fallback?: { requested: string; used: string };
}

export interface TextJob {
  asin: string;
  phase: 'reading' | 'ocr';
  done: number;
  total: number;
}

export interface BookText {
  manuscripts: ManuscriptRow[];
  /** Screenshot sessions captured from the free sample, with how many pages are already read. */
  sampleSessions: { session: string; pages: number; read: number }[];
  /** Metrics for the text that analysis uses (the manuscript if there is one, otherwise the sample). */
  metrics: { source: 'upload' | 'sample'; metrics: ContentMetrics } | null;
  job: TextJob | null;
  error: string | null;
}

export interface MaintenanceStatus {
  kind: 'rebuild' | 'backup' | 'move' | 'export' | 'import' | null;
  done: number;
  total: number;
  error: string | null;
  /** Result of the last finished job, in words. */
  message: string | null;
}

export interface AppSettings {
  /** Closing the window keeps Cadrel Market running in the tray, so the extension can still send pages. */
  keepRunningInTray: boolean;
  startWithWindows: boolean;
  /** Autocomplete sources the keyword explorer may ask. Each is only contacted when the user presses Look up. */
  suggestAmazon: boolean;
  suggestGoogle: boolean;
  suggestBing: boolean;
}

export interface McpSnippets {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Ready-to-paste text for each client. */
  claudeDesktop: string;
  claudeCode: string;
  codex: string;
}

export type { AppInfo, UpdateState, TokenStatus } from '../main/service.js';
import type { AppInfo, UpdateState, TokenStatus } from '../main/service.js';

export interface IssueRow {
  source: string;
  ref: string;
  field: string;
  severity: string;
  detail: string | null;
}

/** Everything the renderer may ask of the main process. Implemented by AppService, exposed through preload. */
export interface Api {
  status(): Promise<Status>;
  /** Native folder picker, then switch to that library. Returns false if the user cancelled. */
  chooseLibrary(): Promise<boolean>;
  setPort(port: number): Promise<Status>;
  token(): Promise<string>;
  rotateToken(): Promise<string>;
  categories(): Promise<CategorySummary[]>;
  books(opts?: { categoryKey?: string; search?: string }): Promise<BookRow[]>;
  book(asin: string): Promise<BookDetail | null>;
  cover(asin: string): Promise<string | null>;
  issues(): Promise<IssueRow[]>;
  queue(opts?: { categoryKey?: string; includeSkipped?: boolean }): Promise<QueueItem[]>;
  /** Opens the next pending book's page in the browser and marks it opened. Null when nothing is pending. */
  openNext(categoryKey?: string): Promise<QueueItem | null>;
  openBook(asin: string): Promise<void>;
  /** Opens the category's Best Sellers page on Amazon in the browser. */
  openShelf(categoryKey: string): Promise<void>;
  setQueueState(asin: string, state: 'pending' | 'skipped' | 'opened'): Promise<void>;
  /** Take a book out of one category's lists (wrong genre) and keep it out of every analysis, search and the MCP there. Captured books stay in the library. */
  excludeFromCategory(asin: string, categoryKey: string): Promise<void>;
  /** Undo that: the book's rows come back from the stored list captures. */
  restoreToCategory(asin: string, categoryKey: string): Promise<void>;
  /** Books taken out of categories (one category, or all), newest first. */
  categoryExclusions(categoryKey?: string): Promise<Exclusion[]>;
  /** The categories whose newest lists carry the book. */
  bookLists(asin: string): Promise<{ key: string; name: string | null }[]>;
  /** Delete a mistakenly captured book (pages, covers, text, notes, files); with alsoExclude it is also taken out of every category it is listed in. */
  removeBook(asin: string, alsoExclude?: boolean): Promise<RemovedBook>;
  revealBook(asin: string): Promise<void>;
  rebuild(): Promise<{ detail: number; list: number; search: number }>;
  maintenanceStatus(): Promise<MaintenanceStatus>;
  onMaintenance(cb: () => void): () => void;
  verifyLibrary(): Promise<VerifyReport>;
  parserHealth(): Promise<HealthRow[]>;
  /** Choose a folder and copy the library there. Null if cancelled. */
  backupLibrary(): Promise<string | null>;
  /** Choose where to save a data pack of the given categories (null: everything) and write it. Null if cancelled. */
  exportData(categoryKeys: string[] | null): Promise<string | null>;
  /** Choose a data pack and add its pages to the library. Null if cancelled. */
  importData(): Promise<{ added: number; alreadyHad: number; skipped: number } | null>;
  /** Choose a folder, copy the library there, and switch to the copy. The old folder is left in place. Null if cancelled. */
  moveLibrary(): Promise<string | null>;
  /** A 6-digit code that the browser extension can exchange for the token; valid for two minutes. */
  pairingCode(): Promise<{ code: string; expiresAt: number }>;
  openExtensionFolder(): Promise<string>;
  openLogs(): Promise<void>;
  settings(): Promise<AppSettings>;
  setSettings(s: Partial<AppSettings>): Promise<AppSettings>;
  /** The full analysis of one category (also analyses any new covers first). */
  analysis(categoryKey: string, topN: number): Promise<CategoryReport>;
  /** Save the category as a spreadsheet (csv) or a readable report (md). Resolves to the saved path, or null if cancelled. */
  exportCategory(categoryKey: string, kind: 'csv' | 'md', topN: number): Promise<string | null>;
  successWeights(): Promise<Weights>;
  setSuccessWeights(w: Weights): Promise<Weights>;
  /** Every category with a list capture, best opportunity first. */
  rankCategories(topN: number): Promise<Opportunity[]>;
  opportunityWeights(): Promise<OpportunityWeights>;
  setOpportunityWeights(w: OpportunityWeights): Promise<OpportunityWeights>;
  /** The rank-to-sales curve (sales per day = a * rank^-b) behind every sales estimate. */
  salesCurve(): Promise<SalesCurve>;
  setSalesCurve(c: SalesCurve): Promise<SalesCurve>;
  bookText(asin: string): Promise<BookText>;
  /** Pick a PDF, EPUB, Word or text file and attach it. Resolves to null if the picker was cancelled. */
  attachManuscript(asin: string): Promise<BookText | null>;
  /** Attach a file the user dropped onto the book (the path comes from the preload's pathForFile). */
  attachManuscriptPath(asin: string, filePath: string): Promise<BookText>;
  removeText(asin: string, source: 'upload' | 'sample'): Promise<BookText>;
  /** Read the screenshots of a sample session (the newest if none is given). */
  readSample(asin: string, session?: string): Promise<BookText>;
  onText(cb: () => void): () => void;
  /** Path of a dropped File (Electron only exposes it through the preload). */
  pathForFile(file: File): string;
  indexStatus(): Promise<IndexStatus>;
  /** "neural" downloads the local model first (needs internet once); "basic" needs nothing but is weaker. */
  buildIndex(kind: 'neural' | 'basic'): Promise<IndexStatus>;
  mcpConfig(): Promise<McpSnippets>;
  /** Writes Cadrel Market.mcpb and shows it in its folder, ready to install from Claude Desktop (Settings → Extensions). */
  installClaudeExtension(): Promise<{ file: string; error: string | null }>;
  onIndex(cb: () => void): () => void;
  communitySources(categoryKey: string): Promise<CommunitySource[]>;
  addCommunitySource(categoryKey: string, subreddit: string): Promise<CommunitySource[]>;
  /** Also deletes the subreddit's stored text unless another category uses it. */
  removeCommunitySource(categoryKey: string, subreddit: string): Promise<CommunitySource[]>;
  /** Fetches the last 7 days of every linked subreddit (or one) and adds them to the library. */
  syncCommunity(categoryKey: string, subreddit?: string): Promise<SyncResult[]>;
  communityStatus(): Promise<CommunityJob | null>;
  /** Stops the running sync after saving the days already read; false if none is running. */
  stopCommunity(): Promise<boolean>;
  /** Everything stored about a phrase (autocomplete cache, Reddit mentions, Trends imports, captured searches). Makes no requests. */
  keywordTable(seed: string, categoryKey?: string): Promise<KeywordTable>;
  /** Asks the enabled autocomplete sources about the phrase (cache first), then returns the table. */
  keywordLookup(seed: string, opts?: { sources?: SuggestSource[]; force?: boolean; categoryKey?: string }): Promise<KeywordLookupResult>;
  keywordStatus(): Promise<KeywordJob | null>;
  /** The searches run on the Keywords tab, newest first, one row per phrase. */
  /** The searches run so far; with a category key, only those researched for it. */
  keywordHistory(categoryKey?: string): Promise<KeywordHistoryRow[]>;
  removeKeywordHistory(seed: string): Promise<void>;
  clearKeywordHistory(): Promise<void>;
  /** Five phrases worth searching for a captured category, from what the library holds, leaving out words already in the category and, given an ASIN, that book's title, subtitle and blurb. Makes no request. */
  keywordIdeas(categoryKey: string, asin?: string): Promise<KeywordIdea[]>;
  keywordStrings(categoryKey: string, asin?: string): Promise<KeywordString[]>;
  /** The outline documents found in the person's projects, and which one this category's suggestions are built on. */
  keywordOutlines(categoryKey: string): Promise<{ available: boolean; outlines: OutlineRef[]; chosen: { project: string; file: string } | null; readable: boolean }>;
  /** Builds the category's suggestions on this outline (null: on the category alone). */
  setKeywordOutline(categoryKey: string, ref: { project: string; file: string } | null): Promise<void>;
  /** Suggestions an AI tool sent in through the MCP server. */
  injectedSuggestions(categoryKey: string): Promise<InjectedSuggestion[]>;
  dismissInjectedSuggestion(id: number): Promise<void>;
  stopKeywords(): Promise<boolean>;
  /** The text of a CSV saved by Google Trends' Download button. */
  /** Import a Google Trends CSV; with a category key its terms are filed under that category's keyword research. */
  importTrends(csv: string, categoryKey?: string): Promise<{ keywords: string[] }>;
  removeTrend(keyword: string): Promise<void>;
  /** Opens Google Trends comparing up to five terms in the browser. */
  openTrends(terms: string[]): Promise<void>;
  /** Opens an Amazon Kindle-store search in the browser, for capturing with the extension. */
  openAmazonSearch(keyword: string): Promise<void>;
  /** What the subreddits linked to the category talk about and ask for, from the synced threads and comments. */
  communityInsights(categoryKey: string): Promise<CommunityInsights>;
  /** Opens a Reddit thread (a reddit.com address from the analysis) in the browser. */
  openThread(url: string): Promise<void>;
  /** My Books: the user's own titles, including ones not captured yet. */
  ownBooks(): Promise<OwnBookRow[]>;
  /** One book if it is in My Books, else null. */
  ownBook(asin: string): Promise<OwnBookRow | null>;
  /** Add a book to My Books (by ASIN, captured or not) or remove it; imported sales data is kept. */
  setOwnBook(asin: string, own: boolean): Promise<void>;
  appInfo(): Promise<AppInfo>;
  updateState(): Promise<UpdateState>;
  /** Asks GitHub for the latest release. Problems are reported in the returned state, not thrown. */
  checkForUpdates(): Promise<UpdateState>;
  /** Downloads the installer from the release found by the last check, checks it, runs it and closes the app. */
  installUpdate(): Promise<UpdateState>;
  openReleasePage(): Promise<void>;
  githubTokenStatus(): Promise<TokenStatus>;
  /** A read-only GitHub token for seeing releases of a private repository; null removes it. */
  setGithubToken(token: string | null): Promise<TokenStatus>;
  /** Tries the capture server again, e.g. after freeing the port some other program was holding it on. Keeps the library open if it already is. */
  reconnect(): Promise<Status>;
  /** Stops the capture server deliberately, without closing the library, so the port is free right away for another program. */
  forceDisconnect(): Promise<Status>;
  /** Quits the program holding the capture server's port (looked up now) and starts the server. */
  freePort(): Promise<Status>;
  /** Subscribe to "something was captured"; returns an unsubscribe function. */
  onCapture(cb: () => void): () => void;
  /** The application menu asked to show a page (currently only "about"); returns an unsubscribe function. */
  onNavigate(cb: (page: string) => void): () => void;
}

export const CHANNELS = [
  'status', 'chooseLibrary', 'setPort', 'token', 'rotateToken', 'categories', 'books', 'book', 'cover', 'issues',
  'queue', 'openNext', 'openBook', 'openShelf', 'setQueueState', 'excludeFromCategory', 'restoreToCategory', 'categoryExclusions', 'bookLists', 'removeBook', 'revealBook', 'rebuild', 'analysis', 'exportCategory', 'successWeights', 'setSuccessWeights', 'rankCategories', 'opportunityWeights', 'setOpportunityWeights', 'salesCurve', 'setSalesCurve', 'maintenanceStatus', 'verifyLibrary', 'parserHealth', 'backupLibrary', 'moveLibrary', 'exportData', 'importData', 'pairingCode', 'openExtensionFolder', 'openLogs', 'settings', 'setSettings', 'bookText', 'attachManuscript', 'attachManuscriptPath', 'removeText', 'readSample', 'indexStatus', 'buildIndex', 'mcpConfig', 'installClaudeExtension', 'appInfo', 'communitySources', 'addCommunitySource', 'removeCommunitySource', 'syncCommunity', 'communityStatus', 'stopCommunity', 'keywordTable', 'keywordLookup', 'keywordStatus', 'keywordHistory', 'removeKeywordHistory', 'clearKeywordHistory', 'keywordIdeas', 'keywordStrings', 'keywordOutlines', 'setKeywordOutline', 'injectedSuggestions', 'dismissInjectedSuggestion', 'stopKeywords', 'importTrends', 'removeTrend', 'openTrends', 'openAmazonSearch', 'communityInsights', 'openThread', 'ownBooks', 'ownBook', 'setOwnBook', 'updateState', 'checkForUpdates', 'installUpdate', 'openReleasePage', 'githubTokenStatus', 'setGithubToken', 'reconnect', 'forceDisconnect', 'freePort',
] as const satisfies readonly (keyof Api)[];
