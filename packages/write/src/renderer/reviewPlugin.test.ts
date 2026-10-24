import { Schema } from '@milkdown/kit/prose/model';
import { describe, expect, it } from 'vitest';
import { EditorState } from '@milkdown/kit/prose/state';
import { makeAnchor } from '../shared/review/comments';
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
