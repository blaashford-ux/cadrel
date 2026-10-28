import { splitPenNames } from '../authors.js';
import type { Db } from '../schema.js';
import type { KenpParse, SalesParse } from './import.js';
import type { PaymentParse, PaymentRow } from './payments.js';
import { fxRate, monthlyEarnings } from './earnings.js';
import type { RoyaltyParse } from './royalty.js';

/**
 * Whose books a library is for. A KDP report lists every book on the author's account, but a Studio publishes only under some of the pen names, and
 * what another pen name earns must not turn up in this Studio's My Books, Finance or catalogue. The scope is the list of pen names the Studio has:
 * `null` means no restriction (nothing is known about the Studio's pen names), a list (even an empty one) restricts to those names.
 */
export type AuthorScope = readonly string[] | null;

/** A name as it is compared: no case, accents or punctuation, one space between words. */
export const foldName = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The comparable forms of one name: as written, and a single "Last, First" turned round. */
function forms(name: string): string[] {
  const out = [foldName(name)];
  const bits = name.split(',');
  if (bits.length === 2 && bits[0]!.trim() && bits[1]!.trim()) out.push(foldName(`${bits[1]} ${bits[0]}`));
  return out.filter(Boolean);
}

export interface ScopeMatcher {
  restricted: boolean;
  /** True: the author field names one of the Studio's pen names (any of them, for a collaboration). False: it names others only. Null: there is no author to go by. */
  inScope(author: string | null | undefined): boolean | null;
}

export function scopeMatcher(scope: AuthorScope): ScopeMatcher {
  if (scope === null) return { restricted: false, inScope: () => true };
  const allowed = new Set(scope.flatMap(forms));
  return {
    restricted: true,
    inScope(author) {
      const names = splitPenNames(author ?? '');
      if (!names.length) return null;
      return names.some((n) => forms(n).some((f) => allowed.has(f)));
    }
  };
}

export interface Excluded {
  /** Books (ASINs) in the file that belong to pen names this Studio does not have. */
  books: number;
  /** Rows dropped with them. */
  rows: number;
  /** The author names those books are under, as the report writes them (no more than 20). */
  authors: string[];
  /** KDP's payment report and monthly summary cover the whole account, so they are only kept when nothing in the file belongs to anyone else. */
  accountTotalsSkipped: boolean;
}

/** What a Studio's share of an account-wide payment report came to (see scopePayments). */
export interface PaymentShare {
  /** Payment lines in the file, and how many were kept (whole or in part). */
  lines: number;
  kept: number;
  /** The Studio's part of the royalties the file pays out, 0 to 1; null when nothing was kept. */
  share: number | null;
  /** Lines kept in part: the Studio's figure is worked out from its own sales, not reported by KDP. */
  estimated: number;
  /** Lines left out because the Studio has no sales or pages read for that month and source ("2025-07 Kindle+"): another pen name's, or not imported yet. */
  unmatched: string[];
}

export interface KdpParts { orders: SalesParse | null; kenp: KenpParse | null; royalty: RoyaltyParse | null; payments: PaymentParse | null }

/**
 * Keeps only what belongs to the Studio's pen names. A book is the Studio's when a row naming its author matches a pen name; a book no row gives an
 * author for is the Studio's only if the library already has it as one (`known`). Rows are dropped by book, so a book's orders, pages read and royalties
 * stay or go together.
 */
export function scopeKdpFile(p: KdpParts, scope: AuthorScope, known: (asin: string) => boolean): { parts: KdpParts; excluded: Excluded; accountPayments: PaymentParse | null } {
  const none: Excluded = { books: 0, rows: 0, authors: [], accountTotalsSkipped: false };
  const m = scopeMatcher(scope);
  if (!m.restricted) return { parts: p, excluded: none, accountPayments: null };
  const status = new Map<string, boolean>();
  const names = new Map<string, string>();
  const see = (rows: { asin: string; author?: string }[]) => {
    for (const r of rows) {
      const s = m.inScope(r.author);
      if (s === null) continue;
      if (s) status.set(r.asin, true);
      else if (!status.has(r.asin)) (status.set(r.asin, false), names.set(r.asin, r.author!));
    }
  };
  see(p.orders?.rows ?? []);
  see(p.kenp?.rows ?? []);
  see(p.royalty?.rows ?? []);
  const keep = (asin: string) => status.get(asin) ?? known(asin);
  let dropped = 0;
  const only = <T extends { asin: string }>(rows: T[]): T[] => rows.filter((r) => keep(r.asin) || (dropped++, false));
  const orders = p.orders && { ...p.orders, rows: only(p.orders.rows) };
  const kenp = p.kenp && { ...p.kenp, rows: only(p.kenp.rows) };
  const royalty = p.royalty && { ...p.royalty, rows: only(p.royalty.rows) };
  const everyAsin = new Set([...(p.orders?.rows ?? []), ...(p.kenp?.rows ?? []), ...(p.royalty?.rows ?? [])].map((r) => r.asin));
  const out = [...everyAsin].filter((a) => !keep(a));
  const authors = [...new Set(out.map((a) => names.get(a)).filter((x): x is string => !!x))].slice(0, 20);
  const hasAuthorData = !!(p.orders?.rows.length || p.kenp?.rows.length || p.royalty?.rows.length);
  // The monthly summary is a total for the whole KDP account and says nothing about which pen name earned what, so it is only kept when the same file shows
  // nothing belongs to anyone else. The payment report is a total too, but its lines are per month and source, so the Studio's part of it is worked out
  // from its own sales (scopePayments) once this file's sales are saved; the caller does that with `accountPayments`.
  const complete = out.length === 0 && hasAuthorData;
  const accountTotalsSkipped = !complete && !!p.royalty?.summary.length;
  return {
    parts: {
      orders: orders && orders.rows.length ? orders : null,
      kenp: kenp && kenp.rows.length ? kenp : null,
      royalty: royalty && (royalty.rows.length || complete) ? { ...royalty, summary: complete ? royalty.summary : [] } : null,
      payments: complete ? p.payments : null
    },
    excluded: { books: out.length, rows: dropped, authors, accountTotalsSkipped },
    accountPayments: !complete && p.payments?.payments.length ? p.payments : null
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The Studio's part of an account-wide payment report. KDP pays one lump sum for every pen name on the account, but lists it per sales month and source (Sales,
 * Kindle+ Royalties). The Studio's own sales for that month and source say how much of the line is its: when they come to (nearly) the whole line, the Studio
 * is the only one paid for it; when they come to less, the Studio's part is what they come to and the rest is another pen name's; when the Studio has none, the
 * line is left out. The Studio's figure uses the exchange rates the app holds, so it is an estimate, and a line within 5% (Kindle+: 15%, since its rate per
 * page is not reported) of the whole counts as the whole. Run after the file's sales are saved, since it reads them.
 */
export function scopePayments(db: Db, parse: PaymentParse, today = new Date()): { payments: PaymentRow[]; share: PaymentShare } {
  const mine = new Map<string, number>(); // "month|sales" / "month|kenp" -> USD
  for (const e of monthlyEarnings(db, {}, today)) {
    const k = `${e.month}|${e.source === 'kenp' ? 'kenp' : 'sales'}`;
    mine.set(k, (mine.get(k) ?? 0) + e.amount * fxRate(db, e.month, e.currency).toUsd);
  }
  const unmatched: string[] = [];
  const out: PaymentRow[] = [];
  let lines = 0, kept = 0, estimated = 0, allAccrued = 0, keptAccrued = 0;
  for (const p of parse.payments) {
    const usdOf = (l: { month: string; currency: string; accrued: number }) => l.accrued * fxRate(db, l.month, l.currency).toUsd;
    const keep: PaymentRow['lines'] = [];
    let all = 0, got = 0;
    for (const l of p.lines) {
      lines++;
      const whole = usdOf(l);
      all += whole;
      const est = mine.get(`${l.month}|${l.source}`) ?? 0;
      if (!(est > 0) || !(l.accrued > 0)) { unmatched.push(`${l.month} ${l.source === 'kenp' ? 'Kindle+' : 'sales'}`); continue; }
      const f = Math.min(1, est / whole);
      if (f >= (l.source === 'kenp' ? 0.85 : 0.95)) { keep.push(l); got += whole; continue; }
      const accrued = round2(l.accrued * f);
      const tax = round2(l.tax * f);
      keep.push({ ...l, accrued, tax, net: round2(accrued - tax) });
      got += whole * f;
      estimated++;
    }
    allAccrued += all;
    keptAccrued += got;
    kept += keep.length;
    if (!keep.length) continue;
    const r = all > 0 ? got / all : 1;
    const whole = r >= 0.9999;
    const accrued = whole ? p.accrued : round2(p.accrued * r);
    const tax = whole ? p.tax : round2(p.tax * r);
    out.push({ ...p, lines: keep, accrued, tax, net: whole ? p.net : round2(accrued - tax), payoutAmount: p.payoutAmount === null || whole ? p.payoutAmount : round2(p.payoutAmount * r) });
  }
  return { payments: out, share: { lines, kept, share: kept ? round2(keptAccrued / (allAccrued || 1)) : null, estimated, unmatched } };
}

/** Whether the library already holds this book as one of the Studio's: it was flagged by hand (no author known), or its author matches. */
export function knownInScope(db: Db, scope: AuthorScope): (asin: string) => boolean {
  const m = scopeMatcher(scope);
  return (asin) => {
    const row = db.prepare('SELECT author FROM own_book WHERE asin = ?').get(asin) as { author: string | null } | undefined;
    return !!row && m.inScope(row.author) !== false;
  };
}
