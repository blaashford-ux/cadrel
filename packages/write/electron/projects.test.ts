import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultTemplates } from '../src/shared/projects';
import {
  addMissingTemplateParts, convertToProject, countProject, createProject, deleteProject, duplicateProject, isProject, listProjects,
  readMeta, readProgress, recordProgress, renameProject, updateMeta
} from './projects';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mdedit-proj-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const novel = () => defaultTemplates().find((t) => t.id === 'novel')!;
const blank = () => defaultTemplates().find((t) => t.id === 'blank')!;
const at = (iso: string) => () => new Date(iso);
const names = async (dir: string) => (await readdir(dir)).sort();

describe('createProject', () => {
  it('builds the template’s folders, starter files and metadata', async () => {
    const r = await createProject(root, 'The Lost King', novel(), { now: at('2026-10-05T10:00:00'), uuid: () => 'id-1' });
    expect(r.path).toBe(path.join(root, 'The Lost King'));
    expect(await names(r.path)).toEqual(['.mdedit', 'Characters', 'Exports', 'Manuscript', 'Research', 'Worldbuilding']);
    expect(await readFile(path.join(r.path, 'Manuscript', 'Draft.md'), 'utf8')).toBe('# Chapter 1\n\n');
    const meta = await readMeta(r.path);
    expect(meta).toMatchObject({ id: 'id-1', name: 'The Lost King', templateName: 'Novel', status: 'planning' });
    expect(meta!.excludedFolders).toContain('Research');
    expect(await isProject(r.path)).toBe(true);
  });

  it('records the starting word count as the progress baseline', async () => {
    const t = { ...novel(), files: [{ path: 'Manuscript/Draft.md', content: 'one two three four five\n' }] };
    const r = await createProject(root, 'P', t, { now: at('2026-10-05T10:00:00') });
    const p = await readProgress(r.path);
    expect(p.days['2026-10-05']).toEqual({ start: 5, end: 5 });
  });

  it('leaves nothing behind when any step fails', async () => {
    for (const failAt of ['folders', 'files', 'meta', 'rename']) {
      await expect(
        createProject(root, 'Doomed', novel(), {
          step: (s) => {
            if (s === failAt) throw new Error('disk on fire at ' + s);
          }
        })
      ).rejects.toThrow(/disk on fire/);
      expect(await names(root)).toEqual([]);
    }
  });

  it('refuses bad names and clashes (case-insensitive) without touching anything', async () => {
    await createProject(root, 'Book', blank());
    await expect(createProject(root, 'book', blank())).rejects.toThrow(/already/);
    await expect(createProject(root, 'a/b', blank())).rejects.toThrow(/cannot contain/);
    await expect(createProject(root, 'CON', blank())).rejects.toThrow(/reserved/);
    await expect(createProject(root, '  ', blank())).rejects.toThrow(/empty/);
    expect(await names(root)).toEqual(['Book']);
  });

  it('creates the Root Folder if it does not exist yet', async () => {
    const deep = path.join(root, 'nested', 'MDEdit');
    await createProject(deep, 'P', blank());
    expect(await isProject(path.join(deep, 'P'))).toBe(true);
  });

  it('copies template defaults into the project overrides', async () => {
    const t = { ...novel(), chapterLevel: 2 };
    const r = await createProject(root, 'P', t);
    expect(r.meta.overrides.chapterLevel).toBe(2);
  });
});

describe('listProjects', () => {
  it('separates projects from other folders, counts words, ignores hidden folders and files', async () => {
    const a = await createProject(root, 'Alpha', novel());
    await writeFile(path.join(a.path, 'Manuscript', 'Draft.md'), 'one two three\n');
    await writeFile(path.join(a.path, 'Research', 'notes.md'), 'many many many many words not counted\n'); // excluded folder
    await mkdir(path.join(root, 'Plain Folder'));
    await mkdir(path.join(root, '.hidden'));
    await writeFile(path.join(root, 'stray.md'), 'x');
    const l = await listProjects(root);
    expect(l.exists).toBe(true);
    expect(l.projects.map((p) => [p.name, p.words, p.files])).toEqual([['Alpha', 3, 1]]);
    expect(l.folders.map((f) => f.name)).toEqual(['Plain Folder']);
    expect(l.projects[0].lastEdited).toBeGreaterThan(0);
  });
  it('reports a missing root', async () => {
    const l = await listProjects(path.join(root, 'nope'));
    expect(l).toMatchObject({ exists: false, projects: [], folders: [] });
  });
  it('a damaged marker still lists the project (named after its folder) and is repaired', async () => {
    const a = await createProject(root, 'Alpha', blank());
    await writeFile(path.join(a.path, '.mdedit', 'project.json'), '{ not json');
    const l = await listProjects(root);
    expect(l.projects[0].name).toBe('Alpha');
    expect(JSON.parse(await readFile(path.join(a.path, '.mdedit', 'project.json'), 'utf8')).name).toBe('Alpha');
  });
});

describe('countProject', () => {
  it('skips excluded folders at any depth, hidden folders and non-Markdown files', async () => {
    const d = path.join(root, 'p');
    await mkdir(path.join(d, 'A', 'Sub'), { recursive: true });
    await mkdir(path.join(d, '.mdedit'), { recursive: true });
    await writeFile(path.join(d, 'A', 'one.md'), 'a b c');
    await writeFile(path.join(d, 'A', 'Sub', 'two.md'), 'd e');
    await writeFile(path.join(d, 'A', 'x.txt'), 'nope nope');
    await writeFile(path.join(d, '.mdedit', 'hid.md'), 'nope nope nope');
    expect((await countProject(d)).words).toBe(5);
    expect((await countProject(d, ['a/sub'])).words).toBe(3);
    expect((await countProject(d, ['A'])).words).toBe(0);
  });
});

describe('renameProject / duplicateProject / delete / convert', () => {
  it('rename moves the folder and the recorded name', async () => {
    const a = await createProject(root, 'Alpha', novel());
    const to = await renameProject(a.path, 'Beta');
    expect(to).toBe(path.join(root, 'Beta'));
    expect(await names(root)).toEqual(['Beta']);
    expect((await readMeta(to))!.name).toBe('Beta');
  });
  it('rename refuses a clash and allows a case-only change', async () => {
    const a = await createProject(root, 'Alpha', blank());
    await createProject(root, 'Beta', blank());
    await expect(renameProject(a.path, 'beta')).rejects.toThrow(/already/);
    const to = await renameProject(a.path, 'ALPHA');
    expect((await readMeta(to))!.name).toBe('ALPHA');
  });
  it('duplicate copies files and settings, with a new id and a fresh history', async () => {
    const a = await createProject(root, 'Alpha', novel(), { now: at('2026-10-05T10:00:00'), uuid: () => 'id-a' });
    await writeFile(path.join(a.path, 'Manuscript', 'Draft.md'), 'one two three\n');
    await updateMeta(a.path, { goal: { targetWords: 5000, startDate: '2026-10-05', targetDate: null }, status: 'drafting' });
    await recordProgress(a.path, at('2026-10-06T09:00:00'));
    const b = await duplicateProject(a.path, 'Alpha Copy', { now: at('2026-10-07T09:00:00'), uuid: () => 'id-b' });
    expect(b.meta).toMatchObject({ id: 'id-b', name: 'Alpha Copy', status: 'drafting', goal: { targetWords: 5000 } });
    expect(await readFile(path.join(b.path, 'Manuscript', 'Draft.md'), 'utf8')).toBe('one two three\n');
    const p = await readProgress(b.path);
    expect(Object.keys(p.days)).toEqual(['2026-10-07']);
    expect(p.days['2026-10-07']).toEqual({ start: 3, end: 3 });
    expect((await readMeta(a.path))!.id).toBe('id-a'); // original untouched
    expect(await names(root)).toEqual(['Alpha', 'Alpha Copy']);
  });
  it('delete only works on projects and uses the supplied trash', async () => {
    const a = await createProject(root, 'Alpha', blank());
    await mkdir(path.join(root, 'Plain'));
    const trashed: string[] = [];
    await deleteProject(a.path, async (p) => void trashed.push(p));
    expect(trashed).toEqual([a.path]);
    await expect(deleteProject(path.join(root, 'Plain'), async () => undefined)).rejects.toThrow(/not a project/);
  });
  it('convert adds only the marker and a baseline, and refuses to run twice', async () => {
    const d = path.join(root, 'Old Work');
    await mkdir(d);
    await writeFile(path.join(d, 'a.md'), 'one two three four');
    const meta = await convertToProject(d, { now: at('2026-10-05T10:00:00'), uuid: () => 'id-c' });
    expect(meta).toMatchObject({ id: 'id-c', name: 'Old Work', templateId: 'blank', excludedFolders: [] });
    expect(await names(d)).toEqual(['.mdedit', 'a.md']);
    expect((await readProgress(d)).days['2026-10-05']).toEqual({ start: 4, end: 4 });
    await expect(convertToProject(d)).rejects.toThrow(/already/);
  });
});

describe('progress recording', () => {
  it('tracks days from the previous day’s end and ignores unchanged totals', async () => {
    const a = await createProject(root, 'Alpha', novel(), { now: at('2026-10-05T08:00:00') });
    const draft = path.join(a.path, 'Manuscript', 'Draft.md');
    await writeFile(draft, 'w '.repeat(100));
    let r = await recordProgress(a.path, at('2026-10-05T12:00:00'));
    expect(r.total).toBe(100);
    expect(r.progress.days['2026-10-05']).toEqual({ start: 2, end: 100 }); // the starter heading is 2 words
    const mtime = (await stat(path.join(a.path, '.mdedit', 'progress.json'))).mtimeMs;
    await new Promise((res) => setTimeout(res, 20));
    await recordProgress(a.path, at('2026-10-05T12:30:00')); // nothing changed
    expect((await stat(path.join(a.path, '.mdedit', 'progress.json'))).mtimeMs).toBe(mtime);
    await writeFile(draft, 'w '.repeat(350));
    r = await recordProgress(a.path, at('2026-10-06T09:00:00'));
    expect(r.progress.days['2026-10-06']).toEqual({ start: 100, end: 350 });
  });
  it('words outside the counted folders do not move the total', async () => {
    const a = await createProject(root, 'Alpha', novel(), { now: at('2026-10-05T08:00:00') });
    await writeFile(path.join(a.path, 'Research', 'big.md'), 'w '.repeat(5000));
    expect((await recordProgress(a.path, at('2026-10-05T12:00:00'))).total).toBe(2); // only the starter heading
  });
  it('a damaged history file starts over instead of failing', async () => {
    const a = await createProject(root, 'Alpha', blank(), { now: at('2026-10-05T08:00:00') });
    await writeFile(path.join(a.path, '.mdedit', 'progress.json'), 'garbage');
    expect((await recordProgress(a.path, at('2026-10-05T12:00:00'))).progress.days['2026-10-05']).toBeDefined();
  });
});

describe('updateMeta / addMissingTemplateParts', () => {
  it('merges overrides without losing the other half, and sanitises', async () => {
    const a = await createProject(root, 'Alpha', novel());
    await updateMeta(a.path, { overrides: { chapterLevel: 3, book: null } });
    const m = await updateMeta(a.path, { status: 'nonsense' as never, notes: 'hello' });
    expect(m.overrides.chapterLevel).toBe(3);
    expect(m.status).toBe('planning');
    expect(m.notes).toBe('hello');
  });
  it('adds only what is missing', async () => {
    const a = await createProject(root, 'Alpha', novel());
    await rm(path.join(a.path, 'Research'), { recursive: true });
    await writeFile(path.join(a.path, 'Manuscript', 'Draft.md'), 'my words');
    const added = await addMissingTemplateParts(a.path, novel());
    expect(added).toEqual(['Research']);
    expect(await readFile(path.join(a.path, 'Manuscript', 'Draft.md'), 'utf8')).toBe('my words');
  });
});

describe('moveProjects', () => {
  it('moves projects (not other folders) and reports clashes', async () => {
    const { moveProjects } = await import('./projects');
    await createProject(root, 'Alpha', blank());
    await createProject(root, 'Beta', blank());
    await mkdir(path.join(root, 'Plain'));
    const dest = path.join(root, '..', path.basename(root) + '-new');
    await mkdir(path.join(dest, 'Beta'), { recursive: true }); // a clash
    try {
      const r = await moveProjects(root, dest);
      expect(r.moved).toEqual(['Alpha']);
      expect(r.failed.map((f) => f.name)).toEqual(['Beta']);
      expect(await names(root)).toEqual(['Beta', 'Plain']);
      expect(await isProject(path.join(dest, 'Alpha'))).toBe(true);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe('active manuscript', () => {
  const series = () => defaultTemplates().find((t) => t.id === 'series')!;
  it('a Series project starts with a Manuscripts folder and no book files', async () => {
    const a = await createProject(root, 'Saga', series(), { now: at('2026-10-05T08:00:00') });
    expect(await names(path.join(a.path, 'Manuscripts'))).toEqual([]);
  });
  it('progress and summaries follow only the active manuscript, each with its own history', async () => {
    const a = await createProject(root, 'Saga', series(), { now: at('2026-10-05T08:00:00') });
    await writeFile(path.join(a.path, 'Manuscripts', 'One.md'), 'w '.repeat(100));
    await writeFile(path.join(a.path, 'Manuscripts', 'Two.md'), 'w '.repeat(40));
    await updateMeta(a.path, { activeManuscript: 'Manuscripts/One.md' });
    let r = await recordProgress(a.path, at('2026-10-05T12:00:00'));
    expect(r).toMatchObject({ total: 100, manuscript: 'Manuscripts/One.md' });
    expect((await listProjects(root)).projects[0].words).toBe(100);
    await updateMeta(a.path, { activeManuscript: 'Manuscripts/Two.md' }); // swap, no prompt, own history
    r = await recordProgress(a.path, at('2026-10-05T13:00:00'));
    expect(r.total).toBe(40);
    expect(r.progress.days['2026-10-05']).toEqual({ start: 40, end: 40 });
    expect((await readProgress(a.path, 'Manuscripts/One.md')).days['2026-10-05'].end).toBe(100);
  });
  it('a deleted manuscript is cleared and the project is counted again', async () => {
    const a = await createProject(root, 'Saga', series(), { now: at('2026-10-05T08:00:00') });
    await updateMeta(a.path, { activeManuscript: 'Manuscripts/Gone.md' });
    const r = await recordProgress(a.path, at('2026-10-05T12:00:00'));
    expect(r.manuscript).toBeNull();
    expect((await readMeta(a.path))!.activeManuscript).toBeNull();
  });
});

