/**
 * Text alignment in Markdown, as a fenced block:
 *
 *     ::: center
 *     Any blocks: paragraphs, headings, quotes, lists.
 *     :::
 *
 * `left`, `center`, `right` and `justify` are the four alignments (`centre` and `justified` are accepted too).
 * Plain Markdown viewers show the two fence lines; MDEdit draws and exports the alignment.
 */
export type Align = 'left' | 'center' | 'right' | 'justify';

export const ALIGNS: readonly Align[] = ['left', 'center', 'right', 'justify'];

const WORDS: Record<string, Align> = { left: 'left', center: 'center', centre: 'center', right: 'right', justify: 'justify', justified: 'justify' };

/** The alignment a fence opener names, or null if the line isn't one. */
export function openerAlign(line: string): Align | null {
  const m = /^[ \t]{0,3}:::[ \t]*([A-Za-z]+)[ \t]*$/.exec(line);
  return m ? (WORDS[m[1].toLowerCase()] ?? null) : null;
}

export const isCloser = (line: string): boolean => /^[ \t]{0,3}:::[ \t]*$/.test(line);

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface AlignedSegment {
  align: Align | null;
  /** The text of the segment, line endings included, without the fence lines. */
  text: string;
}

/**
 * Splits Markdown into runs with one alignment each. Fence lines inside fenced code are ordinary text. An opener
 * inside an open fence ends it and starts the next; a fence that is never closed runs to the end.
 */
export function splitAligned(source: string): AlignedSegment[] {
  const lines = source.split(/(?<=\n)/); // keep each line's terminator
  const out: AlignedSegment[] = [];
  let cur: AlignedSegment = { align: null, text: '' };
  let code: string | null = null;
  const push = () => {
    if (cur.text !== '' || cur.align !== null) out.push(cur);
  };
  for (const raw of lines) {
    const line = raw.replace(/\r?\n$/, '');
    const f = CODE_FENCE.exec(line);
    if (code) {
      if (f && f[1][0] === code[0] && f[1].length >= code.length && line.trim() === f[1]) code = null;
      cur.text += raw;
      continue;
    }
    if (f && !(f[1][0] === '`' && line.slice(f[0].length).includes('`'))) {
      code = f[1];
      cur.text += raw;
      continue;
    }
    const a = openerAlign(line);
    if (a) {
      push();
      cur = { align: a, text: '' };
      continue;
    }
    if (cur.align !== null && isCloser(line)) {
      push();
      cur = { align: null, text: '' };
      continue;
    }
    cur.text += raw;
  }
  push();
  return out.length ? out : [{ align: null, text: '' }];
}

/** The text without its fence lines (for word counts and plain-text analysis). */
export function stripFences(source: string): string {
  if (!source.includes(':::')) return source;
  return splitAligned(source).map((s) => s.text).join('');
}
