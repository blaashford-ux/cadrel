import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, categoryBooks, listBooks, listCategories, listExclusions, listedIn, queue, refreshDerived, asinsInCategory, searchText } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
const CAPTURED = ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ'];

let root: string;
let lib: Library;
const listPage = () => lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
const detail = (a: string) => lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
const asins = () => categoryBooks(lib.db, KEY).map((b) => b.asin);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-rm-'));
  lib = Library.open(root);
  listPage();
  for (const a of CAPTURED) detail(a);
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('excluding a book from a category', () => {
  it('removes it from the category, the queue and the counts, but keeps a captured book in the library', () => {
    const before = listCategories(lib.db)[0]!;
    const queued = queue(lib.db, { includeSkipped: true })[0]!; // a listed book with no page captured
    const captured = CAPTURED[0]!;
    expect(asins()).toContain(queued.asin);
    expect(asins()).toContain(captured);

    expect(lib.excludeFromCategory(queued.asin, KEY).entries).toBeGreaterThan(0);
    expect(lib.excludeFromCategory(captured, KEY).entries).toBeGreaterThan(0);
    expect(asins()).not.toContain(queued.asin);
    expect(asins()).not.toContain(captured);
    expect(queue(lib.db, { includeSkipped: true }).map((q) => q.asin)).not.toContain(queued.asin);
    const after = listCategories(lib.db)[0]!;
    expect(after.listedBooks).toBe(before.listedBooks - 2);
    expect(after.capturedBooks).toBe(before.capturedBooks - 1);
    expect(listBooks(lib.db, { categoryKey: KEY }).map((b) => b.asin)).not.toContain(captured);
    expect(listBooks(lib.db).map((b) => b.asin)).toContain(captured); // still in the library
    expect(listExclusions(lib.db, KEY).map((x) => x.asin).sort()).toEqual([queued.asin, captured].sort());
  });

  it('stays out after a new capture of the list and after a rebuild, and comes back when restored', () => {
    const asin = queue(lib.db)[0]!.asin;
    lib.excludeFromCategory(asin, KEY);
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-19T12:00:00Z' });
    expect(asins()).not.toContain(asin);
    lib.rebuild();
    expect(asins()).not.toContain(asin);
    expect(listExclusions(lib.db)).toHaveLength(1);
    expect(lib.restoreToCategory(asin, KEY).entries).toBeGreaterThan(0);
    expect(asins()).toContain(asin);
    expect(listExclusions(lib.db)).toHaveLength(0);
  });

  it('is remembered in the user-data file, so a lost database gets it back', () => {
    const asin = queue(lib.db)[0]!.asin;
    lib.excludeFromCategory(asin, KEY);
    lib.close();
    fs.rmSync(path.join(root, 'scout.db'), { force: true });
    fs.rmSync(path.join(root, 'scout.db-wal'), { force: true });
    fs.rmSync(path.join(root, 'scout.db-shm'), { force: true });
    lib = Library.open(root);
    expect(listExclusions(lib.db).map((x) => x.asin)).toEqual([asin]);
    lib.rebuild();
    expect(asins()).not.toContain(asin);
  });

  it('hides a captured book from category search even though its own page ranks it in the category', () => {
    const asin = CAPTURED[0]!;
    expect(asinsInCategory(lib.db, KEY).has(asin)).toBe(true);
    lib.excludeFromCategory(asin, KEY);
    expect(asinsInCategory(lib.db, KEY).has(asin)).toBe(false);
  });

  it('refuses a bad ASIN or an unknown category', () => {
    expect(() => lib.excludeFromCategory('nope', KEY)).toThrow(/bad ASIN/);
    expect(() => lib.excludeFromCategory(CAPTURED[0]!, 'amazon.com:kindle:1')).toThrow(/no category/);
  });
});

describe('removing a book from the library', () => {
  it('deletes its rows, index entries and files, and a rebuild does not bring it back', async () => {
    const asin = CAPTURED[0]!;
    lib.annotate(asin, 'tag', 'oops');
    lib.setQueue(asin, 'opened');
    expect(fs.existsSync(path.join(root, 'books', asin))).toBe(true);
    const chunksBefore = lib.db.scalar<number>('SELECT count(*) FROM chunk WHERE asin = ?', asin)!;
    expect(chunksBefore).toBeGreaterThan(0);

    const r = lib.removeBook(asin);
    expect(r).toMatchObject({ asin, snapshots: 1, chunks: chunksBefore, files: true });
    for (const t of ['book', 'snapshot', 'chunk', 'annotation', 'queue_item', 'asset']) expect(lib.db.scalar(`SELECT 1 FROM ${t} WHERE asin = ?`, asin)).toBeUndefined();
    expect(lib.db.scalar('SELECT 1 FROM text_block WHERE snapshot_id NOT IN (SELECT id FROM snapshot)')).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'books', asin))).toBe(false);
    expect(listBooks(lib.db).map((b) => b.asin)).not.toContain(asin);
    // still on the list, but as a book that is not captured
    expect(categoryBooks(lib.db, KEY).find((b) => b.asin === asin)).toMatchObject({ captured: false });
    expect(queue(lib.db).map((q) => q.asin)).toContain(asin);

    expect((await searchText(lib.db, { query: 'the', limit: 200 })).some((h) => h.asin === asin)).toBe(false);
    lib.rebuild();
    expect(listBooks(lib.db).map((b) => b.asin)).not.toContain(asin);
  });

  it('can also take the book out of every category it is listed in', () => {
    const asin = CAPTURED[1]!;
    expect(listedIn(lib.db, asin).map((c) => c.key)).toContain(KEY);
    const r = lib.removeBook(asin, { alsoExclude: true });
    expect(r.excludedFrom).toBeGreaterThanOrEqual(1);
    expect(asins()).not.toContain(asin);
    expect(queue(lib.db).map((q) => q.asin)).not.toContain(asin);
    expect(listExclusions(lib.db, KEY).map((x) => x.asin)).toContain(asin);
  });

  it('refuses a book that is not in the library', () => {
    expect(() => lib.removeBook('B000000000')).toThrow(/no captured book/);
    expect(() => lib.removeBook('bad')).toThrow(/bad ASIN/);
  });
});

describe('refreshDerived', () => {
  it('clears cover measurements and index entries whose source is gone, and nothing else', () => {
    lib.db.prepare("INSERT INTO cover_metrics (sha256, asin, metrics, analyzed_at) VALUES ('gone', 'B0AAAAAAAA', '{}', 'x')").run();
    lib.db.prepare("INSERT INTO chunk (asin, snapshot_id, kind, ordinal, text, text_hash, token_count) VALUES ('B0AAAAAAAA', 1, 'blurb', 0, 'x', 'h', 1)").run();
    const chunks = lib.db.scalar<number>('SELECT count(*) FROM chunk')!;
    expect(refreshDerived(lib.db)).toEqual({ coverMetrics: 1, chunks: 1 });
    expect(lib.db.scalar<number>('SELECT count(*) FROM chunk')).toBe(chunks - 1);
  });
});
