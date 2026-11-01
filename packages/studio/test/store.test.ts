import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryNotes, subtreeIds } from '@cadrel/kernel';
import { Studio, studioFile } from '../src/store';

let dir: string, file: string, s: Studio;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-studio-'));
  file = path.join(dir, 'sub', 'studio.json');
  s = new Studio(file);
});

describe('Studio store', () => {
  it('starts empty when there is no file or it is damaged', async () => {
    expect((await s.read()).tree.projects).toEqual([]);
    await s.createProject({ name: 'Keep' });
    await writeFile(file, '{ not json');
    expect((await s.read()).tree.projects).toEqual([]);
  });

  it('persists projects and notes across instances', async () => {
    const series = await s.createProject({ name: 'Dragon Rider', kind: 'Series' });
    const book = await s.createProject({ name: 'Book 1', parentId: series.id, kind: 'Book' });
    await s.link(book.id, 'write', 'DR1');
    await s.addNote({ projectId: series.id, body: 'Series-wide: keep dragon lore consistent.', author: 'Blake' });
    const again = new Studio(file);
    const d = await again.read();
    expect(d.tree.projects.map((p) => p.name)).toEqual(['Dragon Rider', 'Book 1']);
    expect(d.tree.links).toHaveLength(1);
    expect(d.notes).toHaveLength(1);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('a note on a linked record lands on that record’s project', async () => {
    const p = await s.createProject({ name: 'Book 1' });
    await s.link(p.id, 'market', 'epic-fantasy');
    const n = await s.addNote({ body: 'Price band looks low.', author: 'Blake', target: { module: 'market', kind: 'category', id: 'epic-fantasy', label: 'Epic fantasy' } });
    expect(n.projectId).toBe(p.id);
    const loose = await s.addNote({ body: 'Unlinked.', author: 'Blake', target: { module: 'market', kind: 'category', id: 'other' } });
    expect(loose.projectId).toBeNull();
    await expect(s.addNote({ body: 'x', author: 'y', projectId: 'p_missing' })).rejects.toThrow(/no project/);
  });

  it('a note on a category shared by several projects belongs to none of them, and the category can leave one at a time', async () => {
    const a = await s.createProject({ name: 'Book 1' });
    const b = await s.createProject({ name: 'Book 2' });
    await s.link(a.id, 'market', 'epic-fantasy');
    await s.link(b.id, 'market', 'epic-fantasy');
    expect((await s.read()).tree.links).toHaveLength(2);
    const n = await s.addNote({ body: 'Shared genre note.', author: 'Blake', target: { module: 'market', kind: 'category', id: 'epic-fantasy' } });
    expect(n.projectId).toBeNull();
    await s.unlink('market', 'epic-fantasy', a.id);
    expect((await s.read()).tree.links.map((l) => l.projectId)).toEqual([b.id]);
    const later = await s.addNote({ body: 'Now only Book 2.', author: 'Blake', target: { module: 'market', kind: 'category', id: 'epic-fantasy' } });
    expect(later.projectId).toBe(b.id);
  });

  it('refuses a change to the project tree while the tree is locked, still takes notes, and takes the server’s tree without being refused', async () => {
    const mine = await s.createProject({ name: 'Mine' });
    const seen: number[] = [];
    s.onTreeChange = (t) => seen.push(t.projects.length);
    s.treeLock = () => 'The projects of this Studio are kept by its owner.';
    await expect(s.createProject({ name: 'Nope' })).rejects.toThrow(/kept by its owner/);
    await expect(s.updateProject(mine.id, { name: 'Renamed' })).rejects.toThrow(/kept by its owner/);
    expect((await s.read()).tree.projects.map((p) => p.name)).toEqual(['Mine']);
    await s.addNote({ body: 'A note is fine.', author: 'A', projectId: mine.id });
    expect((await s.read()).notes).toHaveLength(1);
    expect(seen).toEqual([]);
    // what the server holds replaces the local tree, and is not announced back as a local change
    const served = { projects: [{ id: 'p_srv', name: 'From server', parentId: null, kind: '', status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] };
    expect(await s.replaceTree(served)).toBe(true);
    expect(await s.replaceTree(served)).toBe(false);
    expect((await s.read()).tree.projects.map((p) => p.name)).toEqual(['From server']);
    expect(seen).toEqual([]);
    // unlocked, a change is announced
    s.treeLock = null;
    await s.createProject({ name: 'Later' });
    expect(seen).toEqual([2]);
  });

  it('queries a project’s notes including its subprojects', async () => {
    const series = await s.createProject({ name: 'S' });
    const b1 = await s.createProject({ name: 'B1', parentId: series.id });
    const other = await s.createProject({ name: 'Other' });
    for (const p of [series, b1, other]) await s.addNote({ projectId: p.id, body: `on ${p.name}`, author: 'A' });
    const d = await s.read();
    expect(queryNotes(d.notes, { projectIds: subtreeIds(d.tree, series.id) }).map((n) => n.body).sort()).toEqual(['on B1', 'on S']);
  });

  it('deleting a project removes its notes and links but not other projects’', async () => {
    const a = await s.createProject({ name: 'A' });
    const b = await s.createProject({ name: 'B' });
    await s.link(a.id, 'write', 'A');
    await s.addNote({ projectId: a.id, body: 'gone', author: 'x' });
    await s.addNote({ projectId: b.id, body: 'stays', author: 'x' });
    expect(await s.deleteProject(a.id)).toEqual([a.id]);
    const d = await s.read();
    expect(d.notes.map((n) => n.body)).toEqual(['stays']);
    expect(d.tree.links).toEqual([]);
  });

  it('note lifecycle: reply, resolve, edit, delete', async () => {
    const n = await s.addNote({ body: 'Q', author: 'AI', origin: 'ai', category: 'Pricing' });
    await s.replyToNote(n.id, { author: 'Blake', body: 'A' });
    await s.editNote(n.id, { body: 'Q2' });
    await s.setNoteStatus(n.id, 'resolved');
    expect((await s.read()).notes[0]).toMatchObject({ body: 'Q2', status: 'resolved', category: 'pricing', origin: 'ai' });
    await s.deleteNote(n.id);
    expect(queryNotes((await s.read()).notes, { status: 'any' })).toEqual([]);
  });

  it('keeps every change when many land at once, and reports a refused one without losing the rest', async () => {
    const results = await Promise.allSettled([
      ...Array.from({ length: 20 }, (_, i) => s.createProject({ name: `P${i}` })),
      s.createProject({ name: 'P3' }) // duplicate name
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await s.read()).tree.projects).toHaveLength(20);
  });

  it('two Studio objects on one file (the app and the AI server) do not lose each other’s changes', async () => {
    const other = new Studio(file);
    await s.createProject({ name: 'From app' });
    await other.createProject({ name: 'From AI' });
    await s.addNote({ body: 'later', author: 'x' });
    expect((await other.read()).tree.projects.map((p) => p.name)).toEqual(['From app', 'From AI']);
    expect((await other.read()).notes).toHaveLength(1);
  });

  it('studioFile: flag, env, then the app’s own folder', () => {
    expect(studioFile(['--studio', '/x/s.json'], {}, 'linux')).toBe('/x/s.json');
    expect(studioFile([], { CADREL_STUDIO: '/y/s.json' }, 'linux')).toBe('/y/s.json');
    expect(studioFile([], { CADREL_USER_DATA: '/z' }, 'linux')).toBe('/z/studio.json');
    expect(studioFile([], { APPDATA: 'C:\\A' }, 'win32')).toMatch(/Cadrel[\\/]studio\.json$/);
    expect(studioFile([], { XDG_CONFIG_HOME: '/c' }, 'linux')).toBe('/c/Cadrel/studio.json');
  });
});
