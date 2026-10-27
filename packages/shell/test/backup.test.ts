import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  BackupError, createBackup, describeBackup, findMdeditProjects, importMdeditProject, isSecret, previewMdeditImport, restoreBackup, restoreProject, verifyBackup
} from '../src/main/backup';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'cadrel-backup-'));
async function put(root: string, rel: string, text: string | Buffer) {
  const f = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, text);
}
async function tree(root: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) Object.assign(out, await tree(root, r));
    else out[r] = (await readFile(path.join(root, r))).toString('base64');
  }
  return out;
}
const STUDIO = { id: 'local', name: 'My Studio' };
const exists = (p: string) => stat(p).then(() => true, () => false);

async function studio() {
  const base = await tmp();
  const data = path.join(base, 'data');
  const projects = path.join(base, 'Projects');
  await put(data, 'studio.json', '{"tree":{"projects":[]},"notes":[]}');
  await put(data, 'settings.json', '{"theme":"dark"}');
  await put(data, 'secrets/studio-key.bin', 'PRIVATE KEY BYTES');
  await put(data, 'market/github-token.bin', 'TOKEN BYTES');
  await put(data, 'user/profile.json', '{"name":"Ana"}');
  await put(projects, 'Book One/Manuscript/Draft.md', '# Chapter 1\n\nIt began.\n');
  await put(projects, 'Book One/.cadrel/project.json', '{"version":1,"id":"p1","name":"Book One"}');
  await put(projects, 'Book Two/Draft.md', 'Two.\n');
  await put(projects, 'Book Two/cover.png', Buffer.from([0, 1, 2, 250, 255]));
  return { base, data, projects };
}

describe('backup', () => {
  it('round-trips a Studio byte for byte into empty folders', async () => {
    const s = await studio();
    const file = path.join(s.base, 'out', 'a.cadrel-backup');
    const made = await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'data', dir: s.data }, { name: 'Projects', dir: s.projects }] });
    expect(made.files).toBe(7);
    const back = await tmp();
    const r = await restoreBackup({ file, targets: { data: path.join(back, 'data'), Projects: path.join(back, 'Projects') }, maxSchema: 1 });
    expect(r.restored).toBe(7);
    const { secrets: _s, ...rest } = await tree(s.base).then((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('out/') && !isSecret(k.replace(/^data\//, ''), false) && !k.startsWith('data/secrets'))));
    void _s;
    expect(await tree(back)).toEqual(rest);
  });

  it('never includes keys or tokens, and a plant-and-assert proves the bytes are absent from the archive', async () => {
    const s = await studio();
    const file = path.join(s.base, 'a.cadrel-backup');
    await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'data', dir: s.data }] });
    const raw = (await readFile(file)).toString('latin1');
    expect(raw).not.toContain('PRIVATE KEY BYTES');
    expect(raw).not.toContain('TOKEN BYTES');
    const m = await verifyBackup(file);
    expect(m.entries.map((e) => e.path).sort()).toEqual(['data/settings.json', 'data/studio.json', 'data/user/profile.json']);
  });

  it('does not treat a manuscript called Secrets or Token as a secret outside the data folder rules', () => {
    expect(isSecret('Book/Secrets of the Deep.md', false)).toBe(false);
    expect(isSecret('Book/token-economy.md', false)).toBe(false);
    expect(isSecret('studio/secrets/k.bin', false)).toBe(true);
    expect(isSecret('market/github-token.bin', false)).toBe(true);
  });

  it('backs up chosen projects only', async () => {
    const s = await studio();
    const file = path.join(s.base, 'a.cadrel-backup');
    await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'Projects', dir: s.projects, only: ['Book Two'] }] });
    const d = await describeBackup(file);
    expect(d.projects).toEqual(['Book Two']);
  });

  it('refuses to overwrite an existing backup and leaves no half-written file', async () => {
    const s = await studio();
    const file = path.join(s.base, 'a.cadrel-backup');
    await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'data', dir: s.data }] });
    await expect(createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'data', dir: s.data }] })).rejects.toThrow(/already a file/);
    expect((await readdir(s.base)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await expect(createBackup({ file: path.join(s.base, 'x.zip'), studio: STUDIO, appVersion: '0', schema: 1, sources: [] })).rejects.toThrow(/ends in/);
  });

  it('refuses a corrupted archive', async () => {
    const s = await studio();
    const file = path.join(s.base, 'a.cadrel-backup');
    await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'data', dir: s.data }] });
    const bad = path.join(s.base, 'bad.cadrel-backup');
    const buf = await readFile(file);
    await writeFile(bad, buf.subarray(0, Math.floor(buf.length / 2)));
    await expect(verifyBackup(bad)).rejects.toBeInstanceOf(BackupError);
    await writeFile(bad, 'not a zip');
    await expect(verifyBackup(bad)).rejects.toThrow(/damaged or is not a backup/);
    await expect(verifyBackup(path.join(s.base, 'nope.cadrel-backup'))).rejects.toThrow(/not there/);
  });

  it('refuses an archive whose contents were altered, extended, or have no manifest', async () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const sha = (await import('node:crypto')).createHash('sha256').update('hello').digest('hex');
    const manifest = (entries: object[], extra: object = {}) =>
      enc(JSON.stringify({ format: 1, app: '0', created: '', studio: STUDIO, schema: 1, sources: ['data'], entries, ...extra }));
    const dir = await tmp();
    const w = async (name: string, files: Record<string, Uint8Array>) => {
      const f = path.join(dir, name);
      await writeFile(f, zipSync(files));
      return f;
    };
    const good = [{ path: 'data/a.txt', size: 5, sha256: sha }];
    await expect(verifyBackup(await w('ok.cadrel-backup', { 'manifest.json': manifest(good), 'data/a.txt': enc('hello') }))).resolves.toBeTruthy();
    await expect(verifyBackup(await w('alt.cadrel-backup', { 'manifest.json': manifest(good), 'data/a.txt': enc('HELLO') }))).rejects.toThrow(/checksum/);
    await expect(verifyBackup(await w('extra.cadrel-backup', { 'manifest.json': manifest(good), 'data/a.txt': enc('hello'), 'data/b.txt': enc('x') }))).rejects.toThrow(/does not list/);
    await expect(verifyBackup(await w('missing.cadrel-backup', { 'manifest.json': manifest(good) }))).rejects.toThrow(/missing/);
    await expect(verifyBackup(await w('nomanifest.cadrel-backup', { 'data/a.txt': enc('hello') }))).rejects.toThrow(/no manifest/);
    const slip = [{ path: '../evil.txt', size: 5, sha256: sha }];
    await expect(verifyBackup(await w('slip.cadrel-backup', { 'manifest.json': manifest(slip), '../evil.txt': enc('hello') }))).rejects.toThrow(/must not/);
  });

  it('refuses a newer format or schema with "update Cadrel", and a non-empty target', async () => {
    const s = await studio();
    const file = path.join(s.base, 'a.cadrel-backup');
    await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 5, sources: [{ name: 'data', dir: s.data }] });
    await expect(restoreBackup({ file, targets: { data: path.join(s.base, 'fresh') }, maxSchema: 1 })).rejects.toThrow(/Update Cadrel/);
    await expect(restoreBackup({ file, targets: { data: s.data }, maxSchema: 9 })).rejects.toThrow(/not empty/);
    await expect(restoreBackup({ file, targets: { Nope: path.join(s.base, 'z') }, maxSchema: 9 })).rejects.toThrow(/no “Nope”/);
    expect(await exists(path.join(s.base, 'fresh'))).toBe(false);
    const enc = new TextEncoder();
    const f2 = path.join(s.base, 'future.cadrel-backup');
    await writeFile(f2, zipSync({ 'manifest.json': enc.encode(JSON.stringify({ format: 99, studio: STUDIO, sources: [], entries: [] })) }));
    await expect(verifyBackup(f2)).rejects.toThrow(/newer Cadrel/);
  });

  it('restores a single project under a free name beside the existing one', async () => {
    const s = await studio();
    const file = path.join(s.base, 'a.cadrel-backup');
    await createBackup({ file, studio: STUDIO, appVersion: '0.3.0', schema: 1, sources: [{ name: 'Projects', dir: s.projects }] });
    const r = await restoreProject({ file, project: 'Book One', projectsDir: s.projects });
    expect(r.name).not.toBe('Book One');
    expect(await readFile(path.join(r.dir, 'Manuscript', 'Draft.md'), 'utf8')).toBe('# Chapter 1\n\nIt began.\n');
    expect(await readFile(path.join(s.projects, 'Book One', 'Manuscript', 'Draft.md'), 'utf8')).toBe('# Chapter 1\n\nIt began.\n');
    await expect(restoreProject({ file, project: 'Ghost', projectsDir: s.projects })).rejects.toThrow(/no project/);
  });
});

async function mdedit() {
  const root = await tmp();
  const proj = path.join(root, 'mdedit-root', 'The Lost King');
  await put(proj, 'Manuscript/Draft.md', '# One\n\nText.\n\n# Two\n\nMore.\n');
  await put(proj, 'Notes/world.md', 'Magic.');
  await put(proj, '.mdedit/project.json', JSON.stringify({
    version: 1, id: 'abc123', name: 'The Lost King', templateId: 'novel', templateName: 'Novel', createdAt: '2024-01-01T00:00:00.000Z', status: 'editing',
    notes: 'keep going', archived: false, goal: { targetWords: 80000, targetDate: '2030-01-01', startDate: '2024-01-01' }, activeManuscript: 'Manuscript/Draft.md',
    manuscriptGoals: {}, excludedFolders: ['Notes'], editedChapters: { 'Manuscript/Draft.md': ['One'] }, overrides: { chapterLevel: 1, book: {} }
  }));
  await put(proj, '.mdedit/edited.json', JSON.stringify({ version: 1, files: { 'Manuscript/Draft.md': { One: { edited: true, at: 5 } } } }));
  await put(proj, '.mdedit/review/owner.json', '{"version":1,"comments":[]}');
  await put(proj, '.mdedit/progress.json', '{"days":{}}');
  await put(proj, '.mdedit/collab-base.json', '{"drive":"state"}');
  await put(proj, 'Manuscript/Draft.md.bak', 'old');
  return { root, proj, rootFolder: path.join(root, 'mdedit-root'), projects: path.join(root, 'Cadrel', 'Projects') };
}

describe('importing from MDEdit', () => {
  it('finds a project folder, or the projects in a root folder', async () => {
    const m = await mdedit();
    expect(await findMdeditProjects(m.proj)).toEqual([m.proj]);
    expect(await findMdeditProjects(m.rootFolder)).toEqual([m.proj]);
    expect(await findMdeditProjects(m.root)).toEqual([]);
  });

  it('previews what will be created and what is left behind, writing nothing', async () => {
    const m = await mdedit();
    const p = await previewMdeditImport(m.proj, m.projects);
    expect(p).toMatchObject({ name: 'The Lost King', asName: 'The Lost King', chapterFiles: 2, hasGoal: true, reviewFiles: 1, editedMarks: 1, alreadyImportedAs: null });
    expect(p.notCarried.join()).toMatch(/Google Drive/);
    expect(await exists(m.projects)).toBe(false);
    await expect(previewMdeditImport(m.root, m.projects)).rejects.toThrow(/not an MDEdit project/);
  });

  it('copies the project with its goal, active manuscript, edited marks, notes and settings, and leaves the original untouched', async () => {
    const m = await mdedit();
    const before = await tree(m.proj);
    const r = await importMdeditProject({ source: m.proj, projectsDir: m.projects });
    expect(await tree(m.proj)).toEqual(before);
    expect(await readFile(path.join(r.dir, 'Manuscript', 'Draft.md'), 'utf8')).toBe('# One\n\nText.\n\n# Two\n\nMore.\n');
    const meta = JSON.parse(await readFile(path.join(r.dir, '.cadrel', 'project.json'), 'utf8'));
    expect(meta).toMatchObject({ id: 'abc123', name: 'The Lost King', notes: 'keep going', activeManuscript: 'Manuscript/Draft.md', excludedFolders: ['Notes'], overrides: { chapterLevel: 1 } });
    expect(meta.goal.targetWords).toBe(80000);
    expect(JSON.parse(await readFile(path.join(r.dir, '.cadrel', 'edited.json'), 'utf8')).files['Manuscript/Draft.md'].One.edited).toBe(true);
    expect(await exists(path.join(r.dir, '.cadrel', 'review', 'owner.json'))).toBe(true);
    expect(await exists(path.join(r.dir, '.cadrel', 'progress.json'))).toBe(true);
    expect(await exists(path.join(r.dir, '.mdedit'))).toBe(false);
    expect(await exists(path.join(r.dir, '.cadrel', 'collab-base.json'))).toBe(false);
    expect(await exists(path.join(r.dir, 'Manuscript', 'Draft.md.bak'))).toBe(false);
    expect((await readdir(m.projects)).filter((n) => n.endsWith('.importing'))).toEqual([]);
  });

  it('recognises a project it already imported, and makes a separate copy only when asked', async () => {
    const m = await mdedit();
    await importMdeditProject({ source: m.proj, projectsDir: m.projects });
    expect((await previewMdeditImport(m.proj, m.projects)).alreadyImportedAs).toBe('The Lost King');
    await expect(importMdeditProject({ source: m.proj, projectsDir: m.projects })).rejects.toThrow(/already imported/);
    expect(await readdir(m.projects)).toEqual(['The Lost King']);
    const copy = await importMdeditProject({ source: m.proj, projectsDir: m.projects, asNewCopy: true });
    expect(copy.name).not.toBe('The Lost King');
    expect(copy.meta.id).not.toBe('abc123');
    expect((await readdir(m.projects)).sort()).toHaveLength(2);
  });

  it('survives a damaged settings file with defaults, and refuses a project with none', async () => {
    const m = await mdedit();
    await put(m.proj, '.mdedit/project.json', '{"status":"nonsense","goal":42,"activeManuscript":"../../etc/passwd"}');
    const r = await importMdeditProject({ source: m.proj, projectsDir: m.projects });
    expect(r.meta).toMatchObject({ goal: null, activeManuscript: null, name: 'The Lost King' });
    await put(m.proj, '.mdedit/project.json', 'not json');
    await expect(previewMdeditImport(m.proj, path.join(m.root, 'other'))).rejects.toThrow();
  });
});
