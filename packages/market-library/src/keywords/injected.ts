import type { Db } from '../schema.js';
import { stem } from '../analysis/communityInsights.js';
import { candidatePool, autocompleteStatus, type KeywordIdea } from './ideas.js';
import { isUnusableKeywordWord, KEYWORD_STRING_COUNT, KEYWORD_STRING_LIMIT } from './strings.js';
import { normalizeKeyword } from './suggest.js';

/**
 * Keyword suggestions an AI tool sends in (through the MCP server), for the person to look at beside Cadrel's own. An AI that has read the
 * book's outline and the category can choose better than the rules in `ideas.ts`, so this is a way in for them. Nothing here is searched,
 * published or sent anywhere: a suggestion is a row the person can use or dismiss.
 */
export const INJECT_LIMITS = { keywords: 30, strings: KEYWORD_STRING_COUNT, keywordChars: 80, stringChars: KEYWORD_STRING_LIMIT, reason: 300, client: 40 } as const;

export interface InjectedSuggestion {
  id: number;
  categoryKey: string;
  asin: string | null;
  kind: 'keyword' | 'string';
  keyword: string;
  reason: string;
  /** Who sent it, e.g. "Claude". */
  client: string;
  createdAt: string;
  autocomplete: KeywordIdea['autocomplete'];
  checkedAt: string | null;
  /** Things worth knowing that did not stop it being saved: a word Amazon already reads, a word KDP does not allow. */
  warnings: string[];
}

export interface InjectInput {
  client: string;
  asin?: string;
  keywords?: { keyword: string; reason?: string }[];
  /** Candidate contents of the seven KDP keyword boxes. */
  strings?: { keyword: string; reason?: string }[];
  now?: string;
}

export interface InjectResult {
  saved: { kind: 'keyword' | 'string'; keyword: string; warnings: string[] }[];
  rejected: { keyword: string; error: string }[];
}

const cleanText = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Why a phrase may not earn its place, in words, for the person and for the AI to fix. */
function warningsFor(phrase: string, taken: Set<string>, usedBefore?: Set<string>): string[] {
  const words = phrase.split(' ').filter(Boolean);
  const out: string[] = [];
  const dup = words.filter((w) => taken.has(stem(w)));
  if (dup.length) out.push(`${dup.join(', ')} ${dup.length === 1 ? 'is' : 'are'} already read by Amazon from the category or the book's title and blurb, so ${dup.length === 1 ? 'it adds' : 'they add'} nothing here`);
  const bad = words.filter(isUnusableKeywordWord);
  if (bad.length) out.push(`${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} filler or ${bad.length === 1 ? 'a word' : 'words'} KDP does not allow in keywords`);
  if (usedBefore) {
    const again = words.filter((w) => usedBefore.has(stem(w)));
    if (again.length) out.push(`${again.join(', ')} already appear${again.length === 1 ? 's' : ''} in another box; a word never needs to be used twice`);
    for (const w of words) usedBefore.add(stem(w));
  }
  return out;
}

export function addInjectedSuggestions(db: Db, categoryKey: string, input: InjectInput): InjectResult {
  const client = cleanText(input.client, INJECT_LIMITS.client) || 'AI';
  const now = input.now ?? new Date().toISOString();
  const { taken } = candidatePool(db, categoryKey, { asin: input.asin });
  const result: InjectResult = { saved: [], rejected: [] };
  const dismissed = new Set((db.prepare('SELECT kind, keyword FROM keyword_suggestion WHERE category_key = ? AND dismissed_at IS NOT NULL').all(categoryKey) as unknown as { kind: string; keyword: string }[]).map((r) => `${r.kind}:${r.keyword}`));
  const insert = db.prepare(`INSERT INTO keyword_suggestion (category_key, asin, kind, keyword, reason, client, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (category_key, kind, keyword) DO UPDATE SET reason = excluded.reason, client = excluded.client, asin = excluded.asin, created_at = excluded.created_at WHERE dismissed_at IS NULL`);
  const put = (kind: 'keyword' | 'string', items: { keyword: string; reason?: string }[] | undefined, max: number, maxChars: number) => {
    const used = kind === 'string' ? new Set<string>() : undefined;
    const seen = new Set<string>();
    (Array.isArray(items) ? items : []).forEach((it, i) => {
      const k = normalizeKeyword(cleanText(it?.keyword, 400));
      if (!k) return void result.rejected.push({ keyword: String(it?.keyword ?? ''), error: 'empty' });
      if (i >= max) return void result.rejected.push({ keyword: k, error: `at most ${max} ${kind === 'string' ? 'strings' : 'keywords'} per call` });
      if (k.length > maxChars) return void result.rejected.push({ keyword: k, error: `${k.length} characters; ${kind === 'string' ? 'a KDP keyword box takes' : 'keep a keyword to'} ${maxChars}` });
      if (seen.has(k)) return void result.rejected.push({ keyword: k, error: 'sent twice' });
      seen.add(k);
      if (dismissed.has(`${kind}:${k}`)) return void result.rejected.push({ keyword: k, error: 'the person dismissed this earlier' });
      insert.run(categoryKey, input.asin ?? null, kind, k, cleanText(it.reason, INJECT_LIMITS.reason), client, now);
      result.saved.push({ kind, keyword: k, warnings: warningsFor(k, taken, used) });
    });
  };
  db.transaction(() => {
    // the new set replaces this tool's earlier, undismissed one for the category
    const sent = (items?: { keyword: string }[]) => new Set((items ?? []).map((x) => normalizeKeyword(cleanText(x?.keyword, 400))));
    for (const [kind, items] of [['keyword', input.keywords], ['string', input.strings]] as const) {
      if (!items?.length) continue;
      const keep = sent(items);
      const old = db.prepare('SELECT id, keyword FROM keyword_suggestion WHERE category_key = ? AND kind = ? AND client = ? AND dismissed_at IS NULL').all(categoryKey, kind, client) as unknown as { id: number; keyword: string }[];
      for (const o of old) if (!keep.has(o.keyword)) db.prepare('DELETE FROM keyword_suggestion WHERE id = ?').run(o.id);
    }
    put('keyword', input.keywords, INJECT_LIMITS.keywords, INJECT_LIMITS.keywordChars);
    put('string', input.strings, INJECT_LIMITS.strings, INJECT_LIMITS.stringChars);
  })();
  return result;
}

export function listInjectedSuggestions(db: Db, categoryKey: string): InjectedSuggestion[] {
  const { taken } = candidatePool(db, categoryKey);
  const rows = db.prepare('SELECT id, category_key, asin, kind, keyword, reason, client, created_at FROM keyword_suggestion WHERE category_key = ? AND dismissed_at IS NULL ORDER BY kind DESC, id').all(categoryKey) as unknown as { id: number; category_key: string; asin: string | null; kind: 'keyword' | 'string'; keyword: string; reason: string | null; client: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, categoryKey: r.category_key, asin: r.asin, kind: r.kind, keyword: r.keyword, reason: r.reason ?? '', client: r.client, createdAt: r.created_at, ...autocompleteStatus(db, r.keyword), warnings: warningsFor(r.keyword, taken) }));
}

export function dismissInjectedSuggestion(db: Db, id: number, now = new Date().toISOString()): void {
  db.prepare('UPDATE keyword_suggestion SET dismissed_at = ? WHERE id = ?').run(now, id);
}
