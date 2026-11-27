import { Schema, type Node as PmNode } from '@milkdown/kit/prose/model';
import { describe, expect, it } from 'vitest';
import { EditorState } from '@milkdown/kit/prose/state';
import { makeAnchor, type Anchor } from '../shared/review/comments';
import { makeAnchorV2 } from '../shared/review/anchorV2';
import { flatten, offsetToPos, posToOffset, reviewKey, reviewPlugin } from './reviewPlugin';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' }
  }
});
const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('Hello world')]),
  schema.node('paragraph', null, [schema.text('Second one')])
]);

describe('flattening a chapter for notes', () => {
  it('joins blocks with a newline', () => {
    expect(flatten(doc).text).toBe('Hello world\nSecond one');
  });

  it('maps offsets to positions and back', () => {
    const flat = flatten(doc);
    expect(offsetToPos(flat, 0, 'start')).toBe(1);
    expect(offsetToPos(flat, 6, 'start')).toBe(7);
    expect(offsetToPos(flat, 12, 'start')).toBe(14); // start of the second paragraph's text
    expect(offsetToPos(flat, 11, 'end')).toBe(12); // end of the first
    expect(posToOffset(flat, 14)).toBe(12);
    expect(doc.textBetween(offsetToPos(flat, 6, 'start')!, offsetToPos(flat, 11, 'end')!)).toBe('world');
  });
});

describe('notes follow edits to their text', () => {
  const start = () => {
    const state = EditorState.create({ doc, plugins: [reviewPlugin] });
    const notes = [{ id: 'n', kind: 'comment' as const, anchor: makeAnchor('Hello world\nSecond one', 0, 11) }];
    return state.apply(state.tr.setMeta(reviewKey, { notes }));
  };

  it('keeps the note when part of its text is deleted', () => {
    const s = start();
    const next = s.apply(s.tr.delete(2, 5));
    const st = reviewKey.getState(next)!;
    expect(st.found.get('n')).toEqual({ from: 1, to: 9 });
    expect(st.changes).toEqual([expect.objectContaining({ id: 'n', gone: false, anchor: expect.objectContaining({ quote: 'Ho world' }) })]);
  });

  it('marks the note gone, at the same spot, when all its text is deleted', () => {
    const s = start();
    const next = s.apply(s.tr.delete(1, 12));
    const st = reviewKey.getState(next)!;
    expect(st.found.has('n')).toBe(false);
    expect(st.changes).toEqual([expect.objectContaining({ id: 'n', gone: true, anchor: expect.objectContaining({ start: 0 }) })]);
  });

  it('leaves notes alone when the whole document is replaced', () => {
    const s = start();
    const next = s.apply(s.tr.replaceWith(0, s.doc.content.size, doc.content));
    expect(reviewKey.getState(next)!.changes).toEqual([]);
  });
});

// Notes with a place (v2): the bug was a note drawn on the same word in another chapter, or on another repeat of it in this one.
describe('notes are found by where they are', () => {
  const para = (t: string) => schema.node('paragraph', null, [schema.text(t)]);
  const chapter = (...lines: string[]) => schema.node('doc', null, lines.map(para));
  const open = (d: PmNode, notes: { id: string; anchor: Anchor }[], key: string) => {
    const state = EditorState.create({ doc: d, plugins: [reviewPlugin] });
    return state.apply(state.tr.setMeta(reviewKey, { notes: notes.map((n) => ({ ...n, kind: 'comment' as const })), chapter: key }));
  };
  const made = (d: PmNode, key: string, from: string, nth = 0) => {
    const f = flatten(d);
    let at = -1;
    for (let i = 0; i <= nth; i++) at = f.text.indexOf(from, at + 1);
    return makeAnchorV2(f.text, f.segments.map((s) => ({ offset: s.offset, length: s.length })), at, at + from.length, key);
  };
  const text = (s: EditorState, id: string) => {
    const r = reviewKey.getState(s)!.found.get(id);
    return r ? s.doc.textBetween(r.from, r.to) : undefined;
  };

  const one = chapter('Chapter One', 'She said nothing.', 'He said no. Then he said yes.', 'The door said goodbye.');
  const two = chapter('Chapter Two', 'Nobody said a word.', 'He said goodbye, said hello.');

  it('does not draw a note of one chapter on a word of another', () => {
    const a = made(one, 'One', 'said');
    const s = open(two, [{ id: 'n', anchor: a }], 'Two');
    expect(reviewKey.getState(s)!.found.size).toBe(0);
    expect(reviewKey.getState(s)!.pinned.size).toBe(0);
  });

  it('keeps each note on its own repeat of a word in the chapter', () => {
    const notes = [0, 1, 2, 3].map((n) => ({ id: `n${n}`, anchor: made(one, 'One', 'said', n) }));
    const s = open(one, notes, 'One');
    const found = notes.map((n) => reviewKey.getState(s)!.found.get(n.id)!.from);
    expect(new Set(found).size).toBe(4);
    expect(found).toEqual([...found].sort((x, y) => x - y));
    for (const n of notes) expect(text(s, n.id)).toBe('said');
    // the third "said" is in the second paragraph that has two: it is the second of the pair
    expect(s.doc.textBetween(reviewKey.getState(s)!.found.get('n2')!.from - 8, reviewKey.getState(s)!.found.get('n2')!.to + 5)).toBe('Then he said yes.');
  });

  it('shows a note at the start of its paragraph, not on a word, when its text has changed', () => {
    const a = made(one, 'One', 'said yes');
    const changed = chapter('Chapter One', 'She said nothing.', 'He said no. Then he left, and said so.', 'The door said goodbye.');
    const s = open(changed, [{ id: 'n', anchor: a }], 'One');
    const st = reviewKey.getState(s)!;
    expect(st.found.has('n')).toBe(false);
    expect(st.pinned.get('n')).toMatchObject({ why: 'changed' });
    // the start of the third paragraph's text
    expect(s.doc.resolve(st.pinned.get('n')!.pos).parent.textContent).toBe('He said no. Then he left, and said so.');
    expect(st.decos.find().length).toBe(1);
  });

  it('draws an old note without a place only where it was made, never on another word', () => {
    const f = flatten(one).text;
    const at = f.indexOf('said');
    const old = makeAnchor(f, at, at + 4);
    expect(text(open(one, [{ id: 'n', anchor: old }], 'One'), 'n')).toBe('said');
    expect(reviewKey.getState(open(two, [{ id: 'n', anchor: old }], 'Two'))!.found.size).toBe(0);
    const shifted = chapter('A new first line said so.', ...[0, 1, 2, 3].map((i) => ['Chapter One', 'She said nothing.', 'He said no. Then he said yes.', 'The door said goodbye.'][i]!));
    expect(reviewKey.getState(open(shifted, [{ id: 'n', anchor: old }], 'One'))!.found.size).toBe(0);
  });

  it('follows its paragraph when one is added above it, and says so, without counting as an edit', () => {
    const a = made(one, 'One', 'said goodbye');
    const s = open(one, [{ id: 'n', anchor: a }], 'One');
    const next = s.apply(s.tr.insert(0, para('A paragraph put in at the top.')));
    const st = reviewKey.getState(next)!;
    expect(text(next, 'n')).toBe('said goodbye');
    expect(st.changes).toEqual([expect.objectContaining({ id: 'n', gone: false, place: true, anchor: expect.objectContaining({ quote: 'said goodbye', block: expect.objectContaining({ i: 4 }) }) })]);
  });

  it('keeps the place of a note up to date when it is found by another way', () => {
    const a = made(one, 'One', 'said yes');
    const grown = chapter('Chapter One', 'A', 'B', 'C', 'D', 'E', 'She said nothing.', 'He said no. Then he said yes.', 'The door said goodbye.');
    const s = open(grown, [{ id: 'n', anchor: a }], 'One');
    expect(text(s, 'n')).toBeUndefined(); // more than three paragraphs away: not guessed at, pinned
    expect(reviewKey.getState(s)!.pinned.has('n')).toBe(true);
    const near = chapter('Chapter One', 'A', 'She said nothing.', 'He said no. Then he said yes.', 'The door said goodbye.');
    const t = open(near, [{ id: 'n', anchor: a }], 'One');
    expect(text(t, 'n')).toBe('said yes');
    expect(reviewKey.getState(t)!.changes).toEqual([expect.objectContaining({ id: 'n', place: true })]);
  });

  it('keeps a deleted note at its paragraph, and says it was deleted', () => {
    const a = made(one, 'One', 'said no.');
    const s = open(one, [{ id: 'n', anchor: a }], 'One');
    const p = flatten(one).segments[2]!;
    const next = s.apply(s.tr.delete(p.pos + 3, p.pos + 3 + 'said no.'.length));
    const st = reviewKey.getState(next)!;
    expect(st.changes).toEqual([expect.objectContaining({ id: 'n', gone: true, anchor: expect.objectContaining({ block: expect.objectContaining({ i: 2 }) }) })]);
  });
});
