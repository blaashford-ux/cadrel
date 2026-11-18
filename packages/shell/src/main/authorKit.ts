/**
 * What Write's Book Details form can take from Cadrel: the author's profile and their published books (My Books), with each book's series and
 * place in it from the catalogue when the book is there. Electron-free; tested in test/authorKit.test.ts.
 */
import type { AuthorKit, AuthorKitBook } from '@cadrel/write/src/shared/api';

export interface KitSources {
  profile: { displayName: string; penNames: string[]; bio: string; patreonUrl: string; patreonCta: string };
  /** My Books: the books Market knows as the studio's own. */
  own: { asin: string; title: string | null; penNames: string[] }[];
  /** The catalogue's books with their editions, and its series; empty where there is none. */
  books: { title: string; penName?: string; seriesId: string | null; position: number | null; editions: { asin: string | null }[] }[];
  series: { id: string; name: string }[];
}

/** Where a book is sold: the Amazon page for its ASIN. */
export const bookUrl = (asin: string): string => `https://www.amazon.com/dp/${asin}`;

/** A description from a book page as plain paragraphs: tags and entities removed, breaks kept as blank lines. */
export function plainBlurb(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;/g, '’')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildAuthorKit(s: KitSources): AuthorKit {
  const seriesName = new Map(s.series.map((x) => [x.id, x.name]));
  const byAsin = new Map<string, { series: string | null; position: number | null }>();
  for (const b of s.books) for (const e of b.editions) if (e.asin) byAsin.set(e.asin, { series: b.seriesId ? seriesName.get(b.seriesId) ?? null : null, position: b.position });
  const books: AuthorKitBook[] = s.own.map((o) => {
    const c = byAsin.get(o.asin);
    return { asin: o.asin, title: o.title?.trim() || o.asin, url: bookUrl(o.asin), penNames: o.penNames, series: c?.series ?? null, position: c?.position ?? null };
  });
  // Books only the catalogue has (the person has no KDP library on this computer, or the book is not in it) are offered too, with the pen name the catalogue gives
  const have = new Set(books.map((b) => b.asin));
  for (const b of s.books) {
    const asin = b.editions.find((e) => e.asin)?.asin;
    if (!asin || have.has(asin)) continue;
    have.add(asin);
    books.push({ asin, title: b.title, url: bookUrl(asin), penNames: b.penName ? [b.penName] : [], series: b.seriesId ? seriesName.get(b.seriesId) ?? null : null, position: b.position });
  }
  return { profile: s.profile, books };
}
