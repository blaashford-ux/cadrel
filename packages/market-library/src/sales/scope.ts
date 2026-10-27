import { splitPenNames } from '../authors.js';
import type { Db } from '../schema.js';
import type { KenpParse, SalesParse } from './import.js';
import type { PaymentParse } from './payments.js';
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

export interface KdpParts { orders: SalesParse | null; kenp: KenpParse | null; royalty: RoyaltyParse | null; payments: PaymentParse | null }

/**
 * Keeps only what belongs to the Studio's pen names. A book is the Studio's when a row naming its author matches a pen name; a book no row gives an
 * author for is the Studio's only if the library already has it as one (`known`). Rows are dropped by book, so a book's orders, pages read and royalties
 * stay or go together.
 */
export function scopeKdpFile(p: KdpParts, scope: AuthorScope, known: (asin: string) => boolean): { parts: KdpParts; excluded: Excluded } {
  const none: Excluded = { books: 0, rows: 0, authors: [], accountTotalsSkipped: false };
  const m = scopeMatcher(scope);
  if (!m.restricted) return { parts: p, excluded: none };
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
  // The payment report and the monthly summary are totals for the whole KDP account. They say nothing about which pen name earned what, so they can only be
  // kept when the same file shows nothing belongs to anyone else.
  const complete = out.length === 0 && hasAuthorData;
  const accountTotalsSkipped = !complete && !!(p.payments?.payments.length || p.royalty?.summary.length);
  return {
    parts: {
      orders: orders && orders.rows.length ? orders : null,
      kenp: kenp && kenp.rows.length ? kenp : null,
      royalty: royalty && (royalty.rows.length || complete) ? { ...royalty, summary: complete ? royalty.summary : [] } : null,
      payments: complete ? p.payments : null
    },
    excluded: { books: out.length, rows: dropped, authors, accountTotalsSkipped }
  };
}

/** Whether the library already holds this book as one of the Studio's: it was flagged by hand (no author known), or its author matches. */
export function knownInScope(db: Db, scope: AuthorScope): (asin: string) => boolean {
  const m = scopeMatcher(scope);
  return (asin) => {
    const row = db.prepare('SELECT author FROM own_book WHERE asin = ?').get(asin) as { author: string | null } | undefined;
    return !!row && m.inScope(row.author) !== false;
  };
}
