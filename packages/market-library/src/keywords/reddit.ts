import type { Db } from '../schema.js';

/**
 * How often a phrase turns up in the Reddit text already synced into the library (no network). It is a count of
 * mentions inside the subreddits the user linked, over the days they synced: a measure of what those readers talk about,
 * not of how many people search for it.
 */
export interface RedditSignal {
  keyword: string;
  mentions: number;
  threads: number;
  /** Sum of the scores of the mentioning items (negative scores count as 0). */
  score: number;
  /** Mentions per 1,000 items searched, so subreddits and sync sizes can be compared. */
  per1000: number;
  itemsSearched: number;
  bySubreddit: { subreddit: string; mentions: number }[];
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function redditSignal(db: Db, keyword: string, o: { subreddits?: string[] } = {}): RedditSignal {
  const kw = keyword.toLowerCase().replace(/\s+/g, ' ').trim();
  const subs = o.subreddits?.map((s) => s.toLowerCase());
  const scope = subs?.length ? `AND subreddit IN (${subs.map(() => '?').join(',')})` : '';
  const itemsSearched = Number(db.scalar(`SELECT COUNT(*) FROM community_item WHERE 1 = 1 ${scope}`, ...(subs ?? [])) ?? 0);
  if (!kw || !itemsSearched) return { keyword: kw, mentions: 0, threads: 0, score: 0, per1000: 0, itemsSearched, bySubreddit: [] };
  const rows = db
    .prepare(`SELECT subreddit, link_id AS linkId, COALESCE(score, 0) AS score FROM community_item
              WHERE (LOWER(COALESCE(title, '') || ' ' || body) LIKE ? ESCAPE '\\') ${scope}`)
    .all(`%${likeEscape(kw)}%`, ...(subs ?? [])) as { subreddit: string; linkId: string; score: number }[];
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.subreddit, (per.get(r.subreddit) ?? 0) + 1);
  return {
    keyword: kw,
    mentions: rows.length,
    threads: new Set(rows.map((r) => r.linkId)).size,
    score: rows.reduce((a, r) => a + Math.max(r.score, 0), 0),
    per1000: Math.round((rows.length / itemsSearched) * 10000) / 10,
    itemsSearched,
    bySubreddit: [...per].map(([subreddit, mentions]) => ({ subreddit, mentions })).sort((a, b) => b.mentions - a.mentions),
  };
}
