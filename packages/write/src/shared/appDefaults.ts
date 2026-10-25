import { clampLevel } from './chapters';
import { defaultBookDetails, sanitizeBookDetails, type BookDetails } from './export/model';

/**
 * Settings that apply to every book: which heading level starts a chapter, plus a template that
 * new books (files marked for export for the first time) start from. The template is a whole
 * BookDetails so the Settings dialog can use exactly the same forms as Book Details.
 */
export interface AppDefaults {
  /** The heading level (1–6) that starts a chapter. */
  chapterLevel: number;
  /** Front/back matter and export variables for new books. Title and subtitle are always blank here. */
  book: BookDetails;
}

/** A blank year in the template means "the current year when the book is created". */
function normalizeTemplate(book: BookDetails): BookDetails {
  return {
    ...book,
    marked: true,
    title: '',
    subtitle: '',
    export: { ...book.export, excludedChapters: [], epub: { ...book.export.epub, coverImage: '' } }
  };
}

export function defaultAppDefaults(): AppDefaults {
  const book = defaultBookDetails({ title: '', author: '' });
  book.copyright.year = '';
  return { chapterLevel: 1, book: normalizeTemplate(book) };
}

export function sanitizeAppDefaults(raw: unknown): AppDefaults {
  const d = defaultAppDefaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  const rawBook = r.book && typeof r.book === 'object' && !Array.isArray(r.book) ? (r.book as Record<string, unknown>) : null;
  let book = d.book;
  if (rawBook) {
    book = sanitizeBookDetails(rawBook);
    // sanitize fills a missing year with the current one; the template keeps "blank = current year"
    const rawCopyright = rawBook.copyright as Record<string, unknown> | undefined;
    if (!rawCopyright || typeof rawCopyright.year !== 'string') book.copyright.year = '';
  }
  return { chapterLevel: clampLevel(r.chapterLevel), book: normalizeTemplate(book) };
}

/** What a brand-new book starts as: the template, titled from its file name. */
export function bookFromDefaults(defaults: AppDefaults, seed: { title: string; year?: number }): BookDetails {
  const book = structuredClone(defaults.book);
  book.title = seed.title;
  book.marked = true;
  if (!book.copyright.year.trim()) book.copyright.year = String(seed.year ?? new Date().getFullYear());
  return sanitizeBookDetails(book, { title: seed.title });
}
