import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeopleHost } from '../src/main/people';
import { ProjectSync, neverTracked } from '../src/main/projectSync';
import { VaultHost } from '../src/main/vaultHost';
import { migrateVaultFolder } from '../src/main/vaultMigration';

let dir: string, host: PeopleHost, projects: string, where: ConstructorParameters<typeof VaultHost>[1];
const put = async (rel: string, text: string) => {
  const f = path.join(projects, ...rel.split('/'));
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, text);
};
const read = (rel: string) => fsp.readFile(path.join(projects, ...rel.split('/')), 'utf8');
const exists = (rel: string) => fsp.access(path.join(projects, ...rel.split('/'))).then(() => true, () => false);
const sync = (map: Record<string, string | null> = { 'Dragon Rider': 'p1' }) => new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map(Object.entries(map)), offline: () => host.offline });
const vault = () => new VaultHost(host, where).localVault!;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cadrel-ps-'));
  projects = path.join(dir, 'Projects');
  await fsp.mkdir(projects, { recursive: true });
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  where = { dir: projects, blobsDir: path.join(dir, 'blobs'), machine: 'pc-a', stateDir: path.join(dir, 'vault-state'), ignore: neverTracked, writableWhenIdle: true };
});
afterEach(async () => {
  await host.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('what is the Studio’s business', () => {
  it('leaves Cadrel’s own folders, exports, scratch files and loose files alone', () => {
    for (const p of ['Book/.cadrel/project.json', 'Book/Exports/book.epub', 'Book/Manuscript/~$ch1.docx', 'Book/ch1.md.tmp', 'Book/Thumbs.db', 'Book/.git/config']) expect(neverTracked(p), p).toBe(true);
    for (const p of ['Book/Manuscript/Chapter 1.md', 'Book/Art/cover.psd', 'Book/Research/notes.txt']) expect(neverTracked(p), p).toBe(false);
  });
});

describe('the Projects folder and the vault are one thing', () => {
  it('saves a new file in a project, with the project it belongs to, and nothing loose in the Projects folder', async () => {
    await put('Dragon Rider/Manuscript/Chapter 1.md', 'one');
    await put('Dragon Rider/.cadrel/project.json', '{}');
    await put('Dragon Rider/Exports/book.epub', 'x');
    await put('loose.md', 'not in a project');
    const r = await sync().sync();
    expect(r.state).toBe('idle');
    expect(r.summary).toMatchObject({ added: 1, saved: 0 });
    const list = await vault().list();
    expect(list.map((e) => [e.path, e.status])).toEqual([['Dragon Rider/Manuscript/Chapter 1.md', 'latest'], ['loose.md', 'untracked']]);
    expect((await vault().card('Dragon Rider/Manuscript/Chapter 1.md')).projectId).toBe('p1');
    expect((await fsp.readdir(projects)).sort()).toEqual(['Dragon Rider', 'loose.md']); // the vault keeps its notes elsewhere
  });

  it('saves each edit as a new version with no check-out, leaving the file writable', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    await put('Dragon Rider/ch1.md', 'two');
    expect((await s.sync()).summary).toMatchObject({ saved: 1, added: 0 });
    await put('Dragon Rider/ch1.md', 'three');
    await s.sync();
    const h = await vault().history('Dragon Rider/ch1.md');
    expect(h.map((v) => [v.n, v.comment])).toEqual([[3, 'Saved automatically'], [2, 'Saved automatically'], [1, 'Added automatically']]);
    expect((await vault().status('Dragon Rider/ch1.md')).lock).toBeNull();
    await put('Dragon Rider/ch1.md', 'still writable'); // would throw on a read-only file
  });

  it('does nothing when nothing changed, and its quick look needs no pass', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    expect((await s.sync()).summary).toMatchObject({ added: 0, saved: 0, received: 0 });
    expect((await vault().history('Dragon Rider/ch1.md')).length).toBe(1);
  });

  it('brings in a newer version saved elsewhere, and fetches a file this computer lacks', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    await put('Dragon Rider/ch2.md', 'two');
    await sync().sync();
    // another computer (same Studio, same person) saves a new version of ch1
    const other = new VaultHost(host, { ...where, dir: path.join(dir, 'other'), stateDir: path.join(dir, 'other-state'), machine: 'pc-b' }).localVault!;
    await other.getLatest(undefined, { fetchMissing: true });
    await fsp.writeFile(path.join(dir, 'other', 'Dragon Rider', 'ch1.md'), 'one, edited elsewhere');
    expect((await other.saveChanges('Dragon Rider/ch1.md')).outcome).toBe('saved');
    await fsp.rm(path.join(projects, 'Dragon Rider', 'ch2.md'));
    const r = await sync().sync();
    expect(r.summary?.received).toBeGreaterThanOrEqual(2);
    expect(await read('Dragon Rider/ch1.md')).toBe('one, edited elsewhere');
    expect(await read('Dragon Rider/ch2.md')).toBe('two');
  });

  it('keeps both when the same version was changed in two places, and then saves the kept copy as a file of its own', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    const other = new VaultHost(host, { ...where, dir: path.join(dir, 'other'), stateDir: path.join(dir, 'other-state'), machine: 'pc-b' }).localVault!;
    await other.getLatest(undefined, { fetchMissing: true });
    await fsp.writeFile(path.join(dir, 'other', 'Dragon Rider', 'ch1.md'), 'from the other computer');
    await other.saveChanges('Dragon Rider/ch1.md');
    await put('Dragon Rider/ch1.md', 'from here');
    const r = await s.sync();
    expect(r.summary?.conflicts).toHaveLength(1);
    const kept = r.summary!.conflicts[0]!.savedAs;
    expect(kept).toMatch(/^Dragon Rider\/ch1 \(changes \d{4}-\d\d-\d\d pc-a\)\.md$/);
    expect(await read('Dragon Rider/ch1.md')).toBe('from the other computer');
    expect(await read(kept)).toBe('from here');
    expect((await vault().list()).find((e) => e.path === kept)?.status).toBe('latest'); // the follow-up pass saved it
  });

  it('leaves a file someone checked out on purpose alone, and says so', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    await sync().sync();
    const other = new VaultHost(host, { ...where, dir: path.join(dir, 'other'), stateDir: path.join(dir, 'other-state'), machine: 'pc-b' }).localVault!;
    await other.getLatest(undefined, { fetchMissing: true });
    await other.checkOut('Dragon Rider/ch1.md');
    await put('Dragon Rider/ch1.md', 'my edit while it is held');
    const r = await sync().sync();
    expect(r.summary?.held).toEqual(['Dragon Rider/ch1.md']);
    expect(await read('Dragon Rider/ch1.md')).toBe('my edit while it is held');
  });
});

describe('moving the old Vault folder into the Projects folder', () => {
  it('copies what the Projects folder lacks, never overwrites, drops the vault’s claim on a differing copy, and runs once', async () => {
    const old = path.join(dir, 'Vault');
    const oldVault = new VaultHost(host, { dir: old, blobsDir: where.blobsDir, machine: 'pc-a' }).localVault!;
    await fsp.mkdir(path.join(old, 'Dragon Rider'), { recursive: true });
    for (const [f, t] of [['Dragon Rider/a.md', 'A'], ['Dragon Rider/b.md', 'B'], ['Dragon Rider/c.md', 'C']] as const) await fsp.writeFile(path.join(old, f), t);
    for (const f of ['Dragon Rider/a.md', 'Dragon Rider/b.md', 'Dragon Rider/c.md']) await oldVault.add(f);
    await put('Dragon Rider/b.md', 'B');            // already there, the same
    await put('Dragon Rider/c.md', 'C, edited');    // already there, differs
    const marker = path.join(dir, 'moved.json');
    const note = await migrateVaultFolder({ oldDir: old, newDir: projects, stateDir: where.stateDir!, marker });
    expect(note).toMatchObject({ copied: 1, same: 1, differing: ['Dragon Rider/c.md'] });
    expect(await read('Dragon Rider/a.md')).toBe('A');
    expect(await read('Dragon Rider/c.md')).toBe('C, edited');
    expect(await exists('../Vault/Dragon Rider/a.md')).toBe(true); // the old folder is left as it was
    expect(await migrateVaultFolder({ oldDir: old, newDir: projects, stateDir: where.stateDir!, marker })).toBeNull();
    // the first pass: a and b are as the vault has them; c keeps both
    const r = await sync().sync();
    expect(r.summary?.conflicts.map((c) => c.path)).toEqual(['Dragon Rider/c.md']);
    expect(await read('Dragon Rider/c.md')).toBe('C');
    expect((await vault().list()).filter((e) => e.path.startsWith('Dragon Rider/c (changes')).length).toBe(1);
  });
});
