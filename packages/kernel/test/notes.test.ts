import { describe, expect, it } from 'vitest';
import {
  AI_OPEN_MAX, createNote, deleteNote, editNote, openCounts, queryNotes, replyToNote, sanitizeNotes, setNoteStatus, type Note
} from '../src/notes';

const mk = (notes: Note[], o: Partial<Parameters<typeof createNote>[1]> = {}) =>
  createNote(notes, { body: 'Check this.', author: 'Blake', projectId: 'p1', target: { module: 'market', kind: 'category', id: 'epic', label: 'Epic fantasy' }, ...o });

describe('notes', () => {
  it('creates a note on a module record, trimmed and defaulted', () => {
    const { note } = mk([], { body: '  Prices are rising.  ', category: ' Pricing ' });
    expect(note).toMatchObject({ kind: 'comment', status: 'open', body: 'Prices are rising.', category: 'pricing', replies: [], projectId: 'p1' });
    expect(note.target?.module).toBe('market');
    expect(note.origin).toBeUndefined();
  });

  it('allows a note on the studio itself, and refuses empty or oversized text', () => {
    expect(mk([], { projectId: null, target: null }).note.projectId).toBeNull();
    expect(() => mk([], { body: '   ' })).toThrow(/cannot be empty/);
    expect(() => mk([], { body: 'x'.repeat(4001) })).toThrow(/at most/);
    expect(() => mk([], { author: '' })).toThrow(/author/);
  });

  it('a suggestion needs an anchor and a replacement', () => {
    const anchor = { quote: 'teh', prefix: '', suffix: ' dog', start: 0 };
    expect(() => mk([], { kind: 'suggestion' })).toThrow(/needs the text/);
    expect(() => mk([], { kind: 'suggestion', replacement: 'the' })).toThrow(/needs the text/);
    const { note } = mk([], { kind: 'suggestion', replacement: 'the', target: { module: 'write', kind: 'file', id: 'DR1/ch1.md', anchor } });
    expect(note.replacement).toBe('the');
  });

  it('changes status, but only suggestions are accepted or rejected', () => {
    let { notes, note } = mk([]);
    expect(() => setNoteStatus(notes, note.id, 'accepted')).toThrow(/suggestions/);
    notes = setNoteStatus(notes, note.id, 'resolved');
    expect(notes[0]!.status).toBe('resolved');
    expect(() => setNoteStatus(notes, 'nope', 'resolved')).toThrow(/no note/);
  });

  it('edits the body and topic, and replies', () => {
    let { notes, note } = mk([]);
    notes = editNote(notes, note.id, { body: 'Better.', category: 'Cover' });
    notes = replyToNote(notes, note.id, { author: 'Editor', body: 'Agreed.' });
    expect(notes[0]).toMatchObject({ body: 'Better.', category: 'cover' });
    expect(notes[0]!.replies).toHaveLength(1);
    notes = editNote(notes, note.id, { category: null });
    expect(notes[0]!.category).toBeUndefined();
    expect(() => replyToNote(notes, note.id, { author: 'x', body: '' })).toThrow();
  });

  it('caps open AI notes per project, not human ones', () => {
    let notes: Note[] = [];
    for (let i = 0; i < AI_OPEN_MAX; i++) notes = mk(notes, { origin: 'ai', body: `n${i}` }).notes;
    expect(() => mk(notes, { origin: 'ai' })).toThrow(/open AI notes/);
    expect(() => mk(notes, { origin: 'ai', projectId: 'p2' })).not.toThrow();
    expect(() => mk(notes)).not.toThrow();
  });

  it('queries by project set, module, status, origin, topic and text; newest first; deleted hidden', () => {
    let notes: Note[] = [];
    const add = (o: Partial<Parameters<typeof createNote>[1]>, at: string) => {
      const r = mk(notes, { ...o, now: at });
      notes = r.notes;
      return r.note.id;
    };
    const a = add({ projectId: 'p1', body: 'alpha', category: 'pricing' }, '2026-01-01T00:00:00Z');
    add({ projectId: 'p2', body: 'beta', origin: 'ai' }, '2026-01-02T00:00:00Z');
    add({ projectId: 'p1', body: 'gamma', target: { module: 'write', kind: 'file', id: 'f' } }, '2026-01-03T00:00:00Z');
    notes = setNoteStatus(notes, a, 'resolved');
    expect(queryNotes(notes).map((n) => n.body)).toEqual(['gamma', 'beta']);
    expect(queryNotes(notes, { projectIds: ['p1'] }).map((n) => n.body)).toEqual(['gamma']);
    expect(queryNotes(notes, { status: 'any' })).toHaveLength(3);
    expect(queryNotes(notes, { status: 'resolved' }).map((n) => n.body)).toEqual(['alpha']);
    expect(queryNotes(notes, { module: 'market' }).map((n) => n.body)).toEqual(['beta']);
    expect(queryNotes(notes, { origin: 'ai' }).map((n) => n.body)).toEqual(['beta']);
    expect(queryNotes(notes, { origin: 'human', status: 'any' })).toHaveLength(2);
    expect(queryNotes(notes, { status: 'any', category: 'Pricing' }).map((n) => n.body)).toEqual(['alpha']);
    expect(queryNotes(notes, { text: 'EPIC' }).map((n) => n.body)).toEqual(['beta']); // matches the target label
    notes = deleteNote(notes, a);
    expect(queryNotes(notes, { status: 'any' })).toHaveLength(2);
    expect(queryNotes(notes, { status: 'deleted' })).toHaveLength(1);
    expect([...openCounts(notes)]).toEqual([['p2', 1], ['p1', 1]]);
  });

  it('sanitizeNotes drops malformed entries and repairs fields', () => {
    expect(sanitizeNotes('nope')).toEqual([]);
    const out = sanitizeNotes([
      { id: 'a', body: 'ok', author: 'x', status: 'weird', category: ' Foo ', replies: [{ id: 'r', body: 'hi', author: 'y' }, { id: 'r2' }] },
      { id: 'a', body: 'dupe', author: 'x' },
      { id: 'b', body: '', author: 'x' },
      { id: 'c', body: 'with target', author: 'x', target: { module: 'm', kind: 'k', id: 'i', anchor: { quote: 'q' } }, projectId: 'p' }
    ]);
    expect(out.map((n) => n.id)).toEqual(['a', 'c']);
    expect(out[0]).toMatchObject({ status: 'open', category: 'foo' });
    expect(out[0]!.replies).toHaveLength(1);
    expect(out[1]!.target?.anchor).toEqual({ quote: 'q', prefix: '', suffix: '', start: 0 });
  });
});
