import { describe, expect, it } from 'vitest';
import { parseSearchPage, searchQueryOf } from '../src/index.js';

// Synthetic page: it follows the markup Amazon's search results are known to use, but it is not a saved real page.
// Capture a real one with the extension and add it as a fixture to confirm the selectors against live markup.
const row = (asin: string, inner: string) => `<div data-component-type="s-search-result" data-asin="${asin}">${inner}</div>`;
const html = `<html><head><link rel="canonical" href="https://www.amazon.com/s?k=cozy+fantasy"></head><body>
<input id="twotabsearchtextbox" value="cozy fantasy">
<div class="s-desktop-toolbar"><span>1-16 of over 3,000 results for</span></div>
${row('B000000001', '<span class="puis-sponsored-label-text">Sponsored</span><h2 aria-label="Ad Book"><span>Ad Book</span></h2>')}
${row('', '<h2>No asin</h2>')}
${row('B000000002', `<h2 aria-label="Legends &amp; Lattes"><span>Legends &amp; Lattes</span></h2>
  <div class="a-row a-size-base a-color-secondary"><span>by Travis Baldree | Feb 2022</span></div>
  <span class="a-icon-alt">4.6 out of 5 stars</span><a aria-label="12.3K ratings"><span class="s-underline-text">(12.3K)</span></a>
  <span class="a-price"><span class="a-offscreen">$9.99</span></span>`)}
${row('B000000002', '<h2>dupe</h2>')}
</body></html>`;

describe('parseSearchPage', () => {
  const p = parseSearchPage(html, 'https://www.amazon.com/s?k=Cozy+Fantasy&i=digital-text&page=2');
  it('reads the query, store, page and result total from the URL and toolbar', () => {
    expect(p).toMatchObject({ marketplace: 'amazon.com', query: 'cozy fantasy', department: 'digital-text', page: 2, resultCount: 3000, resultCountIsMinimum: true });
    expect(p.issues).toEqual([]);
  });
  it('keeps result rows in order with a sponsored flag, skipping rows without an ASIN and duplicates', () => {
    expect(p.entries.map((e) => [e.position, e.asin, e.sponsored])).toEqual([[1, 'B000000001', true], [2, 'B000000002', false]]);
    expect(p.entries[1]).toMatchObject({ titleRaw: 'Legends & Lattes', authorRaw: 'Travis Baldree', ratingValue: 4.6, ratingCount: 12300, price: 9.99 });
  });
  it('reports a page with no results or no query', () => {
    expect(parseSearchPage('<html><body></body></html>', 'https://www.amazon.com/s?k=x').issues.map((i) => i.field)).toEqual(['resultCount', 'entries']);
    expect(parseSearchPage(html, 'https://www.amazon.com/s?i=digital-text').query).toBe('cozy fantasy'); // falls back to the search box
    expect(parseSearchPage('<html></html>', 'https://www.amazon.com/s').issues.map((i) => i.field)).toContain('query');
  });
  it('parses the query out of a URL', () => {
    expect(searchQueryOf('https://www.amazon.com/s?k=Dragon%20%20Rider')).toBe('dragon rider');
    expect(searchQueryOf('nonsense')).toBeNull();
  });
});
