import type { Db } from '../schema.js';
import { splitCsvLine } from '../csv.js';
import { normalizeKeyword } from './suggest.js';
import { linkKeyword, pruneKeywordLinks } from './links.js';

/**
 * Google Trends has no stable public API and its unofficial endpoints block quickly, so Cadrel Market never calls it:
 * it builds a link that opens the comparison in the browser, and reads the CSV that Trends' own Download button saves.
 * Values are Trends' relative interest (0-100, 100 = the peak of the compared terms), never searches.
 */

export const MAX_TRENDS_TERMS = 5;

export function trendsUrl(terms: string[], geo = 'US', range = 'today 5-y'): string {
  const list = terms.map((t) => t.trim()).filter(Boolean).slice(0, MAX_TRENDS_TERMS);
  if (!list.length) throw new Error('give at least one term');
  const q = new URLSearchParams({ q: list.join(','), geo, date: range });
  return `https://trends.google.com/trends/explore?${q.toString()}`;
}

export interface InterestPoint { date: string; value: number }

export interface InterestSeries {
  keyword: string;
  unit: 'day' | 'week' | 'month';
  geo: string | null;
  points: InterestPoint[];
  importedAt: string;
}

const cells = (line: string) => splitCsvLine(line);

/** Parse the "interest over time" CSV from Google Trends (one or several terms). */
export function parseTrendsCsv(text: string): Omit<InterestSeries, 'importedAt'>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const h = lines.findIndex((l) => /^(week|day|month|time)\s*,/i.test(l));
  if (h < 0) throw new Error('this does not look like a Google Trends "interest over time" CSV (no Week/Day/Month header)');
  const head = cells(lines[h]!);
  const first = head[0]!.toLowerCase();
  const terms = head.slice(1).map((c) => {
    const m = c.match(/^(.*?):\s*\(([^)]*)\)\s*$/);
    return { keyword: normalizeKeyword(m ? m[1]! : c), geo: m ? m[2]! : null };
  });
  if (!terms.length || terms.some((t) => !t.keyword)) throw new Error('the CSV header has no search terms');
  const rows: string[][] = [];
  for (const l of lines.slice(h + 1)) {
    if (!l.trim()) break;
    rows.push(cells(l));
  }
  if (!rows.length) throw new Error('the CSV has no data rows');
  const dates = rows.map((r) => r[0]!);
  const gap = dates.length > 1 ? (Date.parse(dates[1]!) - Date.parse(dates[0]!)) / 86400000 : 7;
  const unit: InterestSeries['unit'] = first === 'month' || gap > 20 ? 'month' : first === 'day' || gap <= 1.5 ? 'day' : 'week';
  return terms.map((t, i) => ({
    keyword: t.keyword,
    unit,
    geo: t.geo,
    points: rows.map((r) => ({ date: r[0]!, value: /^<\s*1$/.test(r[i + 1] ?? '') ? 0 : Number(r[i + 1]) })).filter((p) => p.date && Number.isFinite(p.value)),
  }));
}

export function saveTrends(db: Db, series: Omit<InterestSeries, 'importedAt'>[], now = new Date().toISOString()): number {
  const st = db.prepare('INSERT INTO keyword_trend (keyword, unit, geo, points, imported_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(keyword) DO UPDATE SET unit = excluded.unit, geo = excluded.geo, points = excluded.points, imported_at = excluded.imported_at');
  db.transaction(() => { for (const s of series) st.run(s.keyword, s.unit, s.geo, JSON.stringify(s.points), now); })();
  return series.length;
}

/** Save the series in a Google Trends CSV. With a category, its terms are filed under that category's keyword research. */
export function importTrendsCsv(db: Db, text: string, now?: string, categoryKey?: string | null): { keywords: string[] } {
  const series = parseTrendsCsv(text);
  saveTrends(db, series, now);
  if (categoryKey) for (const s of series) linkKeyword(db, s.keyword, categoryKey, now);
  return { keywords: series.map((s) => s.keyword) };
}

export function getTrend(db: Db, keyword: string): InterestSeries | null {
  const r = db.prepare('SELECT keyword, unit, geo, points, imported_at AS importedAt FROM keyword_trend WHERE keyword = ?').get(normalizeKeyword(keyword)) as
    | { keyword: string; unit: InterestSeries['unit']; geo: string | null; points: string; importedAt: string }
    | undefined;
  return r ? { ...r, points: JSON.parse(r.points) as InterestPoint[] } : null;
}

export function removeTrend(db: Db, keyword: string): void {
  db.prepare('DELETE FROM keyword_trend WHERE keyword = ?').run(normalizeKeyword(keyword));
  pruneKeywordLinks(db);
}

export interface InterestSummary {
  points: number;
  from: string;
  to: string;
  /** Mean of the newest four points. */
  latest: number;
  average: number;
  peak: number;
  /** Newest third of the series against the third before it, as a percentage; null when there is too little to compare. */
  changePct: number | null;
  direction: 'rising' | 'steady' | 'falling' | 'unknown';
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

export function summarizeTrend(points: InterestPoint[]): InterestSummary | null {
  if (!points.length) return null;
  const v = points.map((p) => p.value);
  const third = Math.floor(v.length / 3);
  let changePct: number | null = null;
  if (third >= 4) {
    const recent = mean(v.slice(-third));
    const before = mean(v.slice(-2 * third, -third));
    if (before > 0) changePct = r1(((recent - before) / before) * 100);
  }
  return {
    points: v.length,
    from: points[0]!.date,
    to: points[points.length - 1]!.date,
    latest: r1(mean(v.slice(-4))),
    average: r1(mean(v)),
    peak: Math.max(...v),
    changePct,
    direction: changePct === null ? 'unknown' : changePct > 15 ? 'rising' : changePct < -15 ? 'falling' : 'steady',
  };
}
