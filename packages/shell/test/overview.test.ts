import { describe, expect, it } from 'vitest';
import type { RootListing } from '@cadrel/write/src/shared/projects';
import { marketUnavailable, summariseMarket, summariseWrite, writeUnavailable } from '../src/main/overview';

const project = (name: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
  ({ path: `/r/${name}`, name, words: 0, files: 0, lastEdited: null, meta: { archived: false, goal: null, ...meta }, ...over }) as never;

describe('summariseWrite', () => {
  it('flattens projects, newest first, unwritten last', () => {
    const listing: RootListing = {
      root: '/r',
      exists: true,
      folders: [],
      projects: [
        project('Old', { words: 100, lastEdited: 1000 }),
        project('Blank'),
        project('New', { words: 5000, lastEdited: 9000 }, { goal: { targetWords: 80000 } })
      ]
    };
    const w = summariseWrite(listing, (f) => (f === 'New' ? { name: 'Revising', color: '#abc' } : null));
    expect(w.ok).toBe(true);
    expect(w.projects.map((p) => p.name)).toEqual(['New', 'Old', 'Blank']);
    expect(w.projects[0]).toMatchObject({ stage: 'Revising', stageColor: '#abc', words: 5000, goalWords: 80000, archived: false });
    expect(w.projects[1]!.goalWords).toBeNull();
  });
  it('reports a module that cannot answer, without throwing', () => {
    expect(writeUnavailable(new Error('disk gone'))).toMatchObject({ ok: false, projects: [], error: 'disk gone' });
    expect(writeUnavailable('plain')).toMatchObject({ error: 'plain' });
  });
});

describe('summariseMarket', () => {
  it('counts only pending queue items and names unnamed categories by key', () => {
    const m = summariseMarket({
      status: { libraryRoot: '/lib', port: 4545, serverRunning: true },
      categories: [{ key: 'kindle:123', name: null, listedBooks: 50, capturedBooks: 12, listCaptures: 3, lastListCapture: '2026-10-01' }],
      queue: [{ state: 'pending' }, { state: 'opened' }, { state: 'skipped' }, { state: 'pending' }]
    });
    expect(m).toMatchObject({ ok: true, libraryRoot: '/lib', serverRunning: true, port: 4545, queued: 2 });
    expect(m.categories[0]!.name).toBe('kindle:123');
  });
  it('carries a server error through', () => {
    const m = summariseMarket({ status: { libraryRoot: '/lib', port: 4545, serverRunning: false, serverError: 'port 4545 is in use' } });
    expect(m).toMatchObject({ serverRunning: false, serverError: 'port 4545 is in use' });
    expect(summariseMarket({ status: { libraryRoot: '/lib', port: 4545, serverRunning: true } }).serverError).toBeNull();
    const held = summariseMarket({ status: { libraryRoot: '/lib', port: 4545, serverRunning: false, serverError: 'x', portHolder: { pid: 7, name: 'BookScout.exe' } } });
    expect(held.portHolder).toEqual({ pid: 7, name: 'BookScout.exe' });
  });
  it('is fine with no library chosen yet', () => {
    expect(summariseMarket({ status: { libraryRoot: null, port: 4545, serverRunning: true } })).toMatchObject({ ok: true, libraryRoot: null, categories: [], queued: 0 });
  });
  it('reports a module that cannot answer', () => {
    expect(marketUnavailable(new Error('no db'))).toMatchObject({ ok: false, error: 'no db', categories: [] });
  });
});
