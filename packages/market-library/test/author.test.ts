import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, authorCorpus, detectKind, importSavedPage, listAuthors, queue, savedPageUrl, verifyLibrary } from '../src/index.js';

// The scrubbed real "All Books" page for Leon West, saved from a browser after scrolling to the bottom.
const FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'amazon-com', 'author-allbooks-B0CMJC56GQ.html.gz');
const html = () => zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8');
const URL = 'https://www.amazon.com/stores/author/B0CMJC56GQ/allbooks';

let root: string;
let lib: Library;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-author-')); lib = Library.open(root); });
afterEach(() => { lib.close(); fs.rmSync(root, { recursive: true, force: true }); });
const count = (t: string) => lib.db.scalar<number>(`SELECT count(*) FROM ${t}`)!;

describe('author pages', () => {
  it('are recognised by address', () => {
    expect(detectKind(URL)).toBe('author');
    expect(detectKind('https://www.amazon.com/stores/Leon-West/author/B0CMJC56GQ/allbooks?ref_=x')).toBe('author');
    expect(detectKind('https://www.amazon.com/stores/author/B0CMJC56GQ')).toBeNull();
  });

  it('are stored with their files and every book indexed', () => {
    const r = lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-16T04:00:00.000Z' });
    expect(r).toMatchObject({ kind: 'author', authorId: 'B0CMJC56GQ', books: 45, dir: 'authors/amazon.com/B0CMJC56GQ/20261116T040000Z' });
    for (const f of ['page.html.gz', 'capture.json', 'parsed.json']) expect(fs.existsSync(path.join(root, r.dir, f))).toBe(true);
    expect(count('author_capture')).toBe(1);
    expect(count('author_entry')).toBe(45);
    expect(listAuthors(lib.db)).toEqual([expect.objectContaining({ authorId: 'B0CMJC56GQ', name: 'Leon West', books: 45, totalCount: 45, capturedBooks: 0, captures: 1 })]);
  });

  it('are idempotent for the same capture and keep each capture as history', () => {
    lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-16T04:00:00.000Z' });
    expect(lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-16T04:00:00.000Z' }).replaced).toBe(true);
    expect(count('author_capture')).toBe(1);
    lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-17T04:00:00.000Z' });
    expect(count('author_capture')).toBe(2);
    expect(listAuthors(lib.db)[0]).toMatchObject({ captures: 2, lastCapture: '2026-11-17T04:00:00.000Z' });
  });

  it('give a corpus grouped into series and standalone books', () => {
    lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-16T04:00:00.000Z' });
    const c = authorCorpus(lib.db, 'B0CMJC56GQ')!;
    expect(c).toMatchObject({ name: 'Leon West', totalCount: 45 });
    const names = c.series.map((s) => s.name).sort();
    expect(names).toEqual(expect.arrayContaining(['Rise of the Class Smith', 'Dragon Bound', 'Dungeon Champions', 'Slime Keeper', 'Accidental Goblin King', 'Idle Village Hero', 'Isle of the Amazonian Elves', 'Martial Arts Master', 'Blue-Collar King']));
    const gob = c.series.find((s) => s.name === 'Accidental Goblin King')!;
    expect(gob).toMatchObject({ total: 4, asin: 'B0CMPFS9XJ', url: 'https://www.amazon.com/dp/B0CMPFS9XJ' });
    expect(gob.books.map((b) => [b.seriesPosition, b.collects])).toEqual([[1, false], [2, false], [3, false], [4, false], [null, true]]);
    const dragon = c.series.find((s) => s.name === 'Dragon Bound')!;
    expect(dragon.books.map((b) => b.authorNames)).toEqual(Array(4).fill(['Leon West', 'Freya Stone']));
    expect(c.standalone.map((b) => b.asin)).toContain('B0FFJ2NZCG');
    expect(c.series.flatMap((s) => s.books).length + c.standalone.length).toBe(45);
  });

  it('queue their books for a detail capture, and drop out of the queue once captured', () => {
    lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-16T04:00:00.000Z' });
    const q = queue(lib.db);
    expect(q).toHaveLength(45);
    expect(q[0]).toMatchObject({ asin: 'B0HMX77Z4X', categoryKey: 'uncategorised', author: 'Leon West', state: 'pending' });
    lib.db.prepare("INSERT INTO book (asin, marketplace, title, first_seen, last_seen) VALUES ('B0HMX77Z4X','amazon.com','x','t','t')").run();
    lib.db.prepare("INSERT INTO snapshot (asin, captured_at, dir) VALUES ('B0HMX77Z4X','t','d')").run();
    expect(queue(lib.db)).toHaveLength(44);
    expect(listAuthors(lib.db)[0]!.capturedBooks).toBe(1);
  });

  it('survive a rebuild from the files and pass the library check', () => {
    lib.ingest({ kind: 'author', url: URL, html: html(), capturedAt: '2026-11-16T04:00:00.000Z' });
    expect(lib.rebuild()).toMatchObject({ author: 1 });
    expect(count('author_entry')).toBe(45);
    const v = verifyLibrary(lib.db, root);
    expect(v.notIndexed).toEqual([]);
    expect(v.missingFiles).toEqual([]);
  });

  it('are refused when the grid is empty, leaving no files behind', () => {
    expect(() => lib.ingest({ kind: 'author', url: URL, html: '<html><head><link rel="canonical" href="' + URL + '"></head></html>' })).toThrow(/scroll/);
    expect(fs.existsSync(path.join(root, 'authors'))).toBe(false);
  });
});

describe('importSavedPage', () => {
  it('imports a saved file, finding the address in the page and dating it from the file', () => {
    const f = path.join(root, 'saved.html');
    fs.writeFileSync(f, html());
    expect(savedPageUrl(html())).toMatch(/^https:\/\/www\.amazon\.com\/stores\/Leon-West\/author\/B0CMJC56GQ\/allbooks/);
    expect(detectKind(savedPageUrl(html())!)).toBe('author');
    const r = importSavedPage(lib, f, { capturedAt: '2026-11-16T04:00:00.000Z' });
    expect(r).toMatchObject({ kind: 'author', books: 45, file: f, url: 'https://www.amazon.com/stores/Leon-West/author/B0CMJC56GQ/allbooks' });
  });
  it('reads a .gz and refuses a page it cannot place', () => {
    const f = path.join(root, 'saved.html.gz');
    fs.writeFileSync(f, fs.readFileSync(FIXTURE));
    expect(importSavedPage(lib, f).kind).toBe('author');
    const g = path.join(root, 'other.html');
    fs.writeFileSync(g, '<html><head><link rel="canonical" href="https://www.amazon.com/gp/help/x"></head></html>');
    expect(() => importSavedPage(lib, g)).toThrow(/not a book, list/);
    fs.writeFileSync(g, '<html></html>');
    expect(() => importSavedPage(lib, g)).toThrow(/pass its address/);
  });
});
