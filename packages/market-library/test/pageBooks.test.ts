import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Library, getBook, getPageBook, listBooks } from '../src/index.js';

const html = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'fixtures', 'amazon-com', 'author-allbooks-B0CMJC56GQ.html.gz'))).toString('utf8');
let root: string; let lib: Library;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-pb-')); lib = Library.open(root); });
afterEach(() => { lib.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('lists the books of an author page in the library, marked page-only, and searches them', () => {
  lib.ingest({ kind: 'author', url: 'https://www.amazon.com/stores/author/B0CMJC56GQ/allbooks', html });
  const all = listBooks(lib.db);
  expect(all).toHaveLength(45);
  expect(all.every((b) => b.pageOnly && b.snapshots === 0)).toBe(true);
  expect(all.find((b) => b.asin === 'B0G1QRXWZ6')).toMatchObject({ title: 'Dragon Bound: A Legacy Building Fantasy', authorNames: ['Leon West', 'Freya Stone'], ratingCount: 546, kindlePrice: 5.66 });
  expect(listBooks(lib.db, { search: 'goblin king' }).map((b) => b.asin).sort()).toEqual(['B0CMGZMS9F', 'B0CMPLCPMF', 'B0CRQ1JG55', 'B0D7KJXFXN', 'B0DW4LPYPY']);
  expect(listBooks(lib.db, { search: 'B0FFJ2NZCG' })).toHaveLength(1);
  expect(listBooks(lib.db, { categoryKey: 'amazon.com:kindle:1' })).toEqual([]); // a category shows only its listed books
});

it('gives a page-only book a detail, until the book itself is captured', () => {
  lib.ingest({ kind: 'author', url: 'https://www.amazon.com/stores/author/B0CMJC56GQ/allbooks', html });
  expect(getBook(lib.db, 'B0GRWLF2H1')).toBeNull();
  const d = getPageBook(lib.db, 'B0GRWLF2H1')!;
  expect(d).toMatchObject({ pageOnly: true, authorNames: ['Leon West'], ranks: [], history: [] });
  expect(d.latest).toMatchObject({ title: 'Rise of the Class Smith: A Dungeon Building LitRPG Adventure', series_name: 'Rise of the Class Smith', series_position: 1, series_total: 3, rating_count: 1259 });
  expect(d.formats.map((f) => f.label)).toEqual(['Audiobook', 'Paperback']);
  lib.db.prepare("INSERT INTO book (asin, marketplace, title, first_seen, last_seen) VALUES ('B0GRWLF2H1','amazon.com','x','t','t')").run();
  lib.db.prepare("INSERT INTO snapshot (asin, captured_at, dir) VALUES ('B0GRWLF2H1','t','d')").run();
  expect(getPageBook(lib.db, 'B0GRWLF2H1')).toBeNull();
  expect(listBooks(lib.db).filter((b) => b.pageOnly)).toHaveLength(44);
});
