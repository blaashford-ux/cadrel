import type { Db } from '../schema.js';
import { normalizeKeyword, type SuggestSource } from './suggest.js';
import { cachedLookup } from './explore.js';
import { SUGGEST_SOURCES } from './suggest.js';
import { linkKeyword, pruneKeywordLinks } from './links.js';

/** Every phrase the user has searched on the Keywords tab, once each, so it can be reopened with a click. */
export interface KeywordHistoryRow {
  seed: string;
  firstAt: string;
  lastAt: string;
  /** How many times it was searched. */
  searches: number;
  /** Phrases the last search turned up (the seed itself counts as one). */
  phrases: number;
  /** The autocomplete sources that answered. */
  sources: SuggestSource[];
  /** Keys of the categories this phrase was researched for (empty for a search made before categories were recorded, or with none chosen). */
  categories: string[];
  /** Whether the saved answers are still there, so reopening shows results without a new request (they can be cleared or expire). */
  saved: boolean;
}

/** Remember a search (a repeat updates the one row). */
export function recordKeywordSearch(db: Db, seed: string, o: { phrases: number; sources: SuggestSource[]; now?: Date; categoryKey?: string | null }): void {
  const s = normalizeKeyword(seed);
  if (!s) return;
  const at = (o.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO keyword_history (seed, first_at, last_at, searches, phrases, sources) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(seed) DO UPDATE SET last_at = excluded.last_at, searches = searches + 1, phrases = excluded.phrases, sources = excluded.sources`,
  ).run(s, at, at, o.phrases, JSON.stringify(o.sources));
  if (o.categoryKey) linkKeyword(db, s, o.categoryKey, at);
}


/** The searches run so far, newest first; with a category, only the phrases researched for it. */
export function listKeywordHistory(db: Db, categoryKey?: string | null): KeywordHistoryRow[] {
  const links = new Map<string, string[]>();
  for (const l of db.prepare('SELECT keyword, category_key AS categoryKey FROM keyword_category ORDER BY category_key').all() as unknown as { keyword: string; categoryKey: string }[]) {
    links.set(l.keyword, [...(links.get(l.keyword) ?? []), l.categoryKey]);
  }
  return (db.prepare('SELECT seed, first_at AS firstAt, last_at AS lastAt, searches, phrases, sources FROM keyword_history ORDER BY last_at DESC, seed').all() as unknown as (Omit<KeywordHistoryRow, 'sources' | 'categories' | 'saved'> & { sources: string })[])
    .map((r) => ({ ...r, sources: JSON.parse(r.sources) as SuggestSource[], categories: links.get(r.seed) ?? [], saved: hasSavedResults(db, r.seed) }))
    .filter((r) => !categoryKey || r.categories.includes(categoryKey));
}

export function removeKeywordHistory(db: Db, seed: string): void {
  db.prepare('DELETE FROM keyword_history WHERE seed = ?').run(normalizeKeyword(seed));
  pruneKeywordLinks(db);
}

export function clearKeywordHistory(db: Db): void {
  db.exec('DELETE FROM keyword_history');
  pruneKeywordLinks(db);
}

/** Whether a saved answer still exists for a history entry (answers are a cache and can be cleared), so reopening shows results. */
export function hasSavedResults(db: Db, seed: string): boolean {
  return SUGGEST_SOURCES.some((s) => cachedLookup(db, s, seed) !== null);
}
