import type { Db } from '../schema.js';
import { fxRate, kenpRates, round2, thisMonth, type EarningSource, type EarningState } from './earnings.js';
import { bookAliases, marketplaceCurrency } from './royalty.js';
import { monthsBetween } from './splits.js';

/**
 * Reports on what the author's books earned: a period (the Analysis view) or one month with its comparisons (the Month view).
 * Money is shown in USD at each month's rate, and by source: eBook royalties, print royalties and Kindle Unlimited (KENP).
 * Kindle Unlimited money of the current month is "pending" (KDP has not priced it yet) and is kept out of the totals.
 */

export interface Money { usd: number; ebook: number; print: number; kenp: number }
const zero = (): Money => ({ usd: 0, ebook: 0, print: 0, kenp: 0 });

export interface AnalysisMonth extends Money { month: string; units: number; freeUnits: number; pages: number; state: EarningState }
export interface AnalysisBook extends Money { asin: string; title: string; units: number; pages: number; share: number; estimated: number }
export interface Slice { key: string; usd: number; units: number }

export interface AnalysisReport {
  from: string;
  to: string;
  totals: Money & { units: number; freeUnits: number; pages: number; estimated: number; pending: number };
  months: AnalysisMonth[];
  books: AnalysisBook[];
  marketplaces: Slice[];
  royaltyTypes: Slice[];
  transactions: Slice[];
  daily: { day: string; units: number; free: number; pages: number }[];
  /** Months in the period with no imported royalty sheet, so a gap in the reports is not mistaken for a month of no sales. */
  missingRoyalty: string[];
}

interface Detail { asin: string; month: string; source: EarningSource; marketplace: string; usd: number; units: number; pages: number; rtype: string; ttype: string; state: EarningState }

function details(db: Db, from: string, to: string, today: Date): Detail[] {
  const now = thisMonth(today);
  const out: Detail[] = [];
  const canon = bookAliases(db);
  for (const r of db.prepare(
    `SELECT asin, month, format, marketplace, currency, royalty_type AS rtype, transaction_type AS ttype, SUM(royalty) AS amount, SUM(net_units) AS units
       FROM royalty_month WHERE month >= ? AND month <= ? GROUP BY asin, month, format, marketplace, currency, rtype, ttype`,
  ).all(from, to) as unknown as { asin: string; month: string; format: string; marketplace: string; currency: string; rtype: string; ttype: string; amount: number; units: number }[]) {
    out.push({ asin: canon(r.asin), month: r.month, source: r.format === 'ebook' ? 'ebook' : 'print', marketplace: r.marketplace, usd: round2(r.amount * fxRate(db, r.month, r.currency).toUsd), units: r.units, pages: 0, rtype: r.rtype, ttype: r.ttype, state: 'final' });
  }
  const rates = kenpRates(db);
  for (const r of db.prepare(
    `SELECT asin, substr(day, 1, 7) AS month, marketplace, SUM(pages) AS pages FROM kenp_day WHERE substr(day, 1, 7) >= ? AND substr(day, 1, 7) <= ? GROUP BY asin, month, marketplace`,
  ).all(from, to) as unknown as { asin: string; month: string; marketplace: string; pages: number }[]) {
    const cur = marketplaceCurrency(r.marketplace);
    const rate = rates.get(`${r.month}|${cur}`)!;
    out.push({ asin: r.asin, month: r.month, source: 'kenp', marketplace: r.marketplace, usd: round2(r.pages * rate.rate * fxRate(db, r.month, cur).toUsd), units: 0, pages: r.pages, rtype: 'Kindle+', ttype: 'Kindle+', state: r.month >= now ? 'pending' : rate.state === 'final' ? 'final' : 'estimated' });
  }
  return out;
}

const titles = (db: Db, asins: string[]) => {
  const t = new Map<string, string>();
  for (const a of asins) t.set(a, db.scalar<string>('SELECT COALESCE((SELECT title FROM snapshot WHERE asin = ? ORDER BY captured_at DESC LIMIT 1), (SELECT title FROM own_book WHERE asin = ?))', a, a) ?? a);
  return t;
};

const add = (m: Money, source: EarningSource, usd: number) => { m[source] = round2(m[source] + usd); m.usd = round2(m.usd + usd); };

/** `asin` limits everything in the report to one book (its months, marketplaces, rates, daily units and pages). */
export function analysisReport(db: Db, range: { from: string; to: string; asin?: string }, today = new Date()): AnalysisReport {
  const rows = details(db, range.from, range.to, today).filter((d) => !range.asin || d.asin === range.asin);
  const totals = { ...zero(), units: 0, freeUnits: 0, pages: 0, estimated: 0, pending: 0 };
  const months = new Map<string, AnalysisMonth>();
  for (const m of monthsBetween(range.from, range.to)) months.set(m, { ...zero(), month: m, units: 0, freeUnits: 0, pages: 0, state: 'final' });
  const books = new Map<string, AnalysisBook>();
  const market = new Map<string, Slice>();
  const rtype = new Map<string, Slice>();
  const ttype = new Map<string, Slice>();
  const slice = (map: Map<string, Slice>, key: string, usd: number, units: number) => {
    const s = map.get(key) ?? { key, usd: 0, units: 0 };
    s.usd = round2(s.usd + usd); s.units += units; map.set(key, s);
  };
  for (const d of rows) {
    const mo = months.get(d.month)!;
    mo.units += d.units; mo.pages += d.pages;
    if (d.state === 'pending') { totals.pending = round2(totals.pending + d.usd); mo.state = 'pending'; continue; }
    if (d.state === 'estimated' && mo.state === 'final') mo.state = 'estimated';
    add(mo, d.source, d.usd);
    add(totals, d.source, d.usd);
    totals.units += d.units; totals.pages += d.pages;
    if (d.state === 'estimated') totals.estimated = round2(totals.estimated + d.usd);
    const b = books.get(d.asin) ?? { ...zero(), asin: d.asin, title: '', units: 0, pages: 0, share: 0, estimated: 0 };
    add(b, d.source, d.usd); b.units += d.units; b.pages += d.pages;
    if (d.state === 'estimated') b.estimated = round2(b.estimated + d.usd);
    books.set(d.asin, b);
    slice(market, d.marketplace, d.usd, d.units);
    slice(rtype, d.rtype || 'n/a', d.usd, d.units);
    slice(ttype, d.ttype, d.usd, d.units);
  }
  const t = titles(db, [...books.keys()]);
  for (const b of books.values()) { b.title = t.get(b.asin)!; b.share = totals.usd ? b.usd / totals.usd : 0; }
  const one = range.asin ? ' WHERE asin = ?' : '';
  const daily = db.prepare(
    `SELECT day, SUM(units) AS units, SUM(free) AS free, SUM(pages) AS pages FROM (
       SELECT day, paid_units AS units, free_units AS free, 0 AS pages FROM sales_day${one}
       UNION ALL SELECT day, 0, 0, pages FROM kenp_day${one}) WHERE substr(day, 1, 7) >= ? AND substr(day, 1, 7) <= ? GROUP BY day ORDER BY day`,
  ).all(...(range.asin ? [range.asin, range.asin] : []), range.from, range.to) as unknown as AnalysisReport['daily'];
  totals.freeUnits = daily.reduce((a, d) => a + d.free, 0);
  for (const d of daily) { const mo = months.get(d.day.slice(0, 7)); if (mo) mo.freeUnits += d.free; }
  // KDP's Summary lists every month, with 0 for the quiet ones, while the royalty sheets list only months with sales
  const have = new Set((db.prepare('SELECT month FROM royalty_month UNION SELECT month FROM kdp_summary').all() as unknown as { month: string }[]).map((r) => r.month));
  const sorted = <T extends { usd: number }>(m: Iterable<T>) => [...m].sort((a, b) => b.usd - a.usd);
  return {
    from: range.from, to: range.to, totals, months: [...months.values()], books: sorted(books.values()), marketplaces: sorted(market.values()),
    royaltyTypes: sorted(rtype.values()), transactions: sorted(ttype.values()), daily,
    missingRoyalty: have.size ? monthsBetween(range.from, range.to).filter((m) => !have.has(m) && m < thisMonth(today) && m > [...have].sort()[0]!) : [],
  };
}

export interface MonthReport extends AnalysisReport {
  month: string;
  /** The month's USD total beside the previous month's and the same month a year earlier (null when nothing was imported for it). */
  previous: { month: string; usd: number } | null;
  lastYear: { month: string; usd: number } | null;
  /** Per book, what the previous month made, to show movement. */
  previousByBook: Record<string, number>;
  /** KENP rate per currency this month, and whether KDP has finalized it. */
  kenp: { currency: string; rate: number; state: 'final' | 'estimated'; pages: number }[];
}

const shift = (month: string, by: number) => { const [y, m] = month.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + by, 1)); return d.toISOString().slice(0, 7); };

/** Everything for one month, with the month before and the same month a year ago for comparison. */
export function monthReport(db: Db, month: string, today = new Date()): MonthReport {
  const r = analysisReport(db, { from: month, to: month }, today);
  const side = (m: string) => {
    const x = analysisReport(db, { from: m, to: m }, today);
    return x.totals.usd || x.months[0]!.units || x.months[0]!.pages ? { month: m, usd: x.totals.usd, books: x.books } : null;
  };
  const prev = side(shift(month, -1));
  const year = side(shift(month, -12));
  const rates = kenpRates(db);
  const pages = new Map<string, number>();
  for (const k of db.prepare(`SELECT marketplace, SUM(pages) AS pages FROM kenp_day WHERE substr(day, 1, 7) = ? GROUP BY marketplace`).all(month) as unknown as { marketplace: string; pages: number }[]) {
    const c = marketplaceCurrency(k.marketplace); pages.set(c, (pages.get(c) ?? 0) + k.pages);
  }
  return {
    ...r, month,
    previous: prev && { month: prev.month, usd: prev.usd }, lastYear: year && { month: year.month, usd: year.usd },
    previousByBook: Object.fromEntries((prev?.books ?? []).map((b) => [b.asin, b.usd])),
    kenp: [...pages].map(([currency, p]) => { const x = rates.get(`${month}|${currency}`)!; return { currency, rate: x.rate, state: x.state, pages: p }; }).sort((a, b) => b.pages - a.pages),
  };
}

/** The months that have any money or sales imported, newest first (for the month picker). */
export function reportMonths(db: Db): string[] {
  return (db.prepare(
    `SELECT month FROM (SELECT month FROM royalty_month UNION SELECT substr(day, 1, 7) FROM kenp_day UNION SELECT substr(day, 1, 7) FROM sales_day) ORDER BY month DESC`,
  ).all() as unknown as { month: string }[]).map((r) => r.month);
}
