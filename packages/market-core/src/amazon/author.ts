import * as cheerio from 'cheerio';
import type { AuthorCapture, AuthorEntry, ParseIssue, Person } from '../types.js';
import { clean, marketplaceFromUrl, parseIntLoose, parsePrice } from './util.js';

/** The id the scrubber leaves the author page's product data under (see scrub.ts). */
export const AUTHOR_DATA_ID = 'cadrel-author-products';

export interface AuthorData {
  totalCount: number | null;
  products: { asin: string; authors: { name: string; authorId: string | null }[]; cover: string | null }[];
}

/** "/stores/author/B0CMJC56GQ/allbooks" or "/stores/Leon-West/author/B0CMJC56GQ/allbooks" -> the author id. */
export function authorIdOfUrl(url: string | null | undefined): string | null {
  return url?.match(/\/stores\/(?:[^/?#]+\/)?author\/([A-Z0-9]{10})(?:[/?#]|$)/)?.[1] ?? null;
}

const num = (s: string | null | undefined) => (s ? Number(s) : null);

/** Parse a saved author "All Books" page: the rendered grid, plus the product data the scrubber keeps for co-authors and covers. */
export function parseAuthorPage(html: string, url?: string): AuthorCapture {
  const $ = cheerio.load(html);
  const issues: ParseIssue[] = [];
  const canonical = $('link[rel=canonical]').attr('href') ?? url ?? '';
  const authorId = authorIdOfUrl(canonical) ?? authorIdOfUrl(url) ?? '';
  if (!authorId) issues.push({ field: 'authorId', severity: 'error', detail: `cannot read the author id from "${canonical}"` });
  const marketplace = marketplaceFromUrl(canonical) ?? marketplaceFromUrl(url) ?? 'amazon.com';
  const authorName =
    clean($('[class*=AuthorSubHeader__author-subheader__name]').first().text()) ??
    clean($('title').first().text().replace(/^Amazon\.[a-z.]+:\s*/i, '').split(':')[0]) ??
    null;

  let data: AuthorData | null = null;
  const raw = $(`script#${AUTHOR_DATA_ID}`).first().html();
  if (raw) {
    try { data = JSON.parse(raw) as AuthorData; } catch { issues.push({ field: 'products', severity: 'warn', detail: 'the saved product data did not parse; co-authors and covers are missing' }); }
  }
  const byAsin = new Map((data?.products ?? []).map((p) => [p.asin, p]));
  const pageAuthor: Person[] = authorName ? [{ name: authorName, authorId: authorId || null, role: 'Author' }] : [];

  const entries: AuthorEntry[] = [];
  const seen = new Set<string>();
  $('[data-testid="product-grid-item"]').each((_, el) => {
    const t = $(el);
    const asin = t.attr('data-csa-c-item-id')?.match(/asin\.([A-Z0-9]{10})$/)?.[1];
    if (!asin || seen.has(asin)) return;
    seen.add(asin);
    const title = clean(t.find('[data-testid="product-grid-title"]').first().text()) ?? clean(t.find('a.Overlay__overlay__LloCU').attr('title'));
    const sr = t.find('[class*=BookSeriesInfo__book-series] a').first();
    const srText = clean(sr.attr('title') ?? sr.text());
    let series: AuthorEntry['series'] = null;
    if (srText) {
      const m = srText.match(/^Book\s+(\d+(?:\.\d+)?)\s+of\s+(\d+):\s*(.+)$/i);
      const c = srText.match(/^Collects books from:\s*(.+)$/i);
      const sid = sr.attr('href')?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? null;
      if (m) series = { name: m[3]!, asin: sid, position: Number(m[1]), total: Number(m[2]), collects: false };
      else if (c) series = { name: c[1]!, asin: sid, position: null, total: null, collects: true };
      else series = { name: srText, asin: sid, position: null, total: null, collects: false };
    }
    const alt = t.find('.icon-alt-text').first().text();
    const ratingValue = num(alt.match(/(\d(?:\.\d)?) out of 5/)?.[1]);
    const ratingCount = parseIntLoose(t.find('[data-testid="grid-item-review-count"]').first().text());
    const priceEl = t.find('[data-testid="grid-item-buy-price"] [data-testid]').first();
    const price = parsePrice(priceEl.attr('data-testid')) ?? parsePrice(t.find('[data-testid="grid-item-buy-price"]').first().text());
    const otherFormats = t
      .find('[class*=AlternativeMediaFormats] a[href*="/dp/"]')
      .toArray()
      .map((a) => ({ label: clean($(a).text()) ?? '', asin: $(a).attr('href')?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? '' }))
      .filter((f) => f.asin && f.asin !== asin);
    const d = byAsin.get(asin);
    const imgId = t.find('[data-testid="grid-item-image"] img').first().attr('src')?.match(/\/([A-Za-z0-9+%-]{8,})\.[^/]*$/)?.[1];
    const authors: Person[] = d?.authors.length ? d.authors.map((a) => ({ name: a.name, authorId: a.authorId, role: 'Author' })) : pageAuthor;
    entries.push({
      position: Number(t.attr('data-csa-c-pos')) || entries.length + 1,
      asin, title, authors, authorsKnown: !!d?.authors.length, series, ratingValue, ratingCount,
      format: clean(t.find('[class*=binding-information]').first().text()),
      price, otherFormats, coverUrl: d?.cover ?? (imgId ? `https://m.media-amazon.com/images/I/${imgId}.jpg` : null),
    });
  });
  entries.sort((a, b) => a.position - b.position);

  const totalCount = data?.totalCount ?? null;
  if (!entries.length) issues.push({ field: 'entries', severity: 'error', detail: 'no books in the grid: scroll the whole "All Books" page so every book loads, then save it again' });
  else if (totalCount && entries.length < totalCount) issues.push({ field: 'entries', severity: 'warn', detail: `${entries.length} of ${totalCount} books are on the saved page: scroll to the bottom of "All Books" so the rest load, then save it again` });
  const guessed = entries.filter((e) => !e.authorsKnown).length;
  if (guessed && entries.length) issues.push({ field: 'authors', severity: 'warn', detail: `${guessed} book(s) have no co-author data on the saved page; they are credited to ${authorName ?? 'the page author'} alone` });
  return { marketplace, authorId, authorName, totalCount, entries, issues };
}
