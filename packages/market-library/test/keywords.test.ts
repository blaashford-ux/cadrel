import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COOLDOWN_MS, Library, addCommunitySource, detectKind, expandSeed, getTrend, importTrendsCsv, keywordTable, lookupSuggestions,
  parseTrendsCsv, redditSignal, searchCompetition, summarizeTrend, syncSubreddit, trendsUrl,
} from '../src/index.js';
import { fakeArctic } from './helpers.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const KEY = 'amazon.com:kindle:11650864011';
const NOW = new Date('2026-10-20T12:00:00Z');

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-k-'));
  lib = Library.open(root);
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Serves autocomplete answers per prefix: `answers[prefix]` is the list; anything else is empty. Logs every URL. */
function fakeSuggest(answers: Record<string, string[]>, log: string[] = [], shape: 'amazon' | 'opensearch' = 'opensearch') {
  return (async (url: string) => {
    log.push(url);
    const u = new URL(url);
    const prefix = (u.searchParams.get('prefix') ?? u.searchParams.get('q') ?? u.searchParams.get('query') ?? '').toLowerCase();
    const list = answers[prefix] ?? [];
    return new Response(JSON.stringify(shape === 'amazon' ? { suggestions: list.map((value) => ({ value, type: 'KEYWORD' })) } : [prefix, list]), { status: 200 });
  }) as unknown as typeof fetch;
}
const quick = { delayMs: 0, sleep: async () => {} };

describe('expandSeed', () => {
  it('asks for the seed and seed + a..z, keeps the strongest sighting of each phrase and ranks plain-seed phrases first', async () => {
    const log: string[] = [];
    const f = fakeSuggest({ 'cozy fantasy': ['cozy fantasy books', 'cozy fantasy romance'], 'cozy fantasy b': ['cozy fantasy books', 'cozy fantasy bakery'], 'cozy fantasy r': ['cozy fantasy romance novels'] }, log);
    const r = await expandSeed('google', 'Cozy  Fantasy', { ...quick, fetch: f });
    expect(r.requests).toBe(27);
    expect(log).toHaveLength(27);
    expect(log[0]).toContain('suggestqueries.google.com');
    expect(r.suggestions.map((s) => [s.keyword, s.position, s.via])).toEqual([
      ['cozy fantasy books', 1, 'seed'],
      ['cozy fantasy romance', 2, 'seed'],
      ['cozy fantasy bakery', 2, 'b'],
      ['cozy fantasy romance novels', 1, 'r'],
    ].sort((a, b) => Number(b[2] === 'seed') - Number(a[2] === 'seed') || (a[1] as number) - (b[1] as number) || String(a[0]).localeCompare(String(b[0]))));
    expect(r.stopped).toBeNull();
  });

  it('reads Amazon\'s Kindle-store suggestion shape and Bing\'s OpenSearch shape', async () => {
    const a = await expandSeed('amazon', 'dragon', { ...quick, letters: '', fetch: fakeSuggest({ dragon: ['dragon rider', 'dragon shifter romance'] }, [], 'amazon') });
    expect(a.suggestions.map((s) => s.keyword)).toEqual(['dragon rider', 'dragon shifter romance']);
    const log: string[] = [];
    await expandSeed('amazon', 'dragon', { ...quick, letters: '', fetch: fakeSuggest({}, log, 'amazon') });
    expect(log[0]).toContain('completion.amazon.com');
    expect(log[0]).toContain('alias=digital-text');
    const b = await expandSeed('bing', 'dragon', { ...quick, letters: '', fetch: fakeSuggest({ dragon: ['dragon books'] }) });
    expect(b.suggestions).toHaveLength(1);
  });

  it('gives up on a source after two blocked answers instead of pushing on', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('<html>captcha</html>', { status: 200 }); }) as unknown as typeof fetch;
    const r = await expandSeed('amazon', 'dragon', { ...quick, fetch: f });
    expect(calls).toBe(2);
    expect(r.stopped).toMatch(/stopped answering/);
    expect(r.suggestions).toEqual([]);
    const f429 = (async () => { calls++; return new Response('slow down', { status: 429 }); }) as unknown as typeof fetch;
    calls = 0;
    expect((await expandSeed('google', 'dragon', { ...quick, fetch: f429 })).requests).toBe(2);
  });

  it('stops when cancelled and rejects silly seeds', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await expandSeed('bing', 'dragon', { ...quick, fetch: fakeSuggest({}), signal: ac.signal })).stopped).toBe('cancelled');
    await expect(expandSeed('bing', 'x')).rejects.toThrow(/two characters/);
    await expect(expandSeed('bing', 'x'.repeat(81))).rejects.toThrow(/80/);
  });

  it('honours the request cap', async () => {
    const log: string[] = [];
    await expandSeed('bing', 'dragon', { ...quick, fetch: fakeSuggest({}, log), maxRequests: 5 });
    expect(log).toHaveLength(5);
  });
});

describe('lookupSuggestions cache', () => {
  const answers = { dragon: ['dragon rider', 'dragon books'] };
  it('serves a fresh lookup from the cache with no request, and refetches when forced or stale', async () => {
    const log: string[] = [];
    const f = fakeSuggest(answers, log);
    const first = await lookupSuggestions(lib.db, 'google', 'Dragon', { ...quick, fetch: f, letters: '', now: NOW });
    expect(first.cached).toBe(false);
    expect(log).toHaveLength(1);
    const again = await lookupSuggestions(lib.db, 'google', 'dragon', { ...quick, fetch: f, letters: '', now: new Date(NOW.getTime() + 86400000) });
    expect(again.cached).toBe(true);
    expect(again.suggestions.map((s) => s.keyword)).toEqual(['dragon rider', 'dragon books']);
    expect(log).toHaveLength(1);
    await lookupSuggestions(lib.db, 'google', 'dragon', { ...quick, fetch: f, letters: '', now: new Date(NOW.getTime() + 86400000), force: true });
    await lookupSuggestions(lib.db, 'google', 'dragon', { ...quick, fetch: f, letters: '', now: new Date(NOW.getTime() + 8 * 86400000) });
    expect(log).toHaveLength(3);
  });

  it('does not keep an empty answer for a week: it is asked again after the cool-down, or at once when forced', async () => {
    const log: string[] = [];
    const f = fakeSuggest({}, log);
    await lookupSuggestions(lib.db, 'google', 'cozy fantasy dungeon', { ...quick, fetch: f, letters: '', now: NOW });
    expect(log).toHaveLength(1);
    await lookupSuggestions(lib.db, 'google', 'cozy fantasy dungeon', { ...quick, fetch: f, letters: '', now: new Date(NOW.getTime() + COOLDOWN_MS - 1000) });
    expect(log).toHaveLength(1);
    await lookupSuggestions(lib.db, 'google', 'cozy fantasy dungeon', { ...quick, fetch: f, letters: '', now: new Date(NOW.getTime() + COOLDOWN_MS + 1000) });
    expect(log).toHaveLength(2);
    await lookupSuggestions(lib.db, 'google', 'cozy fantasy dungeon', { ...quick, fetch: f, letters: '', now: new Date(NOW.getTime() + 1000), force: true });
    expect(log).toHaveLength(3);
  });

  it('leaves a source alone for a while after it blocks, and never replaces good data with a blocked lookup', async () => {
    const good = fakeSuggest(answers);
    await lookupSuggestions(lib.db, 'bing', 'dragon', { ...quick, fetch: good, letters: '', now: NOW });
    let calls = 0;
    const blocked = (async () => { calls++; return new Response('no', { status: 429 }); }) as unknown as typeof fetch;
    const later = new Date(NOW.getTime() + 9 * 86400000);
    const r = await lookupSuggestions(lib.db, 'bing', 'dragon', { ...quick, fetch: blocked, now: later });
    expect(r.stopped).toMatch(/stopped answering/);
    expect(r.suggestions).toHaveLength(2); // the older good data is still there
    expect(calls).toBe(2);
    // a blocked fresh seed is remembered, and not retried inside the cool-down
    await lookupSuggestions(lib.db, 'bing', 'elf', { ...quick, fetch: blocked, now: later });
    calls = 0;
    const r2 = await lookupSuggestions(lib.db, 'bing', 'elf', { ...quick, fetch: blocked, now: new Date(later.getTime() + COOLDOWN_MS - 1000) });
    expect(calls).toBe(0);
    expect(r2.cached).toBe(true);
    await lookupSuggestions(lib.db, 'bing', 'elf', { ...quick, fetch: blocked, now: new Date(later.getTime() + COOLDOWN_MS + 1000) });
    expect(calls).toBe(2);
  });
});

describe('Google Trends import', () => {
  const csv = (rows: string[]) => ['Category: All categories', '', 'Week,cozy fantasy: (United States),"dark romance: (United States)"', ...rows].join('\n');
  it('parses a multi-term export, treats <1 as 0 and strips the BOM', () => {
    const s = parseTrendsCsv('﻿' + csv(['2026-09-27,45,<1', '2026-10-04,50,3', '2026-10-11,100,12']));
    expect(s.map((x) => [x.keyword, x.unit, x.geo])).toEqual([['cozy fantasy', 'week', 'United States'], ['dark romance', 'week', 'United States']]);
    expect(s[1]!.points.map((p) => p.value)).toEqual([0, 3, 12]);
  });
  it('rejects files that are not interest-over-time exports', () => {
    expect(() => parseTrendsCsv('a,b\n1,2')).toThrow(/Trends/);
    expect(() => parseTrendsCsv('Week,x: (US)\n')).toThrow(/no data rows/);
  });
  it('summarises direction from the newest third against the one before', () => {
    const pts = (v: number[]) => v.map((value, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value }));
    expect(summarizeTrend(pts([10, 10, 10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 20, 20]))?.direction).toBe('rising');
    expect(summarizeTrend(pts([20, 20, 20, 20, 20, 20, 20, 20, 20, 10, 10, 10, 10, 10, 10, 10, 10, 10]))?.direction).toBe('falling');
    expect(summarizeTrend(pts([5, 6, 5, 6]))?.direction).toBe('unknown');
    expect(summarizeTrend([])).toBeNull();
  });
  it('stores imports per keyword and replaces older ones', () => {
    expect(importTrendsCsv(lib.db, csv(['2026-10-04,50,3', '2026-10-11,100,12']), '2026-10-20T00:00:00Z').keywords).toEqual(['cozy fantasy', 'dark romance']);
    importTrendsCsv(lib.db, csv(['2026-10-18,10,1']));
    expect(getTrend(lib.db, 'Cozy Fantasy')?.points).toHaveLength(1);
  });
  it('builds a browser link for up to five terms', () => {
    const u = new URL(trendsUrl(['a b', 'c', 'd', 'e', 'f', 'g']));
    expect(u.hostname).toBe('trends.google.com');
    expect(u.searchParams.get('q')).toBe('a b,c,d,e,f');
    expect(() => trendsUrl([' '])).toThrow();
  });
});

describe('Reddit mentions from synced text', () => {
  it('counts phrase hits across items, threads and subreddits without any request', async () => {
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'bestsellers-kindle-humorous-fantasy.html.gz'))).toString('utf8'), capturedAt: '2026-10-18T12:00:00Z' });
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    const T = (d: number) => Math.floor(NOW.getTime() / 1000) - d * 86400;
    const client = fakeArctic({
      posts: [{ id: 'p1', title: 'Cozy fantasy with found family?', selftext: 'Need more cozy fantasy', created_utc: T(2), score: 10, link_flair_text: null, author: 'a' }, { id: 'p2', title: 'Grimdark?', selftext: 'The opposite', created_utc: T(1), score: 4, link_flair_text: null, author: 'b' }],
      comments: [{ id: 'c1', link_id: 't3_p1', parent_id: 't3_p1', body: 'Try Legends & Lattes, 100% cozy fantasy', created_utc: T(2), score: 3, author: 'c' }, { id: 'c2', link_id: 't3_p2', parent_id: 't3_p2', body: 'no idea', created_utc: T(1), score: -4, author: 'd' }],
    });
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client, now: NOW });
    const r = redditSignal(lib.db, 'Cozy Fantasy');
    expect(r.mentions).toBe(2);
    expect(r.threads).toBe(1);
    expect(r.score).toBe(13);
    expect(r.itemsSearched).toBe(4);
    expect(r.per1000).toBe(500);
    expect(r.bySubreddit).toEqual([{ subreddit: 'cozyfantasy', mentions: 2 }]);
    expect(redditSignal(lib.db, '100%').mentions).toBe(1); // LIKE wildcards are literal
    expect(redditSignal(lib.db, 'no such phrase').mentions).toBe(0);
    expect(redditSignal(lib.db, 'cozy', { subreddits: ['elsewhere'] }).itemsSearched).toBe(0);
  });
  it('reports zero items when nothing is synced', () => {
    expect(redditSignal(lib.db, 'dragon')).toMatchObject({ mentions: 0, itemsSearched: 0 });
  });
});

describe('keywordTable', () => {
  it('joins the per-source columns for a seed, most widely listed first, and always includes the seed', async () => {
    await lookupSuggestions(lib.db, 'google', 'dragon', { ...quick, letters: '', now: NOW, fetch: fakeSuggest({ dragon: ['dragon rider', 'dragon books'] }) });
    await lookupSuggestions(lib.db, 'bing', 'dragon', { ...quick, letters: '', now: NOW, fetch: fakeSuggest({ dragon: ['dragon books', 'dragon age'] }) });
    await lookupSuggestions(lib.db, 'amazon', 'dragon', { ...quick, letters: '', now: NOW, fetch: fakeSuggest({ dragon: ['dragon rider'] }, [], 'amazon') });
    importTrendsCsv(lib.db, 'Week,dragon books: (United States)\n2026-10-04,10\n2026-10-11,20');
    const t = keywordTable(lib.db, 'Dragon');
    expect(t.rows.map((r) => [r.keyword, r.listedBy])).toEqual([['dragon', 0], ['dragon books', 2], ['dragon rider', 2], ['dragon age', 1]]);
    const books = t.rows.find((r) => r.keyword === 'dragon books')!;
    expect(books.google?.position).toBe(2);
    expect(books.bing?.position).toBe(1);
    expect(books.amazon).toBeNull();
    expect(books.trend?.points).toBe(2);
    expect(t.lookups.map((l) => l.source).sort()).toEqual(['amazon', 'bing', 'google']);
    expect(t.redditItems).toBe(0);
  });
});

describe('search-page captures', () => {
  const page = (rows: string) => `<html><head><link rel="canonical" href="https://www.amazon.com/s?k=cozy+fantasy"></head><body>
    <div data-component-type="s-result-info-bar"><span>1-16 of over 3,000 results for</span> <span>"cozy fantasy"</span></div>${rows}</body></html>`;
  const row = (asin: string, title: string, o: { sponsored?: boolean; ratings?: string; price?: string } = {}) => `
    <div data-component-type="s-search-result" data-asin="${asin}" class="s-result-item">
      ${o.sponsored ? '<span class="puis-sponsored-label-text">Sponsored</span>' : ''}
      <h2 aria-label="${title}"><a><span>${title}</span></a></h2>
      <div class="a-row a-size-base a-color-secondary"><span>by Jane Doe</span></div>
      <span class="a-icon-alt">4.6 out of 5 stars</span>
      <a aria-label="${o.ratings ?? '1,234'} ratings"><span class="s-underline-text">${o.ratings ?? '1,234'}</span></a>
      <span class="a-price"><span class="a-offscreen">${o.price ?? '$4.99'}</span></span>
    </div>`;
  const URL1 = 'https://www.amazon.com/s?k=Cozy+Fantasy&i=digital-text';

  it('detects search URLs', () => {
    expect(detectKind(URL1)).toBe('search');
    expect(detectKind('https://www.amazon.com/s?i=digital-text&k=dragon+rider&ref=nb_sb_noss')).toBe('search');
    expect(detectKind('https://www.amazon.com/s?i=digital-text')).toBeNull();
  });

  it('stores a search page, then reports competition using ranks from captured book pages', () => {
    const r = lib.ingest({ kind: 'detail', url: 'https://www.amazon.com/dp/B0C1R52V2J', html: zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'detail-kindle-B0C1R52V2J.html.gz'))).toString('utf8'), capturedAt: '2026-10-18T12:00:00Z' });
    const rank = lib.db.scalar<number>("SELECT r.rank FROM rank_entry r JOIN snapshot s ON s.id = r.snapshot_id WHERE s.asin = ? AND r.scope = 'overall' AND r.store = 'kindle'", r.asin);
    expect(rank).toBeGreaterThan(0);

    const html = page(row('B000000001', 'Ad book', { sponsored: true }) + row(r.asin!, 'Known book', { ratings: '2,000' }) + row('B000000003', 'Unknown book', { ratings: '10', price: '$2.99' }));
    const out = lib.ingest({ kind: 'search', url: URL1, html, capturedAt: '2026-10-19T12:00:00Z' });
    expect(out).toMatchObject({ kind: 'search', query: 'cozy fantasy', replaced: false, issues: [] });
    expect(fs.existsSync(path.join(root, out.dir, 'page.html.gz'))).toBe(true);

    const c = searchCompetition(lib.db, 'Cozy fantasy')!;
    expect(c).toMatchObject({ resultCount: 3000, resultCountIsMinimum: true, top: 2, sponsored: 1, medianRatings: 1005, withRank: 1, medianRank: rank });
    expect(c.books.map((b) => b.asin)).toEqual([r.asin, 'B000000003']);
    expect(c.books[0]!.dailySales).toBeGreaterThan(0);
    expect(c.books[1]!.rank).toBeNull();
    expect(c.estDailySales).toBe(c.books[0]!.dailySales);
    expect(c.salesBasis).toBe('methods');
    expect(c.estDailySalesLow!).toBeLessThan(c.estDailySales!);
    expect(c.estDailySalesHigh!).toBeGreaterThan(c.estDailySales!);
    expect(c.books[0]).toMatchObject({ dailySalesLow: expect.any(Number), dailySalesHigh: expect.any(Number) });
    expect(searchCompetition(lib.db, 'something never searched')).toBeNull();

    // a rebuild from the files gets the same answer
    lib.rebuild();
    expect(searchCompetition(lib.db, 'cozy fantasy')?.top).toBe(2);
  });

  it('refuses a page with no search words and flags one with no results', () => {
    expect(() => lib.ingest({ kind: 'search', url: 'https://www.amazon.com/s?i=digital-text', html: page(row('B000000001', 'x')) })).toThrow(/search words/);
    const out = lib.ingest({ kind: 'search', url: URL1, html: page('') });
    expect(out.issues.map((i) => i.field)).toContain('entries');
  });
});
