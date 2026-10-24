import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { CategoryRef, ListCapture, ListEntry, ListKind, ParseIssue } from '../types.js';
import { clean, marketplaceFromUrl, parseIntLoose, parsePrice } from './util.js';

function storeOf(slug: string): ListCapture['store'] {
  return slug === 'digital-text' ? 'kindle' : slug === 'books' ? 'books' : 'other';
}

function largestCover(attr: string | undefined, fallback: string | undefined): string | null {
  if (attr) {
    try {
      const map = JSON.parse(attr) as Record<string, [number, number]>;
      let best: string | null = null;
      let area = -1;
      for (const [url, dims] of Object.entries(map)) {
        const a = (dims[0] ?? 0) * (dims[1] ?? 0);
        if (a > area) {
          area = a;
          best = url;
        }
      }
      if (best) return best;
    } catch {
      /* fall through */
    }
  }
  return fallback ?? null;
}

function nodeFromHref(href: string | undefined): string | null {
  const m = href?.match(/\/(\d{5,})(?:\/|$|\?)/);
  return m ? m[1]! : null;
}

export function parseListPage(html: string): ListCapture {
  const $ = cheerio.load(html);
  const issues: ParseIssue[] = [];

  const canonical = $('link[rel=canonical]').attr('href') ?? '';
  const marketplace = marketplaceFromUrl(canonical) ?? 'unknown';
  const cm = canonical.match(/\/(?:zgbs|bestsellers)\/([a-z-]+)\/(\d+)/);
  const storeSlug = cm?.[1] ?? '';
  const nodeId = cm?.[2] ?? '';
  if (!cm) issues.push({ field: 'canonical', severity: 'error', detail: `cannot read store/node from "${canonical}"` });

  // Category breadcrumb: nested lists of the form [ancestor, [ancestor, [... siblings and the current node]]]
  const categoryPath: CategoryRef[] = [];
  let ul: Cheerio<AnyNode> = $('[class*=zg-browse-root]').first();
  for (let guard = 0; guard < 12; guard++) {
    const lis = ul.children('li');
    const nested = lis.eq(1).find('> span > ul, > ul').first();
    if (lis.length === 2 && nested.length) {
      const a = lis.eq(0).find('a').first();
      categoryPath.push({ name: clean(a.text()) ?? '', nodeId: nodeFromHref(a.attr('href')) });
      ul = nested;
    } else break;
  }
  const currentEl = $('[aria-current=page][class*=zg-selected]').first();
  const categoryName = (clean(currentEl.clone().children().remove().end().text()) ?? clean($('h1').first().text()) ?? '').replace(/^Best Sellers in\s+/i, '');
  if (!currentEl.length) issues.push({ field: 'categoryName', severity: 'warn', detail: 'current category marker not found' });

  const tab = $('[role=tablist] [aria-current=page]').first();
  const listKind: ListKind = tab.length ? (/free/i.test(tab.text()) ? 'free' : 'paid') : 'bestsellers';

  const page = parseIntLoose($('.a-pagination li.a-selected').attr('aria-label')) ?? 1;

  // All listed ASINs with ranks
  const recsAttr = $('[data-client-recs-list]').first().attr('data-client-recs-list');
  const listed = new Map<string, number>();
  if (recsAttr) {
    try {
      const recs = JSON.parse(recsAttr) as { id: string; metadataMap: Record<string, string> }[];
      for (const r of recs) listed.set(r.id, Number(r.metadataMap['render.zg.rank']));
    } catch {
      issues.push({ field: 'data-client-recs-list', severity: 'error', detail: 'JSON did not parse' });
    }
  } else issues.push({ field: 'data-client-recs-list', severity: 'warn', detail: 'missing; ranks come only from rendered rows' });

  const rendered = new Map<string, ListEntry>();
  $('#gridItemRoot').each((_, el) => {
    const row = $(el);
    const asin = row.find('[data-asin]').first().attr('data-asin') ?? '';
    if (!asin) return;
    const rank = parseIntLoose(row.find('.zg-bdg-text').first().text()) ?? listed.get(asin) ?? 0;
    const img = row.find('img.p13n-product-image').first();
    const authorLink = row.find('a[href*="/e/"]').first();
    let authorRaw: string | null = null;
    let authorId: string | null = null;
    if (authorLink.length) {
      authorRaw = clean(authorLink.text());
      authorId = authorLink.attr('href')?.match(/\/e\/([A-Z0-9]{10})/)?.[1] ?? null;
    } else {
      authorRaw = clean(row.find('.a-row.a-size-small > span.a-size-small.a-color-base').first().text());
    }
    const rating = row.find('a[aria-label*="out of 5 stars"]').first().attr('aria-label') ?? '';
    const rm = rating.match(/([\d.]+) out of 5 stars(?:,\s*([\d,]+) rating)?/);
    const stdPrice = row.find('[class*=p13n-sc-price_]').first();
    const offerPrice = row.find('span.p13n-sc-price').first();
    const priceNode = stdPrice.length ? stdPrice : offerPrice;
    rendered.set(asin, {
      rank,
      asin,
      rendered: true,
      titleRaw: clean(img.attr('alt')) ?? clean(row.find('[class*=line-clamp-1]').first().text()),
      authorRaw,
      authorId,
      ratingValue: rm ? Number(rm[1]) : null,
      ratingCount: rm?.[2] ? parseIntLoose(rm[2]) : null,
      format: clean(row.find('span.a-color-secondary.a-text-normal').first().text()),
      price: parsePrice(priceNode.text()),
      priceLayout: stdPrice.length ? 'standard' : offerPrice.length ? 'offer_from' : null,
      formatsAvailable: parseIntLoose(row.find('.zg-book-title-format-text').first().text()),
      coverUrl: largestCover(img.attr('data-a-dynamic-image'), img.attr('src')),
    });
  });

  const entries: ListEntry[] = [];
  for (const [asin, rank] of listed) {
    entries.push(
      rendered.get(asin) ?? {
        rank, asin, rendered: false, titleRaw: null, authorRaw: null, authorId: null, ratingValue: null,
        ratingCount: null, format: null, price: null, priceLayout: null, formatsAvailable: null, coverUrl: null,
      },
    );
    rendered.delete(asin);
  }
  for (const e of rendered.values()) entries.push(e); // rendered but not in the JSON (should not happen)
  entries.sort((a, b) => a.rank - b.rank);

  if (listed.size === 0 && entries.length === 0) issues.push({ field: 'entries', severity: 'error', detail: 'no list entries found' });

  return {
    marketplace, storeSlug, store: storeOf(storeSlug), nodeId, categoryName, categoryPath, listKind, page,
    listedCount: listed.size || entries.length, renderedCount: entries.filter((e) => e.rendered).length, entries, issues,
  };
}
