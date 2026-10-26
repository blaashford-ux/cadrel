import { median } from '@cadrel/market-core';
import type { Db } from '../schema.js';

export type TrendMetric = 'median_price' | 'median_rating_count' | 'median_rating' | 'books_listed' | 'new_release_share';

export interface TrendPoint {
  /** A day (YYYY-MM-DD) or a month (YYYY-MM). */
  bucket: string;
  captures: number;
  /** Books the figure is based on. */
  n: number;
  value: number | null;
}

/**
 * How a category's lists changed over time. Each bucket uses the newest capture of every list in it; a book on
 * several lists counts once. With few captures use bucket "day"; with months of history use "month".
 */
export function trend(db: Db, categoryKey: string, metric: TrendMetric, bucket: 'day' | 'month' = 'day'): TrendPoint[] {
  const caps = db
    .prepare('SELECT id, captured_at AS at, list_kind AS kind, page FROM list_capture WHERE category_key = ? ORDER BY captured_at')
    .all(categoryKey) as unknown as { id: number; at: string; kind: string; page: number }[];
  const key = (at: string) => at.slice(0, bucket === 'day' ? 10 : 7);
  const latest = new Map<string, { id: number; at: string }>();
  const counts = new Map<string, number>();
  for (const c of caps) {
    const b = key(c.at);
    counts.set(b, (counts.get(b) ?? 0) + 1);
    latest.set(`${b}|${c.kind}|${c.page}`, { id: c.id, at: c.at });
  }
  const byBucket = new Map<string, number[]>();
  for (const [k, v] of latest) {
    const b = k.split('|')[0]!;
    byBucket.set(b, [...(byBucket.get(b) ?? []), v.id]);
  }
  const col = { median_price: 'price', median_rating_count: 'rating_count', median_rating: 'rating_value' } as const;
  return [...byBucket.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([b, ids]) => {
    const ph = ids.map(() => '?').join(',');
    if (metric === 'books_listed') {
      const n = db.scalar<number>(`SELECT count(DISTINCT asin) FROM list_entry WHERE list_capture_id IN (${ph})`, ...ids) ?? 0;
      return { bucket: b, captures: counts.get(b) ?? 0, n, value: n };
    }
    if (metric === 'new_release_share') {
      const rows = db
        .prepare(
          `SELECT DISTINCT e.asin, s.publication_date AS pub FROM list_entry e JOIN snapshot s ON s.asin = e.asin
           WHERE e.list_capture_id IN (${ph}) AND s.publication_date IS NOT NULL
             AND s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = e.asin)`,
        )
        .all(...ids) as unknown as { pub: string }[];
      const at = Date.parse(b.length === 7 ? `${b}-28` : b);
      const fresh = rows.filter((r) => (at - Date.parse(r.pub)) / 86400000 <= 90).length;
      return { bucket: b, captures: counts.get(b) ?? 0, n: rows.length, value: rows.length ? Math.round((fresh / rows.length) * 1000) / 1000 : null };
    }
    const rows = db
      .prepare(`SELECT e.asin, max(e.${col[metric]}) AS v FROM list_entry e WHERE e.list_capture_id IN (${ph}) AND e.${col[metric]} IS NOT NULL GROUP BY e.asin`)
      .all(...ids) as unknown as { v: number }[];
    const m = median(rows.map((r) => r.v));
    return { bucket: b, captures: counts.get(b) ?? 0, n: rows.length, value: m == null ? null : Math.round(m * 100) / 100 };
  });
}
