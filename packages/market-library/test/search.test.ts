import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, HashingEmbedder, chunkText, embedPending, embeddingStatus, ftsQuery, searchText } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const ASINS = ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW'];

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-s-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  for (const a of ASINS) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const count = (sql: string) => lib.db.scalar<number>(sql)!;

describe('chunkText', () => {
  it('merges short paragraphs and splits long ones on sentences', () => {
    expect(chunkText('One.\n\nTwo.\n\nThree.')).toEqual(['One. Two. Three.']);
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = chunkText(long, 300);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length <= 450)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long);
  });
  it('hard-splits an unbroken run', () => {
    const parts = chunkText('word '.repeat(1000), 300);
    expect(parts.every((p) => p.length <= 450)).toBe(true);
  });
  it('returns nothing for blank text', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
  });
});

describe('chunks from pages', () => {
  it('stores text blocks and chunks per kind for each book', () => {
    expect(count("SELECT count(DISTINCT asin) FROM chunk")).toBe(3);
    expect(count("SELECT count(*) FROM chunk WHERE kind = 'title'")).toBe(3);
    expect(count("SELECT count(*) FROM chunk WHERE kind = 'blurb'")).toBeGreaterThanOrEqual(3);
    expect(count('SELECT count(*) FROM text_block')).toBeGreaterThan(count("SELECT count(*) FROM chunk WHERE kind = 'title'"));
  });

  it('keeps unchanged chunks across a re-capture and survives a rebuild', () => {
    const ids = () => lib.db.prepare('SELECT id FROM chunk ORDER BY id').all().map((r) => (r as { id: number }).id);
    const before = ids();
    lib.ingest({ kind: 'detail', url: 'https://www.amazon.com/dp/B0C1R52V2J', html: read('detail-kindle-B0C1R52V2J.html.gz'), capturedAt: '2026-10-19T13:00:00Z' });
    expect(ids()).toEqual(before);
    lib.rebuild();
    expect(count('SELECT count(*) FROM chunk')).toBe(before.length);
  });
});

describe('keyword search', () => {
  it('finds text and cites the book and capture date', async () => {
    const hits = await searchText(lib.db, { query: 'Dungeon Crawler Carl' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ asin: 'B0C1R52V2J', matched: ['keyword'] });
    expect(hits[0]!.capturedAt).toBe('2026-10-18T13:00:00Z');
  });
  it('filters by kind, asin and category', async () => {
    const onlyBlurb = await searchText(lib.db, { query: 'crawlers', kinds: ['blurb'] });
    expect(onlyBlurb.every((h) => h.kind === 'blurb')).toBe(true);
    expect((await searchText(lib.db, { query: 'crawlers', asins: ['B0HKTD6M9Z'] })).every((h) => h.asin === 'B0HKTD6M9Z')).toBe(true);
    expect(await searchText(lib.db, { query: 'crawlers', categoryKey: 'amazon.com:kindle:nope' })).toEqual([]);
    expect((await searchText(lib.db, { query: 'crawlers', categoryKey: 'amazon.com:kindle:11650864011' })).length).toBeGreaterThan(0);
  });
  it('is safe against query syntax', async () => {
    for (const q of ['"; DROP TABLE chunk; --', 'a AND OR NOT (', '*', '', '   ']) await expect(searchText(lib.db, { query: q })).resolves.toBeInstanceOf(Array);
    expect(ftsQuery('Hello, "World"!')).toBe('"hello" OR "world"');
    expect(ftsQuery('!!')).toBeNull();
  });
  it('caps the limit', async () => {
    expect((await searchText(lib.db, { query: 'the and of', limit: 1000 })).length).toBeLessThanOrEqual(50);
  });
});

describe('vector search', () => {
  const emb = new HashingEmbedder();
  it('is available and embeds every chunk once', async () => {
    expect(lib.db.vecEnabled).toBe(true);
    const n = count('SELECT count(*) FROM chunk');
    expect(await embedPending(lib.db, emb)).toBe(n);
    expect(await embedPending(lib.db, emb)).toBe(0);
    expect(embeddingStatus(lib.db)).toMatchObject({ chunks: n, embedded: n, model: 'hashing-v1:256' });
  });
  it('fuses keyword and meaning hits', async () => {
    await embedPending(lib.db, emb);
    const hits = await searchText(lib.db, { query: 'Dungeon Crawler Carl', embedder: emb });
    expect(hits[0]!.asin).toBe('B0C1R52V2J');
    expect(hits[0]!.matched).toEqual(expect.arrayContaining(['keyword', 'meaning']));
  });
  it('falls back to keywords when vectors are for another model', async () => {
    await embedPending(lib.db, emb);
    const other = { name: 'other', dim: 8, embed: async (t: string[]) => t.map(() => new Float32Array(8)) };
    const hits = await searchText(lib.db, { query: 'crawlers', embedder: other });
    expect(hits.every((h) => h.matched.join() === 'keyword')).toBe(true);
  });
  it('re-embeds new chunks only, and a rebuild costs no model calls', async () => {
    let calls = 0;
    const counting = { name: emb.name, dim: emb.dim, embed: (t: string[]) => ((calls += t.length), emb.embed(t)) };
    await embedPending(lib.db, counting);
    const first = calls;
    lib.rebuild();
    await embedPending(lib.db, counting);
    expect(calls).toBe(first); // all vectors came from the cache
    expect(embeddingStatus(lib.db).embedded).toBe(count('SELECT count(*) FROM chunk'));
  });
  it('starts over when the model changes', async () => {
    await embedPending(lib.db, emb);
    await embedPending(lib.db, new HashingEmbedder(128));
    expect(embeddingStatus(lib.db)).toMatchObject({ model: 'hashing-v1:128' });
  });
});
