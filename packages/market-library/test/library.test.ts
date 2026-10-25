import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, detectKind, SCHEMA_VERSION } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (name: string) => {
  const b = fs.readFileSync(path.join(FIX, name));
  return (name.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8');
};
const DETAIL = 'B0G7R6X55V';
const detailHtml = () => read(`detail-kindle-${DETAIL}.html.gz`);
const listHtml = () => read('bestsellers-kindle-humorous-fantasy.html.gz');

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-'));
  lib = Library.open(root);
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const count = (t: string) => lib.db.scalar<number>(`SELECT count(*) FROM ${t}`)!;

describe('detectKind', () => {
  it('recognises list and detail urls', () => {
    expect(detectKind('https://www.amazon.com/gp/bestsellers/digital-text/11650864011')).toBe('list');
    expect(detectKind('https://www.amazon.com/Best-Sellers-Kindle-Store/zgbs/digital-text/11650864011')).toBe('list');
    expect(detectKind('https://www.amazon.com/Some-Title/dp/B0G7R6X55V/ref=x')).toBe('detail');
    expect(detectKind('https://www.amazon.com/s?k=dragons')).toBe('search');
    expect(detectKind('https://www.amazon.com/gp/help/customer/display.html')).toBeNull();
  });
});

describe('ingest detail', () => {
  it('writes raw page, capture and parsed files, and indexes the snapshot', () => {
    const r = lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${DETAIL}`, html: detailHtml(), capturedAt: '2026-10-18T12:00:00Z' });
    expect(r.asin).toBe(DETAIL);
    expect(r.dir).toBe(`books/${DETAIL}/snapshots/20261018T120000Z`);
    for (const f of ['page.html.gz', 'capture.json', 'parsed.json']) {
      expect(fs.existsSync(path.join(root, r.dir, f))).toBe(true);
    }
    expect(count('book')).toBe(1);
    expect(count('snapshot')).toBe(1);
    expect(count('rank_entry')).toBeGreaterThan(0);
    expect(count('format_offer')).toBeGreaterThan(0);
    const snap = lib.db.prepare('SELECT * FROM snapshot').get() as { title: string; rating_count: number };
    expect(snap.title).toBeTruthy();
    expect(snap.rating_count).toBeGreaterThan(0);
  });

  it('keeps one snapshot per capture time and tracks first/last seen', () => {
    const url = `https://www.amazon.com/dp/${DETAIL}`;
    lib.ingest({ kind: 'detail', url, html: detailHtml(), capturedAt: '2026-10-18T12:00:00Z' });
    lib.ingest({ kind: 'detail', url, html: detailHtml(), capturedAt: '2026-10-19T12:00:00Z' });
    expect(count('snapshot')).toBe(2);
    const b = lib.db.prepare('SELECT * FROM book').get() as { first_seen: string; last_seen: string };
    expect(b.first_seen).toBe('2026-10-18T12:00:00Z');
    expect(b.last_seen).toBe('2026-10-19T12:00:00Z');
  });

  it('is idempotent for the same capture', () => {
    const input = { kind: 'detail' as const, url: `https://www.amazon.com/dp/${DETAIL}`, html: detailHtml(), capturedAt: '2026-10-18T12:00:00Z' };
    const a = lib.ingest(input);
    const ranks = count('rank_entry');
    const b = lib.ingest(input);
    expect(a.replaced).toBe(false);
    expect(b.replaced).toBe(true);
    expect(count('snapshot')).toBe(1);
    expect(count('rank_entry')).toBe(ranks);
  });

  it('stores scrubbed html only', () => {
    // plant a session id in otherwise-real html and check it never reaches disk
    const html = detailHtml().replace('<body', '<!-- 111-2222222-3333333 --><body');
    const r = lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${DETAIL}`, html, capturedAt: '2026-10-18T12:00:00Z' });
    const stored = zlib.gunzipSync(fs.readFileSync(path.join(root, r.dir, 'page.html.gz'))).toString('utf8');
    expect(stored).not.toContain('111-2222222-3333333');
  });

  it('rejects a page with no ASIN without leaving files behind', () => {
    expect(() => lib.ingest({ kind: 'detail', url: 'https://www.amazon.com/', html: '<html></html>' })).toThrow();
    expect(fs.existsSync(path.join(root, 'books'))).toBe(false);
  });
});

describe('ingest list', () => {
  it('indexes the category, capture and entries', () => {
    const r = lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: listHtml(), capturedAt: '2026-10-18T12:00:00Z' });
    expect(r.categoryKey).toBe('amazon.com:kindle:11650864011');
    expect(r.dir).toMatch(/^lists\/amazon\.com\/kindle-11650864011\/(paid|free|bestsellers)-p1\/20261018T120000Z$/);
    expect(count('category')).toBe(1);
    expect(count('list_capture')).toBe(1);
    expect(count('list_entry')).toBeGreaterThanOrEqual(30);
  });
});

describe('assets', () => {
  it('stores covers content-addressed and de-duplicates', () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const a = lib.saveAsset(DETAIL, 'cover', bytes, 'jpg');
    const b = lib.saveAsset(DETAIL, 'cover', bytes, 'jpg');
    expect(a).toBe(b);
    expect(count('asset')).toBe(1);
    expect(fs.readdirSync(path.join(root, 'books', DETAIL, 'covers'))).toHaveLength(1);
  });
  it('rejects odd names', () => {
    expect(() => lib.saveAsset('../../etc', 'cover', Buffer.from('x'), 'jpg')).toThrow();
    expect(() => lib.saveAsset(DETAIL, 'cover', Buffer.from('x'), '../x')).toThrow();
  });
});

describe('rebuild', () => {
  it('recreates identical rows from the files alone', () => {
    lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${DETAIL}`, html: detailHtml(), capturedAt: '2026-10-18T12:00:00Z' });
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: listHtml(), capturedAt: '2026-10-18T12:05:00Z' });
    const snapshot = () => ({
      tables: ['book', 'snapshot', 'format_offer', 'category', 'rank_entry', 'list_capture', 'list_entry', 'parse_issue'].map(count),
      title: lib.db.scalar('SELECT title FROM snapshot'),
    });
    const before = snapshot();
    lib.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM list_entry; DELETE FROM rank_entry; DELETE FROM snapshot; DELETE FROM book;');
    expect(lib.rebuild()).toEqual({ detail: 1, list: 1, search: 0 });
    expect(snapshot()).toEqual(before);
  });
});

describe('schema', () => {
  it('is versioned and reopens cleanly', () => {
    lib.close();
    lib = Library.open(root);
    expect(lib.db.scalar('PRAGMA user_version')).toBe(SCHEMA_VERSION);
  });

  it('upgrades a 0.2.x library (schema 7) on first open, keeping its captures', () => {
    lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${DETAIL}`, html: detailHtml(), capturedAt: '2026-10-18T12:00:00Z' });
    // make the database look like the one 0.2.3 wrote: none of the 0.3.0 tables, version 7
    lib.db.exec(`DROP TABLE keyword_lookup; DROP TABLE keyword_signal; DROP TABLE keyword_trend; DROP TABLE search_entry; DROP TABLE search_capture;
      DROP TABLE sales_day; DROP TABLE rank_point; DROP TABLE kenp_day; DROP TABLE book_kenpc; DROP TABLE own_book; DROP TABLE keyword_history; DROP TABLE category_exclusion; DROP TABLE keyword_category;
      DROP TABLE royalty_month; DROP TABLE kdp_summary; DROP TABLE fx_rate; DROP TABLE kenp_rate; DROP TABLE book_split; DROP TABLE person; DROP TABLE payment_line; DROP TABLE payment; DROP TABLE payment_allocation; DROP TABLE payment_allocated; DROP TABLE payout; PRAGMA user_version = 7;`);
    lib.close();
    lib = Library.open(root);
    expect(lib.db.scalar('PRAGMA user_version')).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(17);
    for (const t of ['keyword_lookup', 'search_capture', 'sales_day', 'kenp_day', 'own_book', 'keyword_history', 'keyword_category', 'royalty_month', 'person', 'book_split', 'payment', 'payment_line', 'payment_allocation', 'payout']) expect(lib.db.scalar('SELECT count(*) FROM ' + t)).toBe(0);
    expect(lib.db.scalar('SELECT count(*) FROM snapshot')).toBe(1);
    expect(lib.db.scalar('SELECT count(*) FROM community_source')).toBe(0); // schema 7 tables are untouched
  });
});
