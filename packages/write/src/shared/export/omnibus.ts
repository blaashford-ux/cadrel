/**
 * An omnibus: several manuscripts exported as one book. Each book keeps its own Book Details (its title, subtitle, dedication, epigraph and which
 * chapters it leaves out) and contributes a title page and its chapters; the omnibus has details of its own (title, author, ISBN, cover) and one
 * set of front and back matter. It is built as one Markdown source and one set of Book Details, then goes through the same export as any book,
 * so every output (EPUB, print PDF, DOCX) and every setting works the same way.
 *
 * Pure and Electron-free; tested in omnibus.test.ts.
 */
import { splitChapters } from '../chapters';
import { countWords } from '../words';
import { isBackMatterTitle } from './assemble';
import { numberToWords } from './headings';
import type { BookDetails } from './model';

export interface OmnibusRecipe {
  title: string;
  subtitle: string;
  author: string;
  /** The omnibus's own ISBN. The books' ISBNs are never carried over. */
  isbn: string;
  /** Absolute path to the omnibus's cover (JPEG or PNG); empty for none. */
  coverImage: string;
  /** Relative to the project, "/" separated, in reading order. */
  files: string[];
  outputs: { epub: boolean; pdf: boolean; docx: boolean };
  /** Each book's title page says "Book 1: Title" rather than only the title. */
  numberBooks: boolean;
  /** Each book's title page carries its own dedication and epigraph (when its Book Details have them). */
  bookFront: boolean;
  /** Keep every book's own back-matter chapters (About the Author, Acknowledgements…). Off: only the last book's are kept. */
  allBackMatter: boolean;
}

export function defaultOmnibusRecipe(seed: Partial<OmnibusRecipe> = {}): OmnibusRecipe {
  return { title: '', subtitle: '', author: '', isbn: '', coverImage: '', files: [], outputs: { epub: true, pdf: true, docx: false }, numberBooks: true, bookFront: true, allBackMatter: false, ...seed };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** A recipe read from a project's metadata. `safe` says whether a relative path is acceptable (no "..", not absolute). Null for anything that is not one. */
export function sanitizeOmnibusRecipe(raw: unknown, safe: (p: string) => boolean = () => true): OmnibusRecipe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const o = r.outputs && typeof r.outputs === 'object' ? (r.outputs as Record<string, unknown>) : {};
  const files = (Array.isArray(r.files) ? r.files : []).filter((f): f is string => typeof f === 'string').map((f) => f.replace(/\\/g, '/')).filter((f) => safe(f));
  const d = defaultOmnibusRecipe();
  return {
    title: str(r.title, 200),
    subtitle: str(r.subtitle, 200),
    author: str(r.author, 200),
    isbn: str(r.isbn, 40),
    coverImage: str(r.coverImage, 1000),
    files: [...new Set(files)].slice(0, 100),
    outputs: { epub: bool(o.epub, d.outputs.epub), pdf: bool(o.pdf, d.outputs.pdf), docx: bool(o.docx, d.outputs.docx) },
    numberBooks: bool(r.numberBooks, d.numberBooks),
    bookFront: bool(r.bookFront, d.bookFront),
    allBackMatter: bool(r.allBackMatter, d.allBackMatter)
  };
}

/** What the dialog shows for each manuscript, taken from its Book Details and its text. */
export interface OmnibusBookInfo {
  path: string;
  title: string;
  subtitle: string;
  author: string;
  chapters: number;
  words: number;
  /** Whether Book Details exist for it yet (otherwise the title is its file name and the author is empty). */
  hasDetails: boolean;
  chapterLevel: number;
}

export interface OmnibusBook {
  path: string;
  source: string;
  details: BookDetails;
  chapterLevel: number;
}

export interface OmnibusPart {
  path: string;
  heading: string;
  chapters: number;
  words: number;
  /** Chapters left out because the book's own Book Details exclude them, or because they are back matter of a book that is not the last. */
  left: number;
}
export interface Composed {
  source: string;
  details: BookDetails;
  chapterLevel: number;
  parts: OmnibusPart[];
  errors: string[];
  warnings: string[];
}

/** Text that goes on a Markdown line without being read as Markdown. */
const plain = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]<>#])/g, '\\$1');
const paragraphs = (s: string): string[] => s.split(/\r?\n\s*\r?\n/).map((p) => p.trim().replace(/\r?\n/g, '  \n')).filter(Boolean);
const centred = (md: string): string => `::: center\n${md}\n:::\n\n`;

/** The title the omnibus suggests for a project's books. */
export const suggestOmnibusTitle = (projectName: string): string => (projectName.trim() ? `${projectName.trim()} Omnibus` : '');

/**
 * One Markdown source and one set of Book Details for the omnibus. The books' text is carried over as written (chapters left out by a book's own
 * Book Details stay out); each book is introduced by a title page made like a chapter, so it appears in every output's contents.
 */
export function composeOmnibus(recipe: OmnibusRecipe, books: OmnibusBook[]): Composed {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parts: OmnibusPart[] = [];
  if (books.length < 2) errors.push('An omnibus needs at least two manuscripts. Pick the books to put together.');
  if (!recipe.title.trim()) errors.push('The omnibus needs a title.');
  const levels = new Set(books.map((b) => b.chapterLevel));
  if (levels.size > 1) errors.push('These manuscripts start their chapters at different heading levels, so they cannot be joined. Set the same chapter heading level on each.');
  const level = books[0]?.chapterLevel ?? 1;
  const first = books[0];
  const last = books[books.length - 1];
  if (!first || !last) return { source: '', details: placeholderDetails(), chapterLevel: level, parts, errors, warnings };

  const authors = [...new Set(books.map((b) => b.details.author.trim()).filter(Boolean))];
  const author = recipe.author.trim() || first.details.author.trim();
  if (authors.length > 1 && !recipe.author.trim()) warnings.push(`The books name different authors (${authors.join(', ')}). The omnibus uses ${author}; change it above if that is not right.`);
  if (!author) errors.push('The omnibus needs an author or pen name.');

  const style = first.details.export.chapterHeading;
  const chunks: string[] = [];
  books.forEach((b, i) => {
    const doc = splitChapters(b.source, level);
    const excluded = new Set(b.details.export.excludedChapters);
    const keepBack = recipe.allBackMatter || b === last;
    let left = 0;
    let words = 0;
    const kept = doc.chapters.filter((c) => {
      if (c.isPreamble) return false;
      if (excluded.has(c.title) || (!keepBack && isBackMatterTitle(c.title))) {
        left++;
        return false;
      }
      return true;
    });
    if (kept.length === 0) {
      errors.push(`“${b.details.title.trim() || b.path}” has no chapters to include. Every chapter needs a Heading ${level}.`);
      return;
    }
    const title = b.details.title.trim() || b.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
    const label = recipe.numberBooks ? (style === 'numberWord' ? `Book ${i + 1}: ${title}` : `Book ${numberToWords(i + 1)}: ${title}`) : title;
    let page = `${'#'.repeat(level)} ${plain(label)}\n\n`;
    let body = '';
    if (b.details.subtitle.trim()) body += centred(`*${plain(b.details.subtitle)}*`);
    if (recipe.bookFront && b.details.dedication.enabled && b.details.dedication.text.trim()) body += centred(paragraphs(b.details.dedication.text).map((p) => `*${plain(p)}*`).join('\n\n'));
    if (recipe.bookFront && b.details.epigraph.enabled && b.details.epigraph.text.trim()) {
      body += centred(paragraphs(b.details.epigraph.text).map((p) => `*${plain(p)}*`).join('\n\n') + (b.details.epigraph.attribution.trim() ? `\n\n${plain(b.details.epigraph.attribution)}` : ''));
    }
    page += body || centred(plain(b.details.author.trim() || author));
    chunks.push(page.trimEnd());
    for (const c of kept) {
      chunks.push(c.raw.trimEnd());
      words += countWords(c.raw);
    }
    if (left > 0) warnings.push(`${left} chapter${left === 1 ? '' : 's'} of “${title}” ${left === 1 ? 'was' : 'were'} left out (excluded in its Book Details, or back matter of a book that is not the last).`);
    parts.push({ path: b.path, heading: label, chapters: kept.length, words, left });
  });

  // the omnibus's own details: its title and author, one set of front and back matter, no book's ISBN, and the layout of the first book
  const base: BookDetails = structuredClone(last.details);
  base.marked = false;
  base.title = recipe.title.trim();
  base.subtitle = recipe.subtitle.trim();
  base.author = author;
  base.copyright.isbn = recipe.isbn.trim();
  base.copyright.edition = '';
  base.dedication = { enabled: false, text: '' };
  base.epigraph = { enabled: false, text: '', attribution: '' };
  base.export = structuredClone(first.details.export);
  base.export.excludedChapters = [];
  base.export.outputs = { ...recipe.outputs };
  base.export.epub.coverImage = recipe.coverImage.trim();
  return { source: chunks.join('\n\n') + '\n', details: base, chapterLevel: level, parts, errors, warnings };
}

/** Never shown; keeps the result well-formed when there is nothing to compose. */
function placeholderDetails(): BookDetails {
  return { version: 1, marked: false, title: '', subtitle: '', author: '' } as unknown as BookDetails;
}

/** What the dialog needs to describe one manuscript: its Book Details and how much text there is. */
export function describeBook(path: string, source: string, details: BookDetails | null, chapterLevel: number): OmnibusBookInfo {
  const doc = splitChapters(source, chapterLevel);
  const chapters = doc.chapters.filter((c) => !c.isPreamble);
  const fallback = path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
  return {
    path,
    title: details?.title.trim() || fallback,
    subtitle: details?.subtitle.trim() ?? '',
    author: details?.author.trim() ?? '',
    chapters: chapters.length,
    words: chapters.reduce((n, c) => n + countWords(c.raw), 0),
    hasDetails: !!details && !!details.title.trim(),
    chapterLevel
  };
}

/** Moves one entry of a list up or down, for the order of the books. */
export function moveItem<T>(list: readonly T[], i: number, delta: -1 | 1): T[] {
  const j = i + delta;
  if (j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
