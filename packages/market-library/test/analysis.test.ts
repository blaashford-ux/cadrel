import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, Library, getWeights, marketShape, packagingStats, readerVoice, setWeights, successScores, trend } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
const TOP5 = ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ'];
const listHtml = read('bestsellers-kindle-humorous-fantasy.html.gz');

let root: string;
let lib: Library;
const ingestList = (at: string) => lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: listHtml, capturedAt: at });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-a-'));
  lib = Library.open(root);
  ingestList('2026-10-18T12:00:00Z');
  for (const a of TOP5) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('marketShape', () => {
  it('splits price bands and reports coverage', () => {
    const m = marketShape(lib.db, KEY, 5);
    expect(m.books).toBeGreaterThanOrEqual(30);
    expect(m.priceBands.top.reduce((n, b) => n + b.count, 0)).toBe(5);
    expect(m.pageBands.known.top).toBe(5);
    expect(m.pageBands.known.rest).toBe(0); // only the top five have detail pages
    expect(m.rankPriceCorrelation.n).toBeGreaterThan(20);
    expect(m.scatter.length).toBe(m.rankPriceCorrelation.n);
    expect(m.series.top.books).toBe(5);
    expect(m.age.top.known).toBe(5);
    expect(m.publicationYears.length).toBeGreaterThan(0);
  });
  it('lists the other categories the captured books also rank in', () => {
    const m = marketShape(lib.db, KEY, 5);
    expect(m.coCategories.length).toBeGreaterThan(0);
    expect(m.coCategories.every((c) => c.name !== 'Kindle Store')).toBe(true);
  });
});

describe('successScores', () => {
  it('scores from rank and lifetime velocity with one capture, and says what is missing', () => {
    const s = successScores(lib.db, KEY);
    const first = s[0]!;
    expect(first.asin).toBe('B0C1R52V2J');
    expect(first.components.rank.normalized).toBe(1);
    expect(first.components.velocity.basis).toMatch(/lifetime/);
    expect(first.missing).toEqual(['stability']);
    expect(first.score).toBeGreaterThan(50);
    const uncaptured = s.find((x) => x.listRank === 20)!;
    expect(uncaptured.missing).toEqual(expect.arrayContaining(['stability', 'velocity']));
    expect(uncaptured.score).toBe(Math.round(uncaptured.components.rank.normalized! * 1000) / 10); // rank only
  });
  it('measures stability once there are three list captures, and observed velocity from two snapshots', () => {
    ingestList('2026-10-25T12:00:00Z');
    ingestList('2026-11-01T12:00:00Z');
    lib.ingest({ kind: 'detail', url: 'https://www.amazon.com/dp/B0C1R52V2J', html: read('detail-kindle-B0C1R52V2J.html.gz'), capturedAt: '2026-11-01T13:00:00Z' });
    const s = successScores(lib.db, KEY).find((x) => x.asin === 'B0C1R52V2J')!;
    expect(s.components.stability.raw).toBe(0); // identical rank every time
    expect(s.components.stability.normalized).not.toBeNull();
    expect(s.components.velocity.basis).toMatch(/observed over 14 days/);
    expect(s.missing).toEqual([]);
  });
  it('weights are configurable and validated', () => {
    expect(getWeights(lib.db)).toEqual(DEFAULT_WEIGHTS);
    setWeights(lib.db, { rank: 1, stability: 0, velocity: 0 });
    const s = successScores(lib.db, KEY)[0]!;
    expect(s.score).toBe(100);
    expect(() => setWeights(lib.db, { rank: 0, stability: 0, velocity: 0 })).toThrow();
    expect(() => setWeights(lib.db, { rank: -1, stability: 1, velocity: 1 })).toThrow();
  });
});

describe('trend', () => {
  it('gives one point per capture day, and by month', () => {
    ingestList('2026-10-25T12:00:00Z');
    ingestList('2026-11-02T12:00:00Z');
    const days = trend(lib.db, KEY, 'median_price');
    expect(days.map((d) => d.bucket)).toEqual(['2026-10-18', '2026-10-25', '2026-11-02']);
    expect(days[0]!.value).toBeGreaterThan(0);
    const months = trend(lib.db, KEY, 'books_listed', 'month');
    expect(months.map((d) => d.bucket)).toEqual(['2026-10', '2026-11']);
    expect(months[0]).toMatchObject({ captures: 2 });
    expect(trend(lib.db, KEY, 'new_release_share')[0]!.n).toBe(5);
    expect(trend(lib.db, 'nope', 'median_price')).toEqual([]);
  });
});

describe('text statistics', () => {
  it('compares packaging for the top five against the rest, with blurb coverage', () => {
    const p = packagingStats(lib.db, KEY, 5);
    expect(p.books.withBlurb).toEqual({ top: 5, rest: 0 });
    expect(p.numeric.title_words!.rest.known).toBeGreaterThan(20); // titles come from list rows
    expect(p.numeric.blurb_words!.top.known).toBe(5);
    expect(p.numeric.blurb_words!.rest.known).toBe(0);
    expect(p.flags.has_bullets!.top.known).toBe(5);
    expect(p.flags.has_subtitle!.rest.known).toBeGreaterThan(20);
    expect(p.tropes.length).toBeGreaterThan(0);
  });
  it('pools reader voice across captured books', () => {
    const v = readerVoice(lib.db, KEY, 5);
    expect(v.top.withText).toBeGreaterThan(0);
    expect(v.rest.withText).toBe(0);
    expect(v.caveat).toMatch(/handful/);
    expect(Object.keys(v.all.themes)).toContain('humor');
  });
});
