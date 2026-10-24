import { median, TROPES } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, type CategoryBook } from '../category.js';

export const STOP = new Set(
  ('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just like me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your ' +
    'book books series novel kindle edition read reading reader readers story stories new one two three first second third author bestselling bestseller get see will page pages free unlimited volume part set collection').split(' '),
);

/** Lowercase word tokens with a light plural strip; numbers and stop words dropped. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) ?? []) {
    if (STOP.has(raw)) continue;
    let w = raw.replace(/['’]s$/, '').replace(/^[-'’]+|[-'’]+$/g, '');
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (/(?:ch|sh|x|z|ss)es$/.test(w) && w.length > 5) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length < 3 || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

type Vec = Map<string, number>;

function norm(v: Vec): Vec {
  let s = 0;
  for (const x of v.values()) s += x * x;
  const d = Math.sqrt(s) || 1;
  return new Map([...v].map(([k, x]) => [k, x / d]));
}
function dot(a: Vec, b: Vec): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let t = 0;
  for (const [k, x] of s) {
    const y = l.get(k);
    if (y) t += x * y;
  }
  return t;
}

export interface TropeCluster {
  id: number;
  /** Most distinctive terms of the cluster, strongest first. */
  label: string[];
  /** Dictionary tropes present in at least half of the cluster's books. */
  tropes: string[];
  books: number;
  /** Books with a blurb (detail page); the rest are described by title alone. */
  withBlurb: number;
  top: number;
  rest: number;
  topShare: number | null;
  restShare: number | null;
  /** topShare / restShare, smoothed so an empty side does not divide by zero. */
  lift: number | null;
  medianListRank: number | null;
  medianRatingCount: number | null;
  medianPrice: number | null;
  examples: { asin: string; listRank: number; title: string | null }[];
  /**
   * gap: well represented at the top but thin below (readers want it, few compete);
   * crowded: many books below, few at the top; thin: too few books to say; neutral: otherwise.
   */
  signal: 'gap' | 'crowded' | 'neutral' | 'thin';
}

export interface TropeClusters {
  topN: number;
  clusters: TropeCluster[];
  /** Books that matched no cluster. */
  unclustered: number;
  books: number;
  withBlurb: number;
  caveats: string[];
}

export interface ClusterOptions {
  /** Merging stops when the closest pair is less similar than this (cosine of tf-idf vectors). */
  minSimilarity?: number;
  /** Never merge below this many clusters; 0 means "let the threshold decide". */
  maxClusters?: number;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

interface Doc {
  b: CategoryBook;
  blurb: boolean;
  terms: string[];
  tropes: string[];
}

function blurbOf(db: Db, asin: string): string | null {
  return (
    db.scalar<string>(
      `SELECT t.body FROM text_block t JOIN snapshot s ON s.id = t.snapshot_id
       WHERE s.asin = ? AND t.kind = 'blurb' ORDER BY s.captured_at DESC LIMIT 1`,
      asin,
    ) ?? null
  );
}

/**
 * Groups a category's books by what they are about, from titles and blurbs (tf-idf and average-linkage clustering;
 * no model download needed, and deterministic). Then compares each group's share of the top N with its share of the
 * rest: a group that is common at the top and rare below is a gap, one that fills the lower ranks but not the top
 * is crowded.
 */
export function tropeClusters(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey), opts: ClusterOptions = {}): TropeClusters {
  const minSim = opts.minSimilarity ?? 0.12;
  const maxClusters = opts.maxClusters ?? 0;
  const docs: Doc[] = books.map((b) => {
    const blurb = b.captured ? blurbOf(db, b.asin) : null;
    const text = `${b.title ?? ''}\n${blurb ?? ''}`;
    return { b, blurb: !!blurb, terms: tokens(text), tropes: Object.entries(TROPES).filter(([, re]) => re.test(text)).map(([k]) => k) };
  });
  const withBlurb = docs.filter((d) => d.blurb).length;
  const caveats: string[] = [];
  if (docs.length < 6) caveats.push(`Only ${docs.length} books on the list; clusters need at least 6.`);
  if (withBlurb < docs.length) caveats.push(`${docs.length - withBlurb} of ${docs.length} books have only a title to go on (no detail page captured), so their grouping is rougher. Capture the rest to sharpen it.`);
  caveats.push('Groups come from word overlap, not from reading the books. Check the examples before trusting a label.');
  if (docs.length < 6) return { topN, clusters: [], unclustered: docs.length, books: docs.length, withBlurb, caveats };

  // tf-idf, with each matched dictionary trope added as an extra (double-weighted) feature
  const df = new Map<string, number>();
  const feats = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of d.tropes) tf.set(`trope:${t}`, 2);
    for (const k of tf.keys()) df.set(k, (df.get(k) ?? 0) + 1);
    return tf;
  });
  const n = docs.length;
  const vecs: Vec[] = feats.map((tf) => {
    const v: Vec = new Map();
    for (const [k, c] of tf) {
      const d = df.get(k)!;
      if (d < 2 && !k.startsWith('trope:')) continue; // a term only one book uses cannot link two books
      if (d > n * 0.6) continue; // a term in most books links everything
      v.set(k, (1 + Math.log(c)) * Math.log(1 + n / d));
    }
    return norm(v);
  });

  // average-linkage agglomerative clustering
  let groups: number[][] = docs.map((_, i) => [i]);
  const sim = vecs.map((a) => vecs.map((b) => dot(a, b)));
  const link = (a: number[], b: number[]) => a.reduce((s, i) => s + b.reduce((t, j) => t + sim[i]![j]!, 0), 0) / (a.length * b.length);
  for (;;) {
    if (maxClusters && groups.length <= maxClusters) break;
    let best = -1, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const s = link(groups[i]!, groups[j]!);
        if (s > best) { best = s; bi = i; bj = j; }
      }
    }
    if (best < minSim) break;
    groups = groups.filter((_, k) => k !== bi && k !== bj).concat([[...groups[bi]!, ...groups[bj]!]]);
  }

  const multi = groups.filter((g) => g.length >= 2);
  const topAll = docs.filter((d) => d.b.listRank <= topN).length;
  const restAll = docs.length - topAll;
  const clusters: TropeCluster[] = multi.map((g) => {
    const members = g.map((i) => docs[i]!).sort((a, b) => a.b.listRank - b.b.listRank);
    const centroid: Vec = new Map();
    for (const i of g) for (const [k, x] of vecs[i]!) centroid.set(k, (centroid.get(k) ?? 0) + x);
    const label = [...centroid].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k.replace(/^trope:/, '')).filter((k, i, a) => a.indexOf(k) === i).slice(0, 4);
    const tropeCount = new Map<string, number>();
    for (const m of members) for (const t of m.tropes) tropeCount.set(t, (tropeCount.get(t) ?? 0) + 1);
    const top = members.filter((m) => m.b.listRank <= topN).length;
    const rest = members.length - top;
    const topShare = topAll ? top / topAll : null;
    const restShare = restAll ? rest / restAll : null;
    // add-half smoothing so a cluster with no books below the top still gets a finite lift
    const lift = topAll && restAll ? (top + 0.5) / topAll / ((rest + 0.5) / restAll) : null;
    const med = (f: (b: CategoryBook) => number | null) => {
      const v = members.map((m) => f(m.b)).filter((x): x is number => x != null);
      return v.length ? median(v) : null;
    };
    const signal: TropeCluster['signal'] =
      members.length < 3 ? 'thin' : lift != null && lift >= 2 && top >= 2 ? 'gap' : lift != null && lift <= 0.5 && rest >= 3 ? 'crowded' : 'neutral';
    return {
      id: 0,
      label,
      tropes: [...tropeCount].filter(([, c]) => c >= members.length / 2).map(([t]) => t).sort(),
      books: members.length,
      withBlurb: members.filter((m) => m.blurb).length,
      top,
      rest,
      topShare: topShare == null ? null : round(topShare),
      restShare: restShare == null ? null : round(restShare),
      lift: lift == null ? null : round(lift, 2),
      medianListRank: med((b) => b.listRank),
      medianRatingCount: med((b) => b.ratingCount),
      medianPrice: med((b) => b.price),
      examples: members.slice(0, 3).map((m) => ({ asin: m.b.asin, listRank: m.b.listRank, title: m.b.title })),
      signal,
    };
  });
  const order = { gap: 0, crowded: 2, neutral: 1, thin: 3 } as const;
  clusters.sort((a, b) => order[a.signal] - order[b.signal] || b.books - a.books || (a.medianListRank ?? 0) - (b.medianListRank ?? 0));
  clusters.forEach((c, i) => (c.id = i + 1));
  if (!topAll || !restAll) caveats.push(`The top ${topN} covers ${topAll ? 'every' : 'no'} listed book, so top-versus-rest shares cannot be compared; lower or raise "Top".`);
  return { topN, clusters, unclustered: docs.length - multi.reduce((s, g) => s + g.length, 0), books: docs.length, withBlurb, caveats };
}
