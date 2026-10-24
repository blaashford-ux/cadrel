import { beforeEach, describe, expect, it } from 'vitest';
import type { UnsavedChoice } from '../api';
import { MemoryFs } from '../memoryFs';
import { createCoreApi, type CoreBackend } from './coreApi';

const ROOT = '/data/MDEdit';
const dialogs = {
  confirmUnsaved: async (): Promise<UnsavedChoice> => 'save',
  confirmOverwrite: async () => true,
  confirmDelete: async () => true,
  confirmRecover: async () => true,
  confirmMarkEdited: async () => false,
};

let fs: MemoryFs;
let backend: CoreBackend;
const make = () =>
  createCoreApi({
    fs, rootFolder: ROOT, settingsFile: '/data/state/settings.json', draftsDir: '/data/state/drafts', trashDir: '/data/state/trash',
    dialogs, now: () => new Date('2026-10-05T12:00:00'),
  });

beforeEach(async () => {
  fs = new MemoryFs();
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir('/data/state', { recursive: true });
  backend = make();
  await backend.load();
});

const novel = async () => {
  const { path } = await backend.api.createProject('The Lost King', 'novel');
  await backend.api.scanFolder(path);
  return path;
};

describe('projects on the phone’s API', () => {
  it('creates a project from a template, lists it and reads its metadata', async () => {
    const path = await novel();
    expect(path).toBe(`${ROOT}/The Lost King`);
    const list = await backend.api.listProjects();
    expect(list.projects.map((p) => p.name)).toEqual(['The Lost King']);
    expect((await backend.api.getProjectMeta(path))?.name).toBe('The Lost King');
    const tree = await backend.api.scanFolder(path);
    expect(tree.children.map((c) => c.name)).toEqual(expect.arrayContaining(['Manuscript', 'Characters']));
  });

  it('refuses names that are not Windows-compliant', async () => {
    await expect(backend.api.createProject('Bad: Name', 'novel')).rejects.toThrow();
    await expect(backend.api.createProject('CON', 'novel')).rejects.toThrow();
  });

  it('renames, duplicates and deletes (to the trash) a project', async () => {
    const path = await novel();
    const renamed = await backend.api.renameProject(path, 'The Found King');
    expect(renamed).toBe(`${ROOT}/The Found King`);
    const copy = await backend.api.duplicateProject(renamed, 'Copy');
    expect(copy.path).toBe(`${ROOT}/Copy`);
    await backend.api.deleteProject(copy.path);
    expect(await fs.stat(copy.path)).toBeNull();
    expect((await fs.readdir('/data/state/trash')).length).toBe(1);
    expect((await backend.api.listProjects()).projects.map((p) => p.name)).toEqual(['The Found King']);
  });

  it('records progress for a project', async () => {
    const path = await novel();
    await backend.api.createFile(`${path}/Manuscript`, 'Ch 1', '# One\nthree little words\n');
    expect((await backend.api.recordProgress(path)).total).toBeNull(); // no active manuscript
    await backend.api.updateProject(path, { activeManuscript: 'Manuscript/Ch 1.md' });
    expect((await backend.api.recordProgress(path)).total).toBeGreaterThanOrEqual(3);
  });

  it('keeps the Root Folder fixed', async () => {
    await expect(backend.api.moveProjects('/elsewhere')).rejects.toThrow(/cannot be changed/);
    const cfg = await backend.api.setProjectsConfig({ rootFolder: '/elsewhere' });
    expect(cfg.root).toBe(ROOT);
  });
});

describe('files on the phone’s API', () => {
  it('creates, saves, reads and stamps a Markdown file', async () => {
    const path = await novel();
    const file = await backend.api.createFile(`${path}/Manuscript`, 'Chapter 1');
    expect(file).toBe(`${path}/Manuscript/Chapter 1.md`);
    const stamp = await backend.api.writeFile(file, '# One\nhello\r\nworld');
    expect(stamp.size).toBeGreaterThan(0);
    expect((await backend.api.readFile(file)).text).toBe('# One\nhello\r\nworld');
    expect((await backend.api.statFile(file))?.mtimeMs).toBe(stamp.mtimeMs);
  });

  it('refuses to write anything that is not Markdown, or to leave the opened folder', async () => {
    const path = await novel();
    await expect(backend.api.writeFile(`${path}/x.txt`, 'x')).rejects.toThrow(/non-Markdown/);
    await expect(backend.api.writeFile(`${ROOT}/other.md`, 'x')).rejects.toThrow(/outside/);
    await expect(backend.api.readFile(`${path}/../etc.md`)).rejects.toThrow(/outside/);
  });

  it('only opens folders inside the Root', async () => {
    await expect(backend.api.scanFolder('/data')).rejects.toThrow(/outside the Root/);
  });

  it('keeps a manuscript’s export settings with it on rename and delete', async () => {
    const path = await novel();
    const dir = `${path}/Manuscript`;
    const md = await backend.api.createFile(dir, 'Book', 'x');
    await fs.writeText(`${dir}/Book.export.json`, '{"marked":true}');
    const renamed = await backend.api.renameNode(md, 'Novel');
    expect(renamed).toBe(`${dir}/Novel.md`);
    expect(await fs.stat(`${dir}/Novel.export.json`)).not.toBeNull();
    expect(await fs.stat(`${dir}/Book.export.json`)).toBeNull();
    await backend.api.trashNode(renamed);
    expect(await fs.stat(`${dir}/Novel.md`)).toBeNull();
    expect(await fs.stat(`${dir}/Novel.export.json`)).toBeNull();
    expect((await fs.readdir('/data/state/trash')).length).toBe(2);
  });

  it('refuses non-compliant names for new files and renames', async () => {
    const path = await novel();
    await expect(backend.api.createFile(path, 'a:b')).rejects.toThrow();
    const f = await backend.api.createFile(path, 'ok');
    await expect(backend.api.renameNode(f, 'nul')).rejects.toThrow(/reserved/);
  });
});

describe('state on the phone’s API', () => {
  it('saves and lists unsaved-edit drafts', async () => {
    await backend.api.saveDraft({ file: `${ROOT}/a.md`, chapter: 0, title: 'One', markdown: '# One', updatedAt: 5 });
    expect((await backend.api.listDrafts()).map((d) => d.file)).toEqual([`${ROOT}/a.md`]);
    await backend.api.clearDraft(`${ROOT}/a.md`);
    expect(await backend.api.listDrafts()).toEqual([]);
  });

  it('keeps settings between launches', async () => {
    await backend.api.setPrefs({ sidebarWidth: 321 });
    backend.api.setLastProject(`${ROOT}/The Lost King`);
    await backend.flush();
    const again = make();
    await again.load();
    expect(await again.api.getPrefs()).toEqual({ sidebarWidth: 321 });
    expect((await again.api.getProjectsConfig()).lastProject).toBe(`${ROOT}/The Lost King`);
  });

  it('keeps custom theme colours between launches, and clears them again', async () => {
    await backend.api.setPrefs({ sidebarWidth: 300, themeCustom: { light: { bg: '#FFFFFF' }, dark: { accent: 'nonsense' } as never } });
    await backend.flush();
    const again = make();
    await again.load();
    expect(await again.api.getPrefs()).toEqual({ sidebarWidth: 300, themeCustom: { light: { bg: '#ffffff' } } });
    again.api.setPrefs({ themeCustom: undefined });
    await again.flush();
    const third = make();
    await third.load();
    expect(await third.api.getPrefs()).toEqual({ sidebarWidth: 300 });
  });

  it('remembers which projects were opened, most recent first, across launches', async () => {
    backend.api.setLastProject(`${ROOT}/The Lost King`);
    backend.api.setLastProject(`${ROOT}/Short Stories`);
    backend.api.setLastProject(`${ROOT}/The Lost King`); // opened again: back to the front, not repeated
    backend.api.setLastProject(null); // closing a project records nothing new
    await backend.flush();
    const again = make();
    await again.load();
    expect((await again.api.getProjectsConfig()).recentProjects).toEqual([`${ROOT}/The Lost King`, `${ROOT}/Short Stories`]);
  });
});

describe('word counts', () => {
  it('are not re-read from files that have not changed', async () => {
    const path = await novel();
    await backend.api.createFile(`${path}/Manuscript`, 'Ch 1', '# One\nthree little words\n');
    await backend.api.listProjects();
    const real = fs.readText.bind(fs);
    let reads = 0;
    fs.readText = async (p: string) => (reads++, real(p));
    await backend.api.listProjects();
    expect(reads).toBe(2); // the project marker and its edited-chapter marks; the chapter's count came from the cache
    await backend.api.writeFile(`${path}/Manuscript/Ch 1.md`, '# One\nfour little words now\n');
    await backend.api.updateProject(path, { activeManuscript: 'Manuscript/Ch 1.md' });
    const again = await backend.api.listProjects();
    expect(again.projects[0].words).toBeGreaterThanOrEqual(4); // the active manuscript is counted afresh
  });
});
