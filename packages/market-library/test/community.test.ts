import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcticShift, Library, communityResume, addCommunitySource, communityThread, communityThreads, listCommunitySources, removeCommunitySource, searchText, syncSubreddit } from '../src/index.js';
import { fakeArctic } from './helpers.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const KEY = 'amazon.com:kindle:11650864011';
const NOW = new Date('2026-10-20T12:00:00Z');
const T = (d: number) => Math.floor(NOW.getTime() / 1000) - d * 86400; // d days ago

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-c-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'bestsellers-kindle-humorous-fantasy.html.gz'))).toString('utf8'), capturedAt: '2026-10-18T12:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (id: string, d: number, extra: object = {}) => ({ id, title: `Thread ${id}`, selftext: `Looking for cozy fantasy with found family, thread ${id}.`, created_utc: T(d) , score: 12, link_flair_text: 'Recommendation', author: 'someone', ...extra });
const comment = (id: string, link: string, parent: string, d: number, body: string, extra: object = {}) => ({ id, link_id: `t3_${link}`, parent_id: parent, body, created_utc: T(d), score: 3, author: 'another', ...extra });

describe('community sources', () => {
  it('links subreddits to a category, normalises names and survives removal rules', () => {
    addCommunitySource(lib.db, root, KEY, '/r/CozyFantasy');
    addCommunitySource(lib.db, root, KEY, 'r/Fantasy');
    expect(listCommunitySources(lib.db, KEY).map((s) => s.subreddit)).toEqual(['cozyfantasy', 'fantasy']);
    expect(() => addCommunitySource(lib.db, root, KEY, 'not a sub!')).toThrow(/not a subreddit name/);
    expect(() => addCommunitySource(lib.db, root, 'nope-nope', 'fantasy')).toThrow(/no category matches/);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'community', 'sources.json'), 'utf8')).sources).toHaveLength(2);
  });
});

describe('syncSubreddit', () => {
  const data = () => ({
    posts: [post('p1', 3), post('p2', 1, { link_flair_text: null, selftext: '' }), post('p3', 2, { selftext: '[removed]', title: 'Gone thread' }), post('pbot', 1, { author: 'AutoModerator' })],
    comments: [
      comment('c1', 'p1', 't3_p1', 3, 'Try Legends & Lattes, it is the gold standard for cozy fantasy.'),
      comment('c2', 'p1', 't1_c1', 2, 'Seconded, and the sequel is just as warm.'),
      comment('c3', 'p1', 't3_p1', 2, '[deleted]'),
      comment('cbot', 'p1', 't3_p1', 2, 'Please read the rules.', { author: 'AutoModerator' }),
      comment('c4', 'old1', 't3_old1', 1, 'Replying to an older thread about slow burn romance.'),
    ],
  });
  const old = { id: 'old1', title: 'Old thread about romance', selftext: 'From last month', created_utc: T(40), score: 99, link_flair_text: 'Discussion', author: 'x' };

  it('stores thread text and comments with sources, no authors, skipping removed and bot text', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    const d = data();
    d.posts.push(old);
    const log: string[] = [];
    const r = await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(d, log), now: NOW });
    expect(r).toMatchObject({ posts: 4, comments: 3, newPosts: 4, newComments: 3, truncated: false });
    expect(r.skipped).toEqual({ removed: 1, bots: 2 });
    expect(r.posts).toBe(4); // p1, p2 (title only), p3 (title only), old1 fetched because it was commented on
    expect(log.some((l) => l.startsWith('/api/posts/ids'))).toBe(true);
    // authors are asked for (to drop bots) but never kept
    const files = fs.readdirSync(path.join(root, 'community', 'cozyfantasy'));
    const written = fs.readFileSync(path.join(root, 'community', 'cozyfantasy', files[0]!), 'utf8');
    expect(written).not.toMatch(/someone|another|AutoModerator|author/i);
    expect(JSON.stringify(lib.db.prepare('SELECT * FROM community_item').all())).not.toMatch(/someone|another|author/i);

    const threads = communityThreads(lib.db, KEY, { sort: 'score' });
    expect(threads[0]).toMatchObject({ id: 'old1', score: 99, flair: 'Discussion' });
    const t = communityThread(lib.db, 'p1')!;
    expect(t.thread.url).toBe('https://www.reddit.com/r/cozyfantasy/comments/p1/');
    expect(t.comments.map((c) => [c.id, c.depth])).toEqual([['c1', 0], ['c2', 1]]);
    expect(t.comments[0]!.url).toBe('https://www.reddit.com/r/cozyfantasy/comments/p1/_/c1/');
  });

  it('is additive: a second sync adds new items, refreshes scores and drops what was since removed', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(data()), now: NOW });
    const d2 = data();
    d2.posts[0]!.score = 50;
    d2.posts.push(post('p9', 0));
    d2.comments[0]!.body = '[removed]';
    const r = await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(d2), now: new Date(NOW.getTime() + 3600_000) });
    expect(r.newPosts).toBe(1);
    expect(r.dropped).toBe(1);
    expect(communityThread(lib.db, 'p1')!.thread.score).toBe(50);
    expect(communityThread(lib.db, 'p1')!.comments.map((c) => c.id)).not.toContain('c1');
    expect(communityThreads(lib.db, KEY, {}).map((t) => t.id)).toContain('p9');
  });

  it('is searchable by category, with citations in the hit', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(data()), now: NOW });
    const hits = await searchText(lib.db, { query: 'legends lattes gold standard', categoryKey: KEY });
    expect(hits[0]).toMatchObject({ kind: 'community_comment', asin: 'r/cozyfantasy' });
    expect(hits[0]!.meta).toMatchObject({ subreddit: 'cozyfantasy', url: expect.stringContaining('/comments/p1/_/c1/'), postTitle: 'Thread p1', score: 3 });
    expect(hits[0]!.text).toMatch(/^Re: Thread p1/);
    expect(await searchText(lib.db, { query: 'legends lattes', categoryKey: 'other:kindle:1' })).toEqual([]);
  });

  it('survives a rebuild of the database from the files', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(data()), now: NOW });
    const before = communityThreads(lib.db, KEY, {}).length;
    lib.rebuild();
    expect(listCommunitySources(lib.db, KEY)).toHaveLength(1);
    expect(communityThreads(lib.db, KEY, {}).length).toBe(before);
    expect((await searchText(lib.db, { query: 'legends lattes', categoryKey: KEY })).length).toBeGreaterThan(0);
  });

  it('removing the only link deletes the stored text', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(data()), now: NOW });
    removeCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    expect(lib.db.scalar('SELECT count(*) FROM community_item')).toBe(0);
    expect(lib.db.scalar("SELECT count(*) FROM chunk WHERE kind LIKE 'community_%'")).toBe(0);
    expect(fs.existsSync(path.join(root, 'community', 'cozyfantasy'))).toBe(false);
  });

  it('pages through a busy window and stops at the comment cap', async () => {
    addCommunitySource(lib.db, root, KEY, 'busy');
    const comments = Array.from({ length: 250 }, (_, i) => comment(`k${i}`, 'p1', 't3_p1', 2, `comment number ${i} about dragons`, { created_utc: T(2) + Math.floor(i / 5) }));
    const r = await syncSubreddit(lib.db, root, 'busy', { client: fakeArctic({ posts: [post('p1', 3)], comments }), now: NOW });
    expect(r.comments).toBe(250);
    const capped = await syncSubreddit(lib.db, root, 'busy', { client: fakeArctic({ posts: [post('p1', 3)], comments }), now: NOW, maxComments: 120 });
    expect(capped.truncated).toBe(true);
    expect(capped.comments).toBeLessThanOrEqual(120);
  });

  it('treats the service\'s 422 "Timeout. Maybe slow down a bit" as retryable, then halves the window', async () => {
    const spans: number[] = [];
    const all = [post('p1', 3), post('p2', 3, { created_utc: T(3) + 40000 })];
    const f = (async (url: string) => {
      const q = new URL(url).searchParams;
      const span = Number(q.get('before')) - Number(q.get('after'));
      spans.push(span);
      // anything wider than 6 hours "times out", as a busy subreddit's day would
      if (span > 6 * 3600) return new Response(JSON.stringify({ data: null, error: 'Timeout. Maybe slow down a bit' }), { status: 422 });
      const rows = all.filter((r) => r.created_utc > Number(q.get('after')) && r.created_utc < Number(q.get('before')));
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new ArcticShift({ fetch: f, delayMs: 0, sleep: async () => {} });
    const r = await c.posts('x', T(3) - 100, T(3) - 100 + 86400, 100);
    expect(r.items.map((i) => i.id).sort()).toEqual(['p1', 'p2']);
    expect(Math.min(...spans)).toBeLessThanOrEqual(6 * 3600 + 2);
    // a service that only ever times out ends in a clear message
    const dead = new ArcticShift({ delayMs: 0, sleep: async () => {}, fetch: (async () => new Response('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 })) as unknown as typeof fetch });
    await expect(dead.posts('x', T(1), T(0), 10)).rejects.toThrow(/try again later/);
  });

  it('keeps trying patiently at a window it cannot split, spaces requests further apart after a timeout, and says why it is waiting', async () => {
    const rows = [{ id: 'r1', link_id: 't3_p', parent_id: 't3_p', body: 'a comment', created_utc: T(1), score: 1 }];
    let calls = 0;
    const waits: number[] = [];
    const said: string[] = [];
    // busy for the first six tries, as a loaded service is, then fine: the old three-try limit would have given up
    const f = (async () => (++calls <= 6 ? new Response('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 }) : new Response(JSON.stringify({ data: calls === 7 ? rows : [] }), { status: 200 }))) as unknown as typeof fetch;
    const c = new ArcticShift({ fetch: f, delayMs: 300, sleep: async (ms) => { waits.push(ms); }, onWait: (m) => said.push(m) });
    const r = await c.comments('x', T(1) - 60, T(1) + 60, 10); // a two-minute window: already as small as it gets
    expect(r.items.map((i) => i.id)).toEqual(['r1']);
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(waits.filter((w) => w > 0).slice(0, 5)).toEqual([2000, 4000, 10000, 30000, 60000]);
    expect(said.some((m) => /busy: waiting 10 s/.test(m))).toBe(true);
    expect(said.every((m) => /^Arctic Shift is busy: waiting \d+ s, then trying again$/.test(m))).toBe(true);
    // after the timeouts the gap before the next request is wider than the configured 300 ms
    waits.length = 0;
    await c.comments('x', T(1) - 60, T(1) + 60, 10);
    expect(waits[0]).toBeGreaterThan(300);
    // and it only gives up after the patient waits are used (bounded: a dead service still ends with a clear message)
    const dead = new ArcticShift({ fetch: (async () => new Response('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 })) as unknown as typeof fetch, delayMs: 0, sleep: async (ms) => { waits.push(ms); } });
    waits.length = 0;
    await expect(dead.comments('x', T(1) - 60, T(1) + 60, 10)).rejects.toThrow(/try again later/);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(200000); // about four minutes of waiting in all
  });

  it('does not wait patiently on a wide window: it splits it first', async () => {
    const waits: number[] = [];
    const f = (async (url: string) => {
      const q = new URL(url).searchParams;
      return Number(q.get('before')) - Number(q.get('after')) > 7200 ? new Response('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 }) : new Response('{"data":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    const c = new ArcticShift({ fetch: f, delayMs: 0, sleep: async (ms) => { waits.push(ms); } });
    await c.posts('x', T(1), T(1) + 86400, 10);
    expect(Math.max(...waits)).toBeLessThan(10000); // quick retries only, until the window is small enough to succeed (no patient waits)
  });

  it('reports progress a day at a time, can be stopped with the finished days kept, and resumes after them', async () => {
    // a saved resume point only counts while it is inside the sync window, which is measured from the real clock: hold it at NOW
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
    addCommunitySource(lib.db, root, KEY, 'busy');
    const data = {
      posts: [post('d1', 6.5), post('d2', 5.5), post('d4', 3.5), post('d6', 1.5)],
      comments: [comment('c1', 'd1', 't3_d1', 6.5, 'first day comment about dragons'), comment('c2', 'd2', 't3_d2', 5.5, 'second day comment'), comment('c4', 'd4', 't3_d4', 3.5, 'fourth day comment'), comment('c6', 'd6', 't3_d6', 1.5, 'sixth day comment')],
    };
    const ac = new AbortController();
    const base = fakeArctic(data);
    const stopping = new ArcticShift({
      delayMs: 0, sleep: async () => {}, signal: ac.signal,
      fetch: (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (u.pathname === '/api/posts/search' && Number(u.searchParams.get('after')) >= T(5) - 2) ac.abort(); // the user presses Stop as day 3 starts
        return (base as any).doFetch(url, init);
      }) as unknown as typeof fetch,
    });
    const progress: { day: number; days: number; step: string }[] = [];
    const first = await syncSubreddit(lib.db, root, 'busy', { client: stopping, signal: ac.signal, now: NOW, onProgress: (p) => progress.push({ day: p.day, days: p.days, step: p.step }) });
    expect(first).toMatchObject({ cancelled: true, daysDone: 2, days: 7, newPosts: 2, newComments: 2 });
    expect(progress.some((p) => p.day === 1 && p.step === 'Reading threads')).toBe(true);
    expect(progress.some((p) => p.day === 2 && p.step === 'Saved')).toBe(true);
    expect(progress.every((p) => p.days === 7)).toBe(true);
    expect(communityThreads(lib.db, KEY, {}).map((t) => t.id).sort()).toEqual(['d1', 'd2']);
    expect(communityResume(lib.db, 'busy')).toBe(T(5));
    expect(listCommunitySources(lib.db, KEY)[0]!.resumeFrom).toBe(new Date(T(5) * 1000).toISOString());

    // starting again carries on after the last saved day and does not read the first two again
    const log: string[] = [];
    const second = await syncSubreddit(lib.db, root, 'busy', { client: fakeArctic(data, log), now: NOW });
    expect(second).toMatchObject({ cancelled: false, newPosts: 2, newComments: 2, daysDone: 7, days: 7 });
    expect(log.filter((l) => l.startsWith('/api/posts/search')).every((l) => Number(new URLSearchParams(l.split('?')[1]).get('after')) >= T(5) - 1)).toBe(true);
    expect(communityThreads(lib.db, KEY, {}).map((t) => t.id).sort()).toEqual(['d1', 'd2', 'd4', 'd6']);
    expect(communityResume(lib.db, 'busy')).toBeNull();
    expect(listCommunitySources(lib.db, KEY)[0]!.resumeFrom).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a good response whose comments talk about timeouts (only the status and the error field count)', async () => {
    const rows = [{ id: 'a', link_id: 't3_p', parent_id: 't3_p', body: 'The audiobook timed out on me; time out for a bit.', created_utc: T(1), score: 1 }];
    const c = new ArcticShift({ delayMs: 0, sleep: async () => {}, fetch: (async () => new Response(JSON.stringify({ data: rows }), { status: 200 })) as unknown as typeof fetch });
    const r = await c.comments('x', T(2), T(0), 10);
    expect(r.items.map((i) => i.id)).toEqual(['a']);
    // a real timeout is still recognised by the service's own error field
    const bad = new ArcticShift({ delayMs: 0, sleep: async () => {}, fetch: (async () => new Response('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 })) as unknown as typeof fetch });
    await expect(bad.comments('x', T(2), T(0), 10)).rejects.toThrow(/rejected the query \(422/);
  });

  it('keeps what a day read before it failed, reports the error, and resumes at that day', async () => {
    addCommunitySource(lib.db, root, KEY, 'busy');
    const data = { posts: [post('d1', 6.5), post('d2', 5.5), post('d3', 4.5)], comments: [comment('c1', 'd1', 't3_d1', 6.5, 'first day comment'), comment('c3', 'd3', 't3_d3', 4.5, 'third day comment')] };
    const base = fakeArctic(data);
    const flaky = new ArcticShift({
      delayMs: 0, sleep: async () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        // day 3's comments cannot be read at all, after its threads were
        if (u.pathname === '/api/comments/search' && Number(u.searchParams.get('after')) >= T(5) - 2) return new Response('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 });
        return (base as any).doFetch(url, init);
      }) as unknown as typeof fetch,
    });
    const r = await syncSubreddit(lib.db, root, 'busy', { client: flaky, now: NOW });
    expect(r.error).toMatch(/Arctic Shift rejected the query/);
    expect(r.cancelled).toBe(false);
    expect(r.daysDone).toBe(2);
    // the two finished days and the threads read on the failed day are all stored
    expect(communityThreads(lib.db, KEY, {}).map((t) => t.id).sort()).toEqual(['d1', 'd2', 'd3']);
    expect(communityResume(lib.db, 'busy')).toBe(T(5));
    const again = await syncSubreddit(lib.db, root, 'busy', { client: fakeArctic(data), now: NOW });
    expect(again).toMatchObject({ error: null, cancelled: false });
    expect(communityThread(lib.db, 'd3')!.comments.map((c) => c.id)).toEqual(['c3']);
    expect(communityResume(lib.db, 'busy')).toBeNull();
  });

  it('retries a rate limit and gives a clear error when the service stays down', async () => {
    let n = 0;
    const waits: number[] = [];
    const flaky = new ArcticShift({ delayMs: 0, sleep: async (ms) => void waits.push(ms), fetch: (async () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'x-ratelimit-reset': '7' } }) : new Response(JSON.stringify({ data: [] }), { status: 200 }))) as unknown as typeof fetch });
    expect(await flaky.postsByIds(['a'])).toEqual([]);
    expect(waits).toContain(7000);
    const down = new ArcticShift({ delayMs: 0, sleep: async () => {}, fetch: (async () => new Response('Query timed out', { status: 500 })) as unknown as typeof fetch });
    await expect(down.postsByIds(['a'])).rejects.toThrow(/try again later/);
  });

  it('does not mark a subreddit as synced when it returned nothing and nothing is stored (a misspelt name)', async () => {
    addCommunitySource(lib.db, root, KEY, 'nosuchsubreddit');
    const log: string[] = [];
    const r = await syncSubreddit(lib.db, root, 'nosuchsubreddit', { client: fakeArctic({ posts: [], comments: [] }, log), now: NOW });
    expect(r).toMatchObject({ posts: 0, comments: 0, error: null, notFound: true, daysDone: 0, requests: 1 });
    expect(log).toHaveLength(1); // one existence check, and the seven days were never read
    expect(log[0]).toContain('limit=1');
    expect(listCommunitySources(lib.db, KEY)[0]!.lastSyncedAt).toBeNull();
    // a real subreddit that had text stored is not "not found" just because a week was quiet
    await syncSubreddit(lib.db, root, 'nosuchsubreddit', { client: fakeArctic({ posts: [{ id: 'q1', title: 'hello', selftext: 'x', created_utc: Math.floor(NOW.getTime() / 1000) - 3600, score: 1, link_flair_text: null, author: 'a' }], comments: [] }), now: NOW });
    const quiet = await syncSubreddit(lib.db, root, 'nosuchsubreddit', { client: fakeArctic({ posts: [], comments: [] }), now: new Date(NOW.getTime() + 60000) });
    expect(quiet).toMatchObject({ posts: 0, notFound: false });
  });

  it('goes ahead when the existence check itself fails, and skips it for a subreddit that already has text', async () => {
    addCommunitySource(lib.db, root, KEY, 'flaky');
    let calls = 0;
    const flaky = new ArcticShift({ fetch: (async (url: string) => {
      calls++;
      if (calls <= 3) return new Response("boom", { status: 500 }); // the check gives up after its retries
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch, delayMs: 0, sleep: async () => {} });
    const r = await syncSubreddit(lib.db, root, 'flaky', { client: flaky, now: NOW, days: 1 });
    expect(r.daysDone).toBe(1); // the check could not tell, so the day was read
    // stored text means the subreddit exists: no check
    const log: string[] = [];
    const post = { id: 'z1', title: 'hello there', selftext: 'x', created_utc: Math.floor(NOW.getTime() / 1000) - 3600, score: 1, link_flair_text: null, author: 'a' };
    await syncSubreddit(lib.db, root, 'flaky', { client: fakeArctic({ posts: [post], comments: [] }), now: NOW, days: 1 });
    await syncSubreddit(lib.db, root, 'flaky', { client: fakeArctic({ posts: [post], comments: [] }, log), now: new Date(NOW.getTime() + 60000), days: 1 });
    expect(log.some((l) => l.includes('sort=desc'))).toBe(false); // the existence check is the only newest-first request
  });
});
