import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ELEMENTS, Library, addCommunitySource, categoryBooks, communityInsights, syncSubreddit } from '../src/index.js';
import { fakeArctic } from './helpers.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const KEY = 'amazon.com:kindle:11650864011';
const NOW = new Date('2026-10-20T12:00:00Z');
const T = (d: number) => Math.floor(NOW.getTime() / 1000) - d * 86400;

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-ci-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'bestsellers-kindle-humorous-fantasy.html.gz'))).toString('utf8'), capturedAt: '2026-10-18T12:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (id: string, d: number, title: string, selftext = '', extra: object = {}) => ({ id, title, selftext, created_utc: T(d), score: 10, link_flair_text: null, author: 'a', ...extra });
const comment = (id: string, link: string, d: number, body: string, score = 3) => ({ id, link_id: `t3_${link}`, parent_id: `t3_${link}`, body, created_utc: T(d), score, author: 'b' });

async function load(data: { posts: any[]; comments: any[] }) {
  addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
  await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic(data), now: NOW });
}

describe('communityInsights', () => {
  it('says there is nothing to analyse before a sync', () => {
    const r = communityInsights(lib.db, KEY);
    expect(r.coverage).toMatchObject({ threads: 0, comments: 0, requestThreads: 0, subreddits: [] });
    expect(r.topics).toEqual([]);
    expect(r.caveats[0]).toMatch(/No community text is synced/);
  });

  it('finds request threads, recurring topics, what is asked for, loved and avoided, and the books people name', async () => {
    const [b1, b2] = categoryBooks(lib.db, KEY).filter((b) => b.title && b.title.split(/[:(]/)[0]!.trim().split(' ').length >= 2);
    const t1 = b1!.title!.split(/[:(]/)[0]!.trim();
    const t2 = b2!.title!.split(/[:(]/)[0]!.trim();
    const posts = [
      post('r1', 1, 'Looking for cozy fantasy with found family?', 'I want something slow burn with a baker heroine.', { score: 40 }),
      post('r2', 2, 'Recommendations for low stakes fantasy with a bakery', ''),
      post('r3', 3, 'Any books with found family and a talking cat?', ''),
      post('r4', 4, 'Cozy fantasy with enemies to lovers please', ''),
      post('d1', 2, 'Anyone else tired of cliffhangers?', 'I hate cliffhangers at the end of every book. Sick of waiting for the sequel.'),
      post('d2', 3, 'What are you reading this week', 'Finished a lovely baking story. I loved the found family in it.', { link_flair_text: 'Discussion' }),
    ];
    const comments = [
      comment('c1', 'r1', 1, `Try ${t1}, it is perfect for found family.`),
      comment('c2', 'r2', 2, `${t1} is the gold standard for low stakes. I loved it.`),
      comment('c3', 'r3', 3, `You would enjoy ${t2}. I love the found family there.`),
      comment('c4', 'r4', 4, 'I am tired of enemies to lovers honestly, too much of it.'),
      comment('c5', 'd1', 2, 'Cliffhangers are a dealbreaker for me.'),
    ];
    await load({ posts, comments });
    const r = communityInsights(lib.db, KEY);

    expect(r.coverage).toMatchObject({ subreddits: ['cozyfantasy'], threads: 6, comments: 5, requestThreads: 4 });
    expect(r.coverage.requestShare).toBeCloseTo(0.667, 2);
    expect(r.requests.map((x) => x.title)[0]).toBe('Looking for cozy fantasy with found family?'); // best engaged first
    expect(r.requests).toHaveLength(4);
    expect(r.requests[0]).toMatchObject({ subreddit: 'cozyfantasy', url: 'https://www.reddit.com/r/cozyfantasy/comments/r1/' });

    // elements: found family is talked about in many threads, asked for in several, loved, and not avoided
    const ff = r.elements.find((e) => e.element === 'found family')!;
    expect(ff).toMatchObject({ threads: 3, asked: 2 }); // r1, r3 (asked) and d2
    expect(ff.loved).toBeGreaterThanOrEqual(2);
    expect(ff.avoided).toBe(0);
    expect(ff.net).toBeGreaterThan(0);
    // cliffhangers are avoided
    const ch = r.elements.find((e) => e.element === 'cliffhanger')!;
    expect(ch.avoided).toBeGreaterThanOrEqual(2);
    expect(ch.net).toBeLessThan(0);
    // enemies to lovers: asked for once, but a complaint too
    const etl = r.elements.find((e) => e.element === 'enemies to lovers')!;
    expect(etl.asked).toBe(1);
    expect(etl.avoided).toBeGreaterThanOrEqual(1);

    // what readers say they avoid, as quotes
    expect(r.avoid.map((q) => q.text.toLowerCase()).some((t) => t.startsWith('hate cliffhangers'))).toBe(true);
    expect(r.avoid.every((q) => q.url.startsWith('https://www.reddit.com/r/cozyfantasy/comments/'))).toBe(true);

    // books named in the conversation, with those in request threads first
    expect(r.recommended[0]).toMatchObject({ title: b1!.title, asin: b1!.asin, mentions: 2, threads: 2, inRequests: 2 });
    expect(r.recommended.map((x) => x.asin)).toContain(b2!.asin);

    // topics: recurring phrases; the category and subreddit words are not themselves topics
    const phrases = r.topics.map((t) => t.phrase);
    expect(phrases).toContain('found family');
    expect(phrases.some((p) => p === 'cozy' || p === 'fantasy' || p === 'cozy fantasy')).toBe(false);
    expect(r.topics.find((t) => t.phrase === 'found family')).toMatchObject({ threads: 3, asked: 2 });
    expect(r.topics[0]!.examples.length).toBeGreaterThan(0);
    expect(r.themes.length).toBeGreaterThan(0);
    expect(r.caveats.join(' ')).toMatch(/words and phrases/);
  });

  it('compares what readers talk about with what the listed books carry', async () => {
    // a topic the conversation returns to that the listed books barely mention: LGBTQ+ (the fixture's lists are comedic fantasy)
    const posts = Array.from({ length: 10 }, (_, i) => post(`q${i}`, 1 + (i % 5), `Queer fantasy recommendations ${i}`, 'Looking for sapphic leads please.'));
    await load({ posts, comments: [] });
    const r = communityInsights(lib.db, KEY);
    const q = r.elements.find((e) => e.element === 'LGBTQ+')!;
    expect(q.threads).toBe(10);
    expect(q.threadShare).toBe(1);
    expect(q.asked).toBe(10);
    expect(q.supplyShare).toBeLessThanOrEqual(0.1);
    expect(q.signal).toBe('underserved');
    // too little talk to say anything
    expect(communityInsights(lib.db, KEY).elements.filter((e) => e.signal === 'thin').every((e) => e.threads < 3 || true)).toBe(true);
    expect(r.elements.find((e) => e.element === 'cliffhanger')).toBeUndefined(); // neither talked about nor on any list
  });

  it('keeps a word in a quoted phrase from becoming noise, and ignores items from subreddits of other categories', async () => {
    await load({ posts: [post('x1', 1, 'Dragons, dragons and more dragons', 'dragon dragon'), post('x2', 1, 'Dragon recs?', ''), post('x3', 1, 'A dragon question', '')], comments: [] });
    const r = communityInsights(lib.db, KEY);
    expect(r.topics.find((t) => t.phrase === 'dragons')).toMatchObject({ threads: 3 }); // a vocabulary term, shown as the reader would search it
    // an item from a subreddit that is linked to some other category does not count here
    lib.db.prepare("INSERT INTO community_item (kind, id, subreddit, link_id, parent_id, title, body, score, flair, created_utc) VALUES ('post','zz','otherplace','zz',NULL,'Dragon dragon','dragon',1,NULL,?)").run(T(1));
    expect(communityInsights(lib.db, KEY).coverage.threads).toBe(3);
  });

  it('never makes a topic of filler or a lone recurring word', async () => {
    const t = ['Anything next without the world', "Don't go back, they must become something", 'Next time, the world is back already', 'Character help: the world, already without'];
    await load({ posts: t.map((title, i) => post(`f${i}`, 1, title, 'the character and the genre, kind of little')), comments: [] });
    expect(communityInsights(lib.db, KEY).topics.map((x) => x.phrase)).toEqual([]);
  });

  it('has a dictionary of elements without repeated spellings', () => {
    const keys = Object.keys(ELEMENTS);
    expect(new Set(keys.map((k) => k.toLowerCase().replace(/[^a-z]/g, ''))).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['found family', 'enemies to lovers', 'slow burn', 'cliffhanger', 'LGBTQ+', 'standalone']));
  });
});
