import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { score, type Anchor } from '../shared/review/comments';
import { makeAnchorV2, placeAnchor, type Block } from '../shared/review/anchorV2';

/** A note as the editor needs it: where to draw it and how. */
export interface NoteMark {
  id: string;
  anchor: Anchor;
  kind: 'comment' | 'suggestion';
}

/**
 * What the open chapter says about each note: `detached` (not in this chapter, or its place could not be found) and `pinned` (its text
 * changed, or it could not be told which paragraph, so it is shown at the start of its paragraph).
 */
export interface NoteStatus {
  detached: string[];
  pinned: string[];
}

/**
 * A note whose place changed: its new anchor, or `gone` when all of its text was deleted (it stays at that spot). `place` is true when
 * only where it is changed (the text it quotes is as it was), which is kept up to date without counting as the note having been edited.
 */
export interface NoteChange {
  id: string;
  anchor: Anchor;
  gone: boolean;
  place?: boolean;
}

export interface ReviewApi {
  /** Called (after each edit) with the notes whose highlighted text changed. */
  onChanges(cb: ((changes: NoteChange[]) => void) | null): void;
  /**
   * Draws these notes, the ones in the chapter whose key is `chapter`, and reports which ones are not found or are only pinned. A note
   * belongs to the chapter it was made in: it is never looked for in another. Without a chapter, notes are looked for in the one text.
   */
  setNotes(notes: NoteMark[], chapter?: string): NoteStatus;
  /** The current selection as an anchor, or null when nothing is selected. `oneBlock` is false if it crosses paragraphs. */
  selection(): { anchor: Anchor; oneBlock: boolean } | null;
  /**
   * What a note should attach to when the user right-clicks at screen point (x, y): the selection if the click is inside it,
   * otherwise the paragraph under the pointer (which is selected so the user can see it). Null over empty text.
   */
  selectionAt(x: number, y: number): { anchor: Anchor; oneBlock: boolean } | null;
  /** Highlights a note and, unless `scroll` is false, scrolls to it (without taking focus). */
  reveal(id: string, scroll?: boolean): boolean;
  /** Replaces a note's quoted text (single paragraph only); false when it can't be found. */
  replace(id: string, text: string): boolean;
  /** Called when the user clicks highlighted text. */
  onClick(cb: ((id: string) => void) | null): void;
}

interface Segment {
  /** Document position where the text of this block starts. */
  pos: number;
  /** Offset of the block's text in the flat text. */
  offset: number;
  length: number;
}

export interface Flat {
  text: string;
  segments: Segment[];
}

/** The chapter as plain text: each text block's text, blocks separated by a newline. Anchors live in this text. */
export function flatten(doc: PmNode): Flat {
  const segments: Segment[] = [];
  let text = '';
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const t = node.textBetween(0, node.content.size, '\n', '￼');
    if (segments.length) text += '\n';
    segments.push({ pos: pos + 1, offset: text.length, length: t.length });
    text += t;
    return false;
  });
  return { text, segments };
}

/** Flat-text offset to document position. A range start prefers the later block at a boundary, an end the earlier. */
export function offsetToPos(flat: Flat, offset: number, edge: 'start' | 'end'): number | null {
  const hits = flat.segments.filter((s) => offset >= s.offset && offset <= s.offset + s.length);
  if (!hits.length) return null;
  const s = edge === 'start' ? hits[hits.length - 1] : hits[0];
  return s.pos + (offset - s.offset);
}

export function posToOffset(flat: Flat, pos: number): number | null {
  const s = flat.segments.find((x) => pos >= x.pos && pos <= x.pos + x.length);
  return s ? s.offset + (pos - s.pos) : null;
}

interface Pin {
  /** Document position of the start of the note's paragraph. */
  pos: number;
  why: 'changed' | 'ambiguous' | 'approx' | 'gone';
}

interface State {
  notes: NoteMark[];
  found: Map<string, { from: number; to: number }>;
  /** Notes kept at the start of their paragraph, because their text changed or they could not be placed exactly. */
  pinned: Map<string, Pin>;
  chapter: string | undefined;
  active: string | null;
  decos: DecorationSet;
  /** Notes the last edit changed; reported to the app by the plugin view. */
  changes: NoteChange[];
}

interface Meta {
  notes?: NoteMark[];
  chapter?: string | null;
  active?: string | null;
}

export const reviewKey = new PluginKey<State>('cadrel-review');

const blocksOf = (flat: Flat): Block[] => flat.segments.map((s) => ({ offset: s.offset, length: s.length }));

/** The same place, as far as a note's anchor says. */
const samePlace = (a: Anchor, b: Anchor) =>
  a.chapter === b.chapter && a.block?.i === b.block?.i && a.block?.off === b.block?.off && a.block?.h === b.block?.h && a.endBlock?.i === b.endBlock?.i && a.endBlock?.off === b.endBlock?.off;

/**
 * Where a note is in this chapter. A note with a place (v2) is found by it. An old one (v1) is drawn only where it was made,
 * with the text around it as it was, so it can never be put on another word; `upgradeAnchor` gives it a place when the file's
 * chapters are at hand.
 */
function resolve(flat: Flat, n: NoteMark, chapter: string | undefined): ReturnType<typeof placeAnchor> {
  const p = placeAnchor(flat.text, blocksOf(flat), n.anchor, chapter);
  if (p.kind !== 'unplaced') return p;
  const a = n.anchor;
  if (a.gone || !a.quote || !flat.text.startsWith(a.quote, a.start) || score(flat.text, a, a.start) !== 2) return p;
  return { kind: 'at', start: a.start, end: a.start + a.quote.length, how: 'exact' };
}

const noteClass = (n: NoteMark, active: string | null, base: string) => `${base} review-${n.kind}${n.id === active ? ' review-active' : ''}`;

function pinWidget(n: NoteMark, active: string | null, why: Pin['why']): HTMLElement {
  const el = document.createElement('span');
  el.className = noteClass(n, active, 'review-pin');
  el.setAttribute('data-note', n.id);
  el.setAttribute('contenteditable', 'false');
  el.title = why === 'gone' ? 'The text this note was about was deleted' : why === 'approx' ? 'This note’s exact place is not certain' : 'The text this note was about has changed';
  return el;
}

function decorate(doc: PmNode, notes: NoteMark[], found: Map<string, { from: number; to: number }>, pinned: Map<string, Pin>, active: string | null): DecorationSet {
  const decos: Decoration[] = [];
  for (const n of notes) {
    const r = found.get(n.id);
    if (r) decos.push(Decoration.inline(r.from, r.to, { class: noteClass(n, active, 'review-mark'), 'data-note': n.id }));
    const pin = pinned.get(n.id);
    if (pin && pin.pos <= doc.content.size) decos.push(Decoration.widget(pin.pos, () => pinWidget(n, active, pin.why), { side: -1, key: `pin-${n.id}-${n.id === active ? 'a' : ''}-${pin.why}` }));
  }
  return DecorationSet.create(doc, decos);
}

function compute(doc: PmNode, notes: NoteMark[], active: string | null, chapter: string | undefined): State {
  const flat = flatten(doc);
  const found = new Map<string, { from: number; to: number }>();
  const pinned = new Map<string, Pin>();
  const changes: NoteChange[] = [];
  const blocks = blocksOf(flat);
  for (const n of notes) {
    const p = resolve(flat, n, chapter);
    if (p.kind === 'at') {
      const from = offsetToPos(flat, p.start, 'start');
      const to = offsetToPos(flat, p.end, 'end');
      if (from === null || to === null || to <= from) continue;
      found.set(n.id, { from, to });
      // found by a way other than its own place: keep the place up to date, so the next time it is found at once
      if (p.how !== 'exact') {
        const anchor = makeAnchorV2(flat.text, blocks, p.start, p.end, chapter);
        if (anchor.v === 2 && !samePlace(anchor, n.anchor)) changes.push({ id: n.id, anchor: { ...n.anchor, ...anchor, quote: n.anchor.quote }, gone: false, place: true });
      }
    } else if (p.kind === 'pinned') {
      const pos = offsetToPos(flat, p.at, 'start');
      if (pos !== null) pinned.set(n.id, { pos, why: p.why });
    }
  }
  return { notes, found, pinned, chapter, active, decos: decorate(doc, notes, found, pinned, active), changes };
}

/** True when a transaction swaps out the whole document (a chapter loaded), rather than editing inside it. */
function replacesAll(tr: Transaction): boolean {
  return tr.steps.some((s) => {
    const m = s.toJSON() as { stepType?: string; from?: number; to?: number };
    return m.stepType === 'replace' && m.from === 0 && m.to === tr.before.content.size;
  });
}

/** Follows the notes through an edit, so changing a note's text changes the note rather than losing it. */
function track(tr: Transaction, prev: State, doc: PmNode): State {
  const flat = flatten(doc);
  const blocks = blocksOf(flat);
  const found = new Map<string, { from: number; to: number }>();
  const pinned = new Map<string, Pin>();
  const changes: NoteChange[] = [];
  for (const n of prev.notes) {
    const r = prev.found.get(n.id);
    const pin = prev.pinned.get(n.id);
    if (pin) pinned.set(n.id, { ...pin, pos: Math.min(tr.mapping.map(pin.pos, -1), doc.content.size) });
    if (!r) continue;
    const from = tr.mapping.map(r.from, 1);
    const to = tr.mapping.map(r.to, -1);
    if (to > from) {
      found.set(n.id, { from, to });
      const a = posToOffset(flat, from);
      const b = posToOffset(flat, to);
      if (a !== null && b !== null) {
        const anchor = makeAnchorV2(flat.text, blocks, a, b, prev.chapter);
        if (flat.text.slice(a, b) !== n.anchor.quote) changes.push({ id: n.id, anchor, gone: false });
        else if (anchor.v === 2 && !samePlace(anchor, n.anchor)) changes.push({ id: n.id, anchor: { ...n.anchor, ...anchor, quote: n.anchor.quote }, gone: false, place: true });
      }
    } else {
      const at = posToOffset(flat, Math.min(from, doc.content.size));
      if (at !== null) changes.push({ id: n.id, anchor: makeAnchorV2(flat.text, blocks, at, at, prev.chapter), gone: true });
    }
  }
  return { ...prev, found, pinned, decos: decorate(doc, prev.notes, found, pinned, prev.active), changes };
}

let clickHandler: ((id: string) => void) | null = null;
let changeHandler: ((changes: NoteChange[]) => void) | null = null;

export const reviewPlugin = new Plugin<State>({
  key: reviewKey,
  state: {
    init: () => ({ notes: [], found: new Map(), pinned: new Map(), chapter: undefined, active: null, decos: DecorationSet.empty, changes: [] }),
    apply(tr, prev, _old, next) {
      const meta = tr.getMeta(reviewKey) as Meta | undefined;
      if (!meta && !tr.docChanged) return prev.changes.length ? { ...prev, changes: [] } : prev;
      if (!meta && !replacesAll(tr)) return track(tr, prev, next.doc);
      return compute(
        next.doc,
        meta?.notes ?? prev.notes,
        meta && 'active' in meta ? (meta.active ?? null) : prev.active,
        meta && 'chapter' in meta ? (meta.chapter ?? undefined) : prev.chapter
      );
    }
  },
  view: () => ({
    update(view, before) {
      const s = reviewKey.getState(view.state);
      if (s && s.changes.length && s !== reviewKey.getState(before) && changeHandler) changeHandler(s.changes);
    }
  }),
  props: {
    decorations: (state) => reviewKey.getState(state)?.decos,
    handleClick(_view, _pos, event) {
      const el = (event.target as HTMLElement | null)?.closest?.('[data-note]');
      const id = el?.getAttribute('data-note');
      if (id && clickHandler) clickHandler(id);
      return false;
    }
  }
});

const stateOf = (view: EditorView) => reviewKey.getState(view.state)!;

/** The review operations for one ProseMirror view. */
export function reviewApiFor(getView: () => EditorView | null): ReviewApi {
  return {
    setNotes(notes, chapter) {
      const view = getView();
      if (!view) return { detached: [], pinned: [] };
      view.dispatch(view.state.tr.setMeta(reviewKey, { notes, chapter: chapter ?? null }));
      const { found, pinned } = stateOf(view);
      return {
        detached: notes.filter((n) => !found.has(n.id) && !pinned.has(n.id)).map((n) => n.id),
        pinned: notes.filter((n) => pinned.has(n.id)).map((n) => n.id)
      };
    },

    selection() {
      const view = getView();
      if (!view) return null;
      const { from, to, empty } = view.state.selection;
      if (empty) return null;
      const flat = flatten(view.state.doc);
      const a = posToOffset(flat, from);
      const b = posToOffset(flat, to);
      if (a === null || b === null || b <= a || !flat.text.slice(a, b).trim()) return null; // nothing but blank space
      return {
        anchor: makeAnchorV2(flat.text, blocksOf(flat), a, b, stateOf(view).chapter),
        oneBlock: !flat.text.slice(a, b).includes('\n')
      };
    },

    selectionAt(x, y) {
      const view = getView();
      if (!view) return null;
      const at = view.posAtCoords({ left: x, top: y })?.pos;
      const { from, to, empty } = view.state.selection;
      if (!empty && (at === undefined || (at >= from && at <= to))) {
        const current = this.selection();
        if (current) return current;
      }
      if (at === undefined) return null;
      const $at = view.state.doc.resolve(at);
      if (!$at.parent.isTextblock || $at.parent.content.size === 0) return null;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $at.start(), $at.end())));
      return this.selection();
    },

    reveal(id, scroll = true) {
      const view = getView();
      if (!view) return false;
      const st = stateOf(view);
      const pin = st.pinned.get(id);
      const hit = st.found.get(id) ?? (pin ? { from: pin.pos, to: pin.pos } : undefined);
      view.dispatch(view.state.tr.setMeta(reviewKey, { active: hit ? id : null }));
      if (!hit) return false;
      if (!scroll) return true;
      const at = view.domAtPos(hit.from).node;
      const el = at.nodeType === 3 ? at.parentElement : (at as HTMLElement);
      el?.scrollIntoView({ block: 'center' });
      return true;
    },

    replace(id, text) {
      const view = getView();
      if (!view) return false;
      const hit = stateOf(view).found.get(id);
      if (!hit) return false;
      const flat = flatten(view.state.doc);
      const a = posToOffset(flat, hit.from);
      const b = posToOffset(flat, hit.to);
      if (a === null || b === null || flat.text.slice(a, b).includes('\n')) return false;
      const tr = view.state.tr.insertText(text, hit.from, hit.to);
      tr.setSelection(TextSelection.create(tr.doc, hit.from + text.length));
      view.dispatch(tr);
      return true;
    },

    onChanges(cb) {
      changeHandler = cb;
    },

    onClick(cb) {
      clickHandler = cb;
    }
  };
}
