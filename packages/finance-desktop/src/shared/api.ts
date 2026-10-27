/**
 * Cadrel Finance: what the Finance view may ask of the main process. The data is Market's library (KDP reports, royalties, splits,
 * payments, payouts) and stays there for now; Finance reaches it through this interface alone, so a later move to the Studio's own
 * store changes nothing on the screens. Types come from where the data layer defines them.
 */
import type {
  AnalysisReport, BookPayments, Calibration, CalibrationPreview, DetectedAuthor, ImportSummary, MonthReport, OwnBookRow, PaymentOwed, PaymentsReport, Payout, Person,
  Rollup, SalesStatus, SplitVersion, Statement, StatementBasis
} from '@cadrel/market-desktop/src/shared/api.js';

export type {
  AnalysisReport, BookPayments, Calibration, CalibrationPreview, DetectedAuthor, ImportSummary, MonthReport, OwnBookRow, PaymentOwed, PaymentsReport, Payout, Person,
  Rollup, SalesStatus, SplitVersion, Statement, StatementBasis
};

export interface FinanceApi {
  /** Is there a Market library to read from? Finance has nothing to show until there is one. */
  ready(): Promise<boolean>;
  /** The books Market knows as the studio's own: the one thing Finance reads of Market's own records. Never written from here. */
  ownBooks(): Promise<OwnBookRow[]>;
  /** Asks Market to open the book's Amazon page, so the extension can capture the authors credited on it. */
  openBook(asin: string): Promise<void>;
  /** What has been imported for calibration: days of sales, books, and how many rank readings can be paired with them. */
  salesStatus(): Promise<SalesStatus>;
  /** Months with any imported sales, royalties or KENP, newest first. */
  moneyMonths(): Promise<string[]>;
  /** Earnings, units and KENP for a span of months ('2026-01' to '2026-10'): by month, book, marketplace and royalty type. */
  moneyAnalysis(from: string, to: string, asin?: string): Promise<AnalysisReport>;
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
  statement(from: string, to: string, basis: StatementBasis, asin?: string): Promise<Statement>;
  /** The payments imported from KDP payment reports with their lines, what does not reconcile with the royalty reports, and what is earned but unpaid. */
  payments(): Promise<PaymentsReport>;
  /** The calculator for one payment: what each author is owed from it (after tax), and its allocation if it has one. */
  paymentOwed(number: string, asin?: string): Promise<PaymentOwed>;
  /** Every payment one book is in, with its part of each, and what it has earned that no payment covers yet. */
  bookPayments(asin: string): Promise<BookPayments>;
  /** Freeze what each author is owed from a payment; allocating again replaces it. */
  allocatePayment(number: string): Promise<PaymentOwed>;
  unallocatePayment(number: string): Promise<void>;
  /** Save one payment's calculator as CSV (one author or all) or PDF (one author; null writes one PDF per author into a chosen folder). */
  exportPayment(number: string, kind: 'csv' | 'pdf', payee: string | null, asin?: string): Promise<string | null>;
  /** What to pay each author for a period: payments dated in it, plus unpaid balances from before, less what was paid out. */
  payoutRollup(from: string, to: string, asin?: string): Promise<Rollup>;
  /** Allocate every unallocated payment dated in the period; returns their numbers. */
  allocateRollup(from: string, to: string): Promise<string[]>;
  /** Save the roll-up as CSV (one author or all) or as each author's payout statement PDF. */
  exportRollup(from: string, to: string, kind: 'csv' | 'pdf', payee: string | null, asin?: string): Promise<string | null>;
  /** What has been paid out to authors. */
  payouts(): Promise<Payout[]>;
  /** Record a payment made to an author, for the period (its first month) it settles. */
  recordPayout(p: { payee: string; paidOn: string; usd: number; period: string; note?: string }): Promise<Payout>;
  deletePayout(id: number): Promise<void>;
  /** Forget one imported payment (its number as shown). */
  removePayment(number: string): Promise<void>;
  /** Save a statement as CSV (one author or all) or PDF (one author; null writes one PDF per author into a chosen folder). Returns where it went, or null if cancelled. */
  exportStatement(from: string, to: string, kind: 'csv' | 'pdf', payee: string | null, basis: StatementBasis, asin?: string): Promise<string | null>;
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
  /** Back to Cadrel Market's default curve and the published-methods range. */
  resetCalibration(): Promise<void>;
  /** Forget imported sales and rank files (the books and pages stay). */
  clearSalesData(): Promise<void>;
  /** Saves one book's earnings by month as a spreadsheet (the same file My Books saves). Returns where it went, or null if cancelled. */
  exportBookEarnings(asin: string): Promise<string | null>;
  /** Subscribe to "something was captured or imported" so figures reload; returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
  /** Another page asked Finance to show something (`book:<ASIN>`: that book's page); returns an unsubscribe function. */
  onNavigate(cb: (page: string) => void): () => void;
}

export const CHANNELS = ['ready', 'bookPayments', 'exportBookEarnings', 'ownBooks', 'openBook', 'salesStatus', 'moneyMonths', 'moneyAnalysis', 'moneyMonth', 'people', 'savePerson', 'deletePerson', 'bookSplit', 'allSplits', 'detectedAuthors', 'setBookSplit', 'statement', 'payments', 'paymentOwed', 'allocatePayment', 'unallocatePayment', 'exportPayment', 'payoutRollup', 'allocateRollup', 'exportRollup', 'payouts', 'recordPayout', 'deletePayout', 'removePayment', 'exportStatement', 'setFxRate', 'setKenpRate', 'importSales', 'importRanks', 'calibrationPreview', 'applyCalibration', 'setKenpc', 'setKuCompletion', 'resetCalibration', 'clearSalesData'] as const satisfies readonly (keyof FinanceApi)[];
