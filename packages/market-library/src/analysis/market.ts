import { bandCounts, median, spearman, type Band } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, summarize, type CategoryBook, type Summary } from '../category.js';

export const PRICE_BANDS: Band[] = [
  { label: 'Under $1', from: 0, to: 1 },
  { label: '$1–$2.99', from: 1, to: 3 },
  { label: '$3–$4.99', from: 3, to: 5 },
  { label: '$5–$6.99', from: 5, to: 7 },
  { label: '$7–$9.99', from: 7, to: 10 },
  { label: '$10+', from: 10, to: Infinity },
];

export const PAGE_BANDS: Band[] = [
  { label: 'Under 200', from: 0, to: 200 },
  { label: '200–299', from: 200, to: 300 },
  { label: '300–399', from: 300, to: 400 },
  { label: '400–599', from: 400, to: 600 },
  { label: '600+', from: 600, to: Infinity },
];

export interface Cohorts<T> {
  top: T;
  rest: T;
}

export interface MarketShape {
  topN: number;
  books: number;
  priceBands: Cohorts<{ label: string; count: number }[]>;
  /** Rank (1 = best) against price; negative means better-ranked books cost more. */
  rankPriceCorrelation: { rho: number | null; n: number };
  pageBands: Cohorts<{ label: string; count: number }[]> & { known: Cohorts<number> };
  /** Days between publication and the list capture. */
  age: Cohorts<{ known: number; medianDays: number | null; within90d: number; within365d: number }>;
  publicationYears: { year: number; top: number; rest: number }[];
  series: Cohorts<{ books: number; inSeries: number; share: number | null; book1: number }>;
  formats: Cohorts<{ known: number; audio: number; paperback: number; hardcover: number }>;
  /** Other categories the captured books also rank in, most common first. */
  coCategories: { name: string; books: number }[];
  scatter: { asin: string; rank: number; price: number; title: string | null }[];
}

const DAY = 86400000;

export function marketShape(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey)): MarketShape {
  const split = (f: (b: CategoryBook) => boolean) => ({ top: books.filter((b) => b.listRank <= topN && f(b)), rest: books.filter((b) => b.listRank > topN && f(b)) });
  const priced = split((b) => b.price != null);
  const paged = split((b) => b.pages != null);
  const listAt = db.scalar<string>('SELECT max(captured_at) FROM list_capture WHERE category_key = ?', categoryKey);
  const listTime = listAt ? Date.parse(listAt) : Date.now();
  const ageOf = (rows: CategoryBook[]) => {
    const days = rows.filter((b) => b.publicationDate).map((b) => (listTime - Date.parse(b.publicationDate!)) / DAY).filter((d) => Number.isFinite(d));
    return { known: days.length, medianDays: days.length ? Math.round(median(days)!) : null, within90d: days.filter((d) => d <= 90).length, within365d: days.filter((d) => d <= 365).length };
  };
  const seriesOf = (rows: CategoryBook[]) => {
    const known = rows.filter((b) => b.captured);
    const inSeries = known.filter((b) => b.seriesName).length;
    return { books: known.length, inSeries, share: known.length ? Math.round((inSeries / known.length) * 1000) / 1000 : null, book1: known.filter((b) => b.seriesName && b.seriesPosition === 1).length };
  };
  const top = books.filter((b) => b.listRank <= topN);
  const rest = books.filter((b) => b.listRank > topN);

  const formatRows = db
    .prepare(
      `SELECT s.asin, group_concat(f.code) AS codes FROM snapshot s LEFT JOIN format_offer f ON f.snapshot_id = s.id
       WHERE s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = s.asin) GROUP BY s.asin`,
    )
    .all() as unknown as { asin: string; codes: string | null }[];
  const codes = new Map(formatRows.map((r) => [r.asin, (r.codes ?? '').split(',')]));
  const fmt = (rows: CategoryBook[]) => {
    const c = rows.filter((b) => b.captured).map((b) => codes.get(b.asin) ?? []);
    return { known: c.length, audio: c.filter((x) => x.includes('AUDIO_DOWNLOAD')).length, paperback: c.filter((x) => x.includes('PAPERBACK')).length, hardcover: c.filter((x) => x.includes('HARDCOVER')).length };
  };

  const years = new Map<number, { top: number; rest: number }>();
  for (const b of books) {
    if (!b.publicationDate) continue;
    const y = Number(b.publicationDate.slice(0, 4));
    const e = years.get(y) ?? { top: 0, rest: 0 };
    if (b.listRank <= topN) e.top++;
    else e.rest++;
    years.set(y, e);
  }

  const asins = books.filter((b) => b.captured).map((b) => b.asin);
  const co = new Map<string, number>();
  if (asins.length) {
    const rows = db
      .prepare(
        `SELECT r.name, r.category_key AS key, count(DISTINCT s.asin) AS n FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id
         WHERE r.scope = 'category' AND s.asin IN (${asins.map(() => '?').join(',')})
           AND s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = s.asin)
           AND (r.category_key IS NULL OR r.category_key <> ?)
         GROUP BY r.name`,
      )
      .all(...asins, categoryKey) as unknown as { name: string; n: number }[];
    for (const r of rows) co.set(r.name, r.n);
  }

  const withPrice = books.filter((b) => b.price != null);
  return {
    topN,
    books: books.length,
    priceBands: { top: bandCounts(priced.top.map((b) => b.price!), PRICE_BANDS), rest: bandCounts(priced.rest.map((b) => b.price!), PRICE_BANDS) },
    rankPriceCorrelation: { rho: spearman(withPrice.map((b) => b.listRank), withPrice.map((b) => b.price!)), n: withPrice.length },
    pageBands: {
      top: bandCounts(paged.top.map((b) => b.pages!), PAGE_BANDS),
      rest: bandCounts(paged.rest.map((b) => b.pages!), PAGE_BANDS),
      known: { top: paged.top.length, rest: paged.rest.length },
    },
    age: { top: ageOf(top), rest: ageOf(rest) },
    publicationYears: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })),
    series: { top: seriesOf(top), rest: seriesOf(rest) },
    formats: { top: fmt(top), rest: fmt(rest) },
    coCategories: [...co.entries()].filter(([n]) => n !== 'Kindle Store').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([name, n]) => ({ name, books: n })),
    scatter: withPrice.map((b) => ({ asin: b.asin, rank: b.listRank, price: b.price!, title: b.title })),
  };
}

export type { Summary };
export { summarize };
