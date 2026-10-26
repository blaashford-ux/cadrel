import type { Db } from '../schema.js';

/**
 * Kindle Unlimited. KDP reports pages read (KENP), not borrows. A borrow is estimated as pages read / (the book's page count
 * in KENP, "KENPC") / (the share of a book the average borrower reads). That is a count of full-read equivalents: with a share
 * of 1 it is the fewest borrows the pages could mean, since many borrowers stop early. Older author reports say Amazon counts
 * a borrow like a sale for rank; Amazon does not document it, so the calibration shows paid-only and paid + borrows side by side.
 */

export const DEFAULT_COMPLETION = 1;
export const MIN_COMPLETION = 0.1;

export function getCompletion(db: Db): number {
  const v = Number(db.scalar<string>("SELECT value FROM kv WHERE key = 'ku_completion'"));
  return Number.isFinite(v) && v >= MIN_COMPLETION && v <= 1 ? v : DEFAULT_COMPLETION;
}

export function setCompletion(db: Db, share: number): number {
  if (!(share >= MIN_COMPLETION && share <= 1)) throw new Error(`the share of a book read must be between ${MIN_COMPLETION * 100}% and 100%`);
  db.prepare("INSERT INTO kv (key, value) VALUES ('ku_completion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(share));
  return share;
}

export interface Kenpc {
  asin: string;
  kenpc: number;
  /** Typed in by the user, or the captured print length used as a stand-in (KENPC is usually different; check your KDP Bookshelf). */
  from: 'you' | 'print length';
}

export function setKenpc(db: Db, asin: string, kenpc: number | null): void {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('bad ASIN');
  if (kenpc === null) { db.prepare('DELETE FROM book_kenpc WHERE asin = ?').run(asin); return; }
  if (!Number.isInteger(kenpc) || kenpc < 1 || kenpc > 20000) throw new Error('KENPC is a whole number of pages, 1 to 20,000');
  db.prepare('INSERT INTO book_kenpc (asin, kenpc) VALUES (?, ?) ON CONFLICT(asin) DO UPDATE SET kenpc = excluded.kenpc').run(asin, kenpc);
}

export function kenpcFor(db: Db, asin: string): Kenpc | null {
  const u = db.scalar<number>('SELECT kenpc FROM book_kenpc WHERE asin = ?', asin);
  if (u) return { asin, kenpc: u, from: 'you' };
  const p = db.scalar<number>('SELECT pages FROM snapshot WHERE asin = ? AND pages IS NOT NULL ORDER BY captured_at DESC LIMIT 1', asin);
  return p ? { asin, kenpc: p, from: 'print length' } : null;
}

export interface KuBook {
  asin: string;
  title: string | null;
  kenpc: number | null;
  kenpcFrom: 'you' | 'print length' | null;
  /** KENP pages read in the imported days. */
  pagesRead: number;
  /** Estimated borrows in those days (null while the book has no page count). */
  borrows: number | null;
}

/** The books with Kindle Unlimited data, with the page count that will be used for each. */
export function kuBooks(db: Db): KuBook[] {
  const completion = getCompletion(db);
  const rows = db.prepare("SELECT asin, SUM(pages) AS pages FROM kenp_day WHERE marketplace = 'amazon.com' GROUP BY asin ORDER BY SUM(pages) DESC").all() as unknown as { asin: string; pages: number }[];
  return rows.map((r) => {
    const k = kenpcFor(db, r.asin);
    const title = db.scalar<string>('SELECT title FROM book WHERE asin = ?', r.asin) ?? null;
    return { asin: r.asin, title, kenpc: k?.kenpc ?? null, kenpcFrom: k?.from ?? null, pagesRead: r.pages, borrows: k ? Math.round((r.pages / (k.kenpc * completion)) * 10) / 10 : null };
  });
}
