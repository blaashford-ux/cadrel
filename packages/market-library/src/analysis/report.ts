import type { Db } from '../schema.js';
import { categoryBooks, cohortStats, resolveCategory, type CategoryBook, type CohortStats } from '../category.js';
import { latestCoverMetrics, coverStats, type CoverStats } from './covers.js';
import { contentStats, type ContentStats } from './content.js';
import { contentMetricsOf } from '../manuscripts.js';
import { marketShape, type MarketShape } from './market.js';
import { getWeights, meanScore, successScores, type BookScore, type Weights } from './score.js';
import { trend, type TrendPoint } from './trend.js';
import { findSubCategories, getOpportunityWeights, getSalesCurve, opportunityScore, type Opportunity, type OpportunityWeights, type SalesCurve, type SubCategory } from './opportunity.js';
import { tropeClusters, type TropeClusters } from './clusters.js';
import { characterStats, type CharacterStats } from './characters.js';
import { bookPackaging, packagingStats, readerVoice, type PackagingStats } from './textStats.js';

export interface CategoryReport {
  category: { key: string; name: string | null };
  generatedAt: string;
  lastListCapture: string | null;
  topN: number;
  books: number;
  booksWithDetail: number;
  cohort: CohortStats;
  market: MarketShape;
  packaging: PackagingStats;
  voice: ReturnType<typeof readerVoice>;
  covers: CoverStats;
  content: ContentStats;
  weights: Weights;
  scores: BookScore[];
  opportunity: Opportunity;
  opportunityWeights: OpportunityWeights;
  salesCurve: SalesCurve;
  clusters: TropeClusters;
  characters: CharacterStats;
  /** Sub-category shelves seen on any captured book page (not only this category's), niche first. */
  shelves: SubCategory[];
  trends: { median_price: TrendPoint[]; median_rating_count: TrendPoint[]; books_listed: TrendPoint[] };
  /** What the numbers cannot tell you yet. */
  caveats: string[];
}

export function categoryReport(db: Db, categoryKey: string, topN = 10, now = new Date().toISOString(), root?: string): CategoryReport {
  const r = resolveCategory(db, categoryKey);
  if ('error' in r) throw new Error(r.error);
  const key = r.category.key;
  const books = categoryBooks(db, key);
  const weights = getWeights(db);
  const captures = db.scalar<number>('SELECT count(DISTINCT captured_at) FROM list_capture WHERE category_key = ?', key) ?? 0;
  const detail = books.filter((b) => b.captured).length;
  const caveats: string[] = [];
  if (detail < books.length) caveats.push(`Only ${detail} of ${books.length} listed books have detail pages, so page counts, blurbs, formats and reviews cover those ${detail} only. The Capture queue lists the rest.`);
  if (captures < 3) caveats.push(`Only ${captures} capture${captures === 1 ? '' : 's'} of this list: rank stability needs 3, and trends need several dates.`);
  if (!books.some((b) => latestCoverMetrics(db, b.asin))) caveats.push('No covers have been analysed yet.');
  caveats.push('Associations are not causes: a book in the top ranks may be there for reasons (author following, promotion, series position) that its packaging does not show.');
  return {
    category: { key, name: r.category.name },
    generatedAt: now,
    lastListCapture: r.category.lastListCapture,
    topN,
    books: books.length,
    booksWithDetail: detail,
    cohort: cohortStats(books, topN),
    market: marketShape(db, key, topN, books),
    packaging: packagingStats(db, key, topN, books),
    voice: readerVoice(db, key, topN, books),
    covers: coverStats(db, key, topN, books),
    content: contentStats(db, key, topN, books),
    weights,
    scores: successScores(db, key, weights, books),
    opportunity: opportunityScore(db, key, topN, undefined, undefined, books),
    opportunityWeights: getOpportunityWeights(db),
    salesCurve: getSalesCurve(db),
    clusters: tropeClusters(db, key, topN, books),
    characters: characterStats(db, key, topN, books, root),
    shelves: findSubCategories(db, { minBooks: 1 }),
    trends: { median_price: trend(db, key, 'median_price'), median_rating_count: trend(db, key, 'median_rating_count'), books_listed: trend(db, key, 'books_listed') },
    caveats,
  };
}

const f = (v: number | null | undefined, d = 1) => (v == null ? '–' : Number(v.toFixed(d)).toLocaleString('en-US'));
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** A report that can be read without an AI. */
export function reportMarkdown(r: CategoryReport): string {
  const L: string[] = [];
  const top = `top ${r.topN}`;
  L.push(`# ${r.category.name ?? r.category.key}: category report`, '');
  L.push(`List captured ${r.lastListCapture ?? 'unknown'} · ${r.books} books on the list, ${r.booksWithDetail} with detail pages · generated ${r.generatedAt}`, '');
  if (r.caveats.length) L.push('## Read this first', '', ...r.caveats.map((c) => `- ${c}`), '');

  L.push(`## ${top[0]!.toUpperCase()}${top.slice(1)} against the rest`, '', `| Metric | ${top} (median) | Rest (median) | Books with data (top / rest) |`, '|---|---:|---:|---:|');
  const labels: Record<string, string> = { price: 'Price ($)', rating: 'Rating', ratingCount: 'Ratings', pages: 'Pages', publicationYear: 'Publication year', seriesPosition: 'Series position' };
  for (const [k, name] of Object.entries(labels)) {
    const a = r.cohort.top.metrics[k]!, b = r.cohort.rest.metrics[k]!;
    L.push(`| ${name} | ${f(a.median, 2)} | ${f(b.median, 2)} | ${a.known} / ${b.known} |`);
  }
  L.push('', `Series share (of books with detail pages): ${top} ${pct(r.market.series.top.share)}, rest ${pct(r.market.series.rest.share)}.`, '');

  L.push('## Price', '', `| Band | ${top} | Rest |`, '|---|---:|---:|');
  r.market.priceBands.top.forEach((b, i) => L.push(`| ${b.label} | ${b.count} | ${r.market.priceBands.rest[i]!.count} |`));
  const rho = r.market.rankPriceCorrelation;
  L.push('', `Rank against price: Spearman ρ = ${rho.rho ?? 'n/a'} over ${rho.n} books (negative: better-ranked books cost more; near 0: no relationship).`, '');

  L.push('## Freshness', '', `Median age at list capture: ${top} ${r.market.age.top.medianDays ?? '–'} days, rest ${r.market.age.rest.medianDays ?? '–'} days. Published within 90 days: ${r.market.age.top.within90d} of ${r.market.age.top.known} in the ${top}, ${r.market.age.rest.within90d} of ${r.market.age.rest.known} in the rest.`, '');

  const p = r.packaging;
  L.push('## Packaging', '', `Blurb figures use books with detail pages (${p.books.withBlurb.top} in the ${top}, ${p.books.withBlurb.rest} in the rest); title figures use every listed book.`, '', `| Measure | ${top} | Rest |`, '|---|---:|---:|');
  for (const [k, name] of [['title_words', 'Title length (words)'], ['blurb_words', 'Blurb length (words)'], ['hook_words', 'First sentence (words)'], ['reading_ease', 'Reading ease (Flesch)']] as const) {
    L.push(`| ${name} | ${f(p.numeric[k]!.top.median)} | ${f(p.numeric[k]!.rest.median)} |`);
  }
  for (const [k, name] of [['has_subtitle', 'Has a subtitle'], ['series_in_title', 'Series named in title'], ['has_question_hook', 'Blurb asks a question'], ['has_bullets', 'Blurb has bullet lines'], ['call_to_action', 'Blurb has a call to action'], ['comp_titles', 'Names comparable books/authors'], ['prestige_claims', 'Bestseller/award claims']] as const) {
    L.push(`| ${name} | ${pct(p.flags[k]!.top.share)} | ${pct(p.flags[k]!.rest.share)} |`);
  }
  if (p.tropes.length) {
    L.push('', '### Tropes and markers in blurbs', '', `| Trope | ${top} | Rest |`, '|---|---:|---:|');
    for (const t of p.tropes.slice(0, 12)) L.push(`| ${t.trope} | ${t.top} (${pct(t.topShare)}) | ${t.rest} (${pct(t.restShare)}) |`);
  }

  const v = r.voice.all;
  if (v.withText) {
    L.push('', '## What readers talk about', '', `${r.voice.caveat} ${v.withText} reviews pooled.`, '', '| Theme | Reviews mentioning | Of which 4–5★ | Of which 1–2★ |', '|---|---:|---:|---:|');
    for (const [k, t] of Object.entries(v.themes).sort((a, b) => b[1].mentions - a[1].mentions).slice(0, 8)) L.push(`| ${k} | ${pct(t.rate)} | ${t.inPositive} | ${t.inNegative} |`);
  }

  const c = r.covers;
  if (c.top.known + c.rest.known) {
    L.push('', '## Covers', '', `| Measure | ${top} (${c.top.known}) | Rest (${c.rest.known}) |`, '|---|---:|---:|');
    for (const [k, name] of [['brightness', 'Brightness (0–1)'], ['contrast', 'Contrast'], ['saturation', 'Saturation'], ['warmth', 'Warmth (−1 cool … +1 warm)'], ['edgeDensity', 'Busyness (edge density)']] as const) L.push(`| ${name} | ${f(c.top[k], 2)} | ${f(c.rest[k], 2)} |`);
    const hues = (g: typeof c.top) => Object.entries(g.dominantHues).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(', ') || '–';
    L.push(`| Dominant hues | ${hues(c.top)} | ${hues(c.rest)} |`);
  }

  const ct = r.content;
  if (ct.top.known + ct.rest.known) {
    L.push('', '## Inside the books', '', ...ct.caveats.map((c) => `- ${c}`), '', `| Measure (median) | ${top} (${ct.top.known}) | Rest (${ct.rest.known}) |`, '|---|---:|---:|');
    for (const [k, name] of [['dialogue_share', 'Dialogue share of words'], ['avg_sentence_words', 'Average sentence (words)'], ['short_sentence_share', 'Sentences of 6 words or fewer'], ['reading_ease', 'Reading ease (Flesch)'], ['grade_level', 'Grade level'], ['opening_first_sentence_words', 'Opening sentence (words)'], ['opening_dialogue_share', 'Dialogue in the first ~300 words'], ['opening_proper_nouns_per_100', 'Names introduced per 100 words, opening']] as const) {
      L.push(`| ${name} | ${f(ct.top.metrics[k]!.median, 2)} | ${f(ct.rest.metrics[k]!.median, 2)} |`);
    }
    L.push(`| Opens with dialogue | ${pct(ct.top.startsWithDialogue.share)} | ${pct(ct.rest.startsWithDialogue.share)} |`);
  }

  const o = r.opportunity;
  L.push('', '## Opportunity', '', `Score ${f(o.score)} of 100 (weights: demand ${r.opportunityWeights.demand}, review barrier ${r.opportunityWeights.reviewBarrier}, openness ${r.opportunityWeights.openness}, churn ${r.opportunityWeights.churn}). A blend of estimates, not a forecast. Components with no data are left out and the rest re-weighted${o.missing.length ? ` (missing: ${o.missing.join(', ')})` : ''}.`, '', '| Component | Value | Score (0–1) | Basis |', '|---|---:|---:|---|');
  for (const [k, c] of Object.entries(o.components)) L.push(`| ${k} | ${f(c.raw, 2)} | ${f(c.normalized, 2)} | ${cell(c.basis)} |`);
  if (o.depth.at) {
    L.push('', '### Depth', '', '| List position | Est. Kindle Store rank | Est. sales/day |', '|---:|---:|---:|');
    for (const p of o.depth.at) L.push(`| #${p.listRank} | ${f(p.overallRank, 0)} | ${f(p.estDailySales)} |`);
  }
  L.push('', o.depth.caveat);

  const ch = r.characters;
  if (ch.readable.top + ch.readable.rest) {
    L.push('', '## Main character and love interests', '', ...ch.caveats.map((c) => `- ${c}`), '', `Books read: ${ch.readable.top} in the ${top}, ${ch.readable.rest} in the rest; ${ch.withText.top} and ${ch.withText.rest} of them with sample or uploaded text as well as the blurb.`);
    const table = (title: string, rows: { label: string; top: number; rest: number; topShare: number | null; restShare: number | null }[]) => {
      if (!rows.length) return;
      L.push('', `### ${title}`, '', `| | ${top} | Rest |`, '|---|---:|---:|');
      for (const t of rows) L.push(`| ${cell(t.label)} | ${t.top} (${pct(t.topShare)}) | ${t.rest} (${pct(t.restShare)}) |`);
    };
    table('Main character gender', ch.mainCharacterGender);
    table('Love interest gender', ch.loveInterestGender);
    table('Number of love interests', ch.loveInterestCount);
    L.push('', `Dual POV (named in the blurb, or alternating name-headed chapters): ${top} ${ch.dualPov.top} (${pct(ch.dualPov.topShare)}), rest ${ch.dualPov.rest} (${pct(ch.dualPov.restShare)}).`);
    table('Main character archetypes', ch.mainCharacterArchetypes);
    table('Love interest archetypes', ch.loveInterestArchetypes);
    table('Character and relationship tropes', ch.tropes);
  }

  const cl = r.clusters;
  L.push('', '## Trope clusters', '', ...cl.caveats.map((c) => `- ${c}`));
  if (cl.clusters.length) {
    L.push('', `| # | Theme | Signal | Books | ${top} | Rest | Lift | Median ratings | Examples |`, '|---:|---|---|---:|---:|---:|---:|---:|---|');
    for (const c of cl.clusters) L.push(`| ${c.id} | ${cell(c.label.join(', '))} | ${c.signal} | ${c.books} | ${c.top} (${pct(c.topShare)}) | ${c.rest} (${pct(c.restShare)}) | ${f(c.lift, 2)} | ${f(c.medianRatingCount, 0)} | ${cell(c.examples.map((e) => (e.title ?? e.asin).slice(0, 40)).join('; '))} |`);
    L.push('', `Gap: common at the top, thin below. Crowded: many books below, few at the top. ${cl.unclustered} book(s) matched no group.`);
  }

  const sh = r.shelves.filter((x) => x.salesToTop10 != null).slice(0, 15);
  if (sh.length) {
    L.push('', '## Sub-category shelves', '', 'Estimated daily sales to reach the top 10 of each shelf, from the sub-category ranks on captured book pages (all categories). Estimates; Kindle Unlimited ignored.', '', '| Shelf | Label | Sales/day to reach #10 | Books seen | List captured |', '|---|---|---:|---:|---|');
    for (const x of sh) L.push(`| ${cell(x.name ?? x.key)} | ${x.label} | ${f(x.salesToTop10)} | ${x.usedBooks} | ${x.listCaptured ? 'yes' : 'no'} |`);
  }

  L.push('', '## Success score', '', `Weights: rank ${r.weights.rank}, stability ${r.weights.stability}, velocity ${r.weights.velocity}. Components that cannot be measured are left out and the rest re-weighted, so scores built on fewer components are less comparable. Mean score of the ${top}: ${meanScore(r.scores.filter((s) => s.listRank <= r.topN)) ?? '–'}.`, '', '| Rank | Title | Score | Rank pts | Stability | Velocity (ratings/day) | Missing |', '|---:|---|---:|---:|---:|---:|---|');
  for (const s of r.scores.slice(0, 15)) L.push(`| ${s.listRank} | ${cell((s.title ?? s.asin).slice(0, 60))} | ${f(s.score)} | ${f(s.components.rank.normalized, 2)} | ${f(s.components.stability.normalized, 2)} | ${f(s.components.velocity.raw, 2)} | ${s.missing.join(', ') || '–'} |`);
  L.push('');
  return L.join('\n');
}

const csvCell = (v: unknown): string => {
  let s = v == null ? '' : String(v);
  // Titles and blurbs are third-party text: stop spreadsheet apps treating them as formulas.
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per listed book with the key measures, for a spreadsheet. */
export function categoryCsv(db: Db, categoryKey: string): string {
  const r = resolveCategory(db, categoryKey);
  if ('error' in r) throw new Error(r.error);
  const books: CategoryBook[] = categoryBooks(db, r.category.key);
  const scores = new Map(successScores(db, r.category.key, getWeights(db), books).map((s) => [s.asin, s]));
  const pack = new Map(bookPackaging(db, books).map((p) => [p.asin, p]));
  const head = [
    'list_rank', 'asin', 'title', 'author', 'detail_captured', 'price_usd', 'rating', 'rating_count', 'pages', 'published', 'series', 'series_position',
    'kindle_store_rank', 'success_score', 'title_words', 'blurb_words', 'hook_words', 'reading_ease', 'tropes',
    'cover_brightness', 'cover_saturation', 'cover_warmth', 'cover_dominant_hue', 'text_source', 'dialogue_share', 'avg_sentence_words', 'grade_level', 'opening_dialogue_share', 'captured_at',
  ];
  const rows = books.map((b) => {
    const m = pack.get(b.asin)!.metrics;
    const hasBlurb = pack.get(b.asin)!.hasBlurb;
    const c = latestCoverMetrics(db, b.asin);
    const t = contentMetricsOf(db, b.asin);
    return [
      b.listRank, b.asin, b.title, b.author, b.captured, b.price, b.ratingValue, b.ratingCount, b.pages, b.publicationDate, b.seriesName, b.seriesPosition,
      b.overallRank, scores.get(b.asin)?.score, m.title.words, hasBlurb ? m.blurb.words : '', hasBlurb ? m.blurb.hookWords : '', hasBlurb ? m.blurb.readingEase : '', hasBlurb ? m.blurb.tropes.join('; ') : '',
      c?.brightness, c?.saturation, c?.warmth, c?.dominantHue, t?.source, t?.metrics.dialogueShare, t?.metrics.avgSentenceWords, t?.metrics.gradeLevel, t?.metrics.opening.dialogueShare, b.capturedAt,
    ].map(csvCell).join(',');
  });
  return [head.join(','), ...rows].join('\r\n') + '\r\n';
}
