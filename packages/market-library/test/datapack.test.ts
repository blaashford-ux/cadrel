import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, exportPack, importPack, readPackManifest, listCategories, queue, addCommunitySource, reindexCommunity, saveTrends, recordKeywordSearch, listCommunitySources, listExclusions, getTrend, cachedLookup, listKeywordHistory, communityThreads, categoryKeywords, importTrendsCsv, removeKeywordHistory, removeTrend } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const LIST = 'amazon.com:kindle:11650864011';

let tmp: string;
let src: Library;
let dst: Library;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-pack-'));
  src = Library.open(path.join(tmp, 'src'));
  dst = Library.open(path.join(tmp, 'dst'));
  src.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  const detail = fs.readdirSync(FIX).find((f) => f.startsWith('detail-kindle-'))!;
  const asin = detail.replace('detail-kindle-', '').replace('.html.gz', '');
  src.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${asin}`, html: read(detail), capturedAt: '2026-10-18T13:00:00Z' });
  src.saveAsset(asin, 'cover', Buffer.from('fake-jpeg-bytes'), 'jpg');
  const row = (a: string) => `<div data-component-type="s-search-result" data-asin="${a}"><h2 aria-label="T"><span>T</span></h2></div>`;
  src.ingest({ kind: 'search', url: 'https://www.amazon.com/s?k=cozy+fantasy', html: `<html><body>${row('B0SEARCH01')}</body></html>`, capturedAt: '2026-10-19T12:00:00Z' });
});

/** A category with everything a user would have collected for it: a list, a search over its books, a subreddit, keyword research, a removed book. */
function fillCategory(lib: Library) {
  const asins = (lib.db.prepare('SELECT DISTINCT asin FROM list_entry ORDER BY rank LIMIT 6').all() as unknown as { asin: string }[]).map((r) => r.asin);
  const row = (a: string) => `<div data-component-type="s-search-result" data-asin="${a}"><h2 aria-label="T${a}"><span>T${a}</span></h2></div>`;
  lib.ingest({ kind: 'search', url: 'https://www.amazon.com/s?k=humorous+fantasy+books', html: `<html><body>${asins.slice(0, 4).map(row).join('')}${row('B0OTHER001')}${row('B0OTHER002')}${row('B0OTHER003')}${row('B0OTHER004')}</body></html>`, capturedAt: '2026-10-19T13:00:00Z' });
  addCommunitySource(lib.db, lib.root, LIST, 'fantasyhumor');
  const dir = path.join(lib.root, 'community', 'fantasyhumor');
  fs.mkdirSync(dir, { recursive: true });
  const post = { kind: 'post', id: 'p1', subreddit: 'fantasyhumor', linkId: 'p1', parentId: null, title: 'Looking for funny fantasy', body: 'Pratchett style please', score: 12, flair: null, createdUtc: 1760000000 };
  const comment = { kind: 'comment', id: 'c1', subreddit: 'fantasyhumor', linkId: 'p1', parentId: 'p1', title: null, body: 'Try Discworld', score: 5, flair: null, createdUtc: 1760000100 };
  fs.writeFileSync(path.join(dir, '20261019T000000Z-d01.jsonl'), [post, comment].map((x) => JSON.stringify(x)).join('\n') + '\n');
  reindexCommunity(lib.db, lib.root);
  // an unrelated subreddit that belongs to no category here
  fs.mkdirSync(path.join(lib.root, 'community', 'elsewhere'), { recursive: true });
  fs.writeFileSync(path.join(lib.root, 'community', 'elsewhere', '20261019T000000Z-d01.jsonl'), JSON.stringify({ ...post, id: 'z', linkId: 'z', subreddit: 'elsewhere' }) + '\n');

  recordKeywordSearch(lib.db, 'humorous fantasy books', { phrases: 2, sources: ['amazon'] }); // made before searches were filed under a category
  recordKeywordSearch(lib.db, 'sourdough starter', { phrases: 1, sources: ['amazon'] });
  recordKeywordSearch(lib.db, 'dad jokes in dungeons', { phrases: 1, sources: ['amazon'], categoryKey: LIST }); // filed under the category in the app
  recordKeywordSearch(lib.db, 'baking bread', { phrases: 1, sources: ['amazon'], categoryKey: 'amazon.com:kindle:other' }); // another category's
  const q = lib.db.prepare('INSERT INTO keyword_lookup (source, seed, fetched_at, requests, stopped) VALUES (?,?,?,?,NULL)');
  const sg = lib.db.prepare('INSERT INTO keyword_signal (source, seed, keyword, position, via) VALUES (?,?,?,?,?)');
  for (const seed of ['humorous fantasy books', 'sourdough starter', 'dad jokes in dungeons', 'baking bread']) {
    q.run('amazon', seed, '2026-10-19T00:00:00Z', 1);
    sg.run('amazon', seed, seed, 1, 'seed');
    sg.run('amazon', seed, `${seed} audiobook`, 2, 'a');
  }
  saveTrends(lib.db, [
    { keyword: 'humorous fantasy books', unit: 'week', geo: 'US', points: [{ date: '2026-01-01', value: 50 }] },
    { keyword: 'sourdough starter', unit: 'week', geo: 'US', points: [{ date: '2026-01-01', value: 70 }] },
  ]);
  lib.excludeFromCategory(asins[5]!, LIST);
  return asins;
}

afterEach(() => {
  src.close();
  dst.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const count = (lib: Library, table: string) => lib.db.scalar<number>(`SELECT count(*) FROM ${table}`);

describe('data packs', () => {
  it('exports the whole library and imports it into an empty one', async () => {
    const file = path.join(tmp, 'all.zip');
    const m = await exportPack(src, file);
    expect(m).toMatchObject({ scope: 'all', counts: { books: 1, lists: 1, searches: 1, covers: 1 } });
    expect(readPackManifest(file).id).toBe(m.id);

    const r = await importPack(dst, file);
    expect(r).toMatchObject({ added: { books: 1, lists: 1, searches: 1, covers: 1 }, alreadyHad: 0, skipped: 0 });
    for (const t of ['book', 'snapshot', 'list_capture', 'list_entry', 'search_capture', 'search_entry', 'asset']) expect(count(dst, t)).toBe(count(src, t));
    expect(listCategories(dst.db).map((c) => c.key)).toEqual(listCategories(src.db).map((c) => c.key));
    expect(queue(dst.db).length).toBe(queue(src.db).length);
  });

  it('importing again changes nothing', async () => {
    const file = path.join(tmp, 'all.zip');
    await exportPack(src, file);
    await importPack(dst, file);
    const before = count(dst, 'list_entry');
    const r = await importPack(dst, file);
    expect(r.added).toEqual({ books: 0, lists: 0, searches: 0, covers: 0 });
    expect(r.alreadyHad).toBeGreaterThan(0);
    expect(count(dst, 'list_entry')).toBe(before);
  });

  it('exports only the chosen categories, with their books but without searches', async () => {
    const file = path.join(tmp, 'one.zip');
    const m = await exportPack(src, file, { categoryKeys: [LIST] });
    expect(m).toMatchObject({ scope: 'categories', categories: [{ key: LIST }], counts: { lists: 1, searches: 0 } });
    expect(m.counts.books).toBeGreaterThan(0);
    await importPack(dst, file);
    expect(count(dst, 'search_capture')).toBe(0);
    expect(count(dst, 'list_capture')).toBe(1);
  });

  it('still imports a pack made by BookScout, before the rename to Cadrel Market', async () => {
    const file = path.join(tmp, 'all.zip');
    await exportPack(src, file);
    const files = unzipSync(fs.readFileSync(file));
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8'));
    files['manifest.json'] = Buffer.from(JSON.stringify({ ...manifest, format: 'bookscout-data-pack' }));
    const old = path.join(tmp, 'bookscout.zip');
    fs.writeFileSync(old, zipSync(files));
    expect(readPackManifest(old).format).toBe('cadrel-market-data-pack');
    expect(await importPack(dst, old)).toMatchObject({ added: { books: 1, lists: 1, searches: 1, covers: 1 }, skipped: 0 });
  });

  it('refuses an unknown or empty category choice, an existing file, and things that are not packs', async () => {
    await expect(exportPack(src, path.join(tmp, 'x.zip'), { categoryKeys: ['amazon.com:kindle:nope'] })).rejects.toThrow(/unknown category/);
    await expect(exportPack(src, path.join(tmp, 'x.zip'), { categoryKeys: [] })).rejects.toThrow(/at least one/);
    expect(fs.existsSync(path.join(tmp, 'x.zip'))).toBe(false);
    const file = path.join(tmp, 'all.zip');
    await exportPack(src, file);
    await expect(exportPack(src, file)).rejects.toThrow(/already exists/);
    fs.writeFileSync(path.join(tmp, 'junk.zip'), 'nope');
    expect(() => readPackManifest(path.join(tmp, 'junk.zip'))).toThrow(/not a Cadrel Market data pack/);
    fs.writeFileSync(path.join(tmp, 'other.zip'), zipSync({ 'manifest.json': Buffer.from('{"format":"something-else"}') }));
    await expect(importPack(dst, path.join(tmp, 'other.zip'))).rejects.toThrow(/not a Cadrel Market data pack/);
  });

  it('ignores entries with unexpected paths and damaged pages instead of writing them', async () => {
    const m = { format: 'cadrel-market-data-pack', version: 1, id: 'x', createdAt: '', scope: 'all', categories: [], counts: {} };
    const evil = zipSync({
      'manifest.json': Buffer.from(JSON.stringify(m)),
      '../evil/capture.json': Buffer.from('{}'),
      'books/B000000001/snapshots/20261018T120000Z/capture.json': Buffer.from('not json'),
      'books/B000000001/snapshots/20261018T120000Z/page.html.gz': Buffer.from('not gzip'),
      'other/file.txt': Buffer.from('x'),
    });
    fs.writeFileSync(path.join(tmp, 'evil.zip'), evil);
    const r = await importPack(dst, path.join(tmp, 'evil.zip'));
    expect(r.added).toEqual({ books: 0, lists: 0, searches: 0, covers: 0 });
    expect(r.skipped).toBe(3);
    expect(fs.existsSync(path.join(tmp, 'evil'))).toBe(false);
    expect(count(dst, 'snapshot')).toBe(0);
  });

  it('sets a user up with a whole category: its searches, subreddit text, keyword research and removed books, and nothing from elsewhere', async () => {
    const asins = fillCategory(src);
    const file = path.join(tmp, 'cat.zip');
    const m = await exportPack(src, file, { categoryKeys: [LIST] });
    expect(m.counts.searches).toBe(1); // the humorous-fantasy search, not the unrelated cozy one
    expect(m.extra).toMatchObject({ subreddits: ['fantasyhumor'], communityFiles: 1, keywordSeeds: 2, trends: 1, exclusions: 1 });

    const r = await importPack(dst, file);
    expect(r.extra).toMatchObject({ subreddits: 1, posts: 1, comments: 1, keywordSeeds: 2, trends: 1, exclusions: 1 });
    expect(r.skipped).toBe(0);

    expect(dst.db.scalar<string>('SELECT query FROM search_capture')).toBe('humorous fantasy books');
    expect(listCommunitySources(dst.db, LIST).map((c) => [c.subreddit, c.posts, c.comments])).toEqual([['fantasyhumor', 1, 1]]);
    expect(communityThreads(dst.db, LIST)[0]).toMatchObject({ title: 'Looking for funny fantasy', comments: 1 });
    expect(dst.db.scalar("SELECT count(*) FROM chunk WHERE kind IN ('community_post','community_comment')")).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dst.root, 'community', 'fantasyhumor', '20261019T000000Z-d01.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dst.root, 'community', 'elsewhere'))).toBe(false);
    expect(cachedLookup(dst.db, 'amazon', 'humorous fantasy books')?.suggestions.map((s) => s.keyword)).toEqual(['humorous fantasy books', 'humorous fantasy books audiobook']);
    expect(cachedLookup(dst.db, 'amazon', 'sourdough starter')).toBeNull();
    // the filed phrase, and the older one that belongs by its wording and its search; both arrive filed under the category
    expect(listKeywordHistory(dst.db, LIST).map((h) => h.seed).sort()).toEqual(['dad jokes in dungeons', 'humorous fantasy books']);
    expect(listKeywordHistory(dst.db).map((h) => h.seed).sort()).toEqual(['dad jokes in dungeons', 'humorous fantasy books']);
    expect(categoryKeywords(dst.db, LIST)).toEqual(['dad jokes in dungeons', 'humorous fantasy books']);
    expect(cachedLookup(dst.db, 'amazon', 'baking bread')).toBeNull();
    expect(getTrend(dst.db, 'humorous fantasy books')).not.toBeNull();
    expect(getTrend(dst.db, 'sourdough starter')).toBeNull();
    expect(listExclusions(dst.db, LIST).map((x) => x.asin)).toEqual([asins[5]]);
    expect(dst.db.scalar('SELECT 1 FROM list_entry WHERE asin = ?', asins[5])).toBeFalsy(); // the removed book stays out
    expect(fs.existsSync(path.join(dst.root, 'user', 'user-data.json'))).toBe(true);
  });

  it('the whole library includes every subreddit and all keyword research, and importing it twice adds nothing', async () => {
    fillCategory(src);
    const file = path.join(tmp, 'all2.zip');
    const m = await exportPack(src, file);
    expect(m.extra).toMatchObject({ subreddits: ['elsewhere', 'fantasyhumor'], keywordSeeds: 4, trends: 2 });
    expect(m.scope).toBe('all');
    await importPack(dst, file);
    expect(cachedLookup(dst.db, 'amazon', 'sourdough starter')).not.toBeNull();
    const again = await importPack(dst, file);
    expect(again.extra).toMatchObject({ posts: 0, comments: 0, trends: 0, exclusions: 0 });
    expect(dst.db.scalar('SELECT count(*) FROM community_item')).toBe(3);
  });

  it('keeps a newer local keyword answer over the pack\'s older one', async () => {
    fillCategory(src);
    const file = path.join(tmp, 'k.zip');
    await exportPack(src, file);
    dst.db.prepare('INSERT INTO keyword_lookup (source, seed, fetched_at, requests, stopped) VALUES (?,?,?,?,NULL)').run('amazon', 'humorous fantasy books', '2026-11-01T00:00:00Z', 9);
    dst.db.prepare('INSERT INTO keyword_signal (source, seed, keyword, position, via) VALUES (?,?,?,?,?)').run('amazon', 'humorous fantasy books', 'mine', 1, 'seed');
    await importPack(dst, file);
    expect(cachedLookup(dst.db, 'amazon', 'humorous fantasy books')!.suggestions.map((s) => s.keyword)).toEqual(['mine']);
  });

  it('files keyword searches and imported trends under a category, and forgets the link with the last record of the phrase', () => {
    recordKeywordSearch(src.db, 'cozy fantasy', { phrases: 3, sources: ['amazon'], categoryKey: LIST });
    recordKeywordSearch(src.db, 'cozy fantasy', { phrases: 4, sources: ['amazon'], categoryKey: 'amazon.com:kindle:other' });
    recordKeywordSearch(src.db, 'unfiled', { phrases: 1, sources: ['amazon'] });
    expect(listKeywordHistory(src.db).find((h) => h.seed === 'cozy fantasy')!.categories).toEqual([LIST, 'amazon.com:kindle:other']);
    expect(listKeywordHistory(src.db, LIST).map((h) => h.seed)).toEqual(['cozy fantasy']);
    expect(listKeywordHistory(src.db, 'amazon.com:kindle:nope')).toEqual([]);
    importTrendsCsv(src.db, 'Category: All categories\n\nWeek,litrpg: (United States)\n2026-01-04,50\n2026-01-11,60\n', undefined, LIST);
    expect(categoryKeywords(src.db, LIST)).toEqual(['cozy fantasy', 'litrpg']);
    removeKeywordHistory(src.db, 'cozy fantasy');
    expect(categoryKeywords(src.db, LIST)).toEqual(['litrpg']);
    removeTrend(src.db, 'litrpg');
    expect(categoryKeywords(src.db, LIST)).toEqual([]);
    expect(src.db.scalar('SELECT count(*) FROM keyword_category')).toBe(0);
  });
});
