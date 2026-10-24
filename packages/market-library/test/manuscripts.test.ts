import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HashingEmbedder, Library, categoryReport, categoryCsv, contentMetricsOf, contentStats, embedPending, excerpt, getManuscripts, listBooks, readManuscriptText,
  readSampleOcr, readSamplePage, reportMarkdown, saveSampleOcr, saveSamplePage, sampleSessions, searchText,
} from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
const ASIN = 'B0C1R52V2J';

const BOOK = `Chapter One

"Not again," said the dragon. "It is Tuesday."

The baker, Mrs. Pell, sighed. She had never liked Tuesdays, and the dragon knew it. ${'The oven glowed and the bread rose slowly. '.repeat(40)}

Chapter Two

"Where is the flour?" asked Mrs. Pell. Nobody knew. ${'The village of Underhill waited for the flour to arrive. '.repeat(40)}`;

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-m-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${ASIN}`, html: read(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const chapters = () => {
  const i = BOOK.indexOf('Chapter Two');
  return [{ title: 'Chapter One', start: 0, end: i }, { title: 'Chapter Two', start: i, end: BOOK.length }];
};
const upload = (text = BOOK) => lib.attachText(ASIN, { source: 'upload', kind: 'txt', label: 'book.txt', text, chapters: text === BOOK ? chapters() : [], original: { name: 'book.txt', data: Buffer.from(text) } });
const count = (sql: string, ...a: any[]) => lib.db.scalar<number>(sql, ...a)!;

describe('attachText', () => {
  it('stores files, a row with metrics, and chunks by chapter', () => {
    const m = upload();
    expect(m).toMatchObject({ asin: ASIN, source: 'upload', kind: 'txt', chapters: 2, complete: true });
    expect(m.words).toBeGreaterThan(500);
    for (const f of ['extracted/upload.txt', 'extracted/upload.json', 'manuscript/book.txt']) expect(fs.existsSync(path.join(root, 'books', ASIN, f))).toBe(true);
    expect(readManuscriptText(root, ASIN, 'upload')).toBe(BOOK);
    const c = contentMetricsOf(lib.db, ASIN)!;
    expect(c.source).toBe('upload');
    expect(c.metrics.chapters.count).toBe(2);
    expect(c.metrics.dialogueShare).toBeGreaterThan(0);
    expect(count("SELECT count(*) FROM chunk WHERE asin = ? AND kind = 'manuscript'", ASIN)).toBeGreaterThanOrEqual(4);
    // no chunk crosses a chapter boundary
    const bad = lib.db.prepare("SELECT text FROM chunk WHERE asin = ? AND kind = 'manuscript'").all(ASIN) as unknown as { text: string }[];
    expect(bad.some((c) => c.text.includes('Chapter Two') && c.text.includes('baked'))).toBe(false);
  });

  it('replaces the previous upload and leaves page chunks alone', () => {
    const pageChunks = count("SELECT count(*) FROM chunk WHERE asin = ? AND kind NOT IN ('manuscript','sample_text')", ASIN);
    upload();
    lib.attachText(ASIN, { source: 'upload', kind: 'txt', label: 'v2.txt', text: 'Short replacement manuscript text that is long enough to count.', chapters: [] });
    expect(getManuscripts(lib.db, ASIN)).toHaveLength(1);
    expect(count("SELECT count(*) FROM chunk WHERE asin = ? AND kind = 'manuscript'", ASIN)).toBe(1);
    expect(count("SELECT count(*) FROM chunk WHERE asin = ? AND kind NOT IN ('manuscript','sample_text')", ASIN)).toBe(pageChunks);
    // a new page capture re-chunks page text without touching the manuscript
    lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${ASIN}`, html: read(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-19T13:00:00Z' });
    expect(count("SELECT count(*) FROM chunk WHERE asin = ? AND kind = 'manuscript'", ASIN)).toBe(1);
  });

  it('keeps an upload and a sample side by side, preferring the upload', () => {
    lib.attachText(ASIN, { source: 'sample', kind: 'ocr', label: '20261019T100000Z', text: 'Sample text from the first pages of the book, long enough.', chapters: [], quality: 91, complete: false });
    expect(contentMetricsOf(lib.db, ASIN)!.source).toBe('sample');
    expect(listBooks(lib.db).find((b) => b.asin === ASIN)!.text).toBe('sample');
    upload();
    expect(contentMetricsOf(lib.db, ASIN)!.source).toBe('upload');
    expect(listBooks(lib.db).find((b) => b.asin === ASIN)!.text).toBe('manuscript');
    expect(getManuscripts(lib.db, ASIN).map((m) => m.source)).toEqual(['sample', 'upload']);
    expect(getManuscripts(lib.db, ASIN)[0]).toMatchObject({ complete: false, quality: 91 });
  });

  it('refuses unknown books, empty text and bad input', () => {
    expect(() => lib.attachText('B000000000', { source: 'upload', kind: 'txt', label: 'x', text: BOOK, chapters: [] })).toThrow(/capture the book's page first/);
    expect(() => lib.attachText(ASIN, { source: 'upload', kind: 'txt', label: 'x', text: '  ', chapters: [] })).toThrow(/no readable text/);
    expect(() => lib.attachText('../etc', { source: 'upload', kind: 'txt', label: 'x', text: BOOK, chapters: [] })).toThrow(/bad ASIN/);
  });

  it('neutralises the original file name', () => {
    lib.attachText(ASIN, { source: 'upload', kind: 'txt', label: 'x', text: BOOK, chapters: [], original: { name: '../../evil.txt', data: Buffer.from('x') } });
    expect(fs.readdirSync(path.join(root, 'books', ASIN, 'manuscript'))).toEqual(['.._.._evil.txt']);
  });

  it('can be removed', () => {
    upload();
    expect(lib.detachText(ASIN, 'upload')).toBe(true);
    expect(getManuscripts(lib.db, ASIN)).toEqual([]);
    expect(count("SELECT count(*) FROM chunk WHERE kind = 'manuscript'")).toBe(0);
    expect(readManuscriptText(root, ASIN, 'upload')).toBeNull();
  });
});

describe('search and excerpts', () => {
  it('finds manuscript text and cites the book, with keyword and meaning search', async () => {
    upload();
    const emb = new HashingEmbedder();
    await embedPending(lib.db, emb);
    const hits = await searchText(lib.db, { query: 'village of Underhill waited for the flour', kinds: ['manuscript'], embedder: emb });
    expect(hits[0]).toMatchObject({ asin: ASIN, kind: 'manuscript' });
    expect(hits[0]!.matched).toEqual(expect.arrayContaining(['keyword', 'meaning']));
    expect(hits[0]!.title).toBeTruthy();
    expect(hits[0]!.capturedAt).toMatch(/^\d{4}-/);
  });

  it('returns excerpts by chapter with paging', () => {
    upload();
    const e = excerpt(root, lib.db, ASIN, { chapter: 1, chars: 200 });
    if (!e || 'error' in e) throw new Error('expected an excerpt');
    expect(e.text.startsWith('Chapter Two')).toBe(true);
    expect(e.more).toBe(true);
    expect(e.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    const next = excerpt(root, lib.db, ASIN, { chapter: 1, chars: 200, offset: 200 });
    if (!next || 'error' in next) throw new Error('expected an excerpt');
    expect(next.from).toBe(e.to);
    expect(excerpt(root, lib.db, ASIN, { chapter: 9 })).toMatchObject({ error: expect.stringContaining('not found') });
    expect(excerpt(root, lib.db, 'B000000000')).toBeNull();
  });
});

describe('rebuild', () => {
  it('restores manuscripts and their chunks from the files', async () => {
    upload();
    const before = count("SELECT count(*) FROM chunk WHERE kind = 'manuscript'");
    lib.rebuild();
    expect(getManuscripts(lib.db, ASIN)).toHaveLength(1);
    expect(count("SELECT count(*) FROM chunk WHERE kind = 'manuscript'")).toBe(before);
    expect(contentMetricsOf(lib.db, ASIN)!.metrics.chapters.count).toBe(2);
  });
});

describe('sample pages', () => {
  const S = '20261019T100000Z';
  it('stores screenshots in order, skips duplicates, and records OCR', () => {
    const a = saveSamplePage(root, ASIN, S, Buffer.from('image-a'), 'png', { crop: { left: 10, top: 20, width: 300, height: 400 } });
    const b = saveSamplePage(root, ASIN, S, Buffer.from('image-b'), 'png');
    const dup = saveSamplePage(root, ASIN, S, Buffer.from('image-a'), 'png');
    expect([a.index, b.index, dup.index, dup.duplicate]).toEqual([1, 2, 1, true]);
    expect(fs.existsSync(path.join(root, 'books', ASIN, 'lookinside', S, 'page-002.png'))).toBe(true);
    saveSampleOcr(root, ASIN, S, 1, 'First page text.', 93);
    const sess = sampleSessions(root, ASIN);
    expect(sess).toHaveLength(1);
    expect(sess[0]!.pages[0]).toMatchObject({ index: 1, crop: { left: 10, top: 20, width: 300, height: 400 }, ocr: { confidence: 93, chars: 16 } });
    expect(readSampleOcr(root, ASIN, S, 1)).toBe('First page text.');
    expect(readSampleOcr(root, ASIN, S, 2)).toBeNull();
    expect(readSamplePage(root, ASIN, S, sess[0]!.pages[1]!).toString()).toBe('image-b');
  });
  it('rejects bad ids', () => {
    expect(() => saveSamplePage(root, '../x', S, Buffer.from('a'), 'png')).toThrow(/bad ASIN/);
    expect(() => saveSamplePage(root, ASIN, '../../x', Buffer.from('a'), 'png')).toThrow(/bad session/);
  });
});

describe('content in reports', () => {
  it('compares books with text and says what the sample can and cannot show', () => {
    upload();
    const s = contentStats(lib.db, KEY, 5);
    expect(s.top).toMatchObject({ known: 1, fullManuscripts: 1 });
    expect(s.rest.known).toBe(0);
    expect(s.top.metrics.dialogue_share!.median).toBeGreaterThan(0);
    expect(s.caveats).toEqual([]);
    lib.detachText(ASIN, 'upload');
    lib.attachText(ASIN, { source: 'sample', kind: 'ocr', label: S2, text: BOOK.slice(0, 700), chapters: [], complete: false });
    expect(contentStats(lib.db, KEY, 5).caveats.join(' ')).toMatch(/only the free sample/);
    expect(contentStats(lib.db, KEY, 5).top.fullManuscripts).toBe(0);
  });
  it('adds an "Inside the books" section and CSV columns', () => {
    expect(reportMarkdown(categoryReport(lib.db, KEY, 5))).not.toContain('## Inside the books');
    upload();
    const md = reportMarkdown(categoryReport(lib.db, KEY, 5));
    expect(md).toContain('## Inside the books');
    expect(md).toContain('Dialogue share of words');
    const csv = categoryCsv(lib.db, KEY).split('\r\n');
    const head = csv[0]!.split(',');
    const row = csv[1]!.split(',');
    expect(row[head.indexOf('text_source')]).toBe('upload');
    expect(Number(row[head.indexOf('dialogue_share')])).toBeGreaterThan(0);
  });
});
const S2 = '20261019T110000Z';
