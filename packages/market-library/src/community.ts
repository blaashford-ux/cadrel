import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './schema.js';
import { chunkText, estimateTokens, hashText } from './text.js';
import { stampOf } from './layout.js';
import { ArcticShift, type ArcticComment, type ArcticPost } from './arcticShift.js';
import { resolveCategory } from './category.js';

/**
 * Community text: what people say in subreddits linked to a category. Only a thread's title and body, its comments' text,
 * scores, post flair and dates are kept; authors are never stored. The files under <library>/community are the source of
 * truth (so a rebuilt database loses nothing); community_item and the chunks are derived from them.
 */

export type CommunityKind = 'post' | 'comment';

export interface CommunityItem {
  kind: CommunityKind;
  /** Reddit's id without its "t3_" / "t1_" prefix. */
  id: string;
  subreddit: string;
  /** The thread (post id) this belongs to; a post's own id for posts. */
  linkId: string;
  /** For comments: the post or comment replied to, as an id with the same kind prefix removed. */
  parentId: string | null;
  title: string | null;
  body: string;
  score: number | null;
  flair: string | null;
  createdUtc: number;
}

/** One line of a sync file: an item, or a tombstone for one that was removed or deleted since it was stored. */
type FileLine = (CommunityItem & { x?: undefined }) | { x: 1; kind: CommunityKind; id: string };

export const COMMUNITY_KINDS = ['community_post', 'community_comment'] as const;
export const SYNC_DAYS = 7;
const MAX_POSTS = 5000;
export const DEFAULT_MAX_COMMENTS = 20000;

const SUB_RE = /^[A-Za-z0-9_]{2,21}$/;
export const cleanSubreddit = (s: string): string => {
  const t = s.trim().replace(/^\/?r\//i, '').replace(/\/+$/, '');
  if (!SUB_RE.test(t)) throw new Error(`"${s.trim()}" is not a subreddit name (letters, numbers and underscores, 2-21 characters)`);
  return t.toLowerCase();
};
/** The label chunks use in place of an ASIN. */
export const communityRef = (sub: string) => `r/${sub.toLowerCase()}`;

const dir = (root: string) => path.join(root, 'community');
const sourcesFile = (root: string) => path.join(dir(root), 'sources.json');

// ---------------------------------------------------------------- sources

export interface CommunitySource {
  categoryKey: string;
  subreddit: string;
  addedAt: string;
  lastSyncedAt: string | null;
  posts: number;
  comments: number;
  /** An earlier sync was stopped or failed; syncing carries on from here (ISO time). */
  resumeFrom: string | null;
  /** ISO times of the oldest and newest stored post. */
  from: string | null;
  to: string | null;
}

export function writeSources(db: Db, root: string): void {
  const rows = db.prepare('SELECT category_key AS categoryKey, subreddit, added_at AS addedAt, last_synced_at AS lastSyncedAt FROM community_source ORDER BY category_key, subreddit').all();
  fs.mkdirSync(dir(root), { recursive: true });
  const tmp = sourcesFile(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, sources: rows }, null, 2));
  fs.renameSync(tmp, sourcesFile(root));
}

export function listCommunitySources(db: Db, categoryKey: string): CommunitySource[] {
  const iso = (t: number | null) => (t == null ? null : new Date(t * 1000).toISOString());
  return (db.prepare('SELECT category_key AS categoryKey, subreddit, added_at AS addedAt, last_synced_at AS lastSyncedAt FROM community_source WHERE category_key = ? ORDER BY added_at, subreddit').all(categoryKey) as unknown as Omit<CommunitySource, 'posts' | 'comments' | 'from' | 'to' | 'resumeFrom'>[]).map((s) => {
    const c = db.prepare("SELECT sum(kind = 'post') AS posts, sum(kind = 'comment') AS comments, min(CASE WHEN kind = 'post' THEN created_utc END) AS lo, max(CASE WHEN kind = 'post' THEN created_utc END) AS hi FROM community_item WHERE subreddit = ?").get(s.subreddit) as { posts: number | null; comments: number | null; lo: number | null; hi: number | null };
    const rs = communityResume(db, s.subreddit);
    return { ...s, posts: c.posts ?? 0, comments: c.comments ?? 0, resumeFrom: rs != null && rs > Date.now() / 1000 - SYNC_DAYS * 86400 ? iso(rs) : null, from: iso(c.lo), to: iso(c.hi) };
  });
}

export function addCommunitySource(db: Db, root: string, categoryKey: string, subreddit: string, now = new Date().toISOString()): CommunitySource[] {
  const r = resolveCategory(db, categoryKey);
  if ('error' in r) throw new Error(r.error);
  db.prepare('INSERT OR IGNORE INTO community_source (category_key, subreddit, added_at) VALUES (?,?,?)').run(r.category.key, cleanSubreddit(subreddit), now);
  writeSources(db, root);
  return listCommunitySources(db, r.category.key);
}

/** Unlink a subreddit from a category. Its stored text is deleted too unless another category still uses it. */
export function removeCommunitySource(db: Db, root: string, categoryKey: string, subreddit: string): CommunitySource[] {
  const sub = cleanSubreddit(subreddit);
  db.transaction(() => {
    db.prepare('DELETE FROM community_source WHERE category_key = ? AND subreddit = ?').run(categoryKey, sub);
    if (!db.scalar('SELECT 1 FROM community_source WHERE subreddit = ?', sub)) {
      db.prepare('DELETE FROM chunk WHERE asin = ? AND kind IN (?,?)').run(communityRef(sub), ...COMMUNITY_KINDS);
      db.prepare('DELETE FROM community_item WHERE subreddit = ?').run(sub);
      fs.rmSync(path.join(dir(root), sub), { recursive: true, force: true });
    }
  })();
  writeSources(db, root);
  return listCommunitySources(db, categoryKey);
}

// ---------------------------------------------------------------- storing and indexing

const permalink = (it: Pick<CommunityItem, 'kind' | 'id' | 'linkId' | 'subreddit'>) =>
  it.kind === 'post' ? `https://www.reddit.com/r/${it.subreddit}/comments/${it.id}/` : `https://www.reddit.com/r/${it.subreddit}/comments/${it.linkId}/_/${it.id}/`;

function chunkRows(db: Db, it: CommunityItem): { text: string; meta: string }[] {
  const postTitle = it.kind === 'post' ? it.title : (db.scalar<string>("SELECT title FROM community_item WHERE kind = 'post' AND id = ?", it.linkId) ?? null);
  const text = it.kind === 'post' ? [it.title, it.body].filter(Boolean).join('\n\n') : `${postTitle ? `Re: ${postTitle}\n\n` : ''}${it.body}`;
  const meta = JSON.stringify({ id: it.id, kind: it.kind, subreddit: it.subreddit, url: permalink(it), score: it.score, flair: it.flair, created: new Date(it.createdUtc * 1000).toISOString(), postId: it.linkId, postTitle, parentId: it.parentId });
  return chunkText(text).map((t) => ({ text: t, meta }));
}

const refOf = (kind: CommunityKind, id: string) => `community:${kind}:${id}`;

function dropItem(db: Db, kind: CommunityKind, id: string): void {
  const del = db.prepare('DELETE FROM chunk WHERE id = ?');
  for (const c of db.prepare('SELECT id FROM chunk WHERE ref = ?').all(refOf(kind, id)) as unknown as { id: number }[]) {
    del.run(c.id);
    try {
      if (db.vecEnabled) db.prepare('DELETE FROM chunk_vec WHERE rowid = ?').run(BigInt(c.id));
    } catch { /* vectors not created yet */ }
  }
  db.prepare('DELETE FROM community_item WHERE kind = ? AND id = ?').run(kind, id);
}

export interface ApplyResult { addedPosts: number; addedComments: number; updated: number; removed: number }

/** Apply items and tombstones to the database. Unchanged text keeps its chunks (and their vectors); only scores/metadata are refreshed. */
export function applyCommunity(db: Db, lines: FileLine[]): ApplyResult {
  const r: ApplyResult = { addedPosts: 0, addedComments: 0, updated: 0, removed: 0 };
  const getItem = db.prepare('SELECT title, body FROM community_item WHERE kind = ? AND id = ?');
  const put = db.prepare(
    `INSERT INTO community_item (kind, id, subreddit, link_id, parent_id, title, body, score, flair, created_utc) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(kind, id) DO UPDATE SET title = excluded.title, body = excluded.body, score = excluded.score, flair = excluded.flair`,
  );
  const insChunk = db.prepare('INSERT INTO chunk (asin, snapshot_id, kind, ordinal, text, text_hash, token_count, meta, ref) VALUES (?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const l of lines) {
      if (l.x) {
        if (getItem.get(l.kind, l.id)) (dropItem(db, l.kind, l.id), r.removed++);
        continue;
      }
      const before = getItem.get(l.kind, l.id) as { title: string | null; body: string } | undefined;
      put.run(l.kind, l.id, l.subreddit, l.linkId, l.parentId, l.title, l.body, l.score, l.flair, l.createdUtc);
      const ref = refOf(l.kind, l.id);
      const rows = chunkRows(db, l);
      if (before && before.body === l.body && (before.title ?? null) === (l.title ?? null)) {
        db.prepare('UPDATE chunk SET meta = ? WHERE ref = ?').run(rows[0]?.meta ?? null, ref);
        continue;
      }
      if (before) r.updated++;
      else if (l.kind === 'post') r.addedPosts++;
      else r.addedComments++;
      for (const c of db.prepare('SELECT id FROM chunk WHERE ref = ?').all(ref) as unknown as { id: number }[]) {
        db.prepare('DELETE FROM chunk WHERE id = ?').run(c.id);
        try { if (db.vecEnabled) db.prepare('DELETE FROM chunk_vec WHERE rowid = ?').run(BigInt(c.id)); } catch { /* none yet */ }
      }
      rows.forEach((c, i) => insChunk.run(communityRef(l.subreddit), 0, l.kind === 'post' ? 'community_post' : 'community_comment', i, c.text, hashText(c.text), estimateTokens(c.text), c.meta, ref));
    }
  })();
  return r;
}

/** Rebuild community_source / community_item / chunks from the files; used after the database is rebuilt or lost. */
export function reindexCommunity(db: Db, root: string): number {
  db.exec("DELETE FROM chunk WHERE kind IN ('community_post','community_comment')");
  db.exec('DELETE FROM community_item; DELETE FROM community_source');
  let n = 0;
  try {
    const f = JSON.parse(fs.readFileSync(sourcesFile(root), 'utf8')) as { sources?: { categoryKey: string; subreddit: string; addedAt: string; lastSyncedAt: string | null }[] };
    const ins = db.prepare('INSERT OR IGNORE INTO community_source (category_key, subreddit, added_at, last_synced_at) VALUES (?,?,?,?)');
    for (const s of f.sources ?? []) ins.run(s.categoryKey, s.subreddit, s.addedAt, s.lastSyncedAt);
  } catch { /* no sources file */ }
  if (!fs.existsSync(dir(root))) return 0;
  for (const sub of fs.readdirSync(dir(root), { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    // posts before comments (so comment chunks can carry the thread title), files in time order
    const lines: FileLine[] = [];
    for (const file of fs.readdirSync(path.join(dir(root), sub.name)).filter((x) => x.endsWith('.jsonl')).sort()) {
      for (const raw of fs.readFileSync(path.join(dir(root), sub.name, file), 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        try { lines.push(JSON.parse(raw) as FileLine); } catch { /* skip a damaged line */ }
      }
    }
    lines.sort((a, b) => Number(b.kind === 'post') - Number(a.kind === 'post'));
    const r = applyCommunity(db, lines);
    n += r.addedPosts + r.addedComments;
  }
  return n;
}

// ---------------------------------------------------------------- syncing

export interface SyncProgress {
  subreddit: string;
  step: string;
  /** The day being read (1-based) out of `days`. */
  day: number;
  days: number;
  /** Threads and comments kept so far in this run. */
  threads: number;
  comments: number;
  requests: number;
  startedAt: number;
}

export interface SyncOptions {
  client?: ArcticShift;
  now?: Date;
  days?: number;
  maxComments?: number;
  onProgress?: (p: SyncProgress) => void;
  /** Aborting stops after saving the days already read; syncing again carries on from there. */
  signal?: AbortSignal;
}

export interface SyncResult {
  subreddit: string;
  from: string;
  to: string;
  posts: number;
  comments: number;
  newPosts: number;
  newComments: number;
  /** Items skipped because they were removed or deleted, or written by a bot. */
  skipped: { removed: number; bots: number };
  /** Items stored earlier and dropped now because they have since been removed. */
  dropped: number;
  truncated: boolean;
  requests: number;
  /** Stopped before the whole period was read. */
  cancelled: boolean;
  /** The whole period was read and Arctic Shift returned nothing, with nothing stored for the subreddit: almost always a misspelt name. */
  notFound: boolean;
  /** The sync failed part-way (what was read is saved; syncing again resumes). */
  error: string | null;
  /** Days read and saved in this run, of the days in the period. */
  daysDone: number;
  days: number;
}

const GONE = /^\s*\[(?:removed|deleted)\]\s*$/i;
const BOT = /^(?:automoderator|.*bot)$/i;

const fromPost = (p: ArcticPost, sub: string): CommunityItem => ({ kind: 'post', id: p.id, subreddit: sub, linkId: p.id, parentId: null, title: (p.title ?? '').trim(), body: (p.selftext ?? '').trim(), score: p.score ?? null, flair: p.link_flair_text?.trim() || null, createdUtc: p.created_utc });
const fromComment = (c: ArcticComment, sub: string): CommunityItem => ({ kind: 'comment', id: c.id, subreddit: sub, linkId: c.link_id.replace(/^t3_/, ''), parentId: c.parent_id.replace(/^t[13]_/, ''), title: null, body: c.body.trim(), score: c.score ?? null, flair: null, createdUtc: c.created_utc });

const resumeKey = (sub: string) => `community_resume:${sub}`;
/** Where an unfinished sync of this subreddit stopped (epoch seconds), if it did. */
export const communityResume = (db: Db, sub: string): number | null => {
  const v = db.scalar<string>('SELECT value FROM kv WHERE key = ?', resumeKey(sub));
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Fetch the last `days` of threads and comments from one subreddit and add them to the library, one day at a time. Each day
 * is saved as soon as it is read, so stopping (or a failure) loses at most the day in progress, and syncing again resumes
 * after the last day saved. Matching items are refreshed and new ones added; nothing stored is replaced wholesale.
 */
export async function syncSubreddit(db: Db, root: string, subreddit: string, o: SyncOptions = {}): Promise<SyncResult> {
  const sub = cleanSubreddit(subreddit);
  const client = o.client ?? new ArcticShift({ signal: o.signal });
  const now = o.now ?? new Date();
  const toSec = Math.floor(now.getTime() / 1000);
  const days = o.days ?? SYNC_DAYS;
  const weekStart = toSec - days * 86400;
  const resumeAt = communityResume(db, sub);
  const fromSec = resumeAt != null ? Math.min(Math.max(weekStart, resumeAt), toSec) : weekStart;
  const maxComments = o.maxComments ?? DEFAULT_MAX_COMMENTS;
  const startedAt = Date.now();
  const total = { posts: 0, comments: 0, newPosts: 0, newComments: 0, dropped: 0 };
  const skipped = { removed: 0, bots: 0 };
  const offsetDays = Math.max(Math.round((fromSec - weekStart) / 86400), 0); // days already saved by an earlier, stopped run
  const seen = new Set<string>();
  const skippedSeen = new Set<string>();
  const skip = (kind: CommunityKind, id: string, why: 'removed' | 'bots') => {
    if (!skippedSeen.has(`${kind}:${id}`)) (skippedSeen.add(`${kind}:${id}`), skipped[why]++);
  };
  let truncated = false;
  let cancelled = false;
  let error: string | null = null;
  let done = 0;
  let current = 1;
  const say = (step: string) => o.onProgress?.({ subreddit: sub, step, day: Math.min(offsetDays + current, days), days, threads: total.posts, comments: total.comments, requests: client.requests, startedAt });
  const stamp = stampOf(now);
  const exists = (kind: CommunityKind, id: string) => !!db.scalar('SELECT 1 FROM community_item WHERE kind = ? AND id = ?', kind, id);

  say('Starting');
  // A name the archive has never heard of reads as an empty week, seven days of requests later: ask first. A failed or timed-out
  // check proves nothing, so the sync goes ahead; so does one for a subreddit that already has text stored.
  let missing = false;
  if (resumeAt == null && !db.scalar('SELECT 1 FROM community_item WHERE subreddit = ? LIMIT 1', sub)) {
    say('Checking the subreddit exists');
    try { missing = !(await client.subredditSeen(sub)).exists; } catch { /* could not tell */ }
  }
  try {
    for (let t = fromSec; t < toSec && !truncated && !missing; t += 86400, done++) {
      if (o.signal?.aborted) throw new Error('cancelled');
      current = done + 1;
      const end = Math.min(t + 86400, toSec);

      // Items go into these maps as they are read, so a failure or a stop still leaves everything read so far to be saved.
      const postMap = new Map<string, ArcticPost>();
      const commentMap = new Map<string, ArcticComment>();
      let older: ArcticPost[] = [];
      let completed = false;
      let failure: unknown = null;
      try {
        say('Reading threads');
        await client.posts(sub, t, end, MAX_POSTS, () => say('Reading threads'), postMap);
        say('Reading comments');
        const dayCap = Math.max(maxComments - total.comments, 1);
        const comments = await client.comments(sub, t, end, dayCap, () => say('Reading comments'), commentMap);
        if (comments.truncated) truncated = true;
        // Comments on older threads need their thread's title to make sense.
        const missing = [...new Set([...commentMap.values()].map((c) => c.link_id.replace(/^t3_/, '')))].filter((id) => !postMap.has(id) && !exists('post', id));
        if (missing.length) (say('Reading older threads that were commented on'), (older = await client.postsByIds(missing)));
        completed = true;
      } catch (e) {
        failure = e;
      }

      const items: FileLine[] = [];
      const tombstones: FileLine[] = [];
      for (const p of [...postMap.values(), ...older]) {
        const it = fromPost(p, sub);
        const bodyGone = GONE.test(it.body);
        if (GONE.test(it.title ?? '') || (!it.title && (!it.body || bodyGone))) {
          skip('post', it.id, 'removed');
          if (exists('post', it.id)) tombstones.push({ x: 1, kind: 'post', id: it.id });
        } else if (p.author && BOT.test(p.author)) skip('post', it.id, 'bots');
        // a post whose text was removed keeps its title, which still says what the thread was about
        else items.push({ ...it, body: bodyGone ? '' : it.body });
      }
      for (const c of commentMap.values()) {
        const it = fromComment(c, sub);
        if (!it.body || GONE.test(it.body)) {
          skip('comment', it.id, 'removed');
          if (exists('comment', it.id)) tombstones.push({ x: 1, kind: 'comment', id: it.id });
        } else if (c.author && BOT.test(c.author)) skip('comment', it.id, 'bots');
        else items.push(it);
      }

      // Save what was read even if the day did not finish: the next run reads the day again and de-duplicates.
      const lines = [...items, ...tombstones];
      say('Saving');
      if (lines.length) {
        const d = path.join(dir(root), sub);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `${stamp}-d${String(offsetDays + current).padStart(2, '0')}${completed ? '' : '-partial'}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
      lines.sort((a, b) => Number(b.kind === 'post') - Number(a.kind === 'post')); // posts first so comment chunks can carry the title
      const r = applyCommunity(db, lines);
      // windows overlap by a second, so an item can come back in the next day's batch: count each once
      for (const i of items) {
        const k = `${i.kind}:${i.id}`;
        if (i.x || seen.has(k)) continue;
        seen.add(k);
        if (i.kind === 'post') total.posts++;
        else total.comments++;
      }
      total.newPosts += r.addedPosts;
      total.newComments += r.addedComments;
      total.dropped += r.removed;
      if (failure) throw failure;
      if (total.comments >= maxComments) truncated = true;
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(resumeKey(sub), String(end));
      say('Saved');
    }
  } catch (e) {
    if (o.signal?.aborted || (e as Error).message === 'cancelled') cancelled = true;
    else error = (e as Error).message;
  }

  if (!cancelled && !error) db.prepare('DELETE FROM kv WHERE key = ?').run(resumeKey(sub));
  const iso = now.toISOString();
  // a sync that read nothing, of a subreddit with nothing stored, did not sync anything (a misspelt name looks exactly like this)
  const hasText = total.posts + total.comments > 0 || !!db.scalar('SELECT 1 FROM community_item WHERE subreddit = ? LIMIT 1', sub);
  const notFound = !hasText && !cancelled && !error;
  if (hasText && (done > 0 || (!cancelled && !error))) db.prepare('UPDATE community_source SET last_synced_at = ? WHERE subreddit = ?').run(iso, sub);
  writeSources(db, root);
  return {
    subreddit: sub, from: new Date(fromSec * 1000).toISOString(), to: iso,
    posts: total.posts, comments: total.comments, newPosts: total.newPosts, newComments: total.newComments,
    skipped, dropped: total.dropped, truncated, requests: client.requests, cancelled, notFound, error, daysDone: Math.min(offsetDays + done, days), days,
  };
}

// ---------------------------------------------------------------- reading

export interface CommunityThread {
  id: string;
  subreddit: string;
  url: string;
  title: string;
  body: string;
  score: number | null;
  flair: string | null;
  created: string;
  /** Comments stored for this thread (it may have more on Reddit; a sync keeps only the last week's). */
  comments: number;
}

const threadOf = (r: Record<string, any>): CommunityThread => ({
  id: r.id, subreddit: r.subreddit, url: permalink({ kind: 'post', id: r.id, linkId: r.id, subreddit: r.subreddit }), title: r.title ?? '', body: r.body, score: r.score, flair: r.flair,
  created: new Date(r.created_utc * 1000).toISOString(), comments: r.comments,
});

/** Threads of a category's linked subreddits, newest or best-scored or most-discussed first. */
export function communityThreads(db: Db, categoryKey: string, o: { subreddit?: string; sort?: 'new' | 'score' | 'comments'; limit?: number; offset?: number } = {}): CommunityThread[] {
  const order = o.sort === 'score' ? 'p.score DESC' : o.sort === 'comments' ? 'comments DESC' : 'p.created_utc DESC';
  const rows = db.prepare(
    `SELECT p.*, (SELECT count(*) FROM community_item c WHERE c.kind = 'comment' AND c.link_id = p.id) AS comments
       FROM community_item p JOIN community_source s ON s.subreddit = p.subreddit AND s.category_key = ?1
      WHERE p.kind = 'post' AND (?2 IS NULL OR p.subreddit = ?2)
      ORDER BY ${order}, p.id LIMIT ?3 OFFSET ?4`,
  ).all(categoryKey, o.subreddit ? cleanSubreddit(o.subreddit) : null, Math.min(Math.max(o.limit ?? 20, 1), 100), Math.max(o.offset ?? 0, 0)) as unknown as Record<string, any>[];
  return rows.map(threadOf);
}

export interface CommunityComment { id: string; parentId: string | null; depth: number; body: string; score: number | null; created: string; url: string }

/** One stored thread with its comments in reading order (replies under their parent, best-scored first). */
export function communityThread(db: Db, postId: string, maxComments = 300): { thread: CommunityThread; comments: CommunityComment[]; omitted: number } | null {
  const p = db.prepare("SELECT p.*, (SELECT count(*) FROM community_item c WHERE c.kind = 'comment' AND c.link_id = p.id) AS comments FROM community_item p WHERE p.kind = 'post' AND p.id = ?").get(postId.replace(/^t3_/, '')) as Record<string, any> | undefined;
  if (!p) return null;
  const rows = db.prepare("SELECT * FROM community_item WHERE kind = 'comment' AND link_id = ? ORDER BY score DESC, created_utc").all(p.id) as unknown as Record<string, any>[];
  const kids = new Map<string, Record<string, any>[]>();
  for (const c of rows) kids.set(c.parent_id, [...(kids.get(c.parent_id) ?? []), c]);
  const out: CommunityComment[] = [];
  const walk = (parent: string, depth: number) => {
    for (const c of kids.get(parent) ?? []) {
      out.push({ id: c.id, parentId: c.parent_id, depth, body: c.body, score: c.score, created: new Date(c.created_utc * 1000).toISOString(), url: permalink({ kind: 'comment', id: c.id, linkId: c.link_id, subreddit: c.subreddit }) });
      walk(c.id, depth + 1);
    }
  };
  walk(p.id, 0);
  // comments whose parent is not stored (an older comment outside the synced weeks) are listed after, at depth 0
  const seen = new Set(out.map((c) => c.id));
  for (const c of rows) if (!seen.has(c.id)) { out.push({ id: c.id, parentId: c.parent_id, depth: 0, body: c.body, score: c.score, created: new Date(c.created_utc * 1000).toISOString(), url: permalink({ kind: 'comment', id: c.id, linkId: c.link_id, subreddit: c.subreddit }) }); walk(c.id, 1); }
  return { thread: threadOf(p), comments: out.slice(0, maxComments), omitted: Math.max(out.length - maxComments, 0) };
}
