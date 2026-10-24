import { describe, expect, it } from 'vitest';
import { parseListPage } from '../src/index.js';
import { fixture } from './fixtures.js';

describe('parseListPage: amazon.com Kindle Cozy Fantasy (excerpt)', () => {
  const l = parseListPage(fixture('amazon-com/bestsellers-kindle-cozy-fantasy.excerpt.html'));
  it('reads the category from the canonical URL and breadcrumb', () => {
    expect(l.marketplace).toBe('amazon.com');
    expect(l.store).toBe('kindle');
    expect(l.nodeId).toBe('214873986011');
    expect(l.categoryName).toBe('Cozy');
    expect(l.categoryPath.map((c) => c.name)).toEqual(['Any Department', 'Kindle Store', 'Kindle eBooks', 'Science Fiction & Fantasy', 'Fantasy']);
    expect(l.categoryPath.at(-1)?.nodeId).toBe('158576011');
    expect(l.listKind).toBe('paid');
    expect(l.page).toBe(1);
  });
  it('lists all 50 ASINs in rank order even though few rows are in the excerpt', () => {
    expect(l.listedCount).toBe(50);
    expect(l.entries).toHaveLength(50);
    expect(l.entries.map((e) => e.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(l.renderedCount).toBe(4);
    const unrendered = l.entries.find((e) => e.rank === 31)!;
    expect(unrendered).toMatchObject({ asin: 'B0DWN961ZQ', rendered: false, titleRaw: null });
  });
  it('parses a normal row', () => {
    expect(l.entries[0]).toMatchObject({
      rank: 1, asin: 'B0G7R6X55V', rendered: true, authorRaw: 'Willa Hurley', authorId: 'B0GVW7ZP4J', ratingValue: 4.7, ratingCount: 22,
      format: 'Kindle Edition', price: 1.14, priceLayout: 'standard', formatsAvailable: 3,
    });
    expect(l.entries[0]!.coverUrl).toContain('_AC_UL900_SR900,600_');
  });
  it('parses the "1 offer from" price layout', () => {
    expect(l.entries[1]).toMatchObject({ asin: 'B0HLR7NQC7', price: 1.99, priceLayout: 'offer_from', formatsAvailable: 2 });
  });
  it('treats a missing formats line as unknown, not zero', () => {
    expect(l.entries[3]).toMatchObject({ asin: 'B0H7QRHNJR', formatsAvailable: null });
  });
  it('reads an author shown as plain text', () => {
    expect(l.entries[14]).toMatchObject({ asin: 'B0H37YDJ7K', authorRaw: 'SixthBell', authorId: null });
  });
  it('reports no issues', () => expect(l.issues).toEqual([]));
});

describe('parseListPage: amazon.com Kindle Humorous Fantasy (full page)', () => {
  const l = parseListPage(fixture('amazon-com/bestsellers-kindle-humorous-fantasy.html.gz'));
  it('has 50 listed and 30 rendered rows', () => {
    expect(l.nodeId).toBe('11650864011');
    expect(l.listedCount).toBe(50);
    expect(l.renderedCount).toBe(30);
    expect(l.entries.filter((e) => !e.rendered)).toHaveLength(20);
  });
  it('has the expected top 5', () => {
    expect(l.entries.slice(0, 5).map((e) => e.asin)).toEqual(['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']);
  });
  it('reports no issues', () => expect(l.issues).toEqual([]));
});

describe('parseListPage: amazon.com.au pages (structure fixtures)', () => {
  it('Books-store Humorous list mixes formats', () => {
    const l = parseListPage(fixture('amazon-com-au/bestsellers-books-humorous-fantasy.html'));
    expect(l).toMatchObject({ marketplace: 'amazon.com.au', store: 'books', nodeId: '4900420051', listedCount: 50, renderedCount: 30 });
    const formats = new Set(l.entries.filter((e) => e.rendered).map((e) => e.format));
    expect(formats.has('Audible Audiobook')).toBe(true);
    expect(formats.has('Kindle Edition')).toBe(true);
  });
  it('Kindle Cozy list is Kindle-only', () => {
    const l = parseListPage(fixture('amazon-com-au/bestsellers-kindle-cozy-fantasy.html'));
    expect(l).toMatchObject({ marketplace: 'amazon.com.au', store: 'kindle', nodeId: '214873306051' });
    expect(new Set(l.entries.filter((e) => e.rendered).map((e) => e.format))).toEqual(new Set(['Kindle Edition']));
  });
});
