import { median } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, type CategoryBook } from '../category.js';
import { bestsellersUrl, listCategories } from '../queries.js';

const DAY = 86400000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------------------------------------------
// 2. Rank-to-sales estimate
// ---------------------------------------------------------------------------------------------------------------

/** sales per day = a * rank^-b, for the paid Kindle Store. An approximation, not a measurement. */
export interface SalesCurve {
  a: number;
  b: number;
}

/** Fitted by eye to commonly quoted figures: roughly 350/day at #100, 57/day at #1,000, 1.5/day at #100,000. */
export const DEFAULT_SALES_CURVE: SalesCurve = { a: 13300, b: 0.79 };

export function getSalesCurve(db: Db): SalesCurve {
  try {
    const c = JSON.parse(db.scalar<string>("SELECT value FROM kv WHERE key = 'sales_curve'") ?? 'null') as Partial<SalesCurve> | null;
    if (c) return { ...DEFAULT_SALES_CURVE, ...c };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_SALES_CURVE };
}

export function setSalesCurve(db: Db, c: SalesCurve): void {
  if (!(c.a > 0) || !(c.b > 0) || !Number.isFinite(c.a) || !Number.isFinite(c.b)) throw new Error('sales curve needs a > 0 and b > 0');
  db.prepare("INSERT INTO kv (key, value) VALUES ('sales_curve', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(c));
}

/** Estimated paid Kindle sales per day for a Kindle Store overall rank. Ignores Kindle Unlimited borrows. */
export function estimateDailySales(rank: number, curve: SalesCurve = DEFAULT_SALES_CURVE): number {
  if (!(rank >= 1)) throw new Error('rank must be 1 or more');
  return curve.a * rank ** -curve.b;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared: least-squares line through log(x), log(y)
// ---------------------------------------------------------------------------------------------------------------

interface LogFit {
  n: number;
  slope: number;
  intercept: number;
}

function logFit(points: { x: number; y: number }[]): LogFit | null {
  const p = points.filter((q) => q.x >= 1 && q.y >= 1).map((q) => ({ x: Math.log(q.x), y: Math.log(q.y) }));
  if (p.length < 4) return null;
  const mx = p.reduce((a, q) => a + q.x, 0) / p.length;
  const my = p.reduce((a, q) => a + q.y, 0) / p.length;
  const sxx = p.reduce((a, q) => a + (q.x - mx) ** 2, 0);
  if (sxx < 1e-9) return null; // every point at the same x: no slope to fit
  const slope = p.reduce((a, q) => a + (q.x - mx) * (q.y - my), 0) / sxx;
  return { n: p.length, slope, intercept: my - slope * mx };
}

const predict = (f: LogFit, x: number) => Math.exp(f.intercept + f.slope * Math.log(x));

// ---------------------------------------------------------------------------------------------------------------
// Category depth: what it takes to sit at #1, #10 and #100 of a list
// ---------------------------------------------------------------------------------------------------------------

export interface DepthAnchor {
  asin: string;
  listRank: number;
  overallRank: number;
  estDailySales: number;
}

export interface CategoryDepth {
  /** Books with both a list rank and a Kindle Store rank (that is, a detail page). */
  anchors: DepthAnchor[];
  fit: { n: number; slope: number } | null;
  /** Estimated Kindle Store rank and daily sales at a few list positions; null when there is too little to fit. */
  at: { listRank: number; overallRank: number; estDailySales: number }[] | null;
  confidence: 'none' | 'low' | 'ok';
  caveat: string;
}

export function categoryDepth(books: CategoryBook[], curve: SalesCurve): CategoryDepth {
  const anchors = books
    .filter((b) => b.overallRank != null && b.overallRank >= 1)
    .map((b) => ({ asin: b.asin, listRank: b.listRank, overallRank: b.overallRank!, estDailySales: round(estimateDailySales(b.overallRank!, curve), 1) }));
  const fit = logFit(anchors.map((a) => ({ x: a.listRank, y: a.overallRank })));
  const confidence = !fit ? 'none' : fit.n >= 10 ? 'ok' : 'low';
  const at = fit
    ? [1, 10, 20, 50, 100].map((r) => {
        const overall = Math.max(1, Math.round(predict(fit, r)));
        return { listRank: r, overallRank: overall, estDailySales: round(estimateDailySales(overall, curve), 1) };
      })
    : null;
  const caveat = !fit
    ? `Needs detail pages for at least 4 books on the list to estimate depth (has ${anchors.length}). Capture more of the top 100.`
    : `Fitted to ${fit.n} books with detail pages. Daily sales come from a rank-to-sales curve (a=${curve.a}, b=${curve.b}) and ignore Kindle Unlimited; treat as an order of magnitude.`;
  return { anchors, fit: fit ? { n: fit.n, slope: round(fit.slope, 3) } : null, at, confidence, caveat };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Opportunity score per category
// ---------------------------------------------------------------------------------------------------------------

export interface OpportunityWeights {
  demand: number;
  reviewBarrier: number;
  openness: number;
  churn: number;
}

export const DEFAULT_OPPORTUNITY_WEIGHTS: OpportunityWeights = { demand: 0.35, reviewBarrier: 0.25, openness: 0.2, churn: 0.2 };

export function getOpportunityWeights(db: Db): OpportunityWeights {
  try {
    const w = JSON.parse(db.scalar<string>("SELECT value FROM kv WHERE key = 'opportunity_weights'") ?? 'null') as Partial<OpportunityWeights> | null;
    if (w) return { ...DEFAULT_OPPORTUNITY_WEIGHTS, ...w };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_OPPORTUNITY_WEIGHTS };
}

export function setOpportunityWeights(db: Db, w: OpportunityWeights): void {
  for (const v of Object.values(w)) if (typeof v !== 'number' || v < 0 || !Number.isFinite(v)) throw new Error('weights must be non-negative numbers');
  if (w.demand + w.reviewBarrier + w.openness + w.churn <= 0) throw new Error('at least one weight must be above zero');
  db.prepare("INSERT INTO kv (key, value) VALUES ('opportunity_weights', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(w));
}

export interface OpportunityComponent {
  raw: number | null;
  /** 0 (bad for a new book) to 1 (good). */
  normalized: number | null;
  weight: number;
  basis: string;
}

export interface Opportunity {
  category: string;
  name: string | null;
  topN: number;
  listedBooks: number;
  /** 0 to 100, from the components that could be measured; null if none could. */
  score: number | null;
  components: Record<keyof OpportunityWeights, OpportunityComponent>;
  missing: string[];
  depth: CategoryDepth;
  /** Plain numbers for the top N, so the score can be argued with. */
  benchmarks: { medianRatingCount: number | null; fewestRatingCount: number | null; booksUnder100Ratings: number; medianPrice: number | null; newWithin365d: { known: number; count: number } };
}

/** Review counts at or below this barely deter a new entrant; at or above the upper bound the barrier is total. */
const REVIEWS_LOW = 50;
const REVIEWS_HIGH = 2000;
/** Estimated daily sales at #20 that score 0 and 1 (log scale). */
const SALES_LOW = 1;
const SALES_HIGH = 100;
/** Share of the top N replaced between first and latest capture that counts as a fully open market. */
const CHURN_FULL = 0.5;

function churnOf(db: Db, categoryKey: string, topN: number): { value: number | null; basis: string } {
  const caps = db
    .prepare('SELECT id, captured_at AS at, list_kind AS kind, page FROM list_capture WHERE category_key = ? AND page = 1 ORDER BY captured_at')
    .all(categoryKey) as unknown as { id: number; at: string; kind: string }[];
  const byKind = new Map<string, typeof caps>();
  for (const c of caps) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  // Use the most-captured list kind (normally the paid bestsellers).
  const series = [...byKind.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  if (series.length < 2) return { value: null, basis: `needs 2+ captures of the list over time (has ${series.length})` };
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const days = (Date.parse(last.at) - Date.parse(first.at)) / DAY;
  if (days < 1) return { value: null, basis: 'captures are less than a day apart' };
  const top = (id: number) => new Set((db.prepare('SELECT asin FROM list_entry WHERE list_capture_id = ? AND rank <= ?').all(id, topN) as unknown as { asin: string }[]).map((r) => r.asin));
  const a = top(first.id);
  const b = top(last.id);
  if (!b.size) return { value: null, basis: 'latest capture has no entries' };
  const fresh = [...b].filter((x) => !a.has(x)).length;
  return { value: fresh / b.size, basis: `${fresh} of ${b.size} top-${topN} books were not in the top ${topN} ${Math.round(days)} days earlier (${series.length} captures)` };
}

export function opportunityScore(
  db: Db,
  categoryKey: string,
  topN = 10,
  weights: OpportunityWeights = getOpportunityWeights(db),
  curve: SalesCurve = getSalesCurve(db),
  books: CategoryBook[] = categoryBooks(db, categoryKey),
): Opportunity {
  const top = books.filter((b) => b.listRank <= topN);
  const listAt = db.scalar<string>('SELECT max(captured_at) FROM list_capture WHERE category_key = ?', categoryKey);
  const listTime = listAt ? Date.parse(listAt) : Date.now();
  const depth = categoryDepth(books, curve);

  // demand: estimated sales of the book at #20. A category where #20 sells almost nothing is not worth entering.
  const at20 = depth.at?.find((p) => p.listRank === 20) ?? null;
  const demand: OpportunityComponent = {
    raw: at20 ? at20.estDailySales : null,
    normalized: at20 ? clamp01(Math.log10(Math.max(at20.estDailySales, 1e-6) / SALES_LOW) / Math.log10(SALES_HIGH / SALES_LOW)) : null,
    weight: weights.demand,
    basis: at20 ? `#20 on the list is about Kindle Store rank ${at20.overallRank}, ~${at20.estDailySales} sales/day (estimate; ${depth.confidence} confidence)` : depth.caveat,
  };

  // reviewBarrier: how many reviews the top N carry. Few reviews means a new book can compete.
  const counts = top.map((b) => b.ratingCount).filter((n): n is number => n != null);
  const medCount = counts.length ? median(counts) : null;
  const reviewBarrier: OpportunityComponent = {
    raw: medCount,
    normalized: medCount == null ? null : 1 - clamp01(Math.log10(Math.max(medCount, 1) / REVIEWS_LOW) / Math.log10(REVIEWS_HIGH / REVIEWS_LOW)),
    weight: weights.reviewBarrier,
    basis: medCount == null ? 'no rating counts on the list' : `median ${medCount} ratings across ${counts.length} of the top ${top.length} books (${REVIEWS_LOW} or fewer scores 1, ${REVIEWS_HIGH} or more scores 0)`,
  };

  // openness: how many of the top N are recent. Needs publication dates, which come from detail pages.
  const dated = top.filter((b) => b.publicationDate && Number.isFinite(Date.parse(b.publicationDate)));
  const recent = dated.filter((b) => (listTime - Date.parse(b.publicationDate!)) / DAY <= 365).length;
  const openness: OpportunityComponent = {
    raw: dated.length ? round(recent / dated.length, 3) : null,
    normalized: dated.length ? recent / dated.length : null,
    weight: weights.openness,
    basis: dated.length ? `${recent} of ${dated.length} top-${topN} books with a known date were published in the last year` : 'no publication dates (needs detail pages for the top books)',
  };

  const ch = churnOf(db, categoryKey, topN);
  const churn: OpportunityComponent = { raw: ch.value == null ? null : round(ch.value, 3), normalized: ch.value == null ? null : clamp01(ch.value / CHURN_FULL), weight: weights.churn, basis: ch.basis };

  const components = { demand, reviewBarrier, openness, churn };
  const used = Object.values(components).filter((c) => c.normalized != null && c.weight > 0);
  const totalW = used.reduce((a, c) => a + c.weight, 0);
  const score = totalW > 0 ? Math.round((used.reduce((a, c) => a + c.normalized! * c.weight, 0) / totalW) * 1000) / 10 : null;

  const prices = top.map((b) => b.price).filter((p): p is number => p != null);
  const cat = listCategories(db).find((c) => c.key === categoryKey);
  return {
    category: categoryKey,
    name: cat?.name ?? null,
    topN,
    listedBooks: books.length,
    score,
    components,
    missing: Object.entries(components).filter(([, c]) => c.normalized == null).map(([k]) => k),
    depth,
    benchmarks: {
      medianRatingCount: medCount,
      fewestRatingCount: counts.length ? Math.min(...counts) : null,
      booksUnder100Ratings: counts.filter((n) => n < 100).length,
      medianPrice: prices.length ? median(prices) : null,
      newWithin365d: { known: dated.length, count: recent },
    },
  };
}

/** Every category that has a list capture, best opportunity first (unscored ones last). */
export function rankCategories(db: Db, topN = 10): Opportunity[] {
  const weights = getOpportunityWeights(db);
  const curve = getSalesCurve(db);
  return listCategories(db)
    .filter((c) => c.listedBooks > 0)
    .map((c) => opportunityScore(db, c.key, topN, weights, curve))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Sub-category finder
// ---------------------------------------------------------------------------------------------------------------

export type ShelfLabel = 'dead' | 'niche' | 'competitive' | 'hot';

export interface SubCategory {
  key: string;
  name: string | null;
  store: string;
  /** Captured books seen ranking in this sub-category (any position). */
  observedBooks: number;
  /** Observed books ranked inside the top 100 of the sub-category (the ones the estimate uses). */
  usedBooks: number;
  bestCategoryRank: number;
  /** Kindle Store rank of the observed book with the best sub-category rank. */
  overallRankAtBest: number;
  /** Estimated daily sales needed to hold #10 of this sub-category; null with too little data. */
  salesToTop10: number | null;
  label: ShelfLabel | null;
  /** The shelf's Best Sellers page on Amazon, built the way book pages link to it. */
  url: string | null;
  /** True when this sub-category already has a list capture of its own. */
  listCaptured: boolean;
  note: string;
}

/** Boundaries, in estimated daily sales to reach #10, between dead / niche / competitive / hot. */
export const SHELF_BOUNDS = { dead: 1, niche: 10, competitive: 50 };

const labelOf = (sales: number): ShelfLabel => (sales < SHELF_BOUNDS.dead ? 'dead' : sales < SHELF_BOUNDS.niche ? 'niche' : sales < SHELF_BOUNDS.competitive ? 'competitive' : 'hot');

/**
 * Looks at the sub-category ranks on every captured book's newest detail page ("#4 in Cozy Fantasy") and works out,
 * for each shelf, roughly how many sales a book needs to be in its top 10. A book at Kindle Store rank 60,000 that
 * is #3 in a sub-category says that shelf is thin. Each observed book implies a #10 figure by scaling its own
 * sales by (its shelf rank / 10)^b with the same exponent as the sales curve; the median over books is used.
 */
export function findSubCategories(db: Db, opts: { minBooks?: number; store?: string } = {}, curve: SalesCurve = getSalesCurve(db)): SubCategory[] {
  const minBooks = opts.minBooks ?? 2;
  const rows = db
    .prepare(
      `SELECT r.category_key AS key, r.name AS name, r.store AS store, r.rank AS catRank, s.asin AS asin,
              (SELECT o.rank FROM rank_entry o WHERE o.snapshot_id = s.id AND o.scope = 'overall' AND o.store = 'kindle') AS overall
       FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id
       WHERE r.scope = 'category' AND r.category_key IS NOT NULL
         AND s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = s.asin)`,
    )
    .all() as unknown as { key: string; name: string | null; store: string; catRank: number; asin: string; overall: number | null }[];
  const listed = new Set((db.prepare('SELECT DISTINCT category_key AS k FROM list_capture').all() as unknown as { k: string }[]).map((r) => r.k));
  const cats = new Map((db.prepare('SELECT key, marketplace, store, node_id AS nodeId FROM category').all() as unknown as { key: string; marketplace: string; store: string; nodeId: string }[]).map((c) => [c.key, c]));

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (opts.store && r.store !== opts.store) continue;
    groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  }
  const out: SubCategory[] = [];
  for (const [key, g] of groups) {
    if (g.length < minBooks) continue;
    const usable = g.filter((r) => r.overall != null && r.overall >= 1 && r.catRank >= 1 && r.catRank <= 100);
    const best = [...g].sort((a, b) => a.catRank - b.catRank)[0]!;
    const implied = usable.map((r) => estimateDailySales(r.overall!, curve) * (r.catRank / 10) ** curve.b);
    const sales = implied.length ? median(implied) : null;
    const label = sales == null ? null : labelOf(sales);
    out.push({
      key,
      name: g.find((r) => r.name)?.name ?? null,
      store: g[0]!.store,
      observedBooks: g.length,
      usedBooks: usable.length,
      bestCategoryRank: best.catRank,
      overallRankAtBest: best.overall ?? 0,
      salesToTop10: sales == null ? null : round(sales, 1),
      label,
      url: cats.has(key) ? bestsellersUrl(cats.get(key)!) : null,
      listCaptured: listed.has(key),
      note:
        sales == null
          ? 'No observed book ranks in the top 100 of this shelf with a Kindle Store rank; nothing to estimate from.'
          : `Estimated from ${usable.length} captured book(s); a niche label with ${usable.length < 3 ? 'fewer than 3 books' : 'this few books'} is a lead to check, not a finding.${listed.has(key) ? '' : ' Capture this sub-category list to confirm.'}`,
    });
  }
  const order: Record<string, number> = { niche: 0, competitive: 1, hot: 2, dead: 3 };
  return out.sort((a, b) => (order[a.label ?? ''] ?? 4) - (order[b.label ?? ''] ?? 4) || b.usedBooks - a.usedBooks || (a.salesToTop10 ?? 0) - (b.salesToTop10 ?? 0));
}
