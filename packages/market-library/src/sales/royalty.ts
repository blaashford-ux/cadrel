import type { Db } from '../schema.js';
import { readXlsx, isXlsx, norm, findHeader, parseDates, num, type Grid } from './grid.js';

/**
 * Money from the KDP download: the monthly royalty sheets (eBook, Paperback, Hardcover; or Combined Sales when a file has no
 * per-format sheets) and the Summary sheet. Royalties are per book, marketplace and royalty type, in the marketplace's own
 * currency. KENP (Kindle Unlimited) money is not in the royalty sheets: it is the Summary's royalty minus the sheets' royalty,
 * which is only non-zero once KDP has finalized the month.
 */

export type RoyaltyFormat = 'ebook' | 'paperback' | 'hardcover';

export interface RoyaltyRow {
  asin: string;
  month: string;
  marketplace: string;
  format: RoyaltyFormat;
  royaltyType: string;
  transactionType: string;
  currency: string;
  units: number;
  refunded: number;
  netUnits: number;
  listPrice: number | null;
  offerPrice: number | null;
  royalty: number;
  title?: string;
  author?: string;
}

export interface SummaryRow { month: string; currency: string; royalty: number }

export interface RoyaltyParse { rows: RoyaltyRow[]; summary: SummaryRow[]; skipped: number }

const ROYALTY_COLS = {
  month: ['royalty date'],
  asin: ['asin', 'asin isbn'],
  market: ['marketplace'],
  royalty: ['royalty'],
  currency: ['currency'],
  'type?': ['royalty type'],
  'txn?': ['transaction type'],
  'units?': ['units sold'],
  'refunded?': ['units refunded'],
  'net?': ['net units sold'],
  'list?': ['avg list price without tax'],
  'offer?': ['avg offer price without tax'],
  'title?': ['title'],
  'author?': ['author name', 'author'],
};

const monthOf = (v: string): string | null => {
  const m = /^(\d{4})-(\d{2})/.exec(v.trim());
  if (m && +m[2]! >= 1 && +m[2]! <= 12) return `${m[1]}-${m[2]}`;
  return parseDates([v])[0]?.slice(0, 7) ?? null;
};

const formatOf = (sheet: string, txn: string): RoyaltyFormat => (/paperback/i.test(sheet + ' ' + txn) ? 'paperback' : /hardcover/i.test(sheet + ' ' + txn) ? 'hardcover' : 'ebook');

function readRoyaltySheet(name: string, rows: Grid, forced: RoyaltyFormat | null): { rows: RoyaltyRow[]; skipped: number } | null {
  const h = findHeader(rows, ROYALTY_COLS);
  if (!h) return null;
  const c = h.cols;
  const out: RoyaltyRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(h.row + 1).filter((x) => x.some(Boolean))) {
    const asin = (r[c.asin!] ?? '').toUpperCase().trim();
    const month = monthOf(r[c.month!] ?? '');
    const royalty = num(r[c.royalty!]);
    const currency = (r[c.currency!] ?? '').toUpperCase().trim();
    if (!/^[A-Z0-9]{10}$/.test(asin) || !month || royalty === null || !/^[A-Z]{3}$/.test(currency)) { skipped++; continue; }
    const txn = c['txn?'] !== undefined ? r[c['txn?']] ?? '' : '';
    const net = c['net?'] !== undefined ? num(r[c['net?']]) : null;
    const units = c['units?'] !== undefined ? num(r[c['units?']]) : null;
    const refunded = c['refunded?'] !== undefined ? num(r[c['refunded?']]) : null;
    const price = (i: string) => (c[i] !== undefined ? num(r[c[i]!]) : null);
    out.push({
      asin, month, marketplace: (r[c.market!] ?? '').toLowerCase().trim() || 'amazon.com', format: forced ?? formatOf(name, txn),
      royaltyType: (c['type?'] !== undefined ? r[c['type?']] : '')?.trim() || '', transactionType: txn.trim() || 'Standard', currency,
      units: Math.round(units ?? net ?? 0), refunded: Math.round(refunded ?? 0), netUnits: Math.round(net ?? (units ?? 0) - (refunded ?? 0)),
      listPrice: price('list?'), offerPrice: price('offer?'), royalty,
      ...(c['title?'] !== undefined && r[c['title?']] ? { title: r[c['title?']]! } : {}),
      ...(c['author?'] !== undefined && r[c['author?']] ? { author: r[c['author?']]! } : {}),
    });
  }
  return out.length ? { rows: out, skipped } : null;
}

function readSummarySheet(rows: Grid): SummaryRow[] {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const heads = rows[i]!.map(norm);
    const cols = heads.map((x, j) => ({ j, code: /^royalty ([a-z]{3})$/.exec(x)?.[1]?.toUpperCase() })).filter((x): x is { j: number; code: string } => !!x.code);
    if (heads[0] !== 'date' || !cols.length) continue;
    const out: SummaryRow[] = [];
    for (const r of rows.slice(i + 1)) {
      const ms = Date.parse(`1 ${r[0] ?? ''} UTC`);
      if (Number.isNaN(ms)) continue;
      const month = new Date(ms).toISOString().slice(0, 7);
      for (const { j, code } of cols) {
        const v = num(r[j]);
        if (v !== null) out.push({ month, currency: code, royalty: v });
      }
    }
    return out;
  }
  return [];
}

/** The royalty and Summary tables of a KDP workbook. Empty when the file has none (an orders-only or KENP-only file). */
export function parseRoyaltyFile(name: string, bytes: Uint8Array): RoyaltyParse {
  if (!isXlsx(name, bytes)) return { rows: [], summary: [], skipped: 0 };
  const sheets = readXlsx(bytes);
  const perFormat = sheets.filter((s) => /^(ebook|paperback|hardcover)\s+royalty/i.test(s.name));
  // the per-format sheets say everything the Combined sheet does, so only one kind is read or the money would be counted twice
  const use = perFormat.length ? perFormat : sheets.filter((s) => /combined\s+sales/i.test(s.name));
  const rows: RoyaltyRow[] = [];
  let skipped = 0;
  for (const s of use) {
    const forced = /paperback/i.test(s.name) ? 'paperback' : /hardcover/i.test(s.name) ? 'hardcover' : /^ebook/i.test(s.name) ? 'ebook' : null;
    const r = readRoyaltySheet(s.name, s.rows, perFormat.length ? forced : null);
    if (r) { rows.push(...r.rows); skipped += r.skipped; }
  }
  const summary = sheets.filter((s) => /^summary$/i.test(s.name)).flatMap((s) => readSummarySheet(s.rows));
  return { rows, summary, skipped };
}

/** Store royalty rows. KDP revises recent months, so a re-import replaces the months it covers for the books it names. */
export function saveRoyaltyRows(db: Db, rows: RoyaltyRow[], summary: SummaryRow[], source: string, now = new Date().toISOString()): void {
  const del = db.prepare('DELETE FROM royalty_month WHERE asin = ? AND month = ?');
  const ins = db.prepare(
    `INSERT INTO royalty_month (asin, month, marketplace, format, royalty_type, transaction_type, currency, title, units, refunded, net_units, list_price, offer_price, royalty, source, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(asin, month, marketplace, format, royalty_type, transaction_type, currency) DO UPDATE SET
       units = units + excluded.units, refunded = refunded + excluded.refunded, net_units = net_units + excluded.net_units, royalty = royalty + excluded.royalty,
       list_price = excluded.list_price, offer_price = excluded.offer_price, source = excluded.source, imported_at = excluded.imported_at`,
  );
  const sum = db.prepare(
    `INSERT INTO kdp_summary (month, currency, royalty, source, imported_at) VALUES (?,?,?,?,?)
     ON CONFLICT(month, currency) DO UPDATE SET royalty = excluded.royalty, source = excluded.source, imported_at = excluded.imported_at`,
  );
  db.transaction(() => {
    for (const k of new Set(rows.map((r) => `${r.asin}|${r.month}`))) { const [a, m] = k.split('|'); del.run(a!, m!); }
    // the same key twice in one file (a refund line beside a sale) adds up through the upsert
    for (const r of rows) ins.run(r.asin, r.month, r.marketplace, r.format, r.royaltyType, r.transactionType, r.currency, r.title ?? null, r.units, r.refunded, r.netUnits, r.listPrice, r.offerPrice, r.royalty, source, now);
    for (const s of summary) sum.run(s.month, s.currency, s.royalty, source, now);
  })();
}

/** The currency KDP pays a marketplace in. */
export function marketplaceCurrency(marketplace: string): string {
  const m = marketplace.toLowerCase().replace(/^www\./, '');
  if (m === 'amazon.com') return 'USD';
  if (m === 'amazon.co.uk') return 'GBP';
  if (m === 'amazon.ca') return 'CAD';
  if (m === 'amazon.com.au') return 'AUD';
  if (m === 'amazon.co.jp') return 'JPY';
  if (m === 'amazon.in') return 'INR';
  if (m === 'amazon.com.br') return 'BRL';
  if (m === 'amazon.com.mx') return 'MXN';
  if (m === 'amazon.pl') return 'PLN';
  if (m === 'amazon.se') return 'SEK';
  if (/^amazon\.(de|fr|es|it|nl|ie|be)$/.test(m)) return 'EUR';
  return 'USD';
}

/**
 * A print edition has its own ASIN, so KDP lists a book's paperback royalties under a different ASIN than its eBook. For money the
 * two are one book (they share a split): this maps an ASIN that only ever appears as print to the eBook ASIN with the same title.
 */
export function bookAliases(db: Db): (asin: string) => string {
  const rows = db.prepare('SELECT asin, title, MAX(format = \'ebook\') AS ebook FROM royalty_month WHERE title IS NOT NULL GROUP BY asin, title').all() as unknown as { asin: string; title: string; ebook: number }[];
  const key = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const ebookByTitle = new Map<string, string>();
  for (const r of rows.filter((x) => x.ebook).sort((a, b) => a.asin.localeCompare(b.asin))) if (!ebookByTitle.has(key(r.title))) ebookByTitle.set(key(r.title), r.asin);
  const alias = new Map<string, string>();
  for (const r of rows.filter((x) => !x.ebook)) { const e = ebookByTitle.get(key(r.title)); if (e && e !== r.asin) alias.set(r.asin, e); }
  return (asin) => alias.get(asin) ?? asin;
}
