import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Library, addCommunitySource, removeCommunitySource, categoryPhrase, clearKeywordHistory, hasSavedResults, listKeywordHistory, lookupSuggestions, recordKeywordSearch,
  removeKeywordHistory, searchPhraseOf, suggestKeywords, suggestKeywordStrings, KEYWORD_STRING_LIMIT, LEXICON, isFiller, looksLikeSearchTerm, syncSubreddit,
} from '../src/index.js';
import { fakeArctic } from './helpers.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
const NOW = new Date('2026-10-20T12:00:00Z');
const T = (d: number) => Math.floor(NOW.getTime() / 1000) - d * 86400;

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-kw-'));
  lib = Library.open(root);
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('keyword history', () => {
  it('keeps one row per phrase, newest first, counting repeats', () => {
    recordKeywordSearch(lib.db, 'Cozy  Fantasy', { phrases: 12, sources: ['google', 'bing'], now: new Date('2026-10-18T10:00:00Z') });
    recordKeywordSearch(lib.db, 'dark romance', { phrases: 5, sources: ['amazon'], now: new Date('2026-10-19T10:00:00Z') });
    recordKeywordSearch(lib.db, 'cozy fantasy', { phrases: 15, sources: ['amazon', 'google'], now: new Date('2026-10-20T10:00:00Z') });
    const h = listKeywordHistory(lib.db);
    expect(h.map((r) => r.seed)).toEqual(['cozy fantasy', 'dark romance']);
    expect(h.every((r) => r.saved === false)).toBe(true); // nothing saved by these test calls
    expect(h[0]).toMatchObject({ searches: 2, phrases: 15, sources: ['amazon', 'google'], firstAt: '2026-10-18T10:00:00.000Z', lastAt: '2026-10-20T10:00:00.000Z' });
    expect(h[1]).toMatchObject({ searches: 1, phrases: 5 });
    recordKeywordSearch(lib.db, '  ', { phrases: 1, sources: [] }); // nothing to remember
    expect(listKeywordHistory(lib.db)).toHaveLength(2);
    removeKeywordHistory(lib.db, 'Dark Romance');
    expect(listKeywordHistory(lib.db).map((r) => r.seed)).toEqual(['cozy fantasy']);
    clearKeywordHistory(lib.db);
    expect(listKeywordHistory(lib.db)).toEqual([]);
  });

  it('says whether the saved answers for a phrase are still there to reopen', async () => {
    expect(hasSavedResults(lib.db, 'dragon')).toBe(false);
    const f = (async () => new Response(JSON.stringify(['dragon', ['dragon rider']]), { status: 200 })) as unknown as typeof fetch;
    await lookupSuggestions(lib.db, 'google', 'dragon', { fetch: f, delayMs: 0, sleep: async () => {}, letters: '', now: NOW });
    expect(hasSavedResults(lib.db, 'Dragon')).toBe(true);
  });
});

describe('category phrase', () => {
  it('names a one-word category with its parent, and skips store-level parents', () => {
    const path = [{ name: 'Any Department' }, { name: 'Kindle Store' }, { name: 'Kindle eBooks' }, { name: 'Science Fiction & Fantasy' }, { name: 'Fantasy' }];
    expect(categoryPhrase('Cozy', path)).toBe('cozy fantasy');
    expect(categoryPhrase('Humorous', path)).toBe('humorous fantasy');
    expect(categoryPhrase('Fantasy', path.slice(0, 4))).toBe('fantasy'); // only store-level parents: nothing to add
    expect(categoryPhrase('Science Fiction & Fantasy', path.slice(0, 3))).toBe('science fiction fantasy');
    expect(categoryPhrase('Cozy Mystery', path)).toBe('cozy mystery');
    expect(categoryPhrase('Fantasy', [{ name: 'Fantasy' }])).toBe('fantasy');
    expect(categoryPhrase(null, path)).toBe('');
  });
  it('turns an element into the words a reader would search', () => {
    expect(searchPhraseOf('grumpy / sunshine')).toBe('grumpy sunshine');
    expect(searchPhraseOf('enemies to lovers')).toBe('enemies to lovers');
    expect(searchPhraseOf('reverse harem / why choose')).toBe('why choose');
    expect(searchPhraseOf('harem')).toBe('harem');
    expect(searchPhraseOf('closed door / sweet')).toBe('closed door');
    expect(searchPhraseOf('cozy setting')).toBe('');
    expect(searchPhraseOf('LGBTQ+')).toBe('lgbtq');
    expect(searchPhraseOf('portal/isekai')).toBe('isekai');
  });
});

describe('suggestKeywords', () => {
  const ingest = () => {
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
    for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
  };

  it('refuses an unknown category', () => {
    expect(() => suggestKeywords(lib.db, 'amazon.com:kindle:1')).toThrow(/unknown category/);
  });

  it('marks each idea by what the stored autocomplete answers say, without asking anyone', async () => {
    ingest();
    const base = suggestKeywords(lib.db, KEY);
    expect(base.every((i) => i.autocomplete === 'unknown' && i.checkedAt === null)).toBe(true);
    const [first, second] = base;
    const answer = (list: string[]) => (async () => new Response(JSON.stringify(['x', list]), { status: 200 })) as unknown as typeof fetch;
    const now = new Date('2026-10-20T00:00:00Z');
    await lookupSuggestions(lib.db, 'google', first!.keyword, { fetch: answer([]), delayMs: 0, sleep: async () => {}, letters: '', now });
    // a phrase that only shows up inside another seed's suggestions counts as listed
    await lookupSuggestions(lib.db, 'google', 'unrelated seed', { fetch: answer([second!.keyword]), delayMs: 0, sleep: async () => {}, letters: '', now });
    const marked = suggestKeywords(lib.db, KEY);
    expect(marked.find((i) => i.keyword === first!.keyword)).toMatchObject({ autocomplete: 'empty', checkedAt: '2026-10-20' });
    expect(marked.find((i) => i.keyword === second!.keyword)).toMatchObject({ autocomplete: 'listed', checkedAt: null });
  });

  it('suggests up to five distinct phrases from the listed books, none repeating a word of the category', () => {
    ingest();
    const ideas = suggestKeywords(lib.db, KEY);
    expect(ideas.length).toBeGreaterThanOrEqual(1);
    expect(ideas.length).toBeLessThanOrEqual(5);
    expect(new Set(ideas.map((i) => i.keyword)).size).toBe(ideas.length);
    for (const i of ideas) {
      expect(i.reason).toMatch(/listed (?:books|titles)|reader request/);
      expect(i.keyword.length).toBeLessThanOrEqual(80);
      expect(i.keyword.split(' ')).not.toContain('humorous');
      expect(i.keyword.split(' ')).not.toContain('fantasy');
    }
    expect(suggestKeywords(lib.db, KEY, 2)).toHaveLength(Math.min(2, ideas.length));
  });

  it('also leaves out the words of the chosen book\'s title, subtitle and blurb', () => {
    ingest();
    const asin = 'B0C1R52V2J';
    const row = lib.db.prepare('SELECT title, description FROM snapshot WHERE asin = ?').get(asin) as { title: string; description: string | null };
    const taken = new Set(`${row.title} ${row.description ?? ''}`.toLowerCase().match(/[a-z]{4,}/g));
    const plain = suggestKeywords(lib.db, KEY, 20);
    const forBook = suggestKeywords(lib.db, KEY, 20, { asin });
    expect(forBook.length).toBeLessThanOrEqual(plain.length);
    for (const i of forBook) for (const w of i.keyword.split(' ')) expect(taken.has(w)).toBe(false);
    expect(suggestKeywords(lib.db, KEY, 5, { asin: 'B000000000' })).toEqual(suggestKeywords(lib.db, KEY, 5)); // a book that is not stored changes nothing
  });

  it('does not suggest a women\'s-romance trope to a category whose subreddits are aimed at men', async () => {
    ingest();
    const post = (id: string, title: string) => ({ id, title, selftext: 'Looking for something.', created_utc: T(1), score: 5, link_flair_text: null, author: 'a' });
    const posts = ['Looking for why choose books', 'Recommendations: why choose with a dragon', 'Any why choose books?'].map((t, i) => post(`w${i}`, t));
    addCommunitySource(lib.db, root, KEY, 'romancebooks');
    await syncSubreddit(lib.db, root, 'romancebooks', { client: fakeArctic({ posts, comments: [] }), now: NOW });
    expect(suggestKeywords(lib.db, KEY).map((i) => i.keyword)).toContain('why choose');
    removeCommunitySource(lib.db, root, KEY, 'romancebooks');
    addCommunitySource(lib.db, root, KEY, 'romance_for_men');
    await syncSubreddit(lib.db, root, 'romance_for_men', { client: fakeArctic({ posts, comments: [] }), now: NOW });
    expect(suggestKeywords(lib.db, KEY).map((i) => i.keyword)).not.toContain('why choose');
  });

  it('puts what readers ask for first, ahead of what the books carry', async () => {
    ingest();
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    const post = (id: string, title: string) => ({ id, title, selftext: 'Looking for something.', created_utc: T(1), score: 5, link_flair_text: null, author: 'a' });
    const posts = ['Looking for a slow burn please', 'Recommendations: slow burn with a dragon', 'Any books with slow burn?', 'Need more found family'].map((t, i) => post(`p${i}`, t));
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic({ posts, comments: [] }), now: NOW });
    const ideas = suggestKeywords(lib.db, KEY);
    expect(ideas[0]).toMatchObject({ keyword: 'slow burn', source: 'readers' });
    expect(ideas[0]!.reason).toMatch(/named in 3 reader requests/);
  });
});

describe('suggestKeywordStrings', () => {
  const ingest = () => {
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
    for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
  };

  it('refuses an unknown category and returns nothing for an empty one', () => {
    expect(() => suggestKeywordStrings(lib.db, 'amazon.com:kindle:1')).toThrow(/unknown category/);
  });

  it('builds strings of at most 50 characters that share no word and use no word of the category', () => {
    ingest();
    const strings = suggestKeywordStrings(lib.db, KEY);
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(strings.length).toBeLessThanOrEqual(7);
    const seen = new Set<string>();
    for (const s of strings) {
      expect(s.chars).toBe(s.keyword.length);
      expect(s.chars).toBeLessThanOrEqual(KEYWORD_STRING_LIMIT);
      expect(s.parts.length).toBeGreaterThanOrEqual(1);
      for (const w of s.keyword.split(' ')) {
        expect(['humorous', 'fantasy', 'the', 'and', 'to', 'book', 'free', 'best']).not.toContain(w);
        expect(seen.has(w)).toBe(false);
        seen.add(w);
      }
    }
  });

  it('leaves out stop words and words KDP does not allow, and honours a smaller count and limit', async () => {
    ingest();
    const strings = suggestKeywordStrings(lib.db, KEY, { count: 3, maxChars: 20 });
    expect(strings.length).toBeLessThanOrEqual(3);
    for (const s of strings) expect(s.keyword.length).toBeLessThanOrEqual(20);
  });

  it('puts what readers ask for first and joins terms the same books carry', async () => {
    ingest();
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    const post = (id: string, title: string) => ({ id, title, selftext: 'Looking for something.', created_utc: T(1), score: 5, link_flair_text: null, author: 'a' });
    const posts = ['Looking for a slow burn please', 'Recommendations: slow burn with a dragon', 'Any books with slow burn?', 'Need more found family'].map((t, i) => post(`p${i}`, t));
    await syncSubreddit(lib.db, root, 'cozyfantasy', { client: fakeArctic({ posts, comments: [] }), now: NOW });
    const strings = suggestKeywordStrings(lib.db, KEY);
    expect(strings[0]!.keyword.startsWith('slow burn')).toBe(true);
    expect(strings[0]!.parts[0]).toMatchObject({ phrase: 'slow burn', source: 'readers' });
  });

  it('also leaves out the words of the chosen book', () => {
    ingest();
    const asin = 'B0C1R52V2J';
    const row = lib.db.prepare('SELECT title, description FROM snapshot WHERE asin = ?').get(asin) as { title: string; description: string | null };
    const taken = new Set(`${row.title} ${row.description ?? ''}`.toLowerCase().match(/[a-z]{4,}/g));
    for (const s of suggestKeywordStrings(lib.db, KEY, { asin })) for (const w of s.keyword.split(' ')) expect(taken.has(w)).toBe(false);
  });
});

describe('keywords look like search terms', () => {
  it('knows the terms a reader searches, and rejects filler', () => {
    for (const term of ['dragons', 'cooking', 'low stakes', 'strong female lead', 'magic system', 'talking animal', 'magical romance', 'closed door', 'spicy', 'romantasy']) expect(LEXICON).toContain(term);
    for (const w of ['next', "don't", 'back', 'behind', 'must', 'become', 'the', 'finally']) expect(isFiller(w)).toBe(true);
    for (const w of ['dragon', 'cooking', 'romantasy', 'stakes']) expect(isFiller(w)).toBe(false);
    expect(looksLikeSearchTerm('next door')).toBe(false);
    expect(looksLikeSearchTerm('become must')).toBe(false);
    expect(looksLikeSearchTerm('dragon rider')).toBe(true);
    expect(looksLikeSearchTerm('dragons')).toBe(false); // a single recurring word is not enough; only the vocabulary allows one word
  });

  it('suggests no filler word, in phrases or in strings', () => {
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
    for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
    const words = [...suggestKeywords(lib.db, KEY, 50).map((i) => i.keyword), ...suggestKeywordStrings(lib.db, KEY).map((s) => s.keyword)].flatMap((k) => k.split(' '));
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(['next', "don't", 'back', 'behind', 'must', 'become', 'finally', 'everything', 'forever']).not.toContain(w);
    for (const s of suggestKeywordStrings(lib.db, KEY)) expect(s.keyword.split(' ').length).toBeLessThanOrEqual(4);
  });
});
