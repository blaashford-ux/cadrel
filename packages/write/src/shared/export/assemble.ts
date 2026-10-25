import { formatChapterHeading, type ChapterHeading } from './headings';
import { applySmartQuotes, parseManuscript, type Block } from './manuscript';
import { buildBackMatter, buildFrontMatter, type MatterPage } from './matter';
import type { BookDetails, ExportSettings } from './model';
import { countWords } from '../words';

export interface BuiltChapter {
  /** Stable id used for file names and links: chapter1, chapter2… */
  id: string;
  title: string;
  heading: ChapterHeading;
  blocks: Block[];
  words: number;
}

export interface TocEntry {
  id: string;
  label: string;
}

export interface BookBuild {
  meta: {
    id: string;
    title: string;
    subtitle: string;
    author: string;
    language: string;
    year: string;
    publisher: string;
    isbn: string;
    description: string;
    rights: string;
    modified: string;
  };
  front: MatterPage[];
  chapters: BuiltChapter[];
  back: MatterPage[];
  /** Real content only: chapters and back-matter pages. Never the title page, copyright page or Contents. */
  toc: TocEntry[];
  settings: ExportSettings;
  totalWords: number;
  warnings: string[];
}

export interface AssembleResult {
  build?: BookBuild;
  /** Problems that stop the export. */
  errors: string[];
}

export function assembleBook(
  source: string,
  details: BookDetails,
  env: { now?: Date; uuid?: () => string; chapterLevel?: number } = {}
): AssembleResult {
  const errors: string[] = [];
  if (!details.title.trim()) errors.push('The book needs a title (Book Details → Title page).');
  if (!details.author.trim()) errors.push('The book needs an author or pen name (Book Details → Title page).');

  const parsed = parseManuscript(source, env.chapterLevel);
  const warnings = [...parsed.warnings];
  const s = details.export;

  const excluded = new Set(s.excludedChapters);
  const kept = parsed.chapters.filter((c) => !excluded.has(c.title));
  if (excluded.size > 0) {
    const left = parsed.chapters.length - kept.length;
    if (left > 0) warnings.push(`${left} chapter${left === 1 ? ' was' : 's were'} excluded from this export.`);
  }
  if (kept.length === 0) {
    const lv = env.chapterLevel ?? 1;
    errors.push(`There are no chapters to export. Every chapter needs a Heading ${lv} (a line starting with “${'#'.repeat(lv)} ”).`);
  }
  if (errors.length) return { errors };

  const { manuscript, applied } = applySmartQuotes({ chapters: kept, warnings: [] }, s.smartQuotes);
  if (applied) warnings.push('Straight quotes were converted to typographic quotes.');

  const chapters: BuiltChapter[] = manuscript.chapters.map((c, i) => {
    const heading = formatChapterHeading(c.title, s.chapterHeading);
    return { id: `chapter${i + 1}`, title: c.title, heading, blocks: c.blocks, words: c.words };
  });

  const front = buildFrontMatter(details);
  const back = buildBackMatter(details, warnings);
  const now = env.now ?? new Date();
  const year = details.copyright.year.trim() || String(now.getFullYear());

  const toc: TocEntry[] = [
    ...chapters.map((c) => ({ id: c.id, label: c.heading.plain || '(untitled)' })),
    ...back.filter((p) => p.heading).map((p) => ({ id: `back-${p.id}`, label: p.heading! }))
  ];

  return {
    errors: [],
    build: {
      meta: {
        id: `urn:uuid:${(env.uuid ?? (() => globalThis.crypto.randomUUID()))()}`,
        title: details.title,
        subtitle: details.subtitle,
        author: details.author,
        language: s.epub.language,
        year,
        publisher: details.copyright.publisher,
        isbn: details.copyright.isbn,
        description: s.epub.description,
        rights: `Copyright © ${year} by ${details.author}`,
        modified: now.toISOString().replace(/\.\d+Z$/, 'Z')
      },
      front,
      chapters,
      back,
      toc,
      settings: s,
      totalWords: chapters.reduce((n, c) => n + c.words, 0) + countWords(front.map((p) => p.blocks.map((b) => ('text' in b ? b.text : '')).join(' ')).join(' ')),
      warnings
    }
  };
}
