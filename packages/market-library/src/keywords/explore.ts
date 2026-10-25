import type { Db } from '../schema.js';
import { SUGGEST_SOURCES, expandSeed, normalizeKeyword, type SuggestOptions, type SuggestSource, type Suggestion } from './suggest.js';
import { redditSignal, type RedditSignal } from './reddit.js';
import { getTrend, summarizeTrend, type InterestSummary } from './trends.js';
import { searchCompetition, type SearchCompetition } from './competition.js';

const DAY = 86400000;
/** A lookup younger than this is served from the cache. */
export const CACHE_DAYS = 7;
/** After a lookup that ended in a block, or that was answered with no phrases at all, the source is left alone this long. */
export const COOLDOWN_MS = 10 * 60 * 1000;

export interface Lookup {
  source: SuggestSource;
  seed: string;
  suggestions: Suggestion[];
  fetchedAt: string;
  /** True when no request was made. */
  cached: boolean;
  requests: number;
  stopped: string | null;
}

export function cachedLookup(db: Db, source: SuggestSource, seed: string): Lookup | null {
  const s = normalizeKeyword(seed);
  const l = db.prepare('SELECT fetched_at AS fetchedAt, requests, stopped FROM keyword_lookup WHERE source = ? AND seed = ?').get(source, s) as
    | { fetchedAt: string; requests: number; stopped: string | null }
    | undefined;
  if (!l) return null;
  const suggestions = db.prepare('SELECT keyword, position, via FROM keyword_signal WHERE source = ? AND seed = ? ORDER BY (via = \'seed\') DESC, position, keyword').all(source, s) as unknown as Suggestion[];
  return { source, seed: s, suggestions, fetchedAt: l.fetchedAt, cached: true, requests: l.requests, stopped: l.stopped };
}

function saveLookup(db: Db, source: SuggestSource, seed: string, suggestions: Suggestion[], requests: number, stopped: string | null, now: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM keyword_signal WHERE source = ? AND seed = ?').run(source, seed);
    const ins = db.prepare('INSERT INTO keyword_signal (source, seed, keyword, position, via) VALUES (?, ?, ?, ?, ?)');
    for (const s of suggestions) ins.run(source, seed, s.keyword, s.position, s.via);
    db.prepare('INSERT INTO keyword_lookup (source, seed, fetched_at, requests, stopped) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source, seed) DO UPDATE SET fetched_at = excluded.fetched_at, requests = excluded.requests, stopped = excluded.stopped').run(source, seed, now, requests, stopped);
  })();
}

export interface LookupOptions extends SuggestOptions {
  force?: boolean;
  now?: Date;
}

/** The suggestions for a seed from one source: from the cache when fresh (or when the source has just blocked us), else fetched and stored. */
export async function lookupSuggestions(db: Db, source: SuggestSource, seed: string, o: LookupOptions = {}): Promise<Lookup> {
  const now = o.now ?? new Date();
  const hit = cachedLookup(db, source, seed);
  if (hit) {
    const age = now.getTime() - Date.parse(hit.fetchedAt);
    // an empty answer is a thin phrase today, not a fact for a week: ask again soon
    const empty = !hit.suggestions.length;
    if (hit.stopped ? age < COOLDOWN_MS : !o.force && age < (empty ? COOLDOWN_MS : CACHE_DAYS * DAY)) return hit;
  }
  const r = await expandSeed(source, seed, o);
  // a lookup that got nothing (blocked at once, or offline) must not replace good older data
  if (r.suggestions.length || !hit) saveLookup(db, source, r.seed, r.suggestions, r.requests, r.stopped, now.toISOString());
  else return { ...hit, cached: true, stopped: r.stopped };
  return { source, seed: r.seed, suggestions: r.suggestions, fetchedAt: now.toISOString(), cached: false, requests: r.requests, stopped: r.stopped };
}

export interface SuggestCell { position: number; via: string }

export interface KeywordRow {
  keyword: string;
  amazon: SuggestCell | null;
  google: SuggestCell | null;
  bing: SuggestCell | null;
  /** How many of the autocomplete sources list the phrase. */
  listedBy: number;
  reddit: RedditSignal | null;
  trend: InterestSummary | null;
  competition: SearchCompetition | null;
}

export interface KeywordTable {
  seed: string;
  rows: KeywordRow[];
  /** One entry per autocomplete source that has data for the seed, for the "fetched on" notes. */
  lookups: { source: SuggestSource; fetchedAt: string; requests: number; stopped: string | null; count: number }[];
  /** Subreddit items searched for the Reddit column; 0 when nothing is synced. */
  redditItems: number;
}

/** Assemble the per-source columns for a seed from what is stored (cache, synced Reddit text, imported Trends, captured search pages). Makes no requests. */
export function keywordTable(db: Db, seed: string, o: { limit?: number; subreddits?: string[] } = {}): KeywordTable {
  const s = normalizeKeyword(seed);
  const rows = new Map<string, KeywordRow>();
  const lookups: KeywordTable['lookups'] = [];
  const row = (keyword: string): KeywordRow => {
    let r = rows.get(keyword);
    if (!r) rows.set(keyword, (r = { keyword, amazon: null, google: null, bing: null, listedBy: 0, reddit: null, trend: null, competition: null }));
    return r;
  };
  for (const src of SUGGEST_SOURCES) {
    const l = cachedLookup(db, src, s);
    if (!l) continue;
    lookups.push({ source: src, fetchedAt: l.fetchedAt, requests: l.requests, stopped: l.stopped, count: l.suggestions.length });
    for (const g of l.suggestions) {
      const r = row(g.keyword);
      r[src] = { position: g.position, via: g.via };
      r.listedBy++;
    }
  }
  row(s); // the seed itself is always a row, even if no source suggests it
  const best = (r: KeywordRow) => Math.min(...[r.amazon, r.google, r.bing].map((c) => c?.position ?? 99));
  const list = [...rows.values()]
    .sort((a, b) => Number(b.keyword === s) - Number(a.keyword === s) || b.listedBy - a.listedBy || best(a) - best(b) || a.keyword.localeCompare(b.keyword))
    .slice(0, o.limit ?? 100);
  let redditItems = 0;
  for (const r of list) {
    r.reddit = redditSignal(db, r.keyword, { subreddits: o.subreddits });
    redditItems = r.reddit.itemsSearched;
    const t = getTrend(db, r.keyword);
    r.trend = t ? summarizeTrend(t.points) : null;
    r.competition = searchCompetition(db, r.keyword);
  }
  return { seed: s, rows: list, lookups, redditItems };
}
