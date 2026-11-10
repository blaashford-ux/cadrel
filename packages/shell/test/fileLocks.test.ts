import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileControl } from '../src/main/fileLocks';
import { PeopleHost } from '../src/main/people';
import { isNotesFile, vaultIgnores, ProjectSync } from '../src/main/projectSync';
import { VaultHost } from '../src/main/vaultHost';

let dir: string, host: PeopleHost, projects: string, where: ConstructorParameters<typeof VaultHost>[1];
const abs = (rel: string) => path.join(projects, ...rel.split('/'));
const put = async (rel: string, text: string) => {
  await fsp.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fsp.chmod(abs(rel), 0o644).catch(() => undefined);
  await fsp.writeFile(abs(rel), text);
};
const control = (mayForce = true) => createFileControl({ vault: () => new VaultHost(host, where).localVault, dir: () => projects, names: async () => new Map(), me: () => host.me, machine: () => 'pc-a', mayForce: async () => mayForce });

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cadrel-fl-'));
  projects = path.join(dir, 'Projects');
  await fsp.mkdir(projects, { recursive: true });
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  where = { dir: projects, blobsDir: path.join(dir, 'blobs'), machine: 'pc-a', stateDir: path.join(dir, 'vault-state'), ignore: vaultIgnores, alwaysWritable: isNotesFile };
});
afterEach(async () => {
  await host.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('Write’s Manage Beta Read', () => {
  it('has nothing on for a manuscript until the author turns chapters on, and keeps them', async () => {
    await put('Book/ms.md', '# One\n\ntext');
    const sync = new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map([['Book', null]]) });
    await sync.sync();
    const c = control();
    expect(await c.betaRead!(abs('Book/ms.md'))).toEqual({ level: 1, chapters: [] });
    expect(await c.setBetaRead!(abs('Book/ms.md'), 1, ['One'])).toEqual({ level: 1, chapters: ['One'] });
    expect(await c.betaRead!(abs('Book/ms.md'))).toEqual({ level: 1, chapters: ['One'] });
    expect(await c.betaRead!(abs('Book/not-in-vault.md'))).toBeNull(); // a file the vault does not hold has no beta read
    expect(await c.betaRead!(path.join(dir, 'elsewhere.md'))).toBeNull();
  });
});

describe('Write’s check-out and check-in', () => {
  it('walks a file through checked in, check out, edit, check in, with one new version', async () => {
    await put('Book/ch1.md', 'one');
    const sync = new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map([['Book', null]]) });
    await sync.sync(); // added, checked out to its author
    const c = control();
    expect(await c.state(abs('Book/ch1.md'))).toMatchObject({ kind: 'mine' });
    expect(await c.checkIn(abs('Book/ch1.md'), 'First chapter')).toMatchObject({ kind: 'free', version: 1 }); // nothing changed since version 1: released, no new version
    await sync.sync(); // protected
    expect((await fsp.stat(abs('Book/ch1.md'))).mode & 0o200).toBe(0);
    expect(await c.checkOut(abs('Book/ch1.md'))).toMatchObject({ kind: 'mine', version: 1, changed: false });
    await put('Book/ch1.md', 'one and more');
    expect(await c.state(abs('Book/ch1.md'))).toMatchObject({ kind: 'mine', changed: true });
    expect(await c.checkIn(abs('Book/ch1.md'), 'Added a line')).toMatchObject({ kind: 'free', version: 2 });
    expect((await new VaultHost(host, where).localVault!.history('Book/ch1.md')).map((v) => v.comment)).toEqual(['Added a line', 'Added automatically']);
  });

  it('lets an administrator take the lock from a lost device, with a reason, and offers it only to someone who may', async () => {
    await put('Book/ch1.md', 'one');
    const sync = new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map([['Book', null]]) });
    await sync.sync();
    const c = control();
    await c.checkIn(abs('Book/ch1.md'));
    // the person's other device (a lost phone) has it checked out
    const lost = new VaultHost(host, { ...where, dir: path.join(dir, 'lost'), stateDir: path.join(dir, 'lost-state'), machine: 'phone-1', writableWhenIdle: true }).localVault!;
    await lost.getLatest(undefined, { fetchMissing: true });
    await lost.checkOut('Book/ch1.md');
    expect(await c.state(abs('Book/ch1.md'))).toMatchObject({ kind: 'other', by: 'you, on phone-1', canRelease: true });
    expect(await control(false).state(abs('Book/ch1.md'))).toMatchObject({ kind: 'other', canRelease: false });
    await expect(c.release!(abs('Book/ch1.md'), '')).rejects.toThrow(/why/i); // a reason is required
    expect(await c.release!(abs('Book/ch1.md'), 'The phone was lost')).toMatchObject({ kind: 'free' });
    // it can be checked out again here
    expect(await c.checkOut(abs('Book/ch1.md'))).toMatchObject({ kind: 'mine' });
  });

  it('gives up a check-out, putting the newest version back', async () => {
    await put('Book/ch1.md', 'one');
    await new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map([['Book', null]]) }).sync();
    const c = control();
    await c.checkIn(abs('Book/ch1.md'));
    await c.checkOut(abs('Book/ch1.md'));
    await put('Book/ch1.md', 'a change I do not want');
    expect(await c.undoCheckOut(abs('Book/ch1.md'))).toMatchObject({ kind: 'free', version: 1 });
    expect(await fsp.readFile(abs('Book/ch1.md'), 'utf8')).toBe('one');
  });

  it('knows nothing of files outside a project’s folder, notes, or what the vault has not taken', async () => {
    await put('loose.md', 'x');
    await put('Book/new.md', 'not seen by a pass yet');
    await put('Book/.cadrel/review/owner.json', '{}');
    const c = control();
    for (const f of ['loose.md', 'Book/new.md', 'Book/.cadrel/review/owner.json']) expect(await c.state(abs(f))).toEqual({ kind: 'unmanaged' });
    await expect(c.checkOut(abs('loose.md'))).rejects.toThrow(/not kept in the Studio/);
  });

  it('shows a file changed without a check-out, and lets it be checked out keeping the changes', async () => {
    await put('Book/ch1.md', 'one');
    await new ProjectSync({ vault: () => new VaultHost(host, where).localVault, dir: projects, projects: async () => new Map([['Book', null]]) }).sync();
    const c = control();
    await c.checkIn(abs('Book/ch1.md'));
    await put('Book/ch1.md', 'edited around the read-only');
    expect(await c.state(abs('Book/ch1.md'))).toMatchObject({ kind: 'unprotected' });
    expect(await c.checkOut(abs('Book/ch1.md'), { keepChanges: true })).toMatchObject({ kind: 'mine', changed: true });
    expect(await fsp.readFile(abs('Book/ch1.md'), 'utf8')).toBe('edited around the read-only');
  });
});
