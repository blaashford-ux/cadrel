/** Conveniences for filling in Book Details from what Cadrel already knows: saved blocks, My Books, the author's profile. Pure, so each is tested. */
import type { AuthorKitBook, BookCard } from './api';
import type { TitleItem } from './export/model';

/** A saved block put into a field: it replaces an empty field, and follows what is there (after a blank line) otherwise. */
export function insertText(current: string, block: string): string {
  const b = block.trim();
  if (!current.trim()) return b;
  return `${current.replace(/\s+$/, '')}\n\n${b}`;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The books to offer for "Also by": those published under this book's author name (all of them when none match, or when asked), without the
 * book being worked on, in series order (a series together, in reading order, then the standalone books by title).
 */
export function alsoByCandidates(books: AuthorKitBook[], o: { author: string; title: string; all?: boolean }): AuthorKitBook[] {
  const author = norm(o.author);
  const byAuthor = books.filter((b) => b.penNames.some((p) => norm(p) === author));
  const pool = !o.all && byAuthor.length ? byAuthor : books;
  return pool
    .filter((b) => norm(b.title) !== norm(o.title))
    .sort((a, b) => {
      if (!!a.series !== !!b.series) return a.series ? -1 : 1;
      if (a.series && b.series && a.series !== b.series) return a.series.localeCompare(b.series);
      const pa = a.position ?? Infinity;
      const pb = b.position ?? Infinity;
      return pa !== pb ? pa - pb : a.title.localeCompare(b.title);
    });
}

/** Adds the chosen books to the Also By list, leaving out any already on it (the same title, or the same link). */
export function addAlsoBy(items: TitleItem[], chosen: AuthorKitBook[], cards: (BookCard | null)[] = []): TitleItem[] {
  const have = new Set(items.flatMap((i) => [norm(i.title), i.url.trim()]).filter(Boolean));
  const out = [...items];
  chosen.forEach((b, i) => {
    if (have.has(norm(b.title)) || (b.url && have.has(b.url))) return;
    out.push({ title: b.title, url: b.url, blurb: cards[i]?.blurb ?? '', cover: cards[i]?.cover ?? '' });
    have.add(norm(b.title));
  });
  return out;
}

/** Whether a book is already on the list. */
export const onAlsoBy = (items: TitleItem[], b: AuthorKitBook): boolean => items.some((i) => norm(i.title) === norm(b.title) || (!!b.url && i.url.trim() === b.url));
