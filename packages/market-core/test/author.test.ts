import { describe, expect, it } from 'vitest';
import { parseAuthorPage, authorIdOfUrl, scrub } from '../src/index.js';
import { fixture } from './fixtures.js';

// A real "All Books" page saved from the browser after scrolling to the bottom, run through the scrubber like every capture.
const page = parseAuthorPage(fixture('amazon-com/author-allbooks-B0CMJC56GQ.html.gz'), 'https://www.amazon.com/stores/author/B0CMJC56GQ/allbooks');

describe('parseAuthorPage', () => {
  it('reads the author, the marketplace and the total', () => {
    expect(page).toMatchObject({ authorId: 'B0CMJC56GQ', authorName: 'Leon West', marketplace: 'amazon.com', totalCount: 45 });
    expect(page.entries).toHaveLength(45);
    expect(new Set(page.entries.map((e) => e.asin)).size).toBe(45);
    expect(page.entries.map((e) => e.position)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
  });
  it('reads a tile: title, series, rating, price, other formats', () => {
    expect(page.entries.find((e) => e.asin === 'B0GRWLF2H1')).toMatchObject({
      title: 'Rise of the Class Smith: A Dungeon Building LitRPG Adventure',
      series: { name: 'Rise of the Class Smith', asin: 'B0GRWNVB49', position: 1, total: 3, collects: false },
      ratingValue: 4.7, ratingCount: 1259, format: 'Kindle Edition', price: 6.89,
      otherFormats: [{ label: 'Audiobook', asin: 'B0H27BBN78' }, { label: 'Paperback', asin: 'B0H2V4H7SK' }],
    });
  });
  it('knows an omnibus collects a series, and a standalone has none', () => {
    expect(page.entries.find((e) => e.asin === 'B0DW4LPYPY')!.series).toMatchObject({ name: 'Accidental Goblin King', position: null, collects: true });
    expect(page.entries.find((e) => e.asin === 'B0FFJ2NZCG')!.series).toBeNull();
  });
  it('keeps co-authors from the product data the scrubber distils, and flags the books that have none', () => {
    const dragon = page.entries.find((e) => e.asin === 'B0G1QRXWZ6')!;
    expect(dragon.authors.map((a) => a.name)).toEqual(['Leon West', 'Freya Stone']);
    expect(dragon.authorsKnown).toBe(true);
    expect(dragon.coverUrl).toMatch(/^https:\/\/m\.media-amazon\.com\/.+\.jpg$/);
    const unknown = page.entries.find((e) => e.asin === 'B0CMGZMS9F')!;
    expect(unknown).toMatchObject({ authorsKnown: false, authors: [{ name: 'Leon West', authorId: 'B0CMJC56GQ' }] });
    expect(unknown.coverUrl).toMatch(/^https:\/\/m\.media-amazon\.com\/images\/I\/\w+\.jpg$/);
    expect(page.issues.map((i) => i.field)).toEqual(['authors']);
  });
  it('drops the signed-in person from the stored page', () => {
    expect(fixture('amazon-com/author-allbooks-B0CMJC56GQ.html.gz')).not.toMatch(/Tristan|A26O4IO4ENYFXH|slateToken|137-3387279|anti-csrftoken-a2z" content="(?!REDACTED)/i);
  });
  it('warns when the page is a short capture and errors when there is no grid', () => {
    const short = parseAuthorPage(fixture('amazon-com/author-allbooks-B0CMJC56GQ.html.gz').replace(/<li class="ProductGridItem__itemOuter[\s\S]*$/, '</body>'), 'https://www.amazon.com/stores/author/B0CMJC56GQ/allbooks');
    expect(short.issues.find((i) => i.field === 'entries')?.severity).toBe('error');
    expect(parseAuthorPage('<html></html>').issues.map((i) => i.field)).toEqual(['authorId', 'entries']);
  });
  it('reads the id from the store URLs', () => {
    expect(authorIdOfUrl('https://www.amazon.com/stores/Leon-West/author/B0CMJC56GQ/allbooks?x=1')).toBe('B0CMJC56GQ');
    expect(authorIdOfUrl('https://www.amazon.com/dp/B0CMJC56GQ')).toBeNull();
  });
  it('scrub leaves a page without product data alone', () => {
    expect(scrub('<html><body>x</body></html>')).not.toContain('cadrel-author-products');
  });
});
