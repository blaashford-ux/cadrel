import type { Db } from '../schema.js';
import { exportUserData } from '../userdata.js';
import { categoryNameSql } from '../queries.js';
import { authorNamesOf, splitPenNames } from '../authors.js';
import { scopeMatcher, type AuthorScope } from './scope.js';

/**
 * The user's own books. They come from imported KDP reports (which name every title and ASIN the user sells) or are flagged by
 * hand, and exist before any page of them has been captured: the Library shows them under My Books and offers to open each on
 * Amazon so the extension can capture it.
 */

export interface OwnBookRow {
  asin: string;
  /** The captured title if there is one, else the title the KDP report gave. */
  title: string | null;
  /** The author names KDP reports the book under (pen names; several for a collaboration); for a book not in a report, the authors on its captured page. */
  penNames: string[];
  /** The people credited as authors on the newest captured page (not editors, illustrators and so on); empty until captured. */
  authorNames: string[];
  source: 'report' | 'manual';
  addedAt: string;
  /** Pages of this book captured so far; 0 means it still needs to be opened on Amazon and sent with the extension. */
  snapshots: number;
  lastCaptured: string | null;
  overallRank: number | null;
  /** Rank on the most recently captured list that includes the book, and that list's category. */
  listRank: number | null;
  listCategory: string | null;
  /** Which text the library holds for the book: a whole manuscript, only the free sample, or none. */
  text: 'manuscript' | 'sample' | null;
  ratingValue: number | null;
  ratingCount: number | null;
  kindlePrice: number | null;
  /** Paid units in the imported Orders reports (all marketplaces), and the span they cover. */
  paidUnits: number;
  firstSaleDay: string | null;
  lastSaleDay: string | null;
  /** Kindle Unlimited pages read in the imported KENP Read reports. */
  kenpPages: number;
}

export interface OwnCandidate { asin: string; title?: string | null; author?: string | null }

const ASIN = /^[A-Z0-9]{10}$/;

/** Add books to My Books (new ones only; a title or author the book lacked is filled in). Returns how many were new. */
export function registerOwnBooks(db: Db, books: OwnCandidate[], source: 'report' | 'manual', now = new Date().toISOString()): number {
  const merged = new Map<string, OwnCandidate>();
  for (const b of books) {
    if (!ASIN.test(b.asin)) continue;
    const c = merged.get(b.asin);
    merged.set(b.asin, { asin: b.asin, title: c?.title || b.title || null, author: c?.author || b.author || null });
  }
  let added = 0;
  const has = db.prepare('SELECT 1 FROM own_book WHERE asin = ?');
  const ins = db.prepare('INSERT INTO own_book (asin, title, author, source, added_at) VALUES (?,?,?,?,?)');
  const fill = db.prepare('UPDATE own_book SET title = COALESCE(title, ?), author = COALESCE(author, ?) WHERE asin = ?');
  db.transaction(() => {
    for (const b of merged.values()) {
      if (has.get(b.asin)) fill.run(b.title ?? null, b.author ?? null, b.asin);
      else { ins.run(b.asin, b.title ?? null, b.author ?? null, source, now); added++; }
    }
  })();
  return added;
}

/** Flag or unflag one book as the user's own. Unflagging keeps imported sales data; the next report import flags it again. */
export function setOwnBook(db: Db, root: string, asin: string, own: boolean, now = new Date().toISOString()): void {
  if (!ASIN.test(asin)) throw new Error('bad ASIN');
  if (own) {
    const t = db.scalar<string>('SELECT title FROM snapshot WHERE asin = ? ORDER BY captured_at DESC LIMIT 1', asin) ?? null;
    registerOwnBooks(db, [{ asin, title: t }], 'manual', now);
  } else {
    db.prepare('DELETE FROM own_book WHERE asin = ?').run(asin);
  }
  exportUserData(db, root);
}

export function isOwnBook(db: Db, asin: string): boolean {
  return !!db.scalar('SELECT 1 FROM own_book WHERE asin = ?', asin);
}

const SELECT = `
  SELECT o.asin,
    COALESCE((SELECT s.title FROM snapshot s WHERE s.asin = o.asin ORDER BY s.captured_at DESC LIMIT 1), o.title) AS title,
    o.author AS reportAuthor,
    (SELECT authors FROM snapshot WHERE asin = o.asin ORDER BY captured_at DESC LIMIT 1) AS authorsJson,
    o.source, o.added_at AS addedAt,
    (SELECT count(*) FROM snapshot WHERE asin = o.asin) AS snapshots,
    (SELECT max(captured_at) FROM snapshot WHERE asin = o.asin) AS lastCaptured,
    (SELECT r.rank FROM snapshot s JOIN rank_entry r ON r.snapshot_id = s.id AND r.scope = 'overall' AND r.store = 'kindle' WHERE s.asin = o.asin ORDER BY s.captured_at DESC LIMIT 1) AS overallRank,
    (SELECT e.rank FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id WHERE e.asin = o.asin ORDER BY l.captured_at DESC, e.rank LIMIT 1) AS listRank,
    (SELECT ${categoryNameSql('c')} FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id JOIN category c ON c.key = l.category_key WHERE e.asin = o.asin ORDER BY l.captured_at DESC, e.rank LIMIT 1) AS listCategory,
    (SELECT CASE WHEN count(CASE source WHEN 'upload' THEN 1 END) > 0 THEN 'manuscript' WHEN count(*) > 0 THEN 'sample' END FROM manuscript WHERE asin = o.asin) AS text,
    (SELECT rating_value FROM snapshot WHERE asin = o.asin ORDER BY captured_at DESC LIMIT 1) AS ratingValue,
    (SELECT rating_count FROM snapshot WHERE asin = o.asin ORDER BY captured_at DESC LIMIT 1) AS ratingCount,
    (SELECT kindle_price FROM snapshot WHERE asin = o.asin ORDER BY captured_at DESC LIMIT 1) AS kindlePrice,
    COALESCE((SELECT sum(paid_units) FROM sales_day WHERE asin = o.asin), 0) AS paidUnits,
    (SELECT min(day) FROM sales_day WHERE asin = o.asin) AS firstSaleDay,
    (SELECT max(day) FROM sales_day WHERE asin = o.asin AND paid_units > 0) AS lastSaleDay,
    COALESCE((SELECT sum(pages) FROM kenp_day WHERE asin = o.asin), 0) AS kenpPages
  FROM own_book o`;

/** My Books: captured ones first (best rank first), then the ones still to capture, by sales. */
export function listOwnBooks(db: Db, scope: AuthorScope = null): OwnBookRow[] {
  const rows = db.prepare(`${SELECT} ORDER BY (snapshots = 0), (overallRank IS NULL), overallRank, paidUnits DESC, title`).all().map(shape);
  return scope === null ? rows : rows.filter((b) => inScope(b, scope));
}

/** Whether a book is under one of the pen names in `scope`: by the author the report gave, else the authors of its captured page. A book with no author known (flagged by hand) is the user's own. */
export function inScope(b: Pick<OwnBookRow, 'penNames' | 'authorNames'>, scope: AuthorScope): boolean {
  if (scope === null) return true;
  const m = scopeMatcher(scope);
  const names = b.penNames.length ? b.penNames : b.authorNames;
  if (!names.length) return true;
  return names.some((n) => m.inScope(n) === true);
}

/** The books in the library that belong to pen names outside `scope`: what a library filled before the Studio had a scope may hold. */
export function booksOutsideScope(db: Db, scope: AuthorScope): OwnBookRow[] {
  return scope === null ? [] : listOwnBooks(db).filter((b) => !inScope(b, scope));
}

/**
 * Removes the books of other pen names from the library: their My Books entries, orders, pages read and royalties. Payment reports and KDP's monthly
 * summaries cover the whole account and cannot be told apart, so they are removed too when anything was. Page captures (market research) stay.
 * Returns how many books went.
 */
export function removeBooksOutsideScope(db: Db, root: string, scope: AuthorScope): number {
  const out = booksOutsideScope(db, scope).map((b) => b.asin);
  if (!out.length) return 0;
  db.transaction(() => {
    for (const asin of out) {
      for (const t of ['own_book', 'sales_day', 'kenp_day', 'royalty_month']) db.prepare(`DELETE FROM ${t} WHERE asin = ?`).run(asin);
    }
    db.exec('DELETE FROM kdp_summary; DELETE FROM payment_line; DELETE FROM payment;');
  })();
  exportUserData(db, root);
  return out.length;
}

function shape(r: any): OwnBookRow {
  const { reportAuthor, authorsJson, ...rest } = r;
  const authorNames = authorNamesOf(authorsJson);
  const reported = splitPenNames(reportAuthor);
  return { ...rest, authorNames, penNames: reported.length ? reported : authorNames } as OwnBookRow;
}

export function getOwnBook(db: Db, asin: string): OwnBookRow | null {
  const r = db.prepare(`${SELECT} WHERE o.asin = ?`).get(asin);
  return r ? shape(r) : null;
}
