import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeReviewFile, type ReviewItem } from '@cadrel/write/src/shared/review/comments';
import { PeopleHost } from '../src/main/people';
import { ProjectSync, isNotesFile, neverTracked, vaultIgnores } from '../src/main/projectSync';
import { VaultHost } from '../src/main/vaultHost';
import { migrateVaultFolder } from '../src/main/vaultMigration';

let dir: string, host: PeopleHost, projects: string, where: ConstructorParameters<typeof VaultHost>[1], clock: number;
const put = async (rel: string, text: string) => {
  const f = path.join(projects, ...rel.split('/'));
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.chmod(f, 0o644).catch(() => undefined); // a read-only copy is replaced the way a program that ignores read-only would
  await fsp.writeFile(f, text);
};
const read = (rel: string) => fsp.readFile(path.join(projects, ...rel.split('/')), 'utf8');
const exists = (rel: string) => fsp.access(path.join(projects, ...rel.split('/'))).then(() => true, () => false);
const writable = async (rel: string) => ((await fsp.stat(path.join(projects, ...rel.split('/')))).mode & 0o200) !== 0;
const sync = (map: Record<string, string | null> = { 'Dragon Rider': 'p1' }) => new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map(Object.entries(map)), offline: () => host.offline, now: () => clock });
const vault = () => new VaultHost(host, where).localVault!;
/** Another computer of the same person: its folder is writable when idle, so it can make changes the plain way. */
const other = () => new VaultHost(host, { ...where, dir: path.join(dir, 'other'), stateDir: path.join(dir, 'other-state'), machine: 'pc-b', writableWhenIdle: true }).localVault!;
const note = (id: string, body: string, updatedAt: string): ReviewItem => ({ id, kind: 'comment', file: 'Manuscript/ch1.md', anchor: { quote: 'q', prefix: '', suffix: '', start: 0 }, body, status: 'open', author: 'Me', createdAt: updatedAt, updatedAt, replies: [] });
const notesText = (...items: ReviewItem[]) => serializeReviewFile({ version: 1, reviewer: { id: 'owner', name: 'Me' }, project: 'Dragon Rider', items });
const NOTES = 'Dragon Rider/.cadrel/review/owner.json';

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cadrel-ps-'));
  projects = path.join(dir, 'Projects');
  await fsp.mkdir(projects, { recursive: true });
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  where = { dir: projects, blobsDir: path.join(dir, 'blobs'), machine: 'pc-a', stateDir: path.join(dir, 'vault-state'), ignore: vaultIgnores, alwaysWritable: isNotesFile };
  clock = 1_800_000_000_000;
});
afterEach(async () => {
  await host.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('what is the Studio’s business', () => {
  it('leaves Cadrel’s own folders, exports, scratch files and loose files alone, except a project’s notes', () => {
    for (const p of ['Book/.cadrel/project.json', 'Book/Exports/book.epub', 'Book/Manuscript/~$ch1.docx', 'Book/ch1.md.tmp', 'Book/Thumbs.db', 'Book/.git/config']) expect(neverTracked(p), p).toBe(true);
    for (const p of ['Book/Manuscript/Chapter 1.md', 'Book/Art/cover.psd', 'Book/Research/notes.txt']) expect(neverTracked(p), p).toBe(false);
    expect(isNotesFile('Book/.cadrel/review/owner.json')).toBe(true);
    expect(isNotesFile('Book/.cadrel/project.json')).toBe(false);
    expect(vaultIgnores('Book/.cadrel/review/owner.json')).toBe(false);
    expect(vaultIgnores('Book/.cadrel/review')).toBe(false);
    expect(vaultIgnores('Book/.cadrel/project.json')).toBe(true);
  });
});

describe('the Projects folder and the vault are one thing, and a file is changed by checking it out', () => {
  it('adds a new file in a project, with the project it belongs to, keeps it checked out to its author, and leaves loose files alone', async () => {
    await put('Dragon Rider/Manuscript/Chapter 1.md', 'one');
    await put('Dragon Rider/.cadrel/project.json', '{}');
    await put('Dragon Rider/Exports/book.epub', 'x');
    await put('loose.md', 'not in a project');
    const r = await sync().sync();
    expect(r.state).toBe('idle');
    expect(r.summary).toMatchObject({ added: 1, unprotected: [] });
    const list = await vault().list();
    expect(list.map((e) => [e.path, e.status])).toEqual([['Dragon Rider/Manuscript/Chapter 1.md', 'checked-out-by-me'], ['loose.md', 'untracked']]);
    expect((await vault().card('Dragon Rider/Manuscript/Chapter 1.md')).projectId).toBe('p1');
    expect((await fsp.readdir(projects)).sort()).toEqual(['Dragon Rider', 'loose.md']); // the vault keeps its notes elsewhere
  });

  it('makes a version only when a file is checked in, and makes the file read-only again then', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    for (const text of ['two', 'three', 'four']) {
      await put('Dragon Rider/ch1.md', text);
      expect((await s.sync()).summary).toMatchObject({ added: 0, unprotected: [] }); // checked out: its own edits are nobody's business
    }
    expect((await vault().history('Dragon Rider/ch1.md')).map((v) => [v.n, v.comment])).toEqual([[1, 'Added automatically']]); // nothing local is versioned
    expect((await vault().checkIn('Dragon Rider/ch1.md', 'End of the chapter')).version).toBe(2);
    await s.sync();
    expect((await vault().history('Dragon Rider/ch1.md')).map((v) => [v.n, v.comment])).toEqual([[2, 'End of the chapter'], [1, 'Added automatically']]);
    expect(await writable('Dragon Rider/ch1.md')).toBe(false);
    // to change it again: check out, edit, check in
    await vault().checkOut('Dragon Rider/ch1.md');
    expect(await writable('Dragon Rider/ch1.md')).toBe(true);
    await put('Dragon Rider/ch1.md', 'five');
    expect((await vault().checkIn('Dragon Rider/ch1.md', 'Second pass')).version).toBe(3);
  });

  it('protects a file nobody has checked out, which an older version of Cadrel left writable', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    await vault().checkIn('Dragon Rider/ch1.md'); // nothing changed: released, no version
    await fsp.chmod(path.join(projects, 'Dragon Rider', 'ch1.md'), 0o644);
    await s.sync();
    expect(await writable('Dragon Rider/ch1.md')).toBe(false);
  });

  it('brings in a newer version saved elsewhere, and fetches a file this computer lacks', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    await put('Dragon Rider/ch2.md', 'two');
    const s = sync();
    await s.sync();
    await vault().checkIn('Dragon Rider/ch1.md');
    await vault().checkIn('Dragon Rider/ch2.md');
    const pc = other();
    await pc.getLatest(undefined, { fetchMissing: true });
    await pc.checkOut('Dragon Rider/ch1.md');
    await fsp.writeFile(path.join(dir, 'other', 'Dragon Rider', 'ch1.md'), 'one, edited elsewhere');
    await pc.checkIn('Dragon Rider/ch1.md', 'elsewhere');
    await fsp.rm(path.join(projects, 'Dragon Rider', 'ch2.md'));
    const r = await s.sync();
    expect(r.summary?.received).toBeGreaterThanOrEqual(2);
    expect(await read('Dragon Rider/ch1.md')).toBe('one, edited elsewhere');
    expect(await read('Dragon Rider/ch2.md')).toBe('two');
  });

  it('never overwrites a file changed without a check-out, lists it, and lets the person check it out keeping the changes', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    await vault().checkIn('Dragon Rider/ch1.md');
    const pc = other();
    await pc.getLatest(undefined, { fetchMissing: true });
    await put('Dragon Rider/ch1.md', 'edited without a check-out'); // got round the read-only
    const r = await s.sync();
    expect(r.summary).toMatchObject({ unprotected: ['Dragon Rider/ch1.md'], received: 0 });
    expect(await read('Dragon Rider/ch1.md')).toBe('edited without a check-out');
    expect((await vault().history('Dragon Rider/ch1.md')).length).toBe(1); // no version by itself
    // nor does a newer version from elsewhere replace it
    await pc.checkOut('Dragon Rider/ch1.md');
    await fsp.writeFile(path.join(dir, 'other', 'Dragon Rider', 'ch1.md'), 'newer elsewhere');
    await pc.checkIn('Dragon Rider/ch1.md');
    expect((await s.sync()).summary).toMatchObject({ unprotected: ['Dragon Rider/ch1.md'], received: 0 });
    expect(await read('Dragon Rider/ch1.md')).toBe('edited without a check-out');
    // taking it onto a version that is no longer the newest is refused, and nothing is lost
    await expect(vault().checkOut('Dragon Rider/ch1.md', { keepChanges: true })).rejects.toThrow(/newer version/);
    expect(await read('Dragon Rider/ch1.md')).toBe('edited without a check-out');
  });

  it('leaves a file someone checked out on purpose alone, and says so', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    await vault().checkIn('Dragon Rider/ch1.md');
    const pc = other();
    await pc.getLatest(undefined, { fetchMissing: true });
    await pc.checkOut('Dragon Rider/ch1.md');
    await put('Dragon Rider/ch1.md', 'my edit while it is held');
    const r = await s.sync();
    expect(r.summary?.held).toEqual(['Dragon Rider/ch1.md']);
    expect(await read('Dragon Rider/ch1.md')).toBe('my edit while it is held');
  });

  it('keeps both when a version is saved over a newer one, and then adds the kept copy as a file of its own', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    const s = sync();
    await s.sync();
    await vault().checkIn('Dragon Rider/ch1.md');
    const pc = other();
    await pc.getLatest(undefined, { fetchMissing: true });
    await fsp.writeFile(path.join(dir, 'other', 'Dragon Rider', 'ch1.md'), 'from the other computer');
    await pc.saveChanges('Dragon Rider/ch1.md');
    await put('Dragon Rider/ch1.md', 'from here');
    const r = await vault().saveChanges('Dragon Rider/ch1.md', 'mine');
    expect(r.outcome).toBe('conflict');
    expect(await read('Dragon Rider/ch1.md')).toBe('from the other computer');
    expect(await read(r.savedAs!)).toBe('from here');
    await s.sync(); // the kept copy is a new file in a project, so it is added
    expect((await vault().list()).find((e) => e.path === r.savedAs)?.status).toBe('checked-out-by-me');
  });
});

describe('notes travel with the project’s files', () => {
  it('adds a project’s notes to the Studio without checking them out, and leaves them writable', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    await put(NOTES, notesText(note('n1', 'tighten this', '2026-01-01T00:00:00Z')));
    await sync().sync();
    expect((await vault().list()).find((e) => e.path === NOTES)).toMatchObject({ status: 'latest', version: 1, lock: null });
    expect(await writable(NOTES)).toBe(true);
    expect((await new VaultHost(host, where).state()) as { entries: { path: string }[] }).toMatchObject({ entries: [{ path: 'Dragon Rider/ch1.md' }] }); // not listed as a file to manage
  });

  it('brings notes made on another computer, and merges when both sides added notes, keeping every note', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    await put(NOTES, notesText(note('n1', 'from here', '2026-01-01T00:00:00Z')));
    const s = sync();
    await s.sync();
    const pc = other();
    await pc.getLatest(undefined, { fetchMissing: true });
    // the other computer adds a note and saves it
    const there = path.join(dir, 'other', ...NOTES.split('/'));
    await fsp.writeFile(there, notesText(note('n1', 'from here', '2026-01-01T00:00:00Z'), note('n2', 'from the phone', '2026-01-02T00:00:00Z')));
    await pc.saveChanges(NOTES, 'Notes');
    // meanwhile a note was added here too
    await put(NOTES, notesText(note('n1', 'from here', '2026-01-01T00:00:00Z'), note('n3', 'added at the desk', '2026-01-03T00:00:00Z')));
    clock += 10 * 60_000;
    const r = await s.sync();
    expect(r.summary).toMatchObject({ notesMerged: 1, conflicts: [] });
    const merged = JSON.parse(await read(NOTES)) as { items: { id: string }[] };
    expect(merged.items.map((i) => i.id)).toEqual(['n1', 'n2', 'n3']);
    // and the merged file is what the Studio has now
    expect(JSON.parse(new TextDecoder().decode(await vault().read(NOTES))).items.map((i: { id: string }) => i.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('saves a flurry of notes as one version, not one each', async () => {
    await put('Dragon Rider/ch1.md', 'one');
    await put(NOTES, notesText(note('n1', 'a', '2026-01-01T00:00:00Z')));
    const s = sync();
    await s.sync();
    await put(NOTES, notesText(note('n1', 'a', '2026-01-01T00:00:00Z'), note('n2', 'b', '2026-01-01T00:01:00Z')));
    await s.sync(); // first save of this file by this run: made
    await put(NOTES, notesText(note('n1', 'a', '2026-01-01T00:00:00Z'), note('n2', 'b', '2026-01-01T00:01:00Z'), note('n3', 'c', '2026-01-01T00:02:00Z')));
    clock += 30_000;
    await s.sync(); // thirty seconds later: waits
    expect((await vault().history(NOTES)).length).toBe(2);
    clock += 3 * 60_000;
    await s.sync();
    expect((await vault().history(NOTES)).length).toBe(3);
  });
});

describe('moving the old Vault folder into the Projects folder', () => {
  it('copies what the Projects folder lacks, never overwrites, leaves a differing copy as the person’s own change, and runs once', async () => {
    const old = path.join(dir, 'Vault');
    const oldVault = new VaultHost(host, { dir: old, blobsDir: where.blobsDir, machine: 'pc-a' }).localVault!;
    await fsp.mkdir(path.join(old, 'Dragon Rider'), { recursive: true });
    for (const [f, t] of [['Dragon Rider/a.md', 'A'], ['Dragon Rider/b.md', 'B'], ['Dragon Rider/c.md', 'C']] as const) await fsp.writeFile(path.join(old, f), t);
    for (const f of ['Dragon Rider/a.md', 'Dragon Rider/b.md', 'Dragon Rider/c.md']) await oldVault.add(f);
    await put('Dragon Rider/b.md', 'B');            // already there, the same
    await put('Dragon Rider/c.md', 'C, edited');    // already there, differs
    const marker = path.join(dir, 'moved.json');
    const note1 = await migrateVaultFolder({ oldDir: old, newDir: projects, stateDir: where.stateDir!, marker });
    expect(note1).toMatchObject({ copied: 1, same: 1, differing: ['Dragon Rider/c.md'] });
    expect(await read('Dragon Rider/a.md')).toBe('A');
    expect(await read('Dragon Rider/c.md')).toBe('C, edited');
    expect(await exists('../Vault/Dragon Rider/a.md')).toBe(true); // the old folder is left as it was
    expect(await migrateVaultFolder({ oldDir: old, newDir: projects, stateDir: where.stateDir!, marker })).toBeNull();
    // the first pass: a and b are as the vault has them; c is the person's own change, left exactly as it is
    const r = await sync().sync();
    expect(r.summary?.unprotected).toEqual(['Dragon Rider/c.md']);
    expect(await read('Dragon Rider/c.md')).toBe('C, edited');
    // checking it out keeping the changes and in again makes the one new version
    await vault().checkOut('Dragon Rider/c.md', { keepChanges: true });
    expect((await vault().checkIn('Dragon Rider/c.md', 'Chapter three')).version).toBe(2);
  });
});
