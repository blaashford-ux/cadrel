import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, categoryBooks, cohortStats, listCategories, resolveCategory, summarize } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-c-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('summarize', () => {
  it('computes quartiles and ignores unknowns', () => {
    expect(summarize([1, 2, 3, 4, null, undefined])).toEqual({ known: 4, min: 1, p25: 1.75, median: 2.5, p75: 3.25, max: 4, mean: 2.5 });
    expect(summarize([null])).toMatchObject({ known: 0, median: null });
  });
});

describe('resolveCategory', () => {
  it('finds by key, node id or name, and explains misses', () => {
    expect('category' in resolveCategory(lib.db, KEY)).toBe(true);
    expect('category' in resolveCategory(lib.db, '11650864011')).toBe(true);
    const byName = resolveCategory(lib.db, 'humorous');
    expect('category' in byName && byName.category.key).toBe(KEY);
    const miss = resolveCategory(lib.db, 'nope');
    expect('error' in miss && miss.error).toContain(KEY);
  });
});

describe('categoryBooks and cohortStats', () => {
  it('merges list rows with captured detail pages', () => {
    const books = categoryBooks(lib.db, KEY);
    expect(books.length).toBeGreaterThanOrEqual(30);
    expect(books[0]).toMatchObject({ asin: 'B0C1R52V2J', listRank: 1, captured: true });
    expect(books[0]!.pages).toBeGreaterThan(0);
    expect(books[2]).toMatchObject({ captured: false, pages: null });
    expect(books[2]!.price).not.toBeNull(); // from the list row
  });
  it('compares top N with the rest and reports coverage', () => {
    const s = cohortStats(categoryBooks(lib.db, KEY), 5);
    expect(s.top.books).toBe(5);
    expect(s.top.captured).toBe(2);
    expect(s.top.metrics.price!.known).toBe(5);
    expect(s.top.metrics.pages!.known).toBe(2); // only the captured ones have page counts
    expect(s.rest.books).toBeGreaterThan(20);
  });
});

describe('renaming a category', () => {
  const shown = () => listCategories(lib.db).find((c) => c.key === KEY)?.name;
  const relist = () => lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-19T12:00:00Z' });

  it('shows the new name, finds the category by it, and keeps it through a re-capture and a rebuild', () => {
    const amazon = shown();
    const r = lib.renameCategory(KEY, '  Cozy   Fantasy ');
    expect(r).toEqual({ name: 'Cozy Fantasy', previous: amazon });
    expect(shown()).toBe('Cozy Fantasy');
    expect(resolveCategory(lib.db, 'cozy fantasy')).toMatchObject({ category: { key: KEY } });
    relist();
    expect(shown()).toBe('Cozy Fantasy');
    lib.rebuild();
    expect(shown()).toBe('Cozy Fantasy');
  });

  it('goes back to Amazon\'s name with an empty name, and refuses an unknown category', () => {
    const amazon = shown();
    lib.renameCategory(KEY, 'Mine');
    expect(lib.renameCategory(KEY, '  ').name).toBe(amazon);
    expect(shown()).toBe(amazon);
    expect(() => lib.renameCategory('amazon.com:kindle:0', 'x')).toThrow(/no category/);
  });

  it('is restored from the user-data file when the database is lost', () => {
    lib.renameCategory(KEY, 'Cozy Fantasy');
    lib.close();
    for (const f of fs.readdirSync(root)) if (/\.db(-wal|-shm)?$/.test(f)) fs.rmSync(path.join(root, f));
    lib = Library.open(root);
    lib.rebuild();
    expect(shown()).toBe('Cozy Fantasy');
  });
});

describe('renaming a tag', () => {
  const tagsOf = (asin: string) => lib.db.prepare("SELECT value FROM annotation WHERE asin = ? AND kind = 'tag' ORDER BY value").all(asin).map((r: any) => r.value);
  it('renames it on every book, merges into an existing tag, and removes it with an empty name', () => {
    lib.annotate('B0C1R52V2J', 'tag', 'comp-titel');
    lib.annotate('B0HKTD6M9Z', 'tag', 'comp-titel');
    lib.annotate('B0HKTD6M9Z', 'tag', 'comp-title');
    expect(lib.renameTag('Comp-Titel', 'Comp-Title')).toBe(2);
    expect(tagsOf('B0C1R52V2J')).toEqual(['comp-title']);
    expect(tagsOf('B0HKTD6M9Z')).toEqual(['comp-title']); // already had it: merged, not duplicated
    expect(lib.renameTag('comp-title', '')).toBe(2);
    expect(tagsOf('B0C1R52V2J')).toEqual([]);
    expect(lib.renameTag('nothing', 'x')).toBe(0);
    expect(() => lib.renameTag(' ', 'x')).toThrow();
  });
  it('is mirrored to the user-data file', () => {
    lib.annotate('B0C1R52V2J', 'tag', 'a');
    lib.renameTag('a', 'b');
    const f = JSON.parse(fs.readFileSync(path.join(root, 'user', 'user-data.json'), 'utf8'));
    expect(f.annotations.map((x: any) => x.value)).toEqual(['b']);
  });
});
