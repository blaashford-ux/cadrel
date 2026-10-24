import type { Db } from '../schema.js';
import { DEFAULT_SALES_CURVE, estimateDailySales, setSalesCurve } from '../analysis/opportunity.js';
import { getCompletion, kenpcFor, kuBooks, type KuBook } from './ku.js';
import { METHODS, getCalibration, saveCalibration, clearCalibration, type Calibration } from './range.js';

/**
 * Fit the rank-to-sales curve (sales/day = a * rank^-b) to the author's own sales. Each point pairs a rank reading from a
 * page the author captured (or an imported rank history) with the average paid units sold per day over the days ending
 * then. The fit is a least-squares line through log(rank) and log(units), so it weighs a book at rank 100,000 as much as
 * one at rank 1,000.
 */

export const WINDOW_DAYS = 3;
/** Fewest points for fitting the slope as well as the level. */
export const MIN_POINTS_SLOPE = 4;
/** Fewest points for fitting the level alone, keeping the default slope. */
export const MIN_POINTS_LEVEL = 2;
/** The slope is only trusted when the ranks span at least this factor. */
export const MIN_RANK_SPREAD = 4;

export interface CalibrationPoint {
  asin: string;
  day: string;
  rank: number;
  /** Units per day the rank is compared with: paid sales, plus estimated borrows in Kindle Unlimited mode. */
  unitsPerDay: number;
  paidPerDay: number;
  borrowsPerDay: number;
  source: 'capture' | 'import';
}

export interface PointSet {
  points: CalibrationPoint[];
  /** Readings dropped because the window had nothing to compare with (no paid sales, or in Kindle Unlimited mode no borrows either), or lay outside the imported days. */
  noSales: number;
  outsideRange: number;
  /** Kindle Unlimited mode only: books with pages read in a window but no page count, so their readings were dropped. */
  noKenpc: string[];
  /** No Orders report was imported, only KENP: paid units were taken as zero. */
  paidAssumedZero: boolean;
}

const DAY = 86400000;
const dayBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

export function calibrationPoints(db: Db, o: { windowDays?: number; includeKu?: boolean } = {}): PointSet {
  const windowDays = o.windowDays ?? WINDOW_DAYS;
  const includeKu = !!o.includeKu;
  const span = (t: string) => db.prepare(`SELECT MIN(day) AS f, MAX(day) AS t FROM ${t} WHERE marketplace = 'amazon.com'`).get() as { f: string | null; t: string | null };
  const orders = span('sales_day');
  const kenp = span('kenp_day');
  const out: PointSet = { points: [], noSales: 0, outsideRange: 0, noKenpc: [], paidAssumedZero: false };
  // paid sales are what the Orders report covers; a KU-only author may have nothing to import there
  let paidRange = orders;
  if (!orders.f) {
    if (!kenp.f) return out;
    paidRange = kenp;
    out.paidAssumedZero = true;
  }
  const paid = new Map<string, number>();
  for (const r of db.prepare("SELECT asin, day, paid_units AS u FROM sales_day WHERE marketplace = 'amazon.com'").all() as unknown as { asin: string; day: string; u: number }[]) paid.set(`${r.asin}|${r.day}`, r.u);
  const pages = new Map<string, number>();
  for (const r of db.prepare("SELECT asin, day, pages AS u FROM kenp_day WHERE marketplace = 'amazon.com'").all() as unknown as { asin: string; day: string; u: number }[]) pages.set(`${r.asin}|${r.day}`, r.u);
  const completion = getCompletion(db);
  const asins = new Set([...paid.keys(), ...pages.keys()].map((k) => k.slice(0, 10)));

  const obs: { asin: string; at: string; rank: number; source: 'capture' | 'import' }[] = [];
  for (const r of db.prepare(
    `SELECT s.asin, s.captured_at AS at, r.rank FROM snapshot s JOIN rank_entry r ON r.snapshot_id = s.id AND r.scope = 'overall' AND r.store = 'kindle'`,
  ).all() as unknown as { asin: string; at: string; rank: number }[]) if (asins.has(r.asin)) obs.push({ ...r, source: 'capture' });
  for (const r of db.prepare('SELECT asin, at, rank FROM rank_point').all() as unknown as { asin: string; at: string; rank: number }[]) if (asins.has(r.asin)) obs.push({ ...r, source: 'import' });

  // one point per book per day: several readings the same day are averaged on the log scale
  const byDay = new Map<string, { asin: string; day: string; logs: number[]; source: 'capture' | 'import' }>();
  for (const o of obs) {
    const day = o.at.slice(0, 10);
    const k = `${o.asin}|${day}`;
    const e = byDay.get(k) ?? { asin: o.asin, day, logs: [], source: o.source };
    e.logs.push(Math.log(o.rank));
    if (o.source === 'capture') e.source = 'capture';
    byDay.set(k, e);
  }
  const noKenpc = new Set<string>();
  for (const e of byDay.values()) {
    const first = dayBefore(e.day, windowDays - 1);
    const inPaid = e.day <= paidRange.t! && first >= paidRange.f!;
    const inKenp = !!kenp.f && e.day <= kenp.t! && first >= kenp.f;
    if (!inPaid || (includeKu && kenp.f && !inKenp)) { out.outsideRange++; continue; }
    let paidTotal = 0, pageTotal = 0;
    for (let i = 0; i < windowDays; i++) {
      const d = dayBefore(e.day, i);
      paidTotal += paid.get(`${e.asin}|${d}`) ?? 0; // a day missing inside the imported range had no orders
      pageTotal += pages.get(`${e.asin}|${d}`) ?? 0;
    }
    let borrows = 0;
    if (includeKu && pageTotal > 0) {
      const k = kenpcFor(db, e.asin);
      if (!k) { noKenpc.add(e.asin); continue; }
      borrows = pageTotal / (k.kenpc * completion);
    }
    if (paidTotal + borrows === 0) { out.noSales++; continue; }
    out.points.push({
      asin: e.asin, day: e.day, rank: Math.round(Math.exp(e.logs.reduce((a, x) => a + x, 0) / e.logs.length)),
      unitsPerDay: (paidTotal + borrows) / windowDays, paidPerDay: paidTotal / windowDays, borrowsPerDay: borrows / windowDays, source: e.source,
    });
  }
  out.noKenpc = [...noKenpc];
  out.points.sort((a, b) => a.rank - b.rank);
  return out;
}

export interface Fit extends Omit<Calibration, 'fittedAt' | 'includesKu' | 'completion'> {}

/** Least-squares fit in log space. Null when there are too few points to say anything. */
export function fitSalesCurve(points: { rank: number; unitsPerDay: number }[], fixedB = DEFAULT_SALES_CURVE.b): Fit | null {
  const p = points.filter((q) => q.rank >= 1 && q.unitsPerDay > 0).map((q) => ({ x: Math.log(q.rank), y: Math.log(q.unitsPerDay) }));
  const n = p.length;
  if (n < MIN_POINTS_LEVEL) return null;
  const ranks = points.map((q) => q.rank);
  const rankMin = Math.min(...ranks), rankMax = Math.max(...ranks);
  const mx = p.reduce((s, q) => s + q.x, 0) / n;
  const my = p.reduce((s, q) => s + q.y, 0) / n;
  const sxx = p.reduce((s, q) => s + (q.x - mx) ** 2, 0);

  let b = fixedB;
  let mode: Fit['mode'] = 'fixed-slope';
  if (n >= MIN_POINTS_SLOPE && rankMax / rankMin >= MIN_RANK_SPREAD && sxx > 1e-9) {
    const slope = -(p.reduce((s, q) => s + (q.x - mx) * (q.y - my), 0) / sxx);
    if (slope >= 0.5 && slope <= 1.3) { b = slope; mode = 'fitted'; }
  }
  const lnA = my + b * mx;
  const k = mode === 'fitted' ? 2 : 1;
  const sse = p.reduce((s, q) => s + (q.y - (lnA - b * q.x)) ** 2, 0);
  const sd = Math.sqrt(sse / Math.max(n - k, 1));
  return { a: Math.exp(lnA), b, mode, n, books: 0, spread: Math.min(Math.max(Math.exp(sd), 1.15), 10), rankMin, rankMax };
}

export interface FitRange { mid: number; low: number; high: number }

export interface ComparisonRow {
  rank: number;
  /** The published methods' lowest and highest estimate. */
  methodsLow: number;
  methodsHigh: number;
  /** The fit counting paid sales only, and the fit counting paid sales plus estimated borrows; null when that fit is not possible. */
  paid: FitRange | null;
  ku: FitRange | null;
}

export interface CalibrationPreview {
  /** The readings behind the selected fit. */
  points: CalibrationPoint[];
  noSales: number;
  outsideRange: number;
  noKenpc: { asin: string; title: string | null }[];
  paidAssumedZero: boolean;
  /** True when a KENP Read report is imported, so a Kindle Unlimited fit can be made. */
  kuAvailable: boolean;
  /** Which fit `fit` and `points` are: with Kindle Unlimited borrows counted as sales, or paid sales only. */
  includeKu: boolean;
  completion: number;
  fit: Fit | null;
  fitPaid: Fit | null;
  fitKu: Fit | null;
  /** Why there is no selected fit, in words. */
  reason: string | null;
  comparison: ComparisonRow[];
  /** Books with Kindle Unlimited data and the page count used for each. */
  kuBooks: KuBook[];
  /** What is applied now, or null while the published methods are in use. */
  current: Calibration | null;
}

const COMPARE_RANKS = [100, 1000, 10000, 100000];
const r2 = (x: number) => Math.round(x * 100) / 100;

function withBooks(fit: Fit | null, set: PointSet): Fit | null {
  if (fit) fit.books = new Set(set.points.map((q) => q.asin)).size;
  return fit;
}

export function calibrationPreview(db: Db, o: { includeKu?: boolean } = {}): CalibrationPreview {
  const kuAvailable = (db.scalar<number>('SELECT COUNT(*) FROM kenp_day') ?? 0) > 0;
  // with KENP data the default is to count borrows: they are how a Kindle Unlimited book gets its rank
  const includeKu = kuAvailable && (o.includeKu ?? true);
  const paidSet = calibrationPoints(db, { includeKu: false });
  const kuSet = kuAvailable ? calibrationPoints(db, { includeKu: true }) : null;
  const fitPaid = withBooks(fitSalesCurve(paidSet.points), paidSet);
  const fitKu = kuSet ? withBooks(fitSalesCurve(kuSet.points), kuSet) : null;
  const set = includeKu ? kuSet! : paidSet;
  const fit = includeKu ? fitKu : fitPaid;
  const range = (f: Fit | null, rank: number): FitRange | null => {
    if (!f) return null;
    const mid = estimateDailySales(rank, f);
    return { mid: r2(mid), low: r2(mid / f.spread), high: r2(mid * f.spread) };
  };
  const comparison = COMPARE_RANKS.map((rank): ComparisonRow => {
    const m = METHODS.map((x) => x.at(rank));
    return { rank, methodsLow: r2(Math.min(...m)), methodsHigh: r2(Math.max(...m)), paid: range(fitPaid, rank), ku: range(fitKu, rank) };
  });
  let reason: string | null = null;
  if (!fit) {
    reason = !set.points.length && !set.noSales && !set.outsideRange && !set.noKenpc.length
      ? 'Nothing to pair yet: import a KDP report, and capture your own book pages (or import a rank history).'
      : `Only ${set.points.length} usable reading${set.points.length === 1 ? '' : 's'}; ${MIN_POINTS_LEVEL} are the minimum. ${set.noSales} had ${includeKu ? 'no paid sales or borrows' : 'no paid sales'} in the ${WINDOW_DAYS} days before, ${set.outsideRange} fall outside the imported days${set.noKenpc.length ? `, and ${set.noKenpc.length} book${set.noKenpc.length === 1 ? ' has' : 's have'} pages read but no page count (set it below)` : ''}.`;
  }
  const title = (asin: string) => db.scalar<string>('SELECT title FROM book WHERE asin = ?', asin) ?? null;
  return {
    points: set.points, noSales: set.noSales, outsideRange: set.outsideRange, noKenpc: set.noKenpc.map((asin) => ({ asin, title: title(asin) })),
    paidAssumedZero: set.paidAssumedZero, kuAvailable, includeKu, completion: getCompletion(db), fit, fitPaid, fitKu, reason, comparison, kuBooks: kuBooks(db), current: getCalibration(db),
  };
}

/** Fit and apply: every estimate (competition, opportunity, MCP) then uses the fitted curve, with its scatter as the range. */
export function applyCalibration(db: Db, o: { includeKu?: boolean } = {}, now = new Date().toISOString()): Calibration {
  const prev = calibrationPreview(db, o);
  if (!prev.fit) throw new Error(prev.reason ?? 'not enough data to fit');
  const cal: Calibration = { ...prev.fit, includesKu: prev.includeKu, completion: prev.completion, fittedAt: now };
  db.transaction(() => {
    setSalesCurve(db, { a: cal.a, b: cal.b });
    saveCalibration(db, cal);
  })();
  return cal;
}

/** Back to the BookScout default curve and the published-methods range. */
export function resetCalibration(db: Db): void {
  db.transaction(() => {
    setSalesCurve(db, { ...DEFAULT_SALES_CURVE });
    clearCalibration(db);
  })();
}
