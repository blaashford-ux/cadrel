import type { Db } from '../schema.js';
import { normalizeKeyword } from './suggest.js';

/** Record that a phrase belongs to a category's research. Repeats change nothing. */
export function linkKeyword(db: Db, keyword: string, categoryKey: string, now = new Date().toISOString()): void {
  const k = normalizeKeyword(keyword);
  if (!k) return;
  db.prepare('INSERT OR IGNORE INTO keyword_category (keyword, category_key, linked_at) VALUES (?,?,?)').run(k, categoryKey, now);
}

/** Forget links for phrases that have neither a search in the history nor an imported trend any more. */
export function pruneKeywordLinks(db: Db): void {
  db.exec('DELETE FROM keyword_category WHERE keyword NOT IN (SELECT seed FROM keyword_history) AND keyword NOT IN (SELECT keyword FROM keyword_trend)');
}

/** The phrases researched for a category (searched, or with imported trends). */
export function categoryKeywords(db: Db, categoryKey: string): string[] {
  return (db.prepare('SELECT keyword FROM keyword_category WHERE category_key = ? ORDER BY keyword').all(categoryKey) as unknown as { keyword: string }[]).map((r) => r.keyword);
}
