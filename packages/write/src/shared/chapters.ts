/**
 * Lossless chapter splitting for Markdown files.
 *
 * A chapter starts at each heading of the chosen level (default 1: ATX `# Title` or Setext `Title` + `===`;
 * level 2 also accepts Setext `---`). Text before the first such heading is a "preamble" chapter. Each chapter keeps its exact
 * original text (`raw`, including line endings), so joinChapters(splitChapters(x)) === x
 * and editing one chapter never alters the others.
 */

export interface Chapter {
  /** Heading text, or '' for a preamble. */
  title: string;
  /** True for the text before the first H1 (front matter, intro). */
  isPreamble: boolean;
  /** Exact source text of this chapter, line endings included. */
  raw: string;
}

export interface MarkdownDoc {
  chapters: Chapter[];
  /** Leading UTF-8 BOM, if the file had one. */
  bom: string;
  /** Dominant line ending, used for newly written text. */
  eol: '\n' | '\r\n';
  /** Which heading level starts a chapter (1–6). */
  level: number;
}

export const MIN_CHAPTER_LEVEL = 1;
export const MAX_CHAPTER_LEVEL = 6;

export function clampLevel(level: unknown): number {
  return typeof level === 'number' && Number.isFinite(level)
    ? Math.min(MAX_CHAPTER_LEVEL, Math.max(MIN_CHAPTER_LEVEL, Math.round(level)))
    : 1;
}

const atxHeading = (level: number) => new RegExp(`^ {0,3}#{${level}}(?:[ \\t]+(.*?))?[ \\t]*$`);
const ANY_ATX = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_UNDERLINE: Record<number, RegExp> = { 1: /^ {0,3}=+[ \t]*$/, 2: /^ {0,3}-+[ \t]*$/ };
const BLOCK_STARTER = /^(?: {4,}|\t|>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|#|`{3,}|~{3,}|<)/;

function stripClosingHashes(s: string): string {
  return s.replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
}

export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

interface Line {
  /** Line content without terminator. */
  text: string;
  /** Offset of the line start within the source. */
  start: number;
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    lines.push({ text: text.slice(start, m.index), start });
    start = m.index + m[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), start });
  return lines;
}

export function splitChapters(source: string, levelIn = 1): MarkdownDoc {
  const level = clampLevel(levelIn);
  const ATX = atxHeading(level);
  const setext = SETEXT_UNDERLINE[level];
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const text = bom ? source.slice(1) : source;
  const lines = toLines(text);
  const eol = detectEol(text);

  const starts: { offset: number; title: string }[] = [];
  let i = 0;

  // YAML front matter belongs to the preamble; '#' comments inside it are not headings.
  if (lines.length > 0 && /^---[ \t]*$/.test(lines[0].text)) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j].text)) {
        i = j + 1;
        break;
      }
    }
  }

  let fence: { char: string; len: number } | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i].text;

    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) fence = null;
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length };
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      starts.push({ offset: lines[i].start, title: stripClosingHashes(atx[1] ?? '') });
      continue;
    }

    // Setext: a one-line paragraph followed by ===
    const prev = i > 0 ? lines[i - 1].text : '';
    const startsParagraph = i === 0 || prev.trim() === '' || ANY_ATX.test(prev);
    if (
      setext &&
      startsParagraph &&
      line.trim() !== '' &&
      !BLOCK_STARTER.test(line) &&
      i + 1 < lines.length &&
      setext.test(lines[i + 1].text)
    ) {
      starts.push({ offset: lines[i].start, title: line.trim() });
      i++; // skip the underline
    }
  }

  const chapters: Chapter[] = [];
  const firstOffset = starts.length ? starts[0].offset : text.length;
  if (firstOffset > 0 || starts.length === 0) {
    chapters.push({ title: '', isPreamble: true, raw: text.slice(0, firstOffset) });
  }
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].offset : text.length;
    chapters.push({ title: s.title, isPreamble: false, raw: text.slice(s.offset, end) });
  });

  return { chapters, bom, eol, level };
}

export function joinChapters(doc: MarkdownDoc): string {
  return doc.bom + doc.chapters.map((c) => c.raw).join('');
}

/**
 * Replace one chapter's text, leaving all others byte-identical.
 * Newlines in `newRaw` are normalised to the document's line ending. The chapter keeps
 * its original run of trailing newlines (blank lines before the next heading, or no final
 * newline at end of file), because WYSIWYG editors don't preserve those.
 * Returns a new document (the input is not mutated).
 */
export function updateChapter(doc: MarkdownDoc, index: number, newRaw: string): MarkdownDoc {
  if (index < 0 || index >= doc.chapters.length) throw new RangeError(`No chapter at index ${index}`);
  const trailing = /(?:\r\n|\r|\n)*$/.exec(doc.chapters[index].raw)![0];
  const isLast = index === doc.chapters.length - 1;
  const body = newRaw.replace(/(?:\r\n|\r|\n)+$/, '').replace(/\r\n|\r|\n/g, doc.eol);
  // A non-last chapter must end in a newline so the next heading starts its own line.
  const raw = body === '' ? trailing : body + (trailing || (isLast ? '' : doc.eol));
  const old = doc.chapters[index];
  const title = old.isPreamble ? '' : (splitChapters(raw, doc.level).chapters.find((c) => !c.isPreamble)?.title ?? old.title);
  const chapters = doc.chapters.slice();
  chapters[index] = { ...old, title, raw };
  return { ...doc, chapters };
}

/** A chapter's text without line-ending differences or trailing newlines, for comparing content. */
export function chapterBody(raw: string): string {
  return raw.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Structural edits: add / move / delete a chapter. All return a fresh, re-split document so
// callers always see the real chapter boundaries of the text that will be written.
// ---------------------------------------------------------------------------

const endsWithNewline = (s: string) => /[\r\n]$/.test(s);

/** Every chapter except the last must end in a newline, or the next heading would be glued to it. */
function withSeparators(doc: MarkdownDoc, raws: string[]): string[] {
  return raws.map((r, i) => (i < raws.length - 1 && r !== '' && !endsWithNewline(r) ? r + doc.eol : r));
}

/** Rebuilds a document from chapter texts, keeping the file's original "no final newline" habit. */
function rebuild(doc: MarkdownDoc, raws: string[], keepFinalNewline: boolean): MarkdownDoc {
  const fixed = withSeparators(doc, raws);
  if (!keepFinalNewline && fixed.length > 0) {
    fixed[fixed.length - 1] = fixed[fixed.length - 1].replace(/(?:\r\n|\r|\n)+$/, '');
  }
  return { ...splitChapters(doc.bom + fixed.join(''), doc.level), bom: doc.bom };
}

/** Index of the chapter that starts at character `offset` (chapters partition the text). */
function indexAtOffset(doc: MarkdownDoc, offset: number): number {
  let pos = 0;
  for (let i = 0; i < doc.chapters.length; i++) {
    if (pos === offset) return i;
    pos += doc.chapters[i].raw.length;
  }
  return Math.max(0, doc.chapters.length - 1);
}

const hadFinalNewline = (doc: MarkdownDoc) => {
  const last = doc.chapters[doc.chapters.length - 1];
  return !last || last.raw === '' || endsWithNewline(last.raw);
};

/** Where chapter `index` starts once `raws` are joined with proper separators. */
const startOf = (doc: MarkdownDoc, raws: string[], index: number) =>
  withSeparators(doc, raws).slice(0, index).join('').length;

/** Inserts `# title` as a new chapter right after chapter `afterIndex`. */
export function insertChapter(doc: MarkdownDoc, afterIndex: number, title: string): { doc: MarkdownDoc; index: number } {
  const raws = doc.chapters.map((c) => c.raw);
  const at = Math.min(Math.max(afterIndex + 1, 0), raws.length);
  raws.splice(at, 0, `${'#'.repeat(doc.level)} ${title.trim()}${doc.eol}${doc.eol}`);
  const next = rebuild(doc, raws, hadFinalNewline(doc));
  return { doc: next, index: indexAtOffset(next, startOf(doc, raws, at)) };
}

/** Moves a real chapter up (-1) or down (+1). Returns null when that move isn't possible. */
export function moveChapter(doc: MarkdownDoc, index: number, delta: -1 | 1): { doc: MarkdownDoc; index: number } | null {
  const target = index + delta;
  const first = doc.chapters[0]?.isPreamble ? 1 : 0;
  if (index < first || index >= doc.chapters.length || target < first || target >= doc.chapters.length) return null;
  const raws = doc.chapters.map((c) => c.raw);
  [raws[index], raws[target]] = [raws[target], raws[index]];
  const next = rebuild(doc, raws, hadFinalNewline(doc));
  return { doc: next, index: indexAtOffset(next, startOf(doc, raws, target)) };
}

/** Removes a chapter (including its heading and everything under it). */
export function deleteChapter(doc: MarkdownDoc, index: number): MarkdownDoc | null {
  if (index < 0 || index >= doc.chapters.length) return null;
  const raws = doc.chapters.map((c) => c.raw);
  raws.splice(index, 1);
  return rebuild(doc, raws, hadFinalNewline(doc));
}

/** Rewrites every chapter's text with `fn`, then re-splits (the edit may have added or removed headings). */
export function mapChapters(doc: MarkdownDoc, fn: (raw: string, index: number) => string): MarkdownDoc {
  return rebuild(
    doc,
    doc.chapters.map((c, i) => fn(c.raw, i)),
    hadFinalNewline(doc)
  );
}
