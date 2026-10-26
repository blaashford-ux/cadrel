import type { Db } from '../schema.js';
import { DEFAULT_SALES_CURVE, estimateDailySales, getSalesCurve, type SalesCurve } from '../analysis/opportunity.js';

/**
 * Published rank-to-sales rules disagree by a factor of two or more, so a single number overstates what is known.
 * Until the user calibrates against their own sales, an estimate is given as the spread across these methods.
 */
export interface Method {
  id: string;
  label: string;
  /** Estimated paid sales per day at a rank. */
  at(rank: number): number;
}

const bookwriterPoints: [number, number][] = [[1, 1500], [1000, 148], [10000, 15], [100000, 1.5]];

/** Log-log interpolation between published points, extended past the last one at the last segment's slope. */
function interpolate(points: [number, number][], rank: number): number {
  let k = points.findIndex(([r]) => r >= rank);
  k = k === -1 ? points.length - 1 : Math.max(k, 1);
  const [r0, v0] = points[k - 1]!;
  const [r1, v1] = points[k]!;
  const slope = (Math.log(v1) - Math.log(v0)) / (Math.log(r1) - Math.log(r0));
  return Math.exp(Math.log(v0) + slope * (Math.log(rank) - Math.log(r0)));
}

export const METHODS: Method[] = [
  { id: 'cadrel-market', label: 'Cadrel Market default (fitted by eye)', at: (r) => estimateDailySales(r, DEFAULT_SALES_CURVE) },
  { id: 'automateed', label: 'Automateed power-law fit', at: (r) => (r < 100 ? 7000 / r ** 0.42 : 76900 / r ** 0.94) },
  { id: 'bookwriter', label: 'Bookwriter point estimates', at: (r) => interpolate(bookwriterPoints, r) },
];

export interface SalesRange {
  low: number;
  mid: number;
  high: number;
  /** methods: the spread of published rules; calibrated: the user's own fit and its scatter; custom: a hand-edited curve with the methods' relative spread. */
  basis: 'methods' | 'calibrated' | 'custom';
  /** Whether the figures include Kindle Unlimited borrows (only a calibration that used them does). */
  includesKu: boolean;
}

export interface Calibration {
  a: number;
  b: number;
  /** How the curve was fitted: slope and level, or level only with the default slope. */
  mode: 'fitted' | 'fixed-slope';
  n: number;
  books: number;
  /** True when the fit counts estimated Kindle Unlimited borrows as sales, so estimates are "sales + borrows" per day, not paid sales alone. */
  includesKu: boolean;
  /** Share of a book the average borrower is assumed to read (1 = all of it) when turning pages read into borrows; 1 gives the fewest borrows. */
  completion: number;
  /** Typical multiplicative scatter of the user's points around the fit (about two-thirds fall within ×/÷ this). */
  spread: number;
  rankMin: number;
  rankMax: number;
  fittedAt: string;
}

const round = (x: number) => Math.round(x * 100) / 100;
const geoMean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

export function getCalibration(db: Db): Calibration | null {
  try {
    const c = JSON.parse(db.scalar<string>("SELECT value FROM kv WHERE key = 'sales_calibration'") ?? 'null') as Calibration | null;
    if (!c) return null;
    // a curve edited by hand after the fit no longer is the fit
    const cur = getSalesCurve(db);
    return Math.abs(cur.a - c.a) < 1e-6 && Math.abs(cur.b - c.b) < 1e-9 ? c : null;
  } catch {
    return null;
  }
}

export function saveCalibration(db: Db, c: Calibration): void {
  db.prepare("INSERT INTO kv (key, value) VALUES ('sales_calibration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(c));
}

export function clearCalibration(db: Db): void {
  db.prepare("DELETE FROM kv WHERE key = 'sales_calibration'").run();
}

export function isDefaultCurve(c: SalesCurve): boolean {
  return Math.abs(c.a - DEFAULT_SALES_CURVE.a) < 1e-6 && Math.abs(c.b - DEFAULT_SALES_CURVE.b) < 1e-9;
}

/** Low, middle and high estimates of paid Kindle sales per day at a Kindle Store overall rank. */
export function estimateSalesRange(db: Db, rank: number): SalesRange {
  if (!(rank >= 1)) throw new Error('rank must be 1 or more');
  const est = METHODS.map((m) => m.at(rank));
  const mm = geoMean(est);
  const cal = getCalibration(db);
  if (cal) {
    const mid = estimateDailySales(rank, cal);
    return { low: round(mid / cal.spread), mid: round(mid), high: round(mid * cal.spread), basis: 'calibrated', includesKu: !!cal.includesKu };
  }
  const curve = getSalesCurve(db);
  if (!isDefaultCurve(curve)) {
    const mid = estimateDailySales(rank, curve);
    return { low: round(mid * (Math.min(...est) / mm)), mid: round(mid), high: round(mid * (Math.max(...est) / mm)), basis: 'custom', includesKu: false };
  }
  return { low: round(Math.min(...est)), mid: round(mm), high: round(Math.max(...est)), basis: 'methods', includesKu: false };
}
