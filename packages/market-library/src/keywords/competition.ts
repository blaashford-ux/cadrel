import { median } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { estimateSalesRange } from '../sales/range.js';
import { normalizeKeyword } from './suggest.js';

/**
 * What a keyword's Amazon results look like, from search pages the user opened and captured with the extension.
 * Nothing is requested: if the user never searched the phrase, there is nothing to show. BSR is not on a search page,
 * so ranks come from books of the results that were captured on their own book page; the rest are left out, not guessed.
 */
export interface SearchResultBook {
  position: number;
  asin: string;
  title: string | null;
  ratingCount: number | null;
  price: number | null;
  /** Kindle Store overall rank from the newest captured book page; null when that book was never captured. */
  rank: number | null;
  /** Estimated paid sales per day at that rank: the middle of the range, and its low and high ends. */
  dailySales: number | null;
  dailySalesLow: number | null;
  dailySalesHigh: number | null;
}

export interface SearchCompetition {
  query: string;
  capturedAt: string;
  resultCount: number | null;
  resultCountIsMinimum: boolean;
  /** The first organic (non-sponsored) results looked at. */
  top: number;
  sponsored: number;
  medianRatings: number | null;
  medianPrice: number | null;
  /** How many of the top results have a captured rank. */
  withRank: number;
  medianRank: number | null;
  /** Sum of estimated daily sales over the ranked ones only: a floor, not a total. Low and high add up each book's range. */
  estDailySales: number | null;
  estDailySalesLow: number | null;
  estDailySalesHigh: number | null;
  /** Where the range comes from: the spread of published methods, the user's own calibration, or a hand-edited curve. */
  salesBasis: 'methods' | 'calibrated' | 'custom';
  /** True when the figures are paid sales plus Kindle Unlimited borrows (a calibration that counted them), not paid sales alone. */
  salesIncludeKu: boolean;
  books: SearchResultBook[];
}

export const TOP_N = 10;

export function searchCompetition(db: Db, keyword: string, topN = TOP_N): SearchCompetition | null {
  const q = normalizeKeyword(keyword);
  const cap = db
    .prepare('SELECT id, captured_at AS capturedAt, result_count AS resultCount, result_count_min AS countMin FROM search_capture WHERE query = ? ORDER BY captured_at DESC LIMIT 1')
    .get(q) as { id: number; capturedAt: string; resultCount: number | null; countMin: number } | undefined;
  if (!cap) return null;
  const rows = db
    .prepare('SELECT position, asin, sponsored, title, rating_count AS ratingCount, price FROM search_entry WHERE search_capture_id = ? ORDER BY position')
    .all(cap.id) as unknown as { position: number; asin: string; sponsored: number; title: string | null; ratingCount: number | null; price: number | null }[];
  const rankOf = db.prepare(
    `SELECT r.rank FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id
      WHERE s.asin = ? AND r.scope = 'overall' AND r.store = 'kindle' ORDER BY s.captured_at DESC LIMIT 1`,
  );
  const books: SearchResultBook[] = rows
    .filter((r) => !r.sponsored)
    .slice(0, topN)
    .map((r) => {
      const rank = (rankOf.get(r.asin) as { rank: number } | undefined)?.rank ?? null;
      const est = rank ? estimateSalesRange(db, rank) : null;
      return { position: r.position, asin: r.asin, title: r.title, ratingCount: r.ratingCount, price: r.price, rank, dailySales: est?.mid ?? null, dailySalesLow: est?.low ?? null, dailySalesHigh: est?.high ?? null };
    });
  const ranked = books.filter((b) => b.rank !== null);
  const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const sum = (k: 'dailySales' | 'dailySalesLow' | 'dailySalesHigh') => (ranked.length ? Math.round(ranked.reduce((a, b) => a + (b[k] ?? 0), 0) * 100) / 100 : null);
  const m = (xs: (number | null)[]) => (nums(xs).length ? median(nums(xs)) : null);
  return {
    query: q,
    capturedAt: cap.capturedAt,
    resultCount: cap.resultCount,
    resultCountIsMinimum: cap.countMin === 1,
    top: books.length,
    sponsored: rows.filter((r) => r.sponsored).length,
    medianRatings: m(books.map((b) => b.ratingCount)),
    medianPrice: m(books.map((b) => b.price)),
    withRank: ranked.length,
    medianRank: m(ranked.map((b) => b.rank)),
    estDailySales: sum('dailySales'),
    estDailySalesLow: sum('dailySalesLow'),
    estDailySalesHigh: sum('dailySalesHigh'),
    salesBasis: ranked[0] ? estimateSalesRange(db, ranked[0].rank!).basis : 'methods',
    salesIncludeKu: ranked[0] ? estimateSalesRange(db, ranked[0].rank!).includesKu : false,
    books,
  };
}
