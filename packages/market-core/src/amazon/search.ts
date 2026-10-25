import * as cheerio from 'cheerio';
import type { ParseIssue } from '../types.js';
import { clean, marketplaceFromUrl, parseIntLoose, parsePrice } from './util.js';

export interface SearchEntry {
  /** 1-based place among the results the page shows, sponsored ones included. */
  position: number;
  asin: string;
  sponsored: boolean;
  titleRaw: string | null;
  authorRaw: string | null;
  ratingValue: number | null;
  ratingCount: number | null;
  /** "Kindle Edition" and so on, when the row says. */
  format: string | null;
  price: number | null;
}

export interface SearchCapture {
  marketplace: string;
  /** What was typed in the search box (lower-cased, spaces collapsed). */
  query: string;
  /** Store department from the URL's `i` parameter, e.g. "digital-text". */
  department: string | null;
  page: number;
  /** The total Amazon reports ("of over 3,000 results"); a lower bound when `resultCountIsMinimum`. */
  resultCount: number | null;
  resultCountIsMinimum: boolean;
  entries: SearchEntry[];
  issues: ParseIssue[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The query from a search URL (`k=`), or null. */
export function searchQueryOf(url: string): string | null {
  try {
    const q = new URL(url).searchParams.get('k');
    return q ? norm(q) : null;
  } catch {
    return null;
  }
}

/** Parse an Amazon search-results page. `url` supplies the query, store and page number, which the HTML does not state reliably. */
export function parseSearchPage(html: string, url: string): SearchCapture {
  const $ = cheerio.load(html);
  const issues: ParseIssue[] = [];
  let u: URL | null = null;
  try { u = new URL(url); } catch { /* reported below */ }

  const marketplace = marketplaceFromUrl($('link[rel=canonical]').attr('href')) ?? marketplaceFromUrl(url) ?? 'unknown';
  const query = searchQueryOf(url) ?? norm($('#twotabsearchtextbox').attr('value') ?? '');
  if (!query) issues.push({ field: 'query', severity: 'error', detail: 'no search words in the URL (k=) or the search box' });
  const department = u?.searchParams.get('i') ?? null;
  const page = Number(u?.searchParams.get('page')) || parseIntLoose($('.s-pagination-item.s-pagination-selected').first().text()) || 1;

  // "1-16 of over 3,000 results for" / "1-48 of 628 results for"
  const info = clean($('[data-component-type="s-result-info-bar"], .s-desktop-toolbar, .s-breadcrumb').first().text()) ?? '';
  const cm = info.match(/of\s+(over\s+)?([\d,]+)\s+results?/i) ?? info.match(/^([\d,]+)\s+results?\b/i);
  const resultCount = cm ? parseIntLoose(cm[cm.length - 1]) : null;
  const resultCountIsMinimum = !!cm && /over/i.test(cm[1] ?? '');
  if (resultCount === null) issues.push({ field: 'resultCount', severity: 'warn', detail: 'result total not found' });

  const entries: SearchEntry[] = [];
  const seen = new Set<string>();
  $('[data-component-type="s-search-result"]').each((_, el) => {
    const row = $(el);
    const asin = row.attr('data-asin') ?? '';
    if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) return;
    seen.add(asin);
    const sponsored = row.find('.puis-sponsored-label-text, [aria-label*="Sponsored" i]').length > 0 || /^\s*Sponsored\b/i.test(row.find('.s-label-popover-default').first().text());
    const title = clean(row.find('h2').first().attr('aria-label')) ?? clean(row.find('h2 span').first().text());
    const alt = row.find('.a-icon-alt').first().text();
    const rm = alt.match(/([\d.]+) out of 5/);
    const countLabel = row.find('a[aria-label*="rating" i], span[aria-label*="rating" i]').first().attr('aria-label') ?? clean(row.find('[data-csa-c-func-deps="aui-da-a-popover"] + a span.s-underline-text, a span.s-underline-text').first().text());
    const byLine = clean(row.find('.a-row.a-size-base.a-color-secondary').first().text()) ?? '';
    const by = byLine.match(/^by\s+(.+?)(?:\s*\||\s*\d{4}$|$)/i);
    const fmt = clean(row.find('a.a-size-base.a-link-normal.s-link-style').filter((_, a) => /kindle|paperback|hardcover|audiobook|audible/i.test($(a).text())).first().text());
    entries.push({
      position: entries.length + 1,
      asin,
      sponsored,
      titleRaw: title,
      authorRaw: by ? clean(by[1]!.replace(/\band\s+\d+\s+more\b/i, '')) : null,
      ratingValue: rm ? Number(rm[1]) : null,
      ratingCount: countLabel ? parseIntLoose(countLabel.replace(/(\d)\.(\d)\s*K/i, (_, a, b) => `${a}${b}00`).replace(/(\d+)\s*K\b/i, (_, a) => `${a}000`)) : null,
      format: fmt,
      price: parsePrice(row.find('.a-price .a-offscreen').first().text()),
    });
  });
  if (!entries.length) issues.push({ field: 'entries', severity: 'error', detail: 'no search results found' });
  else if (!entries.some((e) => !e.sponsored)) issues.push({ field: 'sponsored', severity: 'warn', detail: 'every row looks sponsored; the sponsored marker may have changed' });

  return { marketplace, query, department, page, resultCount, resultCountIsMinimum, entries, issues };
}
