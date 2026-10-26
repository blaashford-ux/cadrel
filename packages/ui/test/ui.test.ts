import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NoteView } from '@cadrel/kernel';
import { NotesPanel, ago } from '../src';

const note = (o: Partial<NoteView> = {}): NoteView => ({
  id: 'n_1', projectId: 'p1', target: { module: 'market', kind: 'category', id: 'c', label: 'Epic fantasy' }, kind: 'comment', body: 'Prices look thin.', status: 'open',
  category: 'pricing', author: 'Blake', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', replies: [{ id: 'r1', author: 'Sam', createdAt: '2026-01-02T00:00:00Z', body: 'Agreed.' }], source: 'studio', ...o
});
const api = { add: async () => undefined, setStatus: async () => undefined, reply: async () => undefined, remove: async () => undefined };
const html = (notes: NoteView[], extra: object = {}) => renderToStaticMarkup(createElement(NotesPanel, { notes, api, act: async (j) => (await j(), { ok: true }), ...extra }));

describe('ago', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  it('says how long ago, plainly', () => {
    expect(ago(null, now)).toBe('not started');
    expect(ago(now - 5_000, now)).toBe('just now');
    expect(ago(now - 90_000, now)).toBe('2 minutes ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(ago(now - 90 * 86_400_000, now)).toBe('3 months ago');
  });
});

describe('NotesPanel', () => {
  it('shows a note with its author, topic, where it is, body and replies', () => {
    const h = html([note()]);
    expect(h).toContain('Blake');
    expect(h).toContain('pricing');
    expect(h).toContain('Epic fantasy');
    expect(h).toContain('Prices look thin.');
    expect(h).toContain('Agreed.');
  });
  it('studio notes can be resolved and replied to; a note kept by a module sends you to the module', () => {
    const mine = html([note()], { onOpenModule: () => undefined });
    expect(mine).toContain('>Resolve</button>');
    expect(mine).toContain('Reply');
    const theirs = html([note({ source: 'module', target: { module: 'write', kind: 'file', id: 'DR1/ch1.md' } })], { onOpenModule: () => undefined });
    expect(theirs).not.toContain('>Resolve</button>');
    expect(theirs).toContain('Open in Write');
  });
  it('marks AI notes and hides resolved ones until asked', () => {
    expect(html([note({ origin: 'ai' })])).toContain('cn-chip ai');
    expect(html([note({ status: 'resolved' })])).toContain('No notes match.');
  });
  it('has a box to write a note only when told where it goes', () => {
    expect(html([])).not.toContain('New note');
    expect(html([], { addTo: { label: 'Book 1' } })).toContain('Add a note on Book 1…');
    expect(html([])).toContain('No notes yet.');
  });
});
