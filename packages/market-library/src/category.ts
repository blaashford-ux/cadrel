import type { Db } from './schema.js';
import type { CategorySummary } from './queries.js';
import { categoryNameSql, listCategories } from './queries.js';
import { authorNamesOf } from './authors.js';

export interface CategoryBook {
  asin: string;
  /** Best rank on the newest capture of any list of this category. */
  listRank: number;
  title: string | null;
  author: string | null;
  /** False when the book is known only from the list row (no detail page captured yet). */
  captured: boolean;
  ratingValue: number | null;
  ratingCount: number | null;
  price: number | null;
  pages: number | null;
  publicationDate: string | null;
  seriesName: string | null;
  seriesPosition: number | null;
  overallRank: number | null;
  capturedAt: string | null;
}

/** Find a category by key, node id, or (unique, case-insensitive) name. */
export function resolveCategory(db: Db, ref: string): { category: CategorySummary } | { error: string } {
  const all = listCategories(db);
  const q = ref.trim().toLowerCase();
  const exact = all.filter((c) => c.key.toLowerCase() === q || c.nodeId === ref.trim());
  if (exact.length === 1) return { category: exact[0]! };
  const byName = all.filter((c) => (c.name ?? '').toLowerCase() === q);
  const loose = byName.length ? byName : all.filter((c) => (c.name ?? '').toLowerCase().includes(q));
  if (loose.length === 1) return { category: loose[0]! };
  const names = all.map((c) => `${c.name ?? '?'} (${c.key})`).join('; ');
  return { error: loose.length > 1 ? `ambiguous category "${ref}": ${loose.map((c) => c.key).join(', ')}` : `no category matches "${ref}". Known: ${names || 'none captured yet'}` };
}

export const CATEGORY_NAME_MAX = 120;

/**
 * Give a category your own name, or (with `name` null or empty) go back to the name Amazon gives it. The name is kept apart from the
 * captured one, so it survives re-captures and rebuilds. Returns the name now shown and the one it replaced.
 */
export function renameCategory(db: Db, categoryKey: string, name: string | null, now = new Date().toISOString()): { name: string | null; previous: string | null } {
  if (!db.scalar('SELECT 1 FROM category WHERE key = ?', categoryKey)) throw new Error(`no category ${categoryKey}`);
  const previous = db.scalar<string>(`SELECT ${categoryNameSql('c')} FROM category c WHERE c.key = ?`, categoryKey) ?? null;
  const clean = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, CATEGORY_NAME_MAX);
  if (!clean) db.prepare('DELETE FROM category_rename WHERE category_key = ?').run(categoryKey);
  else db.prepare('INSERT INTO category_rename (category_key, name, renamed_at) VALUES (?,?,?) ON CONFLICT(category_key) DO UPDATE SET name = excluded.name, renamed_at = excluded.renamed_at').run(categoryKey, clean, now);
  return { name: db.scalar<string>(`SELECT ${categoryNameSql('c')} FROM category c WHERE c.key = ?`, categoryKey) ?? null, previous };
}

/** Everything known about the books on a category's newest list captures, best rank first. */
export function categoryBooks(db: Db, categoryKey: string): CategoryBook[] {
  return db
    .prepare(
      `WITH latest AS (
         SELECT lc.id FROM list_capture lc WHERE lc.category_key = ?1 AND lc.captured_at = (
           SELECT max(captured_at) FROM list_capture x WHERE x.category_key = lc.category_key AND x.list_kind = lc.list_kind AND x.page = lc.page)
       ), ranked AS (
         SELECT e.asin, min(e.rank) AS listRank, max(e.title) AS title, max(e.author) AS author,
                max(e.rating_value) AS lrv, max(e.rating_count) AS lrc, max(e.price) AS lprice
         FROM list_entry e WHERE e.list_capture_id IN (SELECT id FROM latest) GROUP BY e.asin
       )
       SELECT r.asin, r.listRank, COALESCE(s.title, r.title) AS title,
              s.authors AS authorsJson, r.author AS listAuthor,
              s.id IS NOT NULL AS captured,
              COALESCE(s.rating_value, r.lrv) AS ratingValue, COALESCE(s.rating_count, r.lrc) AS ratingCount,
              COALESCE(s.kindle_price, r.lprice) AS price, s.pages AS pages, s.publication_date AS publicationDate,
              s.series_name AS seriesName, s.series_position AS seriesPosition,
              (SELECT rk.rank FROM rank_entry rk WHERE rk.snapshot_id = s.id AND rk.scope = 'overall' AND rk.store = 'kindle') AS overallRank,
              s.captured_at AS capturedAt
       FROM ranked r LEFT JOIN snapshot s ON s.asin = r.asin AND s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = r.asin)
       ORDER BY r.listRank, r.asin`,
    )
    .all(categoryKey)
    .map(({ authorsJson, listAuthor, ...r }: any) => {
      // everyone credited as an author on the captured page (a collaboration has several); the list row's name until it is captured
      const names = authorNamesOf(authorsJson);
      return { ...r, author: names.length ? names.join(', ') : listAuthor ?? null, captured: !!r.captured };
    }) as unknown as CategoryBook[];
}

export interface Summary {
  /** How many books had a value; the rest are unknown, not zero. */
  known: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  mean: number | null;
}

export function summarize(values: (number | null | undefined)[]): Summary {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { known: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null };
  const q = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
  };
  const r = (x: number) => Math.round(x * 100) / 100;
  return { known: v.length, min: v[0]!, p25: r(q(0.25)), median: r(q(0.5)), p75: r(q(0.75)), max: v[v.length - 1]!, mean: r(v.reduce((a, b) => a + b, 0) / v.length) };
}

export const METRICS = {
  price: (b: CategoryBook) => b.price,
  rating: (b: CategoryBook) => b.ratingValue,
  ratingCount: (b: CategoryBook) => b.ratingCount,
  pages: (b: CategoryBook) => b.pages,
  publicationYear: (b: CategoryBook) => (b.publicationDate ? Number(b.publicationDate.slice(0, 4)) : null),
  seriesPosition: (b: CategoryBook) => b.seriesPosition,
} as const;
export type MetricName = keyof typeof METRICS;

export interface CohortStats {
  topN: number;
  top: { books: number; captured: number; metrics: Record<string, Summary>; inSeries: number };
  rest: { books: number; captured: number; metrics: Record<string, Summary>; inSeries: number };
}

/** Compare the top N books of a category with the rest, metric by metric. */
export function cohortStats(books: CategoryBook[], topN: number): CohortStats {
  const part = (rows: CategoryBook[]) => ({
    books: rows.length,
    captured: rows.filter((b) => b.captured).length,
    inSeries: rows.filter((b) => b.seriesName).length,
    metrics: Object.fromEntries((Object.keys(METRICS) as MetricName[]).map((m) => [m, summarize(rows.map(METRICS[m]))])),
  });
  return { topN, top: part(books.filter((b) => b.listRank <= topN)), rest: part(books.filter((b) => b.listRank > topN)) };
}
