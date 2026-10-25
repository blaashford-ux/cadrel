import { mean, percentileRank, stdev } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, type CategoryBook } from '../category.js';

export interface Weights {
  rank: number;
  stability: number;
  velocity: number;
}

export const DEFAULT_WEIGHTS: Weights = { rank: 0.5, stability: 0.2, velocity: 0.3 };

export interface Component {
  /** The raw measurement, in its own unit. */
  raw: number | null;
  /** 0 (worst in the category) to 1 (best). */
  normalized: number | null;
  weight: number;
  /** Where the raw value came from, so it can be argued with. */
  basis: string;
}

export interface BookScore {
  asin: string;
  title: string | null;
  listRank: number;
  /** 0 to 100, from the components that could be measured; null if none could. */
  score: number | null;
  components: { rank: Component; stability: Component; velocity: Component };
  /** Components with no data (weights are renormalised over the rest). */
  missing: string[];
}

const DAY = 86400000;

export function getWeights(db: Db): Weights {
  try {
    const w = JSON.parse(db.scalar<string>("SELECT value FROM kv WHERE key = 'success_weights'") ?? 'null') as Partial<Weights> | null;
    if (w) return { ...DEFAULT_WEIGHTS, ...w };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_WEIGHTS };
}

export function setWeights(db: Db, w: Weights): void {
  for (const v of Object.values(w)) if (typeof v !== 'number' || v < 0 || !Number.isFinite(v)) throw new Error('weights must be non-negative numbers');
  if (w.rank + w.stability + w.velocity <= 0) throw new Error('at least one weight must be above zero');
  db.prepare("INSERT INTO kv (key, value) VALUES ('success_weights', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(w));
}

/** Per book: ranks it held on this category's lists across captures (best rank per capture time). */
function rankHistories(db: Db, categoryKey: string): Map<string, number[]> {
  const rows = db
    .prepare(
      `SELECT e.asin, l.captured_at AS at, min(e.rank) AS rank FROM list_entry e JOIN list_capture l ON l.id = e.list_capture_id
       WHERE l.category_key = ? GROUP BY e.asin, l.captured_at ORDER BY l.captured_at`,
    )
    .all(categoryKey) as unknown as { asin: string; rank: number }[];
  const m = new Map<string, number[]>();
  for (const r of rows) m.set(r.asin, [...(m.get(r.asin) ?? []), r.rank]);
  return m;
}

/** Ratings gained per day. Observed between captures when there are two or more days apart; otherwise lifetime average. */
function velocityOf(db: Db, b: CategoryBook): { value: number | null; basis: string } {
  if (!b.captured) return { value: null, basis: 'no detail page captured' };
  const pts = db.prepare('SELECT captured_at AS at, rating_count AS n FROM snapshot WHERE asin = ? AND rating_count IS NOT NULL ORDER BY captured_at').all(b.asin) as unknown as { at: string; n: number }[];
  if (pts.length >= 2) {
    const days = (Date.parse(pts[pts.length - 1]!.at) - Date.parse(pts[0]!.at)) / DAY;
    if (days >= 1) return { value: Math.max(0, (pts[pts.length - 1]!.n - pts[0]!.n) / days), basis: `observed over ${Math.round(days)} days (${pts.length} captures)` };
  }
  if (b.ratingCount != null && b.publicationDate) {
    const days = Math.max(30, (Date.parse(pts[pts.length - 1]?.at ?? new Date().toISOString()) - Date.parse(b.publicationDate)) / DAY);
    if (Number.isFinite(days)) return { value: b.ratingCount / days, basis: 'lifetime average since publication (one capture only)' };
  }
  return { value: null, basis: 'no rating count or publication date' };
}

export function successScores(db: Db, categoryKey: string, weights: Weights = getWeights(db), books: CategoryBook[] = categoryBooks(db, categoryKey)): BookScore[] {
  const hist = rankHistories(db, categoryKey);
  const n = Math.max(books.length, 2);

  const vel = new Map(books.map((b) => [b.asin, velocityOf(db, b)]));
  const stab = new Map<string, number | null>();
  for (const b of books) {
    const h = hist.get(b.asin) ?? [];
    const sd = h.length >= 3 ? stdev(h.map((r) => Math.log(r))) : null;
    stab.set(b.asin, sd);
  }
  const velVals = [...vel.values()].map((v) => v.value).filter((v): v is number => v != null);
  const stabVals = [...stab.values()].filter((v): v is number => v != null);

  return books.map((b) => {
    const v = vel.get(b.asin)!;
    const sd = stab.get(b.asin) ?? null;
    const components = {
      rank: { raw: b.listRank, normalized: books.length > 1 ? 1 - (b.listRank - 1) / (n - 1) : 1, weight: weights.rank, basis: `rank ${b.listRank} of ${books.length} on the newest list` } as Component,
      stability: {
        raw: sd == null ? null : Math.round(sd * 1000) / 1000,
        normalized: sd == null ? null : 1 - percentileRank(stabVals, sd),
        weight: weights.stability,
        basis: sd == null ? `needs 3+ list captures (has ${(hist.get(b.asin) ?? []).length})` : `std. dev. of log rank over ${(hist.get(b.asin) ?? []).length} captures (lower is steadier)`,
      } as Component,
      velocity: {
        raw: v.value == null ? null : Math.round(v.value * 100) / 100,
        normalized: v.value == null ? null : percentileRank(velVals, v.value),
        weight: weights.velocity,
        basis: v.basis,
      } as Component,
    };
    const used = Object.entries(components).filter(([, c]) => c.normalized != null && c.weight > 0);
    const totalW = used.reduce((a, [, c]) => a + c.weight, 0);
    const score = totalW > 0 ? Math.round((used.reduce((a, [, c]) => a + c.normalized! * c.weight, 0) / totalW) * 1000) / 10 : null;
    return {
      asin: b.asin, title: b.title, listRank: b.listRank, score, components,
      missing: Object.entries(components).filter(([, c]) => c.normalized == null).map(([k]) => k),
    };
  });
}

export function meanScore(scores: BookScore[]): number | null {
  const v = scores.map((s) => s.score).filter((s): s is number => s != null);
  const m = mean(v);
  return m == null ? null : Math.round(m * 10) / 10;
}
