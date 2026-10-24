/**
 * Line numbers. They count the lines of the whole Markdown file (1-based), so a number means the same
 * thing in any chapter and Go To can cross chapter boundaries.
 */
import { isCloser, openerAlign } from './align';
import type { MarkdownDoc } from './chapters';

const TERMINATOR = /\r\n|\n|\r/g;

/** Number of lines in `text` (a final line without a terminator still counts; empty text has none). */
export function countLines(text: string): number {
  if (text === '') return 0;
  const breaks = text.match(TERMINATOR)?.length ?? 0;
  return /(?:\r\n|\n|\r)$/.test(text) ? breaks : breaks + 1;
}

/** The file line on which chapter `index` starts. */
export function chapterStartLine(doc: MarkdownDoc, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < doc.chapters.length; i++) line += countLines(doc.chapters[i].raw);
  return line;
}

/** Total lines in the file (at least 1, so Go To always has somewhere to land). */
export function totalLines(doc: MarkdownDoc): number {
  return Math.max(1, chapterStartLine(doc, doc.chapters.length) - 1);
}

/**
 * Which chapter holds file line `line`, and which line of that chapter (1-based) it is.
 * Out-of-range numbers clamp to the first/last line of the file.
 */
export function locateLine(doc: MarkdownDoc, line: number): { chapter: number; line: number } {
  const target = Math.min(Math.max(1, Math.floor(line)), totalLines(doc));
  let start = 1;
  let last = 0;
  for (let i = 0; i < doc.chapters.length; i++) {
    const n = countLines(doc.chapters[i].raw);
    if (n > 0) last = i;
    if (target < start + n) return { chapter: i, line: target - start + 1 };
    start += n;
  }
  return { chapter: last, line: Math.max(1, countLines(doc.chapters[last]?.raw ?? '')) };
}

export interface BlockLines {
  /** First line of the block, 1-based within the text. */
  start: number;
  /** Last line of the block. */
  end: number;
}

/**
 * Splits Markdown into blocks the way the formatted editor sees them: runs of lines separated by
 * blank lines (blank lines inside a code fence do not split it). Used to give each paragraph the
 * line number it has in the source.
 */
export function blockLines(text: string): BlockLines[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const blocks: BlockLines[] = [];
  let open: BlockLines | null = null;
  let fence: { char: string; len: number } | null = null;
  /** Inside a `::: align` fence the editor shows one block, whatever blank lines it holds. */
  let aligned = false;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!fence) {
      if (openerAlign(l)) {
        // an opener ends a fence that is still open and starts the next block
        open = { start: n, end: n };
        blocks.push(open);
        aligned = true;
        return;
      }
      if (aligned && isCloser(l)) {
        open!.end = n;
        open = null;
        aligned = false;
        return;
      }
    }
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      if (close.test(l)) fence = null;
      open!.end = n;
      return;
    }
    if (l.trim() === '') {
      if (aligned) open!.end = n;
      else open = null;
      return;
    }
    if (!open) {
      open = { start: n, end: n };
      blocks.push(open);
    } else {
      open.end = n;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) fence = { char: f[1][0], len: f[1].length };
  });
  return blocks;
}

/** Start offsets of every line in `text` (always at least one entry). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  const re = /\r\n|\n|\r/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) starts.push(m.index + m[0].length);
  return starts;
}
