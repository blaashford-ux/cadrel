import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, categoryBooks, cohortStats, resolveCategory, summarize } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-c-'));
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
