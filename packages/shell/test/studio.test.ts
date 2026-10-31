import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, emptyTree } from '@cadrel/kernel';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { rollUp, StudioService } from '../src/main/studio';

async function service(writeRoot: string | null = '/books', viewer?: ConstructorParameters<typeof StudioService>[0]['viewer']) {
  const mem = new MemoryFs();
  mem.seed('/books/DR1/.cadrel/project.json', '{"status":"drafting"}');
  mem.seed('/books/DR1/Book.md', '# One\n\nShe walked slowly to the door.\n');
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'cadrel-svc-')), 'studio.json');
  return new StudioService({ file, author: () => 'Blake', writeRoot: async () => writeRoot, fs: mem, viewer });
}

describe('StudioService', () => {
  it('reports the tree, notes by people and by Write, and open counts rolled up to the Series', async () => {
    const s = await service();
    const series = await s.createProject({ name: 'Dragon Rider', kind: 'Series' });
    const book = await s.createProject({ name: 'Book 1', parentId: series.id, kind: 'Book' });
    await s.link(book.id, 'write', 'DR1');
    const mine = await s.addNote({ projectId: book.id, body: 'Check the map.', category: 'continuity' });
    await s.addNote({ projectId: series.id, body: 'Series arc.', target: null });
    const st = await s.state();
    expect(st.author).toBe('Blake');
    expect(st.tree.projects).toHaveLength(2);
    expect(st.notes.map((n) => n.body).sort()).toEqual(['Check the map.', 'Series arc.']);
    expect(st.notes.find((n) => n.id === mine.id)).toMatchObject({ author: 'Blake', origin: 'human', source: 'studio', category: 'continuity' });
    expect(st.openByProject).toEqual({ [series.id]: 2, [book.id]: 1 });

    await s.setNoteStatus(mine.id, 'resolved');
    await s.replyToNote(mine.id, 'Done.');
    expect((await s.state()).openByProject).toEqual({ [series.id]: 1 });
    await s.deleteNote(mine.id);
    expect((await s.state()).notes.map((n) => n.body)).toEqual(['Series arc.']);
  });

  it('works with no Write folder chosen', async () => {
    const s = await service(null);
    await s.addNote({ projectId: null, body: 'Studio-wide' });
    expect((await s.state()).notes).toHaveLength(1);
  });

  it('refuses duplicates and loops with a readable message', async () => {
    const s = await service();
    const a = await s.createProject({ name: 'A' });
    const b = await s.createProject({ name: 'B', parentId: a.id });
    await expect(s.createProject({ name: 'a' })).rejects.toThrow(/already exists/);
    await expect(s.moveProject(a.id, b.id)).rejects.toThrow(/into itself/);
    await expect(s.deleteProject(a.id, false)).rejects.toThrow(/1 subproject/);
    expect(await s.deleteProject(a.id, true)).toHaveLength(2);
  });
});

describe('rollUp', () => {
  it('counts open notes of a project and everything below it', () => {
    const a = createProject(emptyTree(), { name: 'A' });
    const b = createProject(a.tree, { name: 'B', parentId: a.project.id });
    const c = createProject(b.tree, { name: 'C', parentId: b.project.id });
    const notes = [
      { projectId: c.project.id, status: 'open' as const },
      { projectId: c.project.id, status: 'resolved' as const },
      { projectId: a.project.id, status: 'open' as const },
      { projectId: null, status: 'open' as const }
    ];
    expect(rollUp(c.tree, notes)).toEqual({ [a.project.id]: 2, [b.project.id]: 1, [c.project.id]: 1 });
  });
});

describe('projects hidden from people who are not assigned to them', () => {
  it('shows the tree, notes, counts and links of the visible projects only, and refuses changes to the rest', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'cadrel-hide-')), 'studio.json');
    const base = { file, author: () => 'Blake', writeRoot: async () => null, fs: new MemoryFs() };
    const everyone = new StudioService(base);
    const ser = await everyone.createProject({ name: 'Dragon Rider', kind: 'Series' });
    const b1 = await everyone.createProject({ name: 'Book 1', parentId: ser.id, kind: 'Book' });
    const secret = await everyone.createProject({ name: 'Secret', kind: 'Book' });
    await everyone.link(b1.id, 'write', 'DR1');
    await everyone.link(secret.id, 'write', 'Hush');
    await everyone.addNote({ projectId: secret.id, body: 'Hidden note.' });
    await everyone.addNote({ projectId: b1.id, body: 'Visible note.' });

    // The same file, seen by someone who is assigned to Book 1 only (so Dragon Rider shows as the container it sits in).
    const narrowed = new StudioService({ ...base, viewer: async (t) => ({ all: false, visible: new Set(t.projects.filter((p) => p.name !== 'Secret').map((p) => p.id)) }) });
    const st = await narrowed.state();
    expect(st.tree.projects.map((p) => p.name).sort()).toEqual(['Book 1', 'Dragon Rider']);
    expect(st.tree.links).toEqual([{ projectId: b1.id, module: 'write', ref: 'DR1' }]);
    expect(st.notes.map((n) => n.body)).toEqual(['Visible note.']);
    expect(st.openByProject).toEqual({ [ser.id]: 1, [b1.id]: 1 });
    expect(await narrowed.hiddenLinks()).toEqual([{ module: 'write', ref: 'Hush' }]);
    for (const attempt of [
      () => narrowed.updateProject(secret.id, { name: 'Nope' }),
      () => narrowed.addNote({ projectId: secret.id, body: 'x' }),
      () => narrowed.createProject({ name: 'Child', parentId: secret.id }),
      () => narrowed.link(secret.id, 'write', 'Other'),
      () => narrowed.archiveProject(secret.id, true),
      () => narrowed.deleteProject(secret.id, true)
    ]) await expect(attempt()).rejects.toThrow(/no such project/);
    await narrowed.updateProject(b1.id, { name: 'Book One' }); // what they can see they can still change (their role decides that)

    const after = await everyone.state(); // the hidden project is untouched in the file
    expect(after.tree.projects.map((p) => p.name).sort()).toEqual(['Book One', 'Dragon Rider', 'Secret']);
    expect(after.notes).toHaveLength(2);
  });
});
