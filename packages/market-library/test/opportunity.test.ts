import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OPPORTUNITY_WEIGHTS, DEFAULT_SALES_CURVE, Library, bestsellersUrl, categoryDepth, estimateDailySales, findSubCategories, getOpportunityWeights, getSalesCurve,
  opportunityScore, rankCategories, setOpportunityWeights, setSalesCurve, type CategoryBook,
} from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
const TOP5 = ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ'];
const listHtml = read('bestsellers-kindle-humorous-fantasy.html.gz');

let root: string;
let lib: Library;
const ingestList = (at: string) => lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: listHtml, capturedAt: at });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-o-'));
  lib = Library.open(root);
  ingestList('2026-10-18T12:00:00Z');
  for (const a of TOP5) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const book = (listRank: number, overallRank: number | null): CategoryBook => ({
  asin: `A${listRank}`, listRank, title: null, author: null, captured: overallRank != null, ratingValue: null, ratingCount: null, price: null, pages: null,
  publicationDate: null, seriesName: null, seriesPosition: null, overallRank, capturedAt: null,
});

describe('rank to sales', () => {
  it('falls with rank and reproduces the anchor points roughly', () => {
    expect(estimateDailySales(100)).toBeGreaterThan(estimateDailySales(1000));
    expect(estimateDailySales(100)).toBeGreaterThan(250);
    expect(estimateDailySales(100)).toBeLessThan(450);
    expect(estimateDailySales(100000)).toBeGreaterThan(0.8);
    expect(estimateDailySales(100000)).toBeLessThan(3);
    expect(() => estimateDailySales(0)).toThrow();
  });
  it('stores an editable curve and rejects nonsense', () => {
    expect(getSalesCurve(lib.db)).toEqual(DEFAULT_SALES_CURVE);
    setSalesCurve(lib.db, { a: 5000, b: 0.7 });
    expect(getSalesCurve(lib.db)).toEqual({ a: 5000, b: 0.7 });
    expect(() => setSalesCurve(lib.db, { a: 0, b: 1 })).toThrow();
    expect(() => setSalesCurve(lib.db, { a: 1, b: NaN })).toThrow();
  });
});

describe('categoryDepth', () => {
  it('needs four anchors and says so', () => {
    const d = categoryDepth([book(1, 500), book(2, 800), book(3, null)], DEFAULT_SALES_CURVE);
    expect(d.at).toBeNull();
    expect(d.confidence).toBe('none');
    expect(d.caveat).toMatch(/at least 4/);
  });
  it('fits a line through log list rank and log Kindle rank', () => {
    // overall = 200 * listRank^1.5, exactly
    const books = [1, 3, 8, 20, 45, 90].map((r) => book(r, Math.round(200 * r ** 1.5)));
    const d = categoryDepth(books, DEFAULT_SALES_CURVE);
    expect(d.fit!.slope).toBeCloseTo(1.5, 1);
    expect(d.confidence).toBe('low');
    const p10 = d.at!.find((p) => p.listRank === 10)!;
    expect(p10.overallRank).toBeGreaterThan(5500);
    expect(p10.overallRank).toBeLessThan(7000);
    expect(d.at![0]!.estDailySales).toBeGreaterThan(d.at![4]!.estDailySales);
  });
  it('refuses to fit when every anchor sits at the same list rank', () => {
    expect(categoryDepth([1, 1, 1, 1].map((r, i) => book(r, 100 + i)), DEFAULT_SALES_CURVE).fit).toBeNull();
  });
});

describe('opportunityScore', () => {
  it('scores what it can with one capture and lists the rest as missing', () => {
    const o = opportunityScore(lib.db, KEY, 5);
    expect(o.category).toBe(KEY);
    expect(o.listedBooks).toBeGreaterThanOrEqual(30);
    expect(o.missing).toEqual(expect.arrayContaining(['churn']));
    expect(o.components.reviewBarrier.normalized).not.toBeNull();
    expect(o.components.openness.normalized).not.toBeNull();
    expect(o.score).toBeGreaterThanOrEqual(0);
    expect(o.score).toBeLessThanOrEqual(100);
    expect(o.benchmarks.newWithin365d.known).toBe(5);
    expect(o.components.churn.basis).toMatch(/2\+ captures/);
  });
  it('measures churn once the list has been captured again', () => {
    ingestList('2026-10-25T12:00:00Z'); // identical list a week later: nothing changed
    const o = opportunityScore(lib.db, KEY, 5);
    expect(o.components.churn.raw).toBe(0);
    expect(o.components.churn.normalized).toBe(0);
    expect(o.missing).not.toContain('churn');
  });
  it('re-balances over what is measured: a zero weight drops a component', () => {
    const only = opportunityScore(lib.db, KEY, 5, { demand: 0, reviewBarrier: 1, openness: 0, churn: 0 });
    expect(only.score).toBe(Math.round(only.components.reviewBarrier.normalized! * 1000) / 10);
  });
  it('scores few reviews higher than many', () => {
    const med = (n: number) => opportunityScore(lib.db, KEY, 5, undefined, undefined, lib.db && ([1, 2, 3, 4, 5].map((r) => ({ ...book(r, null), ratingCount: n })) as CategoryBook[])).components.reviewBarrier.normalized!;
    expect(med(30)).toBe(1);
    expect(med(5000)).toBe(0);
    expect(med(300)).toBeGreaterThan(med(1000));
  });
  it('stores weights and validates them', () => {
    expect(getOpportunityWeights(lib.db)).toEqual(DEFAULT_OPPORTUNITY_WEIGHTS);
    setOpportunityWeights(lib.db, { demand: 1, reviewBarrier: 0, openness: 0, churn: 0 });
    expect(getOpportunityWeights(lib.db).demand).toBe(1);
    expect(() => setOpportunityWeights(lib.db, { demand: 0, reviewBarrier: 0, openness: 0, churn: 0 })).toThrow();
    expect(() => setOpportunityWeights(lib.db, { demand: -1, reviewBarrier: 1, openness: 0, churn: 0 })).toThrow();
  });
  it('ranks categories that have a list capture', () => {
    const r = rankCategories(lib.db, 5);
    expect(r.map((x) => x.category)).toContain(KEY);
    expect(r.every((x) => x.depth)).toBe(true);
  });
});

describe('findSubCategories', () => {
  it('groups the shelf ranks on captured pages and labels them', () => {
    const shelves = findSubCategories(lib.db, { minBooks: 1 });
    expect(shelves.length).toBeGreaterThan(0);
    for (const s of shelves) {
      expect(s.observedBooks).toBeGreaterThanOrEqual(1);
      expect(s.usedBooks).toBeLessThanOrEqual(s.observedBooks);
      if (s.salesToTop10 != null) expect(['dead', 'niche', 'competitive', 'hot']).toContain(s.label);
    }
    const hf = shelves.find((s) => s.key === KEY);
    if (hf) expect(hf.listCaptured).toBe(true);
    // every shelf links to its Best Sellers page the way captured book pages do (store segment + node id)
    for (const s of shelves) expect(s.url).toMatch(/^https:\/\/www\.amazon\.com\/(?:gp\/bestsellers\/(?:digital-text|books)\/\d+|b\?node=\d+)$/);
  });
  it('implies a #10 figure from each book and reports shelves with enough books only', () => {
    // Two books on a made-up shelf: #2 at Kindle rank 20,000 and #5 at 50,000.
    const snap = (asin: string) => lib.db.scalar<number>('SELECT id FROM snapshot WHERE asin = ?', asin)!;
    lib.db.prepare("INSERT INTO category (key, marketplace, store, node_id, name, path) VALUES ('amazon.com:kindle:999', 'amazon.com', 'kindle', '999', 'Test Shelf', NULL)").run();
    const ins = lib.db.prepare("INSERT INTO rank_entry (snapshot_id, category_key, store, scope, name, rank) VALUES (?, 'amazon.com:kindle:999', 'kindle', 'category', 'Test Shelf', ?)");
    ins.run(snap(TOP5[0]!), 2);
    ins.run(snap(TOP5[1]!), 5);
    expect(findSubCategories(lib.db, { minBooks: 3 }).find((s) => s.key === 'amazon.com:kindle:999')).toBeUndefined();
    const s = findSubCategories(lib.db, { minBooks: 2 }).find((x) => x.key === 'amazon.com:kindle:999')!;
    expect(s.observedBooks).toBe(2);
    expect(s.bestCategoryRank).toBe(2);
    expect(s.listCaptured).toBe(false);
    expect(s.url).toBe('https://www.amazon.com/gp/bestsellers/digital-text/999');
    expect(s.note).toMatch(/Capture this sub-category list/);
    const overall = (a: string) => lib.db.scalar<number>("SELECT rank FROM rank_entry WHERE snapshot_id = ? AND scope = 'overall' AND store = 'kindle'", snap(a))!;
    const expected = [estimateDailySales(overall(TOP5[0]!)) * (2 / 10) ** DEFAULT_SALES_CURVE.b, estimateDailySales(overall(TOP5[1]!)) * (5 / 10) ** DEFAULT_SALES_CURVE.b];
    expect(s.salesToTop10).toBeCloseTo(Math.round(((expected[0]! + expected[1]!) / 2) * 10) / 10, 0);
  });
});

describe('bestsellersUrl', () => {
  it('builds the address captured book pages link to, and a browse-node address for stores it does not know', () => {
    expect(bestsellersUrl({ store: 'kindle', nodeId: '12527147011' })).toBe('https://www.amazon.com/gp/bestsellers/digital-text/12527147011');
    expect(bestsellersUrl({ store: 'books', nodeId: '15756641', marketplace: 'amazon.com' })).toBe('https://www.amazon.com/gp/bestsellers/books/15756641');
    expect(bestsellersUrl({ store: 'other', nodeId: '555' })).toBe('https://www.amazon.com/b?node=555');
    expect(() => bestsellersUrl({ store: 'kindle', nodeId: '12/../x' })).toThrow(/node id/);
  });
  it('agrees with the links on a real captured book page', () => {
    const html = zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'detail-kindle-B0G7R6X55V.html.gz'))).toString('utf8');
    const hrefs = [...html.matchAll(/href="(\/gp\/bestsellers\/(?:digital-text|books)\/\d+)\//g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      const [, , , slug, node] = h.split('/');
      expect(bestsellersUrl({ store: slug === 'books' ? 'books' : 'kindle', nodeId: node! })).toBe(`https://www.amazon.com${h}`);
    }
  });
});
