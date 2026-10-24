import type { ContentMetrics } from '@cadrel/market-core';
import type { HealthRow, VerifyReport } from '@cadrel/market-library';
import type { Exclusion, RemovedBook, KeywordHistoryRow, KeywordIdea, KeywordString, CommunityInsights, ThreadRef, OwnBookRow, CalibrationPreview, Calibration, ImportSummary, SalesStatus, KuBook, CommunitySource, SyncResult, KeywordTable, KeywordRow, SearchCompetition, SuggestSource } from '@cadrel/market-library';
import type { Payout, PaymentOwed, Rollup, AnalysisReport, DetectedAuthor, MonthReport, PaymentsReport, Person, SplitVersion, Statement, StatementBasis } from '@cadrel/market-library';
import type { BookDetail, BookRow, CategoryReport, CategorySummary, ManuscriptRow, QueueItem, SampleSession, Weights, Opportunity, OpportunityWeights, SalesCurve } from '@cadrel/market-library';

export type { Exclusion, RemovedBook, KeywordHistoryRow, KeywordIdea, KeywordString, CommunityInsights, ThreadRef, OwnBookRow, CalibrationPreview, Calibration, ImportSummary, SalesStatus, KuBook, CommunitySource, SyncResult, KeywordTable, KeywordRow, SearchCompetition, SuggestSource };
export type { Payout, PaymentOwed, Rollup, AnalysisReport, DetectedAuthor, MonthReport, PaymentsReport, Person, SplitVersion, Statement, StatementBasis };
export type { HealthRow, VerifyReport, ContentMetrics, BookDetail, BookRow, CategoryReport, CategorySummary, ManuscriptRow, QueueItem, SampleSession, Weights, Opportunity, OpportunityWeights, SalesCurve };

export interface Status {
  libraryRoot: string | null;
  port: number;
  serverRunning: boolean;
  serverError: string | null;
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
  /** Closing the window keeps BookScout running in the tray, so the extension can still send pages. */
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
  /** Writes BookScout.mcpb and shows it in its folder, ready to install from Claude Desktop (Settings → Extensions). */
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
  /** What has been imported for calibration: days of sales, books, and how many rank readings can be paired with them. */
  salesStatus(): Promise<SalesStatus>;
  /** Months with any imported sales, royalties or KENP, newest first. */
  moneyMonths(): Promise<string[]>;
  /** Earnings, units and KENP for a span of months ('2026-01' to '2026-10'): by month, book, marketplace and royalty type. */
  moneyAnalysis(from: string, to: string): Promise<AnalysisReport>;
  /** Everything for one month, with the previous month and the same month last year for comparison. */
  moneyMonth(month: string): Promise<MonthReport>;
  /** The people who are paid royalties, and the pen names each writes under. */
  people(): Promise<Person[]>;
  savePerson(p: { id?: number; name: string; penNames?: string[] }): Promise<Person>;
  /** Throws when the person is in a book's split. */
  deletePerson(id: number): Promise<void>;
  /** The versions of a book's royalty split, oldest first. */
  bookSplit(asin: string): Promise<SplitVersion[]>;
  allSplits(): Promise<Record<string, SplitVersion[]>>;
  /** Author names found on your books (the names KDP reports and the authors credited on captured pages), with the books each is on and the person it already belongs to. */
  detectedAuthors(): Promise<DetectedAuthor[]>;
  /** Save a split (shares add up to 100; each names a person by id, or by author name, which finds or creates the person) from a month on ('YYYY-MM'; omitted means every month). An empty list removes the book's split. */
  setBookSplit(asin: string, shares: { personId?: number; name?: string; pct: number }[], fromMonth?: string): Promise<void>;
  /** What each author is owed for a span of months. KENP of the current month is pending and not included. */
  statement(from: string, to: string, basis: StatementBasis): Promise<Statement>;
  /** The payments imported from KDP payment reports with their lines, what does not reconcile with the royalty reports, and what is earned but unpaid. */
  payments(): Promise<PaymentsReport>;
  /** The calculator for one payment: what each author is owed from it (after tax), and its allocation if it has one. */
  paymentOwed(number: string): Promise<PaymentOwed>;
  /** Freeze what each author is owed from a payment; allocating again replaces it. */
  allocatePayment(number: string): Promise<PaymentOwed>;
  unallocatePayment(number: string): Promise<void>;
  /** Save one payment's calculator as CSV (one author or all) or PDF (one author; null writes one PDF per author into a chosen folder). */
  exportPayment(number: string, kind: 'csv' | 'pdf', payee: string | null): Promise<string | null>;
  /** What to pay each author for a period: payments dated in it, plus unpaid balances from before, less what was paid out. */
  payoutRollup(from: string, to: string): Promise<Rollup>;
  /** Allocate every unallocated payment dated in the period; returns their numbers. */
  allocateRollup(from: string, to: string): Promise<string[]>;
  /** Save the roll-up as CSV (one author or all) or as each author's payout statement PDF. */
  exportRollup(from: string, to: string, kind: 'csv' | 'pdf', payee: string | null): Promise<string | null>;
  /** What has been paid out to authors. */
  payouts(): Promise<Payout[]>;
  /** Record a payment made to an author, for the period (its first month) it settles. */
  recordPayout(p: { payee: string; paidOn: string; usd: number; period: string; note?: string }): Promise<Payout>;
  deletePayout(id: number): Promise<void>;
  /** Forget one imported payment (its number as shown). */
  removePayment(number: string): Promise<void>;
  /** Save a statement as CSV (one author or all) or PDF (one author; null writes one PDF per author into a chosen folder). Returns where it went, or null if cancelled. */
  exportStatement(from: string, to: string, kind: 'csv' | 'pdf', payee: string | null, basis: StatementBasis): Promise<string | null>;
  /** The USD value of one unit of a currency for a month; null goes back to the default. */
  setFxRate(month: string, currency: string, toUsd: number | null): Promise<void>;
  /** The Kindle Unlimited rate per page for a month and currency; null goes back to KDP's figure (or the estimate). */
  setKenpRate(month: string, currency: string, rate: number | null): Promise<void>;
  /** A KDP Orders report (.xlsx or .csv); the renderer reads the file and passes its bytes. */
  importSales(name: string, bytes: Uint8Array): Promise<ImportSummary>;
  /** A rank-history file; `asin` names the book when the file has no ASIN column. */
  importRanks(name: string, bytes: Uint8Array, asin?: string): Promise<ImportSummary>;
  /** The paired readings, the fit, and how it compares with the published methods. Changes nothing. */
  calibrationPreview(opts?: { includeKu?: boolean }): Promise<CalibrationPreview>;
  /** Fit and use the curve for every estimate. Throws (with the reason) when there is not enough data. */
  applyCalibration(opts?: { includeKu?: boolean }): Promise<Calibration>;
  /** A book's KENPC (its page count in Kindle Unlimited, from the KDP Bookshelf); null removes it. */
  setKenpc(asin: string, kenpc: number | null): Promise<void>;
  /** The share of a book the average borrower is assumed to read, 0.1 to 1; returns the saved value. */
  setKuCompletion(share: number): Promise<number>;
  /** Back to BookScout's default curve and the published-methods range. */
  resetCalibration(): Promise<void>;
  /** Forget imported sales and rank files (the books and pages stay). */
  clearSalesData(): Promise<void>;
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
  /** Subscribe to "something was captured"; returns an unsubscribe function. */
  onCapture(cb: () => void): () => void;
  /** The application menu asked to show a page (currently only "about"); returns an unsubscribe function. */
  onNavigate(cb: (page: string) => void): () => void;
}

export const CHANNELS = [
  'status', 'chooseLibrary', 'setPort', 'token', 'rotateToken', 'categories', 'books', 'book', 'cover', 'issues',
  'queue', 'openNext', 'openBook', 'openShelf', 'setQueueState', 'excludeFromCategory', 'restoreToCategory', 'categoryExclusions', 'bookLists', 'removeBook', 'revealBook', 'rebuild', 'analysis', 'exportCategory', 'successWeights', 'setSuccessWeights', 'rankCategories', 'opportunityWeights', 'setOpportunityWeights', 'salesCurve', 'setSalesCurve', 'maintenanceStatus', 'verifyLibrary', 'parserHealth', 'backupLibrary', 'moveLibrary', 'exportData', 'importData', 'pairingCode', 'openExtensionFolder', 'openLogs', 'settings', 'setSettings', 'bookText', 'attachManuscript', 'attachManuscriptPath', 'removeText', 'readSample', 'indexStatus', 'buildIndex', 'mcpConfig', 'installClaudeExtension', 'appInfo', 'communitySources', 'addCommunitySource', 'removeCommunitySource', 'syncCommunity', 'communityStatus', 'stopCommunity', 'keywordTable', 'keywordLookup', 'keywordStatus', 'keywordHistory', 'removeKeywordHistory', 'clearKeywordHistory', 'keywordIdeas', 'keywordStrings', 'stopKeywords', 'importTrends', 'removeTrend', 'openTrends', 'openAmazonSearch', 'communityInsights', 'openThread', 'ownBooks', 'ownBook', 'setOwnBook', 'salesStatus', 'moneyMonths', 'moneyAnalysis', 'moneyMonth', 'people', 'savePerson', 'deletePerson', 'bookSplit', 'allSplits', 'detectedAuthors', 'setBookSplit', 'statement', 'payments', 'removePayment', 'paymentOwed', 'allocatePayment', 'unallocatePayment', 'exportPayment', 'payoutRollup', 'allocateRollup', 'exportRollup', 'payouts', 'recordPayout', 'deletePayout', 'exportStatement', 'setFxRate', 'setKenpRate', 'importSales', 'importRanks', 'calibrationPreview', 'applyCalibration', 'setKenpc', 'setKuCompletion', 'resetCalibration', 'clearSalesData', 'updateState', 'checkForUpdates', 'installUpdate', 'openReleasePage', 'githubTokenStatus', 'setGithubToken',
] as const satisfies readonly (keyof Api)[];
