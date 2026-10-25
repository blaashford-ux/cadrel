import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './schema.js';
import { removeVec } from './chunks.js';
import { isAsin } from './layout.js';

/**
 * Taking books out. Two different things:
 *  - excluding a book from a category (it is on that category's list but is the wrong genre): its list rows for that category are
 *    deleted and stay out through re-captures and rebuilds, so every analysis, search and the MCP stop seeing it there. The book
 *    itself stays in the library if it was captured, since it may belong to another category.
 *  - removing a book from the library (it was captured by mistake): its captured pages, covers, text, notes and index entries are
 *    deleted from the database and from disk, so a rebuild cannot bring it back.
 */

export interface Exclusion {
  categoryKey: string;
  categoryName: string | null;
  asin: string;
  title: string | null;
  excludedAt: string;
}

/** The columns of a parsed list row, as stored. */
export interface ListEntryRow {
  rank: number;
  asin: string;
  rendered: boolean;
  titleRaw: string | null;
  authorRaw: string | null;
  authorId: string | null;
  ratingValue: number | null;
  ratingCount: number | null;
  format: string | null;
  price: number | null;
  priceLayout: string | null;
  formatsAvailable: number | null;
  coverUrl: string | null;
}

export function insertListEntry(db: Db, listCaptureId: number, e: ListEntryRow): void {
  db.prepare(
    `INSERT INTO list_entry (list_capture_id, rank, asin, rendered, title, author, author_id, rating_value, rating_count,
       format, price, price_layout, formats_available, cover_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(listCaptureId, e.rank, e.asin, e.rendered ? 1 : 0, e.titleRaw, e.authorRaw, e.authorId, e.ratingValue, e.ratingCount,
    e.format, e.price, e.priceLayout, e.formatsAvailable, e.coverUrl);
}

/** ASINs excluded from a category, for the list indexer to skip. */
export function excludedAsins(db: Db, categoryKey: string): Set<string> {
  return new Set((db.prepare('SELECT asin FROM category_exclusion WHERE category_key = ?').all(categoryKey) as unknown as { asin: string }[]).map((r) => r.asin));
}

export function listExclusions(db: Db, categoryKey?: string): Exclusion[] {
  return db
    .prepare(
      `SELECT x.category_key AS categoryKey, c.name AS categoryName, x.asin, x.title, x.excluded_at AS excludedAt
       FROM category_exclusion x LEFT JOIN category c ON c.key = x.category_key
       WHERE (?1 IS NULL OR x.category_key = ?1) ORDER BY x.excluded_at DESC, x.asin`,
    )
    .all(categoryKey ?? null) as unknown as Exclusion[];
}

/** The categories whose newest list captures carry the book (excluded ones are already gone from them). */
export function listedIn(db: Db, asin: string): { key: string; name: string | null }[] {
  return db
    .prepare(
      `SELECT DISTINCT c.key, c.name FROM list_entry e
         JOIN list_capture lc ON lc.id = e.list_capture_id
         JOIN category c ON c.key = lc.category_key
       WHERE e.asin = ? AND lc.captured_at = (SELECT max(captured_at) FROM list_capture x WHERE x.category_key = lc.category_key AND x.list_kind = lc.list_kind AND x.page = lc.page)
       ORDER BY c.name`,
    )
    .all(asin) as unknown as { key: string; name: string | null }[];
}

/** Take a book out of one category's lists, and keep it out. Returns how many list rows went. */
export function excludeFromCategory(db: Db, asin: string, categoryKey: string, now = new Date().toISOString()): { entries: number } {
  if (!isAsin(asin)) throw new Error('bad ASIN');
  if (!db.scalar('SELECT 1 FROM category WHERE key = ?', categoryKey)) throw new Error(`no category ${categoryKey}`);
  return db.transaction(() => {
    const title = (db.scalar<string>('SELECT title FROM book WHERE asin = ?', asin)
      ?? db.scalar<string>('SELECT e.title FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id WHERE e.asin = ? AND l.category_key = ? LIMIT 1', asin, categoryKey)) ?? null;
    db.prepare('INSERT INTO category_exclusion (category_key, asin, title, excluded_at) VALUES (?,?,?,?) ON CONFLICT(category_key, asin) DO NOTHING').run(categoryKey, asin, title, now);
    const r = db.prepare('DELETE FROM list_entry WHERE asin = ? AND list_capture_id IN (SELECT id FROM list_capture WHERE category_key = ?)').run(asin, categoryKey);
    return { entries: Number(r.changes) };
  })();
}

/** Undo an exclusion: the book's rows come back from the stored list captures. Returns how many rows came back. */
export function restoreToCategory(db: Db, root: string, asin: string, categoryKey: string): { entries: number } {
  if (!isAsin(asin)) throw new Error('bad ASIN');
  return db.transaction(() => {
    db.prepare('DELETE FROM category_exclusion WHERE category_key = ? AND asin = ?').run(categoryKey, asin);
    let entries = 0;
    const caps = db.prepare('SELECT id, dir FROM list_capture WHERE category_key = ?').all(categoryKey) as unknown as { id: number; dir: string }[];
    for (const c of caps) {
      let parsed: { entries?: ListEntryRow[] };
      try { parsed = JSON.parse(fs.readFileSync(path.join(root, c.dir, 'parsed.json'), 'utf8')); } catch { continue; }
      for (const e of parsed.entries ?? []) {
        if (e.asin !== asin || db.scalar('SELECT 1 FROM list_entry WHERE list_capture_id = ? AND asin = ? AND rank = ?', c.id, asin, e.rank)) continue;
        insertListEntry(db, c.id, e);
        entries++;
      }
    }
    return { entries };
  })();
}

export interface RemovedBook { asin: string; snapshots: number; chunks: number; assets: number; files: boolean; excludedFrom: number }

/**
 * Delete a captured book: database rows, derived index entries and the files under books/<asin>. With `alsoExclude`, it is also taken
 * out of every category it is listed in (otherwise it stays on those lists as a book that is not captured yet, and in the queue).
 * Your own-book entry and imported sales are kept.
 */
export function removeBook(db: Db, root: string, asin: string, o: { alsoExclude?: boolean; now?: string } = {}): RemovedBook {
  if (!isAsin(asin)) throw new Error('bad ASIN');
  const dir = path.join(root, 'books', asin);
  const snapshots = db.scalar<number>('SELECT count(*) FROM snapshot WHERE asin = ?', asin) ?? 0;
  if (!snapshots && !db.scalar('SELECT 1 FROM book WHERE asin = ?', asin) && !fs.existsSync(dir)) throw new Error(`no captured book with ASIN ${asin}`);
  let excludedFrom = 0;
  const out = db.transaction(() => {
    if (o.alsoExclude) for (const c of listedIn(db, asin)) { excludeFromCategory(db, asin, c.key, o.now); excludedFrom++; }
    const ids = db.prepare('SELECT id FROM chunk WHERE asin = ?').all(asin) as unknown as { id: number }[];
    for (const c of ids) removeVec(db, c.id);
    db.prepare('DELETE FROM chunk WHERE asin = ?').run(asin);
    db.prepare('DELETE FROM manuscript WHERE asin = ?').run(asin);
    db.prepare("DELETE FROM parse_issue WHERE source_kind = 'snapshot' AND source_id IN (SELECT id FROM snapshot WHERE asin = ?)").run(asin);
    db.prepare('DELETE FROM snapshot WHERE asin = ?').run(asin);
    db.prepare('DELETE FROM book WHERE asin = ?').run(asin);
    db.prepare('DELETE FROM annotation WHERE asin = ?').run(asin);
    db.prepare('DELETE FROM queue_item WHERE asin = ?').run(asin);
    db.prepare('DELETE FROM cover_metrics WHERE asin = ?').run(asin);
    const assets = Number(db.prepare('DELETE FROM asset WHERE asin = ?').run(asin).changes);
    // a category that only this book's page had mentioned has no list behind it and nothing to show
    db.exec('DELETE FROM category WHERE NOT EXISTS (SELECT 1 FROM list_capture WHERE category_key = category.key) AND NOT EXISTS (SELECT 1 FROM rank_entry WHERE category_key = category.key)');
    return { asin, snapshots, chunks: ids.length, assets, excludedFrom };
  })();
  const files = fs.existsSync(dir);
  if (path.dirname(dir) === path.join(root, 'books')) fs.rmSync(dir, { recursive: true, force: true });
  return { ...out, files };
}

/**
 * Clear what is derived from pages that no longer exist: cover measurements for deleted covers and search-index entries for books
 * no longer in the library. Everything else (the analyses, reports, searches) is computed from the database when asked, so it
 * needs no refresh. Cheap and safe to run at any time.
 */
export function refreshDerived(db: Db): { coverMetrics: number; chunks: number } {
  return db.transaction(() => {
    const coverMetrics = Number(db.prepare('DELETE FROM cover_metrics WHERE sha256 NOT IN (SELECT sha256 FROM asset)').run().changes);
    const orphans = db.prepare('SELECT id FROM chunk WHERE asin NOT IN (SELECT asin FROM book) AND asin NOT IN (SELECT asin FROM manuscript)').all() as unknown as { id: number }[];
    for (const c of orphans) { removeVec(db, c.id); db.prepare('DELETE FROM chunk WHERE id = ?').run(c.id); }
    return { coverMetrics, chunks: orphans.length };
  })();
}
