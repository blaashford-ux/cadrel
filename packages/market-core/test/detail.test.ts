import { describe, expect, it } from 'vitest';
import { parseDetailPage } from '../src/index.js';
import { DETAIL_ASINS, detailFixture, fixture } from './fixtures.js';

describe('parseDetailPage: The Stormtender\'s Call (Cozy #1, series book)', () => {
  const d = parseDetailPage(detailFixture('B0G7R6X55V'));
  it('identity and people', () => {
    expect(d).toMatchObject({ asin: 'B0G7R6X55V', marketplace: 'amazon.com', title: "The Stormtender's Call: Tales of Breakwater Isle Book 1" });
    expect(d.authors).toEqual([{ name: 'Willa Hurley', authorId: 'B0GVW7ZP4J', role: 'Author' }]);
    expect(d.series).toEqual({ name: 'Tales of Breakwater Isle', position: 1, total: 2 });
  });
  it('rating, histogram, price and formats', () => {
    expect(d).toMatchObject({ ratingValue: 4.7, ratingCount: 22, kindlePrice: 1.14 });
    expect(d.histogram).toEqual({ '5': 81, '4': 10, '3': 9, '2': 0, '1': 0 });
    expect(d.formats.map((f) => f.code)).toEqual(['KINDLE', 'AUDIO_DOWNLOAD', 'PAPERBACK']);
    expect(d.formats[1]).toMatchObject({ price: 0.99, note: expect.any(String) });
  });
  it('details', () => {
    expect(d).toMatchObject({ pages: 296, publicationDate: '2026-08-12', language: 'English', isbn13: '979-8901530115', fileSizeMb: 3.6 });
    expect(d.detailRows['ASIN']).toBe('B0G7R6X55V');
  });
  it('best sellers rank joins the Kindle and Books stores', () => {
    expect(d.ranks).toEqual([
      { store: 'kindle', scope: 'overall', name: 'Kindle Store', nodeId: null, rank: 609 },
      { store: 'kindle', scope: 'category', name: 'Cozy Fantasy Fiction', nodeId: '214873986011', rank: 1 },
      { store: 'kindle', scope: 'category', name: "Women's Fantasy Fiction", nodeId: '7588888011', rank: 3 },
      { store: 'books', scope: 'category', name: 'Cozy Fantasy Fiction', nodeId: '211759009011', rank: 3 },
    ]);
  });
  it('description, cover, sample, reviews, related', () => {
    expect(d.description).toMatch(/^When meteorologist Marilee Jenkins/);
    expect(d.coverUrl).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\/.+\.jpg$/);
    expect(d.hasReadSample).toBe(true);
    expect(d.reviews.length).toBeGreaterThanOrEqual(5);
    expect(d.reviews[0]).toMatchObject({ stars: 5, verified: true, country: 'United States', date: expect.stringMatching(/^2026-08-\d\d$/) });
    expect(d.reviews[0]!.body).toBeTruthy();
    expect(d.relatedAsins.length).toBeGreaterThan(0);
    expect(d.relatedAsins).not.toContain('B0G7R6X55V');
  });
});

describe('parseDetailPage: variants', () => {
  it('traditionally published standalone (Wicker) has a publisher, editorial reviews, no series', () => {
    const d = parseDetailPage(detailFixture('B0HLR7NQC7'));
    expect(d.title).toBe('Wicker');
    expect(d.publisher).toBe('Tordotcom');
    expect(d.series).toBeNull();
    expect(d.editorialReviews).toBeTruthy();
    expect(d.pages).toBe(26);
  });
  it('book with hardcover and audio CD formats and 65k ratings (Dungeon Crawler Carl 6)', () => {
    const d = parseDetailPage(detailFixture('B0C1R52V2J'));
    expect(d.ratingCount).toBe(65493);
    expect(d.formats.map((f) => f.code)).toEqual(expect.arrayContaining(['KINDLE', 'HARDCOVER']));
    expect(d.ranks.find((r) => r.scope === 'category' && r.name === 'Humorous Fantasy')).toMatchObject({ rank: 1, nodeId: '11650864011' });
    expect(d.series).toMatchObject({ position: 6, total: 8 });
  });
  it('standalone without series (Mr. Whiskers) ', () => {
    const d = parseDetailPage(detailFixture('B0GPRVQ8QJ'));
    expect(d.series).toBeNull();
    expect(d.ranks.some((r) => r.name === 'Horror Comedy')).toBe(true);
  });
});

describe('parseDetailPage: all fixtures', () => {
  for (const asin of DETAIL_ASINS) {
    it(`${asin} parses with no errors and the core fields`, () => {
      const d = parseDetailPage(detailFixture(asin));
      expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(d.asin).toBe(asin);
      for (const k of ['title', 'ratingValue', 'ratingCount', 'pages', 'publicationDate', 'description', 'coverUrl', 'kindlePrice'] as const) {
        expect(d[k], k).not.toBeNull();
      }
      expect(d.authors.length).toBeGreaterThan(0);
      expect(d.ranks.filter((r) => r.scope === 'category').length).toBeGreaterThanOrEqual(2);
      expect(d.ranks[0]!.scope).toBe('overall');
      expect(d.reviews.length).toBeGreaterThan(0);
      expect(Object.values(d.histogram ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(98);
    });
  }
  it('the page saved with Read Sample open is the same book and the same data', () => {
    const a = parseDetailPage(detailFixture('B0GPRVQ8QJ'));
    const b = parseDetailPage(fixture('amazon-com/detail-kindle-B0GPRVQ8QJ.read-sample-open.html.gz'));
    // sponsored products are ads and change on every page load
    expect({ ...b, sponsoredAsins: [], issues: [] }).toEqual({ ...a, sponsoredAsins: [], issues: [] });
  });
  it('also parses when the two documents are merged into one', () => {
    const raw = detailFixture('B0G7R6X55V');
    const parts = raw.split(/(?=<!doctype html)/i);
    expect(parts).toHaveLength(2);
    const merged = parts[0]! + parts[1]!.replace(/^<!doctype html>/i, '');
    const a = parseDetailPage(raw);
    const b = parseDetailPage(merged);
    expect(b.ranks).toEqual(a.ranks);
    expect(b.title).toBe(a.title);
  });
});
