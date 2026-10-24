import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, copyLibrary, listBooks, parserHealth, queue, verifyLibrary } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const ASIN = 'B0C1R52V2J';

let root: string, tmp: string;
let lib: Library;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-mt-'));
  root = path.join(tmp, 'lib');
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-19T12:00:00Z' });
  lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${ASIN}`, html: read(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-19T13:00:00Z' });
  lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${ASIN}`, html: read(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-28T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parserHealth', () => {
  it('groups captures by week and lists the fields that went missing', () => {
    const snaps = lib.db.prepare('SELECT id, captured_at FROM snapshot ORDER BY captured_at').all() as unknown as { id: number; captured_at: string }[];
    lib.db.prepare("DELETE FROM parse_issue").run();
    lib.db.prepare("INSERT INTO parse_issue (source_kind, source_id, field, severity, detail) VALUES ('snapshot', ?, 'pages', 'warn', 'x'), ('snapshot', ?, 'description', 'warn', 'x')").run(snaps[1]!.id, snaps[1]!.id);
    const h = parserHealth(lib.db);
    const books = h.filter((r) => r.kind === 'book pages');
    expect(books.map((r) => [r.week, r.captures, r.withIssues])).toEqual([['2026-10-26', 1, 1], ['2026-10-19', 1, 0]]);
    expect(books[0]).toMatchObject({ share: 1, fields: [{ field: 'description', captures: 1 }, { field: 'pages', captures: 1 }] });
    expect(h.some((r) => r.kind === 'list pages' && r.week === '2026-10-19')).toBe(true);
  });
});

describe('verifyLibrary', () => {
  it('is clean for a healthy library', () => {
    const r = verifyLibrary(lib.db, root);
    expect(r).toMatchObject({ ok: true, integrity: 'ok', foreignKeyProblems: 0, notIndexed: [], missingFiles: [], counts: { books: 1, snapshots: 2, listCaptures: 1 } });
    expect(r.sizeBytes).toBeGreaterThan(1000);
  });
  it('finds missing files, unindexed captures and missing covers', () => {
    lib.saveAsset(ASIN, 'cover', Buffer.from('img'), 'png');
    fs.rmSync(path.join(root, 'books', ASIN, 'snapshots', '20261019T130000Z', 'page.html.gz'));
    const stray = path.join(root, 'books', 'B000000000', 'snapshots', '20261001T000000Z');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'capture.json'), '{}');
    fs.rmSync(path.join(root, 'books', ASIN, 'covers'), { recursive: true });
    const r = verifyLibrary(lib.db, root);
    expect(r.ok).toBe(false);
    expect(r.missingFiles).toEqual([`books/${ASIN}/snapshots/20261019T130000Z`]);
    expect(r.notIndexed).toEqual(['books/B000000000/snapshots/20261001T000000Z']);
    expect(r.missingAssets).toHaveLength(1);
  });
});

describe('copyLibrary', () => {
  it('copies a library with its database, skipping models unless asked, and the copy opens and answers the same', async () => {
    fs.mkdirSync(path.join(root, 'models', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'x', 'big.onnx'), 'model');
    lib.attachText(ASIN, { source: 'upload', kind: 'txt', label: 'b.txt', text: 'A book with enough text to count as a manuscript here.', chapters: [] });
    lib.annotate(ASIN, 'tag', 'keeper');
    const seen: number[] = [];
    const r = await copyLibrary(lib.db, root, path.join(tmp, 'moved'), { onProgress: (p) => seen.push(p.files) });
    expect(r.files).toBeGreaterThan(5);
    expect(seen.at(-1)).toBe(r.files);
    expect(fs.existsSync(path.join(tmp, 'moved', 'models'))).toBe(false);
    const b = Library.open(path.join(tmp, 'moved'));
    expect(listBooks(b.db).map((x) => x.asin)).toEqual(listBooks(lib.db).map((x) => x.asin));
    expect(queue(b.db).length).toBe(queue(lib.db).length);
    expect(verifyLibrary(b.db, path.join(tmp, 'moved')).ok).toBe(true);
    expect(b.db.scalar("SELECT count(*) FROM annotation")).toBe(1);
    b.close();
    const withModels = await copyLibrary(lib.db, root, path.join(tmp, 'moved2'), { includeModels: true });
    expect(withModels.files).toBe(r.files + 1);
  });

  it('refuses unsafe destinations', async () => {
    await expect(copyLibrary(lib.db, root, path.join(root, 'inside'))).rejects.toThrow(/inside the library/);
    await expect(copyLibrary(lib.db, root, root)).rejects.toThrow(/inside the library/);
    await expect(copyLibrary(lib.db, root, tmp)).rejects.toThrow(/contain the library|not empty/);
    fs.mkdirSync(path.join(tmp, 'full'));
    fs.writeFileSync(path.join(tmp, 'full', 'x'), '1');
    await expect(copyLibrary(lib.db, root, path.join(tmp, 'full'))).rejects.toThrow(/not empty/);
  });

  it('handles a large library (thousands of files) and reports progress', async () => {
    for (let i = 0; i < 1500; i++) {
      const dir = path.join(root, 'books', `B${String(i).padStart(9, '0')}`, 'covers');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'c.jpg'), Buffer.alloc(2048, i % 255));
    }
    let last = 0;
    const t0 = Date.now();
    const r = await copyLibrary(lib.db, root, path.join(tmp, 'big'), { onProgress: (p) => (last = p.files) });
    expect(r.files).toBeGreaterThan(1500);
    expect(last).toBe(r.files);
    expect(Date.now() - t0).toBeLessThan(30000);
    const b = Library.open(path.join(tmp, 'big'));
    expect(listBooks(b.db)).toHaveLength(1);
    b.close();
  }, 60000);
});

describe('rebuildAsync', () => {
  it('reports progress, flags the library as busy meanwhile, and matches the synchronous rebuild', async () => {
    const before = [listBooks(lib.db).length, lib.db.scalar<number>('SELECT count(*) FROM chunk')];
    const seen: string[] = [];
    let busyDuring = false;
    const r = await lib.rebuildAsync((d, t) => { busyDuring = busyDuring || lib.rebuilding; seen.push(`${d}/${t}`); });
    expect(r).toEqual({ detail: 2, list: 1, search: 0 });
    expect(seen.at(-1)).toBe('3/3');
    expect(busyDuring).toBe(true);
    expect(lib.rebuilding).toBe(false);
    expect([listBooks(lib.db).length, lib.db.scalar<number>('SELECT count(*) FROM chunk')]).toEqual(before);
  });
  it('rolls back and clears the flag when a page cannot be read', async () => {
    fs.rmSync(path.join(root, 'books', ASIN, 'snapshots', '20261019T130000Z', 'page.html.gz'));
    await expect(lib.rebuildAsync()).rejects.toThrow();
    expect(lib.rebuilding).toBe(false);
    expect(listBooks(lib.db)).toHaveLength(1); // the old index is still there
    lib.db.exec('SELECT 1'); // the connection is usable (no transaction left open)
  });
});
