import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../schema.js';
import { stampOf } from '../layout.js';
import { exportUserData } from '../userdata.js';
import { registerOwnBooks, type OwnCandidate } from './own.js';
import { parsePaymentFile, savePayments, type PaymentParse } from './payments.js';
import { parseRoyaltyFile, saveRoyaltyRows, type RoyaltyParse } from './royalty.js';
import { knownInScope, scopeKdpFile, type AuthorScope, type Excluded } from './scope.js';
import { readXlsx, readCsv, isXlsx, norm, findHeader, parseDates, cell, num, type Grid } from './grid.js';

/**
 * The author's own sales, imported from files they download from KDP (no daily tracking), and optional rank-history
 * files. The files are kept under <library>/sales so a lost database can be rebuilt from them.
 *
 * Column names are matched loosely because KDP does not document the download layout; a file that cannot be read
 * says which headers it found.
 */

// ---------------------------------------------------------------- sales

/** True when every date in a column is a month (2026-10) rather than a day. */
const isMonthly = (values: string[]) => values.some((v) => v.trim()) && values.filter((v) => v.trim()).every((v) => /^\d{4}-\d{2}$/.test(v.trim()));

export interface SalesRow { asin: string; day: string; marketplace: string; paidUnits: number; freeUnits: number; title?: string; author?: string }

export interface SalesParse { rows: SalesRow[]; sheet: string | null; skipped: number }

const SALES_COLS = {
  date: ['date', 'order date', 'order placed date', 'day'],
  asin: ['asin', 'asin isbn', 'asin/isbn'].map(norm),
  paid: ['paid units', 'units sold', 'net units sold', 'units ordered', 'units', 'paid'],
  'free?': ['free units', 'free'],
  'market?': ['marketplace', 'store'],
  'title?': ['title', 'book title', 'product title'],
  'author?': ['author', 'author name', 'authors'],
};

/** Read a KDP Orders-style report (xlsx or csv) into daily paid and free units per ASIN. */
export function parseSalesFile(name: string, bytes: Uint8Array): SalesParse {
  const grids: { name: string; rows: Grid }[] = isXlsx(name, bytes) ? readXlsx(bytes) : [{ name: 'csv', rows: readCsv(Buffer.from(bytes).toString('utf8')) }];
  const seen: string[] = [];
  // prefer a sheet that looks like the orders report; otherwise the first with the needed columns
  const ordered = [...grids].sort((a, b) => Number(/order/i.test(b.name)) - Number(/order/i.test(a.name)));
  for (const g of ordered) {
    const h = findHeader(g.rows, SALES_COLS);
    if (!h) {
      if (g.rows[0]) seen.push(`${g.name}: ${g.rows.slice(0, 6).find((r) => r.filter(Boolean).length > 2)?.filter(Boolean).slice(0, 8).join(', ') ?? 'no table'}`);
      continue;
    }
    const body = g.rows.slice(h.row + 1).filter((r) => r.some(Boolean));
    // KDP's workbook has Orders Processed by month and Orders Placed by day: month totals must not become one-day totals
    if (isMonthly(body.map((r) => r[h.cols.date!] ?? ''))) { seen.push(`${g.name}: dates are months, not days`); continue; }
    const days = parseDates(body.map((r) => r[h.cols.date!] ?? ''));
    const rows: SalesRow[] = [];
    let skipped = 0;
    body.forEach((r, i) => {
      const asin = (r[h.cols.asin!] ?? '').toUpperCase().trim();
      const paid = num(r[h.cols.paid!]);
      if (!/^[A-Z0-9]{10}$/.test(asin) || !days[i] || paid === null) { skipped++; return; }
      const market = (h.cols['market?'] !== undefined ? r[h.cols['market?']] : '')?.toLowerCase().trim() || 'amazon.com';
      rows.push({
        asin, day: days[i]!, marketplace: market, paidUnits: Math.max(Math.round(paid), 0), freeUnits: h.cols['free?'] !== undefined ? Math.max(Math.round(num(r[h.cols['free?']]) ?? 0), 0) : 0,
        ...cell(r, h.cols['title?'], 'title'), ...cell(r, h.cols['author?'], 'author'),
      });
    });
    if (!rows.length) { seen.push(`${g.name}: columns found but no usable rows`); continue; }
    return { rows, sheet: g.name === 'csv' ? null : g.name, skipped };
  }
  throw new Error(`could not find a daily sales table (it needs Date, ASIN and Paid Units/Units Sold columns). Found: ${seen.join(' | ') || 'nothing readable'}`);
}

// ---------------------------------------------------------------- Kindle Unlimited pages read

export interface KenpRow { asin: string; day: string; marketplace: string; pages: number; title?: string; author?: string }
export interface KenpParse { rows: KenpRow[]; sheet: string | null; skipped: number }

const KENP_COLS = {
  date: ['date', 'order date', 'day'],
  asin: ['asin', 'asin isbn'],
  pages: ['kenp read', 'kenp', 'pages read', 'kindle edition normalized pages kenp read', 'kindle edition normalized page kenp read', 'normalized pages read', 'kindle edition normalized pages'],
  'market?': ['marketplace', 'store'],
  'title?': ['title', 'book title', 'product title'],
  'author?': ['author', 'author name', 'authors'],
};

/** Read a KDP "KENP Read" report (xlsx or csv): Kindle Unlimited pages read per day per ASIN. */
export function parseKenpFile(name: string, bytes: Uint8Array): KenpParse {
  const grids: { name: string; rows: Grid }[] = isXlsx(name, bytes) ? readXlsx(bytes) : [{ name: 'csv', rows: readCsv(Buffer.from(bytes).toString('utf8')) }];
  const ordered = [...grids].sort((a, b) => Number(/kenp/i.test(b.name)) - Number(/kenp/i.test(a.name)));
  for (const g of ordered) {
    const h = findHeader(g.rows, KENP_COLS);
    if (!h) continue;
    const body = g.rows.slice(h.row + 1).filter((r) => r.some(Boolean));
    const days = parseDates(body.map((r) => r[h.cols.date!] ?? ''));
    const rows: KenpRow[] = [];
    let skipped = 0;
    body.forEach((r, i) => {
      const asin = (r[h.cols.asin!] ?? '').toUpperCase().trim();
      const pages = num(r[h.cols.pages!]);
      if (!/^[A-Z0-9]{10}$/.test(asin) || !days[i] || pages === null) { skipped++; return; }
      rows.push({ asin, day: days[i]!, marketplace: (h.cols['market?'] !== undefined ? r[h.cols['market?']] : '')?.toLowerCase().trim() || 'amazon.com', pages: Math.max(Math.round(pages), 0), ...cell(r, h.cols['title?'], 'title'), ...cell(r, h.cols['author?'], 'author') });
    });
    if (rows.length) return { rows, sheet: g.name === 'csv' ? null : g.name, skipped };
  }
  throw new Error('could not find a KENP Read table (it needs Date, ASIN and KENP Read columns)');
}

// ---------------------------------------------------------------- rank history

export interface RankRow { asin: string; at: string; rank: number }
const RANK_COLS = {
  date: ['date', 'time', 'datetime', 'date time', 'timestamp', 'day'],
  rank: ['rank', 'sales rank', 'bsr', 'best sellers rank', 'kindle rank', 'overall rank'],
  'asin?': ['asin'],
};

/** Read a rank-history file (date or timestamp, rank, optional ASIN). `defaultAsin` is used when the file has no ASIN column. */
export function parseRankFile(name: string, bytes: Uint8Array, defaultAsin?: string): { rows: RankRow[]; skipped: number } {
  const grids: { name: string; rows: Grid }[] = isXlsx(name, bytes) ? readXlsx(bytes) : [{ name: 'csv', rows: readCsv(Buffer.from(bytes).toString('utf8')) }];
  for (const g of grids) {
    const h = findHeader(g.rows, RANK_COLS);
    if (!h) continue;
    if (h.cols['asin?'] === undefined && !(defaultAsin && /^[A-Z0-9]{10}$/.test(defaultAsin))) throw new Error('this file has no ASIN column: choose which book it is for');
    const body = g.rows.slice(h.row + 1).filter((r) => r.some(Boolean));
    const raw = body.map((r) => r[h.cols.date!] ?? '');
    const days = parseDates(raw);
    const rows: RankRow[] = [];
    let skipped = 0;
    body.forEach((r, i) => {
      const asin = (h.cols['asin?'] !== undefined ? r[h.cols['asin?']] ?? '' : defaultAsin!).toUpperCase().trim();
      const rank = num(r[h.cols.rank!]);
      if (!/^[A-Z0-9]{10}$/.test(asin) || !days[i] || rank === null || rank < 1) { skipped++; return; }
      const time = /[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(raw[i]!)?.[1];
      rows.push({ asin, at: `${days[i]}T${time ? (time.length === 5 ? `${time}:00` : time) : '12:00:00'}Z`, rank: Math.round(rank) });
    });
    if (rows.length) return { rows, skipped };
  }
  throw new Error('could not find a rank table (it needs a Date and a Rank column)');
}

// ---------------------------------------------------------------- storing

const dirOf = (root: string) => path.join(root, 'sales');
const safe = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';

export function saveSalesRows(db: Db, rows: SalesRow[], source: string, now = new Date().toISOString()): void {
  const st = db.prepare(
    `INSERT INTO sales_day (asin, day, marketplace, paid_units, free_units, source, imported_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(asin, day, marketplace) DO UPDATE SET paid_units = excluded.paid_units, free_units = excluded.free_units, source = excluded.source, imported_at = excluded.imported_at`,
  );
  // a report can list an ASIN twice for one day (formats, orders vs. KU): add them up before storing
  const sum = new Map<string, SalesRow>();
  for (const r of rows) {
    const k = `${r.asin}|${r.day}|${r.marketplace}`;
    const c = sum.get(k);
    sum.set(k, c ? { ...c, paidUnits: c.paidUnits + r.paidUnits, freeUnits: c.freeUnits + r.freeUnits } : r);
  }
  db.transaction(() => { for (const r of sum.values()) st.run(r.asin, r.day, r.marketplace, r.paidUnits, r.freeUnits, source, now); })();
}

export function saveKenpRows(db: Db, rows: KenpRow[], source: string, now = new Date().toISOString()): void {
  const st = db.prepare(
    `INSERT INTO kenp_day (asin, day, marketplace, pages, source, imported_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(asin, day, marketplace) DO UPDATE SET pages = excluded.pages, source = excluded.source, imported_at = excluded.imported_at`,
  );
  const sum = new Map<string, KenpRow>();
  for (const r of rows) {
    const k = `${r.asin}|${r.day}|${r.marketplace}`;
    const c = sum.get(k);
    sum.set(k, c ? { ...c, pages: c.pages + r.pages } : r);
  }
  db.transaction(() => { for (const r of sum.values()) st.run(r.asin, r.day, r.marketplace, r.pages, source, now); })();
}

export function saveRankRows(db: Db, rows: RankRow[], source: string): void {
  const st = db.prepare('INSERT INTO rank_point (asin, at, rank, source) VALUES (?,?,?,?) ON CONFLICT(asin, at, source) DO UPDATE SET rank = excluded.rank');
  db.transaction(() => { for (const r of rows) st.run(r.asin, r.at, r.rank, source); })();
}

export interface ImportSummary {
  file: string;
  rows: number;
  books: number;
  from: string;
  to: string;
  skipped: number;
  /** What the file held: paid orders, Kindle Unlimited pages read, or both (a workbook with both tabs). */
  contains?: ('orders' | 'kenp' | 'royalties' | 'payments')[];
  /** Payments read from a KDP payment report. */
  paymentCount?: number;
  paymentFrom?: string;
  paymentTo?: string;
  /** Royalty rows read, and the months they cover. */
  royaltyRows?: number;
  royaltyFrom?: string;
  royaltyTo?: string;
  /** Rows of KENP data, when the file had any. */
  kenpRows?: number;
  /** Books this file added to My Books, and how many books the file named. */
  newBooks?: number;
  titles?: number;
  /** Set when the library is limited to the Studio's pen names: what the file held that was left out because it belongs to other pen names. */
  excluded?: Excluded;
  /** The library is limited to the Studio's pen names and the Studio has none, so nothing could be brought in. */
  noPenNames?: boolean;
}

/** Read whichever KDP tables a file holds: paid orders, KENP pages read, royalties, or any mix (a full workbook). */
export function parseKdpFile(name: string, bytes: Uint8Array): { orders: SalesParse | null; kenp: KenpParse | null; royalty: RoyaltyParse | null; payments: PaymentParse | null } {
  let orders: SalesParse | null = null;
  let kenp: KenpParse | null = null;
  let ordersErr = '';
  try { orders = parseSalesFile(name, bytes); } catch (e) { ordersErr = (e as Error).message; }
  try { kenp = parseKenpFile(name, bytes); } catch { /* reported below if nothing at all was found */ }
  let royalty: RoyaltyParse | null = null;
  try { const r = parseRoyaltyFile(name, bytes); if (r.rows.length || r.summary.length) royalty = r; } catch { /* a workbook without royalty sheets */ }
  let payments: PaymentParse | null = null;
  try { const r = parsePaymentFile(name, bytes); if (r.payments.length) payments = r; } catch { /* not a payment report */ }
  if (!orders && !kenp && !royalty && !payments) throw new Error(ordersErr || 'could not find a sales table');
  return { orders, kenp, royalty, payments };
}

/** The books a royalty sheet names, without the print edition of a book whose eBook is also named (one book, two ASINs). */
function ownRoyaltyBooks(r: RoyaltyParse | null): { asin: string; title?: string; author?: string }[] {
  const rows = r?.rows ?? [];
  const ebookTitles = new Set(rows.filter((x) => x.format === 'ebook').map((x) => (x.title ?? '').toLowerCase().trim()));
  return rows.filter((x) => x.format === 'ebook' || !x.title || !ebookTitles.has(x.title.toLowerCase().trim()));
}

/** Parse, keep a copy of the file, and store its rows. Re-importing an overlapping report just replaces those days. */
export function importSalesFile(db: Db, root: string, name: string, bytes: Uint8Array, now = new Date(), scope: AuthorScope = null): ImportSummary {
  const parsed = parseKdpFile(name, bytes);
  // Only the Studio's pen names come in (see scope.ts); everything else in the report is left out, and so is its trace in the library.
  const { parts: p, excluded } = scopeKdpFile(parsed, scope, knownInScope(db, scope));
  const file = `${stampOf(now)}-${safe(name)}`;
  fs.mkdirSync(path.join(dirOf(root), 'orders'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(root), 'orders', file), bytes);
  if (p.orders) saveSalesRows(db, p.orders.rows, file, now.toISOString());
  if (p.kenp) saveKenpRows(db, p.kenp.rows, file, now.toISOString());
  if (p.royalty) saveRoyaltyRows(db, p.royalty.rows, p.royalty.summary, file, now.toISOString());
  if (p.payments) savePayments(db, p.payments.payments, file, now.toISOString());
  const named = [...(p.orders?.rows ?? []), ...(p.kenp?.rows ?? []), ...ownRoyaltyBooks(p.royalty)] as OwnCandidate[];
  const newBooks = registerOwnBooks(db, named, 'report', now.toISOString());
  exportUserData(db, root);
  const all = [...(p.orders?.rows ?? []), ...(p.kenp?.rows ?? [])];
  const paid = (p.payments?.payments ?? []).map((x) => x.paidOn).sort();
  const days = [...all.map((r) => r.day), ...(p.royalty?.rows ?? []).map((r) => `${r.month}-01`), ...paid].sort();
  const months = (p.royalty?.rows ?? []).map((r) => r.month).sort();
  return {
    file, rows: all.length, books: new Set(named.map((r) => r.asin)).size, from: days[0] ?? '', to: days[days.length - 1] ?? '',
    skipped: (p.orders?.skipped ?? 0) + (p.kenp?.skipped ?? 0) + (p.royalty?.skipped ?? 0) + (p.payments?.skipped ?? 0),
    contains: [...(p.orders ? ['orders' as const] : []), ...(p.kenp ? ['kenp' as const] : []), ...(p.royalty ? ['royalties' as const] : []), ...(p.payments ? ['payments' as const] : [])],
    kenpRows: p.kenp?.rows.length,
    ...(p.payments ? { paymentCount: p.payments.payments.length, paymentFrom: paid[0], paymentTo: paid[paid.length - 1] } : {}),
    ...(p.royalty ? { royaltyRows: p.royalty.rows.length, royaltyFrom: months[0], royaltyTo: months[months.length - 1] } : {}),
    newBooks,
    titles: new Set(named.map((b) => b.asin)).size,
    ...(scope !== null ? { excluded, ...(scope.length === 0 ? { noPenNames: true } : {}) } : {}),
  };
}

export function importRankFile(db: Db, root: string, name: string, bytes: Uint8Array, defaultAsin?: string, now = new Date()): ImportSummary {
  const p = parseRankFile(name, bytes, defaultAsin);
  const file = `${stampOf(now)}-${defaultAsin ? defaultAsin + '-' : ''}${safe(name)}`;
  fs.mkdirSync(path.join(dirOf(root), 'ranks'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(root), 'ranks', file), bytes);
  // the default ASIN is needed again when the file is read back, so it is part of the saved name
  saveRankRows(db, p.rows, file);
  const days = p.rows.map((r) => r.at.slice(0, 10)).sort();
  return { file, rows: p.rows.length, books: new Set(p.rows.map((r) => r.asin)).size, from: days[0]!, to: days[days.length - 1]!, skipped: p.skipped };
}

/** Read every saved file again (a lost database, or after a parser fix). Oldest first so newer reports win. */
export function reindexSales(db: Db, root: string, scope: AuthorScope = null): number {
  let n = 0;
  for (const kind of ['orders', 'ranks'] as const) {
    const d = path.join(dirOf(root), kind);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      try {
        const bytes = new Uint8Array(fs.readFileSync(path.join(d, f)));
        if (kind === 'orders') {
          const { parts: p } = scopeKdpFile(parseKdpFile(f, bytes), scope, knownInScope(db, scope));
          if (p.orders) saveSalesRows(db, p.orders.rows, f, f.slice(0, 16));
          if (p.kenp) saveKenpRows(db, p.kenp.rows, f, f.slice(0, 16));
          if (p.royalty) saveRoyaltyRows(db, p.royalty.rows, p.royalty.summary, f, f.slice(0, 16));
          if (p.payments) savePayments(db, p.payments.payments, f, f.slice(0, 16));
          registerOwnBooks(db, [...(p.orders?.rows ?? []), ...(p.kenp?.rows ?? []), ...ownRoyaltyBooks(p.royalty)] as OwnCandidate[], 'report', f.slice(0, 16));
        }
        else saveRankRows(db, parseRankFile(f, bytes, /^\d{8}T\d{6}Z-([A-Z0-9]{10})-/.exec(f)?.[1]).rows, f);
        n++;
      } catch {
        /* a file that no longer parses is left in place, not deleted */
      }
    }
  }
  return n;
}

export function clearSalesData(db: Db, root: string): void {
  db.exec('DELETE FROM sales_day; DELETE FROM kenp_day; DELETE FROM rank_point; DELETE FROM royalty_month; DELETE FROM kdp_summary; DELETE FROM payment_line; DELETE FROM payment;');
  fs.rmSync(dirOf(root), { recursive: true, force: true });
}

export interface SalesStatus {
  days: number;
  books: number;
  from: string | null;
  to: string | null;
  /** Rank readings from pages captured of those books, plus imported rank history. */
  rankFromCaptures: number;
  rankImported: number;
  /** Kindle Unlimited pages-read data: days with any, books, and the range covered. Zero when no KENP report was imported. */
  kenpDays: number;
  kenpBooks: number;
  kenpFrom: string | null;
  kenpTo: string | null;
}

export function salesStatus(db: Db): SalesStatus {
  const r = db.prepare("SELECT COUNT(*) AS days, COUNT(DISTINCT asin) AS books, MIN(day) AS f, MAX(day) AS t FROM sales_day WHERE marketplace = 'amazon.com'").get() as { days: number; books: number; f: string | null; t: string | null };
  const k = db.prepare("SELECT COUNT(*) AS days, COUNT(DISTINCT asin) AS books, MIN(day) AS f, MAX(day) AS t FROM kenp_day WHERE marketplace = 'amazon.com'").get() as { days: number; books: number; f: string | null; t: string | null };
  const known = 'SELECT asin FROM sales_day UNION SELECT asin FROM kenp_day';
  const caps = db.scalar<number>(
    `SELECT COUNT(*) FROM snapshot s JOIN rank_entry r ON r.snapshot_id = s.id AND r.scope = 'overall' AND r.store = 'kindle'
      WHERE s.asin IN (${known})`) ?? 0;
  return {
    days: r.days, books: new Set([...(db.prepare(known).all() as unknown as { asin: string }[]).map((x) => x.asin)]).size, from: r.f, to: r.t,
    rankFromCaptures: caps, rankImported: db.scalar<number>(`SELECT COUNT(*) FROM rank_point WHERE asin IN (${known})`) ?? 0,
    kenpDays: k.days, kenpBooks: k.books, kenpFrom: k.f, kenpTo: k.t,
  };
}
