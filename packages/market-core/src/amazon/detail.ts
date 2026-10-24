import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { DetailCapture, FormatOffer, ParseIssue, Person, RankEntry, ReviewItem } from '../types.js';
import { Docs, clean, loadDocs, marketplaceFromUrl, parseIntLoose, parseLongDate, parsePrice } from './util.js';

type El = Cheerio<AnyNode>;

const storeFromSlug = (s: string | undefined): RankEntry['store'] => (s === 'digital-text' ? 'kindle' : s === 'books' ? 'books' : 'other');

function blockText(el: El): string | null {
  const c = el.clone();
  c.find('br').replaceWith('\n');
  const html = c.html() ?? '';
  const text = html
    .replace(/<\/(p|div|li|h\d)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
  const out = text.split('\n').map((l) => l.replace(/[ \t‎‏]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out === '' ? null : out;
}

function parseRanks(d: Docs): RankEntry[] {
  const li = d.all('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li').find((l) => /Best Sellers Rank/i.test(l.text()));
  if (!li) return [];
  const ranks: RankEntry[] = [];
  const own = li.clone();
  own.find('ul').remove();
  const om = clean(own.text())?.match(/#\s*([\d,]+)\s+in\s+([^(]+?)\s*(?:\(|$)/);
  if (om) ranks.push({ store: 'other', scope: 'overall', name: om[2]!.trim(), nodeId: null, rank: parseIntLoose(om[1])! });
  if (ranks[0]) ranks[0].store = /kindle/i.test(ranks[0].name) ? 'kindle' : /books/i.test(ranks[0].name) ? 'books' : 'other';
  li.find('ul li').each((_, n) => {
    const row = li.find(n as never);
    const t = clean(row.text()) ?? '';
    const rm = t.match(/#\s*([\d,]+)\s+in\b/);
    const a = row.find('a').first();
    if (!rm || !a.length) return;
    const href = a.attr('href') ?? '';
    const hm = href.match(/\/bestsellers\/([a-z-]+)\/(\d+)/);
    let name = clean(a.text()) ?? '';
    let store = storeFromSlug(hm?.[1]);
    const pm = name.match(/\s*\((Kindle Store|Books)\)\s*$/);
    if (pm) {
      name = name.slice(0, pm.index).trim();
      if (!hm) store = pm[1] === 'Books' ? 'books' : 'kindle';
    }
    ranks.push({ store, scope: 'category', name, nodeId: hm?.[2] ?? null, rank: parseIntLoose(rm[1])! });
  });
  return ranks;
}

function parseReviews(d: Docs): ReviewItem[] {
  return d.all('[data-hook=review]').map((r) => {
    const stars = parseIntLoose(r.find('[data-hook=review-star-rating] .a-icon-alt, [data-hook=cmps-review-star-rating] .a-icon-alt').first().text());
    const titleEl = r.find('[data-hook=reviewTitle]').first();
    titleEl.find('.a-icon-alt').remove();
    const dateLine = clean(r.find('[data-hook=review-date]').first().text()) ?? '';
    const dm = dateLine.match(/Reviewed in (?:the )?(.+?) on (.+)$/);
    const helpful = clean(r.find('[data-hook=helpful-vote-statement]').first().text());
    const body = r.find('[data-hook=reviewRichContentContainer]').first();
    return {
      stars,
      title: clean(titleEl.text()),
      country: dm?.[1] ?? null,
      date: parseLongDate(dm?.[2]),
      verified: r.find('[data-hook=avp-badge]').length > 0,
      format: clean(r.find('[data-hook=format-strip]').first().text())?.replace(/^Format:\s*/i, '') ?? null,
      helpfulVotes: helpful ? (/^One\b/i.test(helpful) ? 1 : parseIntLoose(helpful)) : null,
      body: body.length ? blockText(body) : null,
    };
  });
}

export function parseDetailPage(html: string): DetailCapture {
  const d = new Docs(loadDocs(html));
  const issues: ParseIssue[] = [];
  const need = <T>(field: string, v: T | null | undefined): T | null => {
    if (v == null || (Array.isArray(v) && v.length === 0)) issues.push({ field, severity: 'warn', detail: 'not found' });
    return v ?? null;
  };

  const canonicalUrl = d.first('link[rel=canonical]')?.attr('href') ?? null;

  // details list: "Label ‏ : ‎ value", kept verbatim
  const detailRows: Record<string, string> = {};
  for (const li of d.all('#detailBullets_feature_div > ul > li, #detailBullets_feature_div li')) {
    if (li.find('ul').length) continue;
    const t = clean(li.text());
    const m = t?.match(/^([^:]{1,60}?)\s*:\s*(.+)$/);
    if (m && !(m[1]! in detailRows)) detailRows[m[1]!.trim()] = m[2]!.trim();
  }

  const asin = canonicalUrl?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? detailRows['ASIN'] ?? null;
  if (!asin) issues.push({ field: 'asin', severity: 'error', detail: 'no ASIN in canonical URL or details' });

  const title = need('title', clean(d.first('#productTitle')?.text()));

  const authors: Person[] = [];
  for (const sp of d.all('#bylineInfo span.author')) {
    const a = sp.find('a').first();
    const name = clean(a.text());
    if (!name) continue;
    authors.push({
      name,
      authorId: a.attr('href')?.match(/\/e\/([A-Z0-9]{10})/)?.[1] ?? null,
      role: clean(sp.find('.contribution').text())?.replace(/[(),]/g, '').trim() || null,
    });
  }
  need('authors', authors);

  const seriesText = clean(d.first('#seriesBulletWidget_feature_div')?.text());
  const sm = seriesText?.match(/Book\s+(\d+)\s+of\s+(\d+)\s*:\s*(.+)$/i) ?? null;
  const series = sm ? { name: sm[3]!.trim(), position: Number(sm[1]), total: Number(sm[2]) } : null;

  const ratingValue = (() => {
    const t = d.first('#acrPopover')?.attr('title') ?? d.first('[data-hook=rating-out-of-text]')?.text();
    const m = t?.match(/([\d.]+) out of 5/);
    return m ? Number(m[1]) : null;
  })();
  const ratingCount =
    parseIntLoose(d.first('[data-hook=total-review-count]')?.text()) ?? parseIntLoose(d.first('#acrCustomerReviewText')?.text());
  need('ratingValue', ratingValue);

  const histogram: Record<string, number> = {};
  for (const a of d.all('#histogramTable a[aria-label]')) {
    const m = a.attr('aria-label')?.match(/(\d+) percent of reviews have (\d) star/);
    if (m) histogram[m[2]!] = Number(m[1]);
  }

  const formats: FormatOffer[] = d.all('#tmmSwatches .swatchElement').map((sw) => {
    const id = sw.attr('id') ?? '';
    const priceText = clean(sw.find('.slot-price').first().text());
    return {
      code: id.replace(/^tmm-grid-swatch-/, ''),
      label: clean(sw.find('.slot-title span').first().text()) ?? id,
      priceText,
      price: parsePrice(priceText),
      note: clean(sw.find('.slot-extraMessage').first().text()),
    };
  });
  need('formats', formats);
  const kindlePrice = formats.find((f) => f.code === 'KINDLE')?.price ?? null;

  // book details: details list first, "rich product information" carousel as a fallback
  const rpi = (key: string) => clean(d.first(`#rpi-attribute-book_details-${key} .rpi-attribute-value`)?.text());
  const pages = parseIntLoose(detailRows['Print length'] ?? rpi('ebook_pages'));
  const publicationDate = parseLongDate(detailRows['Publication date'] ?? rpi('publication_date'));
  const fsm = (detailRows['File size'] ?? rpi('file_size'))?.match(/([\d.]+)\s*(KB|MB|GB)/i);
  const fileSizeMb = fsm ? Number(fsm[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[fsm[2]!.toUpperCase() as 'KB'] ?? 1) : null;
  const publisher = detailRows['Publisher']?.replace(/\s*\([^)]*\)\s*$/, '').trim() ?? null;
  need('pages', pages);
  need('publicationDate', publicationDate);

  const descEl = d.first('#bookDescription_feature_div .a-expander-content') ?? d.first('#bookDescription_feature_div');
  const description = need('description', descEl ? blockText(descEl) : null);

  const coverUrl =
    html.match(/"hiRes":"(https:[^"]+)"/)?.[1] ??
    (() => {
      const m = d.first('#landingImage, #ebooksImgBlkFront, #imgBlkFront')?.attr('data-a-dynamic-image');
      if (!m) return null;
      try {
        return Object.keys(JSON.parse(m) as Record<string, unknown>).pop() ?? null;
      } catch {
        return null;
      }
    })();
  need('coverUrl', coverUrl);

  const ranks = parseRanks(d);
  need('ranks', ranks);

  const reviews = parseReviews(d);

  const asinsIn = (sel: string) => [...new Set(d.all(`${sel} a[href*="/dp/"]`).map((a) => a.attr('href')?.match(/\/dp\/([A-Z0-9]{10})/)?.[1]).filter((x): x is string => !!x))].filter((x) => x !== asin);
  const sponsored = [...new Set(d.all('[id^=sp_detail2_B]').map((e) => e.attr('id')?.match(/^sp_detail2_(B[0-9A-Z]{9})$/)?.[1]).filter((x): x is string => !!x))];

  return {
    asin, marketplace: marketplaceFromUrl(canonicalUrl), canonicalUrl, title, authors, series, ratingValue, ratingCount,
    histogram: Object.keys(histogram).length ? { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0, ...histogram } : null, formats, kindlePrice, pages, publicationDate, publisher,
    language: detailRows['Language'] ?? null, isbn13: detailRows['ISBN-13'] ?? null, fileSizeMb, description, coverUrl, ranks, reviews,
    relatedAsins: asinsIn('#sims-simsContainer_feature_div_0'), sponsoredAsins: sponsored,
    editorialReviews: (() => { const e = d.first('#editorialReviews_feature_div'); return e ? blockText(e) : null; })(),
    aboutAuthor: (() => { const e = d.first('#moreAboutTheAuthorCard_feature_div'); return e ? blockText(e) : null; })(),
    hasAplus: (clean(d.first('#aplus_feature_div')?.text())?.length ?? 0) > 20,
    hasCustomersSay: /Customers say/.test(html),
    hasReadSample: !!d.first('#ebooksReadSampleButton'),
    detailRows, issues,
  };
}
