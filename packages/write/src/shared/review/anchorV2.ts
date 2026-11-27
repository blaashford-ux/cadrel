/**
 * Where a note is, not what it says. A v1 anchor is a quote with some text round it, and when the text round it has changed it is found
 * again by looking for the quote anywhere, which puts a comment on the wrong "said" of the chapter, or of another chapter. A v2 anchor
 * is the note's chapter, the paragraph in it and the offset in the paragraph, with the quote kept as evidence that the place is still
 * the place. When the evidence runs out the note is pinned to the start of its paragraph and flagged; it never moves to another word.
 *
 * Pure: text and blocks in, a placement out. `blocks` are the text blocks of one chapter as `flatten` (the editor) or
 * `flattenMarkdownBlocks` (no editor) give them: where each starts in the chapter's flat text, and how long it is.
 */
import { makeAnchor, score, type Anchor } from './comments';

export interface Block {
  offset: number;
  length: number;
}

/** How many paragraphs either side of its number a paragraph is looked for when the paragraphs above it have changed. */
export const BLOCK_REACH = 3;
/** How far from its old offset a lone repeat of the quote, in a paragraph that has changed, may be and still be the note's text. */
export const NEAR = 10;

/** A short hash of a paragraph's text (FNV-1a, 32 bits): to tell that it is the same paragraph, not to be secure. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const textOf = (text: string, b: Block) => text.slice(b.offset, b.offset + b.length);

/** The number of the block holding flat offset `at`; at a boundary the later block for a start, the earlier for an end. -1 for none. */
export function blockAt(blocks: Block[], at: number, edge: 'start' | 'end'): number {
  let hit = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (at >= b.offset && at <= b.offset + b.length) {
      hit = i;
      if (edge === 'end') return i;
    }
  }
  return hit;
}

/** A v2 anchor for text[start, end) of the chapter `chapter`. */
export function makeAnchorV2(text: string, blocks: Block[], start: number, end: number, chapter: string | undefined): Anchor {
  const a = makeAnchor(text, start, end);
  const i = blockAt(blocks, start, 'start');
  if (chapter === undefined || i < 0) return a;
  const j = blockAt(blocks, end, 'end');
  return {
    ...a,
    v: 2,
    chapter,
    block: { i, off: start - blocks[i]!.offset, h: hashText(textOf(text, blocks[i]!)) },
    ...(j >= 0 && j !== i ? { endBlock: { i: j, off: end - blocks[j]!.offset } } : {})
  };
}

export type Placement =
  /** The note's text, found where the note is. */
  | { kind: 'at'; start: number; end: number; how: 'exact' | 'edited' | 'moved' }
  /** The note is kept at the start of its paragraph (`at` is its flat offset): the text changed, or it cannot be told which paragraph. */
  | { kind: 'pinned'; at: number; block: number; why: 'changed' | 'ambiguous' | 'approx' | 'gone' }
  /** The note is in another chapter. */
  | { kind: 'elsewhere' }
  /** An old note that has not been given a place yet (see `upgradeAnchor`). */
  | { kind: 'unplaced' };

/** The block that is the note's paragraph: where it was if its text is the same, else the one paragraph nearby that has that text. */
function blockFor(text: string, blocks: Block[], want: { i: number; h: string }): number | 'ambiguous' | null {
  const here = blocks[want.i];
  if (here && hashText(textOf(text, here)) === want.h) return want.i;
  const near: number[] = [];
  for (let j = want.i - BLOCK_REACH; j <= want.i + BLOCK_REACH; j++) {
    const b = blocks[j];
    if (j !== want.i && b && hashText(textOf(text, b)) === want.h) near.push(j);
  }
  return near.length === 1 ? near[0]! : near.length > 1 ? 'ambiguous' : null;
}

/** Where the note is in this chapter. `chapter` is the open chapter's key; undefined means the chapters are not told apart (one text). */
export function placeAnchor(text: string, blocks: Block[], a: Anchor, chapter: string | undefined): Placement {
  if (a.chapter === undefined || !a.block) return { kind: 'unplaced' };
  if (chapter !== undefined && a.chapter !== chapter) return { kind: 'elsewhere' };
  if (!blocks.length) return { kind: 'elsewhere' };
  const want = a.block;
  const home = Math.min(want.i, blocks.length - 1);
  const pin = (i: number, why: 'changed' | 'ambiguous' | 'approx' | 'gone'): Placement => ({ kind: 'pinned', block: i, at: blocks[i]!.offset, why });
  const found = blockFor(text, blocks, want);

  if (a.approx) return pin(typeof found === 'number' ? found : home, 'approx');
  if (a.gone || !a.quote) return pin(typeof found === 'number' ? found : home, 'gone');

  // the paragraph is as it was (or has moved as it was) and the text is where it was in it
  if (typeof found === 'number') {
    const at = blocks[found]!.offset + want.off;
    if (text.startsWith(a.quote, at)) return { kind: 'at', start: at, end: at + a.quote.length, how: found === want.i ? 'exact' : 'moved' };
  }
  if (found === 'ambiguous') return pin(home, 'ambiguous');

  // the paragraph has been edited: the quote, if it is still in it, with the text round it as the evidence
  const b = blocks[want.i];
  if (b) {
    const c: { at: number; s: number; d: number }[] = [];
    for (let k = text.indexOf(a.quote, b.offset); k !== -1 && k <= b.offset + b.length; k = text.indexOf(a.quote, k + 1)) c.push({ at: k, s: score(text, a, k), d: Math.abs(k - b.offset - want.off) });
    c.sort((x, y) => y.s - x.s || x.d - y.d);
    const best = c[0];
    if (best && (best.s >= 1 || c.length === 1 || best.d <= NEAR)) return { kind: 'at', start: best.at, end: best.at + a.quote.length, how: 'edited' };
  }
  return pin(home, 'changed');
}

/** A chapter as `upgradeAnchor` needs it. */
export interface ChapterText {
  key: string;
  text: string;
  blocks: Block[];
}

/**
 * Gives an old note a place: the chapter, paragraph and offset where its text is. Null when there is nothing to do (it has a place
 * in a chapter that is there) or nothing to go on (its text is in no chapter, or is in several chapters with nothing to tell them
 * apart). Sure when its quote has both sides of its context intact in exactly one chapter; otherwise it is placed in the likeliest
 * chapter and marked `approx`, to be shown at the start of that paragraph and flagged, never drawn on a word.
 */
export function upgradeAnchor(chapters: ChapterText[], a: Anchor): Anchor | null {
  if (a.v === 2 && a.chapter !== undefined && a.block && chapters.some((c) => c.key === a.chapter)) return null;
  const quote = a.gone || !a.quote ? '' : a.quote;
  type Hit = { c: number; start: number; s: number; d: number };
  const hits: Hit[] = [];
  chapters.forEach((c, ci) => {
    let best: Hit | null = null;
    if (!quote) {
      const joined = a.prefix + a.suffix;
      const k = joined ? c.text.indexOf(joined) : -1;
      if (k !== -1) best = { c: ci, start: k + a.prefix.length, s: 2, d: Math.abs(k + a.prefix.length - a.start) };
    } else {
      for (let k = c.text.indexOf(quote); k !== -1; k = c.text.indexOf(quote, k + 1)) {
        const h = { c: ci, start: k, s: score(c.text, a, k), d: Math.abs(k - a.start) };
        if (!best || h.s > best.s || (h.s === best.s && h.d < best.d)) best = h;
      }
    }
    if (best) hits.push(best);
  });
  if (!hits.length) return null;
  const top = Math.max(...hits.map((h) => h.s));
  const tops = hits.filter((h) => h.s === top);
  const sure = top === 2 && tops.length === 1;
  // old notes whose text is in several chapters with no context to tell them apart: not guessed at
  if (!sure && top === 0 && hits.length > 1) return null;
  const pick = sure ? tops[0]! : [...hits].sort((x, y) => y.s - x.s || x.d - y.d)[0]!;
  const ch = chapters[pick.c]!;
  const end = pick.start + quote.length;
  const placed = makeAnchorV2(ch.text, ch.blocks, pick.start, end, ch.key);
  if (placed.v !== 2) return null;
  if (sure) {
    const { approx: _approx, ...rest } = a;
    return { ...rest, ...placed, quote: a.quote, ...(quote ? {} : { prefix: a.prefix, suffix: a.suffix }) };
  }
  const { approx: _approx, ...rest } = a;
  return { ...rest, v: 2, chapter: ch.key, block: placed.block, ...(placed.endBlock ? { endBlock: placed.endBlock } : {}), start: pick.start, approx: true };
}
