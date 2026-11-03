/**
 * Text anchors: a quote with a little of the text on either side and where it was, so a comment can be found again after the text moves.
 * The same shape as Cadrel Write's anchor (and `NoteAnchor`), so notes written in Write can become queries without translation. Pure: text in,
 * positions out. An anchor is made against one exact version of a file; `locateAnchor` finds it in another version, or says it is gone.
 */
import type { NoteAnchor } from './notes';

export type TextAnchor = NoteAnchor;

/** How much of the surrounding text is kept on each side. */
export const ANCHOR_CONTEXT = 40;
/** The longest quote an anchor holds. */
export const ANCHOR_QUOTE_MAX = 2000;

export function makeAnchor(text: string, start: number, end: number): TextAnchor {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT),
    start
  };
}

const score = (text: string, a: TextAnchor, at: number, len: number): number =>
  (text.slice(Math.max(0, at - a.prefix.length), at) === a.prefix ? 1 : 0) + (text.slice(at + len, at + len + a.suffix.length) === a.suffix ? 1 : 0);

export type Located = { start: number; end: number; how: 'same-place' | 'moved' | 'reflowed' };

/**
 * Where the anchor is in `text`. Exactly where it was if the text around it is unchanged; otherwise the occurrence of the quote with the
 * most matching context, nearest the old position; otherwise the quote with its whitespace read as one space (a paragraph that was
 * re-wrapped). Null when the quote is no longer there, which the caller shows as a comment whose passage was changed or removed.
 */
export function locateAnchor(text: string, a: TextAnchor): Located | null {
  if (!a.quote) return null;
  if (text.startsWith(a.quote, a.start) && score(text, a, a.start, a.quote.length) === 2) return { start: a.start, end: a.start + a.quote.length, how: 'same-place' };
  let best: { start: number; score: number; dist: number } | null = null;
  for (let i = text.indexOf(a.quote); i !== -1; i = text.indexOf(a.quote, i + 1)) {
    const s = score(text, a, i, a.quote.length);
    const dist = Math.abs(i - a.start);
    if (!best || s > best.score || (s === best.score && dist < best.dist)) best = { start: i, score: s, dist };
  }
  if (best) return { start: best.start, end: best.start + a.quote.length, how: best.start === a.start ? 'same-place' : 'moved' };

  // the quote with each run of whitespace as one space, found in the text read the same way, then mapped back to real positions
  const squash = (s: string) => s.replace(/\s+/g, ' ');
  const want = squash(a.quote).trim();
  if (!want) return null;
  const map: number[] = [];
  let flat = '';
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) {
      if (flat.endsWith(' ')) continue;
      flat += ' ';
    } else flat += text[i];
    map.push(i);
  }
  let found: { at: number; dist: number } | null = null;
  for (let i = flat.indexOf(want); i !== -1; i = flat.indexOf(want, i + 1)) {
    const dist = Math.abs(map[i]! - a.start);
    if (!found || dist < found.dist) found = { at: i, dist };
  }
  if (!found) return null;
  return { start: map[found.at]!, end: map[found.at + want.length - 1]! + 1, how: 'reflowed' };
}
