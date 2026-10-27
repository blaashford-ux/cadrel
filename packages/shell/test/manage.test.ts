import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { linksOf } from '@cadrel/kernel';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { ProjectManager, type WriteFolders } from '../src/main/manage';
import { StudioService } from '../src/main/studio';

/** A stand-in for Write: folders in a list, with Write's own rules about names. */
function fakeWrite() {
  const root = '/w';
  const folders = new Map<string, { project: boolean; meta: { status: string; notes: string; archived: boolean; templateId: string } }>();
  const opened: string[] = [];
  const trashed: string[] = [];
  const name = (p: string) => path.posix.basename(p);
  const w: WriteFolders = {
    projectsRoot: () => root,
    templates: () => [{ id: 'novel', name: 'Novel', description: 'One book' }, { id: 'blank', name: 'Blank', description: '' }],
    listFolders: async () => ({
      projects: [...folders].filter(([, v]) => v.project).map(([n]) => ({ name: n, path: `${root}/${n}` })),
      others: [...folders].filter(([, v]) => !v.project).map(([n]) => ({ name: n, path: `${root}/${n}` }))
    }),
    createProject: async (n, t) => {
      if (/[<>:"/\\|?*]/.test(n)) throw new Error('A name cannot contain < > : " / \\ | ? *');
      if (folders.has(n)) throw new Error(`There is already a project called “${n}”.`);
      folders.set(n, { project: true, meta: { status: 'planning', notes: '', archived: false, templateId: t } });
      return { path: `${root}/${n}` };
    },
    renameProject: async (p, n) => {
      if (folders.has(n)) throw new Error(`There is already a project called “${n}”.`);
      folders.set(n, folders.get(name(p))!);
      folders.delete(name(p));
      return `${root}/${n}`;
    },
    duplicateProject: async (p, n) => {
      folders.set(n, { project: true, meta: { ...folders.get(name(p))!.meta } });
      return { path: `${root}/${n}` };
    },
    deleteProject: async (p) => void (folders.delete(name(p)), trashed.push(name(p))),
    readProject: async (p) => {
      const f = folders.get(name(p));
      return f && f.project ? { ...f.meta, templateName: 'Novel', createdAt: '2026-01-01' } : null;
    },
    updateProject: async (p, patch) => void Object.assign(folders.get(name(p))!.meta, patch),
    convertFolder: async (p) => void (folders.get(name(p))!.project = true),
    addMissingTemplateParts: async () => ['Research'],
    openProject: (p) => void opened.push(p)
  };
  return { w, folders, opened, trashed };
}

let studio: StudioService, mgr: ProjectManager, fake: ReturnType<typeof fakeWrite>;
beforeEach(async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'cadrel-mgr-')), 'studio.json');
  studio = new StudioService({ file, author: () => 'Blake', writeRoot: async () => null, fs: new MemoryFs() });
  fake = fakeWrite();
  mgr = new ProjectManager(studio, fake.w);
});
const tree = async () => (await studio.studio.read()).tree;

describe('ProjectManager', () => {
  it('creates a project with its manuscript folder from a template, linked', async () => {
    const r = await mgr.create({ name: 'Dragon Rider', kind: 'Series', template: 'novel' });
    expect(r.folder).toBe('/w/Dragon Rider');
    expect(fake.folders.get('Dragon Rider')!.meta.templateId).toBe('novel');
    expect(linksOf(await tree(), r.id, 'write')).toEqual([{ projectId: r.id, module: 'write', ref: 'Dragon Rider' }]);
  });

  it('creates a plain project with no folder; a subproject goes under its parent', async () => {
    const s = await mgr.create({ name: 'Series', template: null });
    const b = await mgr.create({ name: 'Book 1', parentId: s.id, template: 'novel' });
    expect(s.folder).toBeNull();
    expect(fake.folders.size).toBe(1);
    expect((await tree()).projects.find((p) => p.id === b.id)!.parentId).toBe(s.id);
  });

  it('finds a free folder name when the project’s own name is taken', async () => {
    fake.folders.set('Book', { project: false, meta: { status: '', notes: '', archived: false, templateId: '' } });
    const r = await mgr.create({ name: 'Book', template: 'blank' });
    expect(r.folder).toBe('/w/Book 2');
    expect((await tree()).projects[0]!.name).toBe('Book');
  });

  it('refuses a name Windows will not allow, and leaves nothing half-made', async () => {
    await expect(mgr.create({ name: 'Bad: name', template: 'novel' })).rejects.toThrow(/cannot contain|name/i);
    expect((await tree()).projects).toEqual([]);
    expect(fake.folders.size).toBe(0);
  });

  it('refuses an unknown template, and removes its folder when the tree refuses a duplicate sibling', async () => {
    await expect(mgr.create({ name: 'X', template: 'nope' })).rejects.toThrow(/no longer exists/);
    await mgr.create({ name: 'Same', template: null });
    await expect(mgr.create({ name: 'same', template: 'novel' })).rejects.toThrow(/already exists/);
    expect([...fake.folders.keys()]).toEqual([]); // the folder made for it was taken away again
  });

  it('adds a manuscript folder to a project that has none, once', async () => {
    const r = await mgr.create({ name: 'Plain', template: null });
    expect(await mgr.addManuscript(r.id, 'blank')).toBe('/w/Plain');
    await expect(mgr.addManuscript(r.id, 'blank')).rejects.toThrow(/already has/);
  });

  it('renames the project and its folder together, and keeps them linked', async () => {
    const r = await mgr.create({ name: 'Old', template: 'novel' });
    await mgr.rename(r.id, 'New');
    expect((await tree()).projects[0]!.name).toBe('New');
    expect([...fake.folders.keys()]).toEqual(['New']);
    expect(linksOf(await tree(), r.id, 'write')[0]!.ref).toBe('New');
  });

  it('a rename the folder refuses changes nothing; one the tree refuses puts the folder back', async () => {
    const a = await mgr.create({ name: 'A', template: 'novel' });
    await mgr.create({ name: 'B', template: 'novel' });
    await expect(mgr.rename(a.id, 'B')).rejects.toThrow(/already/);
    expect((await tree()).projects.map((p) => p.name)).toEqual(['A', 'B']);
    // a sibling with that name exists in the tree but its folder has another name: the folder is renamed back
    const c = await mgr.create({ name: 'C', template: null });
    await studio.updateProject(c.id, { name: 'Taken' });
    await expect(mgr.rename(a.id, 'Taken')).rejects.toThrow(/already exists/);
    expect(new Set(fake.folders.keys())).toEqual(new Set(['A', 'B']));
    expect(linksOf(await tree(), a.id, 'write')[0]!.ref).toBe('A');
  });

  it('archiving covers the subprojects’ folders too; restoring brings back one', async () => {
    const s = await mgr.create({ name: 'S', template: 'novel' });
    const b = await mgr.create({ name: 'B1', parentId: s.id, template: 'novel' });
    await mgr.archive(s.id, true);
    expect(fake.folders.get('S')!.meta.archived).toBe(true);
    expect(fake.folders.get('B1')!.meta.archived).toBe(true);
    await mgr.archive(s.id, false);
    expect(fake.folders.get('S')!.meta.archived).toBe(false);
    expect(fake.folders.get('B1')!.meta.archived).toBe(true);
    void b;
  });

  it('deleting takes the subprojects, their notes and their folders (to the bin)', async () => {
    const s = await mgr.create({ name: 'S', template: 'novel' });
    const b = await mgr.create({ name: 'B1', parentId: s.id, template: 'novel' });
    await studio.addNote({ projectId: b.id, body: 'gone with it' });
    const other = await mgr.create({ name: 'Other', template: 'novel' });
    await studio.addNote({ projectId: other.id, body: 'stays' });
    expect((await mgr.remove(s.id)).sort()).toEqual([b.id, s.id].sort());
    expect(fake.trashed.sort()).toEqual(['B1', 'S']);
    expect([...fake.folders.keys()]).toEqual(['Other']);
    expect((await studio.state()).notes.map((n) => n.body)).toEqual(['stays']);
  });

  it('duplicates a project and its folder as a sibling', async () => {
    const r = await mgr.create({ name: 'Book', kind: 'Book', template: 'novel' });
    await mgr.setManuscript(r.id, { notes: 'draft notes' });
    const copyId = await mgr.duplicate(r.id);
    const t = await tree();
    expect(t.projects.find((p) => p.id === copyId)).toMatchObject({ name: 'Book copy', kind: 'Book' });
    expect(fake.folders.get('Book copy')!.meta.notes).toBe('draft notes');
    expect(linksOf(t, copyId, 'write')[0]!.ref).toBe('Book copy');
  });

  it('reads and sets what the manuscript folder says: its notes', async () => {
    const r = await mgr.create({ name: 'Book', template: 'novel' });
    expect((await mgr.manuscript(r.id))!.meta).toMatchObject({ templateId: 'novel' });
    await mgr.setManuscript(r.id, { notes: 'Needs a stronger midpoint.' });
    expect((await mgr.manuscript(r.id))!.meta).toMatchObject({ notes: 'Needs a stronger midpoint.' });
    const plain = await mgr.create({ name: 'Plain', template: null });
    expect(await mgr.manuscript(plain.id)).toBeNull();
    await expect(mgr.setManuscript(plain.id, { notes: 'x' })).rejects.toThrow(/no manuscript folder/);
    expect(await mgr.addMissingParts(r.id)).toEqual(['Research']);
  });

  it('opens a project in Write by its folder; one with no folder says what to do', async () => {
    const r = await mgr.create({ name: 'Book', template: 'novel' });
    await mgr.open(r.id);
    expect(fake.opened).toEqual(['/w/Book']);
    const plain = await mgr.create({ name: 'Plain', template: null });
    await expect(mgr.open(plain.id)).rejects.toThrow(/Add one on the Projects page/);
  });

  it('brings in folders Write has that the tree does not own: projects as they are, plain folders made projects first', async () => {
    fake.folders.set('Old Novel', { project: true, meta: { status: 'drafting', notes: '', archived: false, templateId: 'novel' } });
    fake.folders.set('Loose', { project: false, meta: { status: '', notes: '', archived: false, templateId: '' } });
    await mgr.create({ name: 'Mine', template: 'novel' });
    expect(await mgr.unfiled()).toEqual({ projects: [{ name: 'Old Novel' }], folders: [{ name: 'Loose' }] });
    const a = await mgr.adopt('Old Novel');
    const b = await mgr.adopt('Loose');
    expect(fake.folders.get('Loose')!.project).toBe(true);
    expect(linksOf(await tree(), a, 'write')[0]!.ref).toBe('Old Novel');
    expect(linksOf(await tree(), b, 'write')[0]!.ref).toBe('Loose');
    expect(await mgr.unfiled()).toEqual({ projects: [], folders: [] });
    await expect(mgr.adopt('Missing')).rejects.toThrow(/no folder called/);
  });
});
