import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, categoryReport, reportMarkdown, tokens, tropeClusters, type CategoryBook } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-c-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const book = (listRank: number, title: string): CategoryBook => ({
  asin: `T${String(listRank).padStart(9, '0')}`, listRank, title, author: null, captured: false, ratingValue: null, ratingCount: 100 * listRank, price: 3.99, pages: null,
  publicationDate: null, seriesName: null, seriesPosition: null, overallRank: null, capturedAt: null,
});

// 4 dragon-diner books ranked high, 4 dungeon-crafting books ranked low, 2 unrelated
const SET: CategoryBook[] = [
  book(1, 'The Dragon Diner Chronicles'), book(2, 'Dragon Diner Mornings'), book(3, 'A Dragon Diner Wedding'), book(4, 'Dragon Diner and the Missing Spoon'),
  book(5, 'Dungeon Crafting Apprentice'), book(6, 'Dungeon Crafting Master'), book(7, 'Dungeon Crafting Wars'), book(8, 'Dungeon Crafting Legacy'),
  book(9, 'Quarterly Tax Returns Explained'), book(10, 'Pasta Recipes of Umbria'),
];

describe('tokens', () => {
  it('lowercases, strips stop words, numbers and plural s', () => {
    expect(tokens('The Dragons of 2026 and the Witches’ Cats')).toEqual(['dragon', 'witch', 'cat']);
    expect(tokens('Books: A Series, Book 3')).toEqual([]);
  });
});

describe('tropeClusters', () => {
  it('groups books that share distinctive words, and compares top with rest', () => {
    const r = tropeClusters(lib.db, KEY, 4, SET);
    const dragon = r.clusters.find((c) => c.label.includes('dragon'))!;
    const dungeon = r.clusters.find((c) => c.label.includes('dungeon'))!;
    expect(dragon.books).toBe(4);
    expect(dragon.top).toBe(4);
    expect(dragon.rest).toBe(0);
    expect(dungeon.books).toBe(4);
    expect(dungeon.top).toBe(0);
    expect(dragon.lift!).toBeGreaterThan(dungeon.lift!);
    expect(dragon.signal).toBe('gap');
    expect(dungeon.signal).toBe('crowded'); // none in the top 4, 4 of the 6 below
    expect(r.unclustered).toBe(2);
    expect(dragon.examples[0]!.listRank).toBe(1);
    expect(dragon.medianRatingCount).toBe(250);
  });
  it('is deterministic', () => {
    expect(tropeClusters(lib.db, KEY, 4, SET)).toEqual(tropeClusters(lib.db, KEY, 4, SET));
  });
  it('declines to cluster tiny lists', () => {
    const r = tropeClusters(lib.db, KEY, 2, SET.slice(0, 4));
    expect(r.clusters).toEqual([]);
    expect(r.caveats.join(' ')).toMatch(/at least 6/);
  });
  it('respects maxClusters', () => {
    expect(tropeClusters(lib.db, KEY, 4, SET, { maxClusters: 2, minSimilarity: 0 }).clusters.length).toBeLessThanOrEqual(2);
  });
  it('works on the real fixture list and says how many books lack blurbs', () => {
    const r = tropeClusters(lib.db, KEY, 10);
    expect(r.books).toBeGreaterThanOrEqual(30);
    expect(r.withBlurb).toBe(5);
    expect(r.caveats.join(' ')).toMatch(/only a title/);
    for (const c of r.clusters) expect(c.books).toBeGreaterThanOrEqual(2);
  });
});

describe('report', () => {
  it('carries the opportunity, cluster and shelf sections', () => {
    const rep = categoryReport(lib.db, KEY, 5);
    expect(rep.opportunity.category).toBe(KEY);
    expect(rep.clusters.books).toBeGreaterThanOrEqual(30);
    expect(Array.isArray(rep.shelves)).toBe(true);
    const md = reportMarkdown(rep);
    expect(md).toContain('## Opportunity');
    expect(md).toContain('## Trope clusters');
  });
});
