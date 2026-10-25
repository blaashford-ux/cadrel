// Scale check. Skipped unless CADREL_MARKET_PERF=1:  CADREL_MARKET_PERF=1 npx vitest run --root packages/market-library test/perf.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  HashingEmbedder, Library, categoryCsv, categoryReport, embedPending, getBook, listBooks, listCategories, queue, searchText, successScores, verifyLibrary,
} from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const run = process.env.CADREL_MARKET_PERF === '1';
const WORDS = 'dragon baker oven village wizard cozy cottage tea magic quest sword library cat witch tavern forest river castle bread flour mystery'.split(' ');

function timed<T>(label: string, f: () => T, budgetMs: number): T {
  const t = performance.now();
  const r = f();
  const ms = Math.round(performance.now() - t);
  console.log(`PERF ${label}: ${ms} ms (budget ${budgetMs})`);
  expect(ms, label).toBeLessThan(budgetMs);
  return r;
}

describe.skipIf(!run)('large library', () => {
  it('ingest speed on real pages', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-perf-'));
    const lib = Library.open(root);
    const html = read('detail-kindle-B0C1R52V2J.html.gz');
    const t = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) lib.ingest({ kind: 'detail', url: 'https://www.amazon.com/dp/B0C1R52V2J', html, capturedAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() });
    const per = (performance.now() - t) / N;
    console.log(`PERF ingest one book page: ${Math.round(per)} ms`);
    expect(per).toBeLessThan(800);
    const rb = performance.now();
    lib.rebuild();
    console.log(`PERF rebuild ${N} pages: ${Math.round(performance.now() - rb)} ms`);
    lib.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 120000);

  it('queries over 5,000 books, 25,000 snapshots and 150,000 text chunks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-perf-'));
    const lib = Library.open(root);
    const db = lib.db;
    const BOOKS = 5000, SNAPS = 5, CATS = 20, ENTRIES = 100, LISTS = 12, CHUNKS = 30;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const sentence = () => Array.from({ length: 22 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
    const asinOf = (i: number) => 'B' + String(i).padStart(9, '0');

    const t0 = performance.now();
    db.begin();
    const bk = db.prepare('INSERT INTO book (asin, marketplace, title, first_seen, last_seen) VALUES (?,?,?,?,?)');
    const sn = db.prepare('INSERT INTO snapshot (asin, captured_at, dir, url, title, authors, rating_value, rating_count, kindle_price, pages, publication_date, has_read_sample) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)');
    const rk = db.prepare("INSERT INTO rank_entry (snapshot_id, category_key, store, scope, name, rank) VALUES (?,?,'kindle','overall','Kindle Store',?)");
    const ch = db.prepare("INSERT INTO chunk (asin, snapshot_id, kind, ordinal, text, text_hash, token_count) VALUES (?,?,?,?,?,?,?)");
    for (let i = 0; i < BOOKS; i++) {
      const a = asinOf(i);
      bk.run(a, 'amazon.com', `Book ${i}`, '2026-01-01T00:00:00Z', '2026-10-05T00:00:00Z');
      let last = 0;
      for (let s = 0; s < SNAPS; s++) {
        const r = sn.run(a, `2026-10-0${s + 1}T00:00:00Z`, `books/${a}/snapshots/s${s}`, 'u', `Book ${i} of the ${WORDS[i % 20]}`, '[{"name":"A"}]', 3 + rnd() * 2, Math.floor(rnd() * 5000), 2 + rnd() * 8, 200 + Math.floor(rnd() * 400), '2025-05-05');
        last = Number(r.lastInsertRowid);
        rk.run(last, null, 1 + Math.floor(rnd() * 100000));
      }
      for (let c = 0; c < CHUNKS; c++) {
        const text = sentence() + ' ' + i + ' ' + c;
        ch.run(a, last, c === 0 ? 'blurb' : 'review', c, text, `h${i}_${c}`, 40);
      }
    }
    const cat = db.prepare('INSERT INTO category (key, marketplace, store, node_id, name, path) VALUES (?,?,?,?,?,?)');
    const lc = db.prepare("INSERT INTO list_capture (category_key, list_kind, page, captured_at, dir, url, listed_count, rendered_count) VALUES (?, 'paid', 1, ?, 'd', 'u', 100, 100)");
    const le = db.prepare('INSERT INTO list_entry (list_capture_id, rank, asin, rendered, title, author, rating_value, rating_count, price) VALUES (?,?,?,1,?,?,?,?,?)');
    for (let c = 0; c < CATS; c++) {
      const key = `amazon.com:kindle:${1000 + c}`;
      cat.run(key, 'amazon.com', 'kindle', String(1000 + c), `Category ${c}`, '[]');
      for (let l = 0; l < LISTS; l++) {
        const id = Number(lc.run(key, `2026-10-${String(l + 1).padStart(2, '0')}T00:00:00Z`).lastInsertRowid);
        for (let e = 1; e <= ENTRIES; e++) le.run(id, e, asinOf((c * 211 + e * 7 + l) % BOOKS), `Book ${e}`, 'Author', 4.4, 1000 + e, 4.99);
      }
    }
    db.commit();
    console.log(`PERF generate data: ${Math.round(performance.now() - t0)} ms (${BOOKS * CHUNKS} chunks)`);
    const key = 'amazon.com:kindle:1005';

    timed('listCategories', () => listCategories(db), 1500);
    timed('listBooks (all 5,000)', () => listBooks(db), 1500);
    timed('listBooks in a category', () => listBooks(db, { categoryKey: key }), 1500);
    timed('listBooks search', () => listBooks(db, { search: 'Book 12' }), 1500);
    timed('queue', () => queue(db), 1500);
    timed('getBook', () => getBook(db, asinOf(77)), 200);
    timed('successScores', () => successScores(db, key), 1500);
    const rep = timed('categoryReport', () => categoryReport(db, key, 10), 4000);
    expect(rep.books).toBeGreaterThan(50);
    timed('categoryCsv', () => categoryCsv(db, key), 4000);
    timed('verifyLibrary', () => verifyLibrary(db, root), 5000);

    const t1 = performance.now();
    const hits = await searchText(db, { query: 'dragon baker village', limit: 10 });
    console.log(`PERF keyword search over ${BOOKS * CHUNKS} chunks: ${Math.round(performance.now() - t1)} ms`);
    expect(hits).toHaveLength(10);
    expect(performance.now() - t1).toBeLessThan(1500);
    timed('keyword search, filtered by category', () => void searchText(db, { query: 'wizard tavern', categoryKey: key, limit: 10 }), 3000);

    // vectors for a subset (hashing embedder is cheap; the real model is the limit in practice)
    db.exec("DELETE FROM chunk WHERE id % 5 <> 0"); // keep 30,000 chunks
    const emb = new HashingEmbedder();
    const t2 = performance.now();
    await embedPending(db, emb);
    console.log(`PERF embed 30,000 chunks (hashing): ${Math.round(performance.now() - t2)} ms`);
    const t3 = performance.now();
    const fused = await searchText(db, { query: 'dragon baker village', limit: 10, embedder: emb });
    console.log(`PERF hybrid search over 30,000 vectors: ${Math.round(performance.now() - t3)} ms`);
    expect(fused.length).toBeGreaterThan(0);
    expect(performance.now() - t3).toBeLessThan(2000);
    lib.close();
    fs.rmSync(root, { recursive: true, force: true });
  }, 600000);
});
