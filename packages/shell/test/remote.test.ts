// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
import { mkdtemp, readFile, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, type KeyPair } from '@cadrel/kernel';
import { PermissionDenied } from '@cadrel/service';
import { LocalVault, DirBlobs } from '@cadrel/store';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';
import { backupServerRecords, moveRecordsToServer, restoreServerRecords } from '../src/main/moveRecords';
import { PeopleHost } from '../src/main/people';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-remote-'));
  dirs.push(d);
  return d;
};

/** A Studio built in the stand-in Cloudflare, with an owner and a way to bring people in. */
async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  let online = true;
  const fetchFn = (async (i: string | URL | Request, init?: RequestInit) => (online ? cf.fetchFn(i, init) : Promise.reject(new TypeError('offline')))) as typeof fetch;
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn });
  const person = async (role: string, name: string, grant: { projectId?: string; days?: number } = {}) => {
    const { link } = await owner.invite(role, name, 'Acme', grant);
    const j = await joinStudio({ link, yourName: name, fetchFn });
    return new StudioClient({ url: built.url, key: j.key, fetchFn });
  };
  return { cf, owner, ownerKey, person, fetchFn, setOnline: (on: boolean) => (online = on) };
}

/** One person's computer: a working folder, a local copy of contents, and the vault over the server. */
async function computer(client: StudioClient, machine: string) {
  const root = await tmp();
  const me = await client.me();
  const store = new OfflineAwareStore(new RemoteVaultStore(client), path.join(root, 'cache.json'));
  const vault = new LocalVault({ store, blobs: new RemoteBlobs(client, new DirBlobs(path.join(root, 'blobs'))), dir: path.join(root, 'work'), personId: me.personId, machine });
  await (await import('node:fs/promises')).mkdir(path.join(root, 'work'), { recursive: true });
  const file = (rel: string) => path.join(root, 'work', rel);
  return { vault, store, me, file, write: (rel: string, text: string) => writeFile(file(rel), text), read: (rel: string) => readFile(file(rel), 'utf8'), root };
}

describe('a Studio whose records are on its server', () => {
  it('the app’s service, over the wire: the owner’s records, a member’s role, and a refusal that arrives as the same kind of error', async () => {
    const s = await studio();
    const author = await s.person('author', 'Ann Author');
    const ownerSvc = remoteService(s.owner).as('ignored');
    const annSvc = remoteService(author).as('ignored');
    await ownerSvc.catalogue.createBook({ title: 'Lead Me' });
    expect((await annSvc.catalogue.books()).map((b) => b.title)).toEqual(['Lead Me']);
    expect((await ownerSvc.people.list()).map((p) => p.name).sort()).toEqual(['Ann Author', 'Owner']);
    expect(await annSvc.can('vault.force')).toBe(false);
    expect(await ownerSvc.can('vault.force')).toBe(true);
    const e = await annSvc.people.createRole({ name: 'Sneaky', capabilities: ['vault.force'] }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(PermissionDenied);
    expect((e as PermissionDenied).capability).toBe('roles.manage');
    // sets and maps survive the trip
    const vis = await annSvc.visibleProjects({ projects: [], links: [] });
    expect(vis.visible).toBeInstanceOf(Set);
  });

  it('the exit test with real files: the author checks a chapter out, the editor sees the lock, the author checks in, the editor gets the new version', async () => {
    const s = await studio();
    const ann = await computer(await s.person('author', 'Ann Author'), 'ann-pc');
    const ed = await computer(await s.person('editor', 'Ed Editor'), 'ed-pc');

    await ann.write('ch1.md', 'Chapter one, first draft.');
    expect((await ann.vault.add('ch1.md')).status).toBe('latest');
    expect((await ed.vault.getLatest(undefined, { fetchMissing: true })).updated).toEqual(['ch1.md']);
    expect(await ed.read('ch1.md')).toBe('Chapter one, first draft.');

    await ann.vault.checkOut('ch1.md');
    const seen = await ed.vault.status('ch1.md');
    expect(seen.status).toBe('checked-out-by-other');
    expect(seen.lock).toMatchObject({ personId: ann.me.personId, machine: 'ann-pc' });
    await expect(ed.vault.checkOut('ch1.md')).rejects.toMatchObject({ code: 'locked' });

    await ann.write('ch1.md', 'Chapter one, second draft.');
    const done = await ann.vault.checkIn('ch1.md', 'Revised');
    expect(done).toMatchObject({ unchanged: false, version: 2, status: 'latest' });

    expect((await ed.vault.status('ch1.md')).status).toBe('out-of-date');
    await ed.vault.getLatest();
    expect(await ed.read('ch1.md')).toBe('Chapter one, second draft.');
    expect((await ed.vault.history('ch1.md')).map((v) => [v.n, v.comment])).toEqual([[2, 'Revised'], [1, 'First version']]);
  });

  it('an administrator force-releases a lock: the holder’s unsaved work is kept next to the file, and the vault’s version put back', async () => {
    const s = await studio();
    const ann = await computer(await s.person('author', 'Ann Author'), 'ann-pc');
    const boss = await computer(s.owner, 'boss-pc');
    await ann.write('ch1.md', 'v1');
    await ann.vault.add('ch1.md');
    await ann.vault.checkOut('ch1.md');
    await ann.write('ch1.md', 'v1 plus Ann’s unsaved work');

    await expect(ann.vault.forceRelease('ch1.md', 'because')).rejects.toThrow(/not allowed/);
    await boss.vault.forceRelease('ch1.md', 'Ann is on leave');

    await expect(ann.vault.checkIn('ch1.md')).rejects.toMatchObject({ code: 'not-holder' });
    const kept = await ann.vault.keepOrphansAside();
    expect(kept).toMatchObject([{ path: 'ch1.md', reason: 'Ann is on leave' }]);
    expect(kept[0]!.savedAs).toMatch(/^ch1 \(lock removed \d{4}-\d{2}-\d{2}\)\.md$/);
    expect(await ann.read(kept[0]!.savedAs!)).toBe('v1 plus Ann’s unsaved work');
    expect(await ann.read('ch1.md')).toBe('v1');
  });

  it('a guest given one book sees only that book’s files', async () => {
    const s = await studio();
    await s.owner.request('PUT', '/v1/tree', { projects: [{ id: 'pS', name: 'Series', parentId: null, kind: 'Series' }, { id: 'pB1', name: 'Book 1', parentId: 'pS', kind: 'Book' }, { id: 'pB2', name: 'Book 2', parentId: 'pS', kind: 'Book' }], links: [] });
    const boss = await computer(s.owner, 'boss-pc');
    await boss.write('one.png', 'cover one');
    await boss.write('two.png', 'cover two');
    await boss.vault.add('one.png');
    await boss.vault.add('two.png');
    await boss.vault.setCard('one.png', {}, 'pB1');
    await boss.vault.setCard('two.png', {}, 'pB2');
    const gus = await computer(await s.person('guest', 'Gus Guest', { projectId: 'pB1', days: 3 }), 'gus-pc');
    expect((await gus.vault.list()).map((e) => e.path)).toEqual(['one.png']);
    expect((await gus.vault.getLatest(undefined, { fetchMissing: true })).updated).toEqual(['one.png']);
    expect(await gus.read('one.png')).toBe('cover one');
    await expect(gus.vault.status('two.png')).rejects.toBeTruthy();
  });

  it('when the Studio cannot be reached, the last list is shown, a checked-out file can still be edited, and it is checked in when back', async () => {
    const s = await studio();
    const ann = await computer(await s.person('author', 'Ann Author'), 'ann-pc');
    await ann.write('ch1.md', 'v1');
    await ann.vault.add('ch1.md');
    await ann.vault.checkOut('ch1.md');
    expect((await ann.vault.list()).map((e) => e.path)).toEqual(['ch1.md']);

    s.setOnline(false);
    const offline = await ann.vault.list();
    expect(offline.map((e) => [e.path, e.status])).toEqual([['ch1.md', 'checked-out-by-me']]);
    expect(ann.store.offline).toBe(true);
    await ann.write('ch1.md', 'v2 written on the train');
    await expect(ann.vault.checkIn('ch1.md', 'Train')).rejects.toThrow(/cannot be reached/);
    expect(await ann.read('ch1.md')).toBe('v2 written on the train');

    s.setOnline(true);
    expect((await ann.vault.checkIn('ch1.md', 'Train')).version).toBe(2);
    expect(ann.store.offline).toBe(false);
  });
});

describe('moving a Studio’s records to its server', () => {
  it('brings the people, the catalogue, the work, the vault with its files and the projects across, and a member joining afterwards sees them', async () => {
    const s = await studio();
    const dir = await tmp();
    // the owner's computer, before: a records file with a book, a task and a file in the vault
    const host = new PeopleHost();
    await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Olive Owner' });
    const svc = host.service!.as(host.me);
    const bo = await svc.people.create({ name: 'Bo Lin', kind: 'contractor' });
    const book = await svc.catalogue.createBook({ title: 'Lead Me', penName: 'Mara' });
    await svc.catalogue.addEdition(book.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    await svc.work.createTask({ projectId: 'pB1', title: 'Write the blurb', assigneeId: bo.id });
    const vault = host.vault({ dir: path.join(dir, 'work'), blobsDir: path.join(dir, 'blobs'), machine: 'olive-pc' })!;
    await (await import('node:fs/promises')).mkdir(path.join(dir, 'work'), { recursive: true });
    await writeFile(path.join(dir, 'work', 'ch1.md'), 'Chapter one.');
    await vault.add('ch1.md');
    await host.snapshot(path.join(dir, 'copy.db'));
    const tree = { projects: [{ id: 'pB1', name: 'Book 1', parentId: null, kind: 'Book', status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] };

    const steps: string[] = [];
    const moved = await moveRecordsToServer({ client: s.owner, recordsCopy: path.join(dir, 'copy.db'), ownerPersonId: host.me, blobsDir: path.join(dir, 'blobs'), tree, step: (t) => steps.push(t) });
    expect(moved.files).toBe(1);
    expect(moved.missing).toEqual([]);
    expect(moved.rows).toBeGreaterThan(20);
    expect(steps).toEqual(expect.arrayContaining([expect.stringMatching(/projects/)]));

    // the owner, now through the server, is the same person with the same records
    expect((await s.owner.me()).personId).toBe(host.me);
    const ownerSvc = remoteService(s.owner).as('x');
    expect((await ownerSvc.people.list()).map((p) => p.name).sort()).toEqual(['Bo Lin', 'Olive Owner']);
    expect((await ownerSvc.catalogue.books()).map((b) => [b.title, b.editions[0]!.asin])).toEqual([['Lead Me', 'B0AAAAAAA1']]);
    expect((await ownerSvc.work.tasks({ projectId: 'pB1' })).map((t) => t.title)).toEqual(['Write the blurb']);
    const remote = await computer(s.owner, 'olive-pc-2');
    expect((await remote.vault.getLatest(undefined, { fetchMissing: true })).updated).toEqual(['ch1.md']);
    expect(await remote.read('ch1.md')).toBe('Chapter one.');
    expect((await s.owner.tree()).projects.map((p) => p.name)).toEqual(['Book 1']);

    // a person who joins afterwards is a person here, with the role invited, and sees the vault
    const ed = await computer(await s.person('editor', 'Ed Editor'), 'ed-pc');
    expect((await ed.vault.list()).map((e) => e.path)).toEqual(['ch1.md']);
    expect((await remoteService(s.owner).as('x').people.list()).map((p) => p.name)).toContain('Ed Editor');
    // running it again starts over and ends the same
    const again = await moveRecordsToServer({ client: s.owner, recordsCopy: path.join(dir, 'copy.db'), ownerPersonId: host.me, blobsDir: path.join(dir, 'blobs'), tree });
    expect(again.rows).toBe(moved.rows);
    expect((await ownerSvc.catalogue.books()).map((b) => b.title)).toEqual(['Lead Me']);
    await host.close();
  });

  it('is refused for anyone but the owner, and for a table the server does not have', async () => {
    const s = await studio();
    const ann = await s.person('author', 'Ann');
    await expect(ann.request('POST', '/v1/records/import', { phase: 'start' })).rejects.toThrow(/Only the Studio’s owner/);
    await expect(s.owner.request('POST', '/v1/records/import', { phase: 'rows', table: 'member', rows: [{ id: 'x' }] })).rejects.toThrow(/not a table/);
    await expect(s.owner.request('POST', '/v1/records/import', { phase: 'rows', table: 'person', rows: [{ 'id; DROP TABLE person': 'x' }] })).rejects.toThrow(/columns/);
  });
});

describe('the app’s people host over a server Studio', () => {
  it('opens a joined Studio through its server: the people and roles page, the vault, the pen names for imports; says so when it cannot be reached and opens when it can', async () => {
    const s = await studio();
    const key = await generateKeyPair();
    // an owner has made a pen name; a member joins and opens the Studio on their computer
    await remoteService(s.owner).as('x').people.createPenName({ displayName: 'Mara Quinn' });
    const ann = await s.person('author', 'Ann Author');
    const host = new PeopleHost();
    s.setOnline(false);
    const down = await host.openRemote({ client: ann, studioId: 'sabc123def4' });
    expect(down.ok).toBe(false);
    expect(await host.state()).toMatchObject({ available: false, reason: expect.stringMatching(/cannot be reached/) });
    expect(host.isRemote).toBe(false);
    s.setOnline(true);
    expect((await host.openRemote({ client: ann, studioId: 'sabc123def4' })).ok).toBe(true);
    expect(host.isRemote).toBe(true);
    // an Author does not see the people and roles page; the owner does
    expect(await host.state()).toMatchObject({ available: false, reason: expect.stringMatching(/does not let you see the people/) });
    const boss = new PeopleHost();
    await boss.openRemote({ client: s.owner, studioId: 'sabc123def4' });
    const st = await boss.state();
    expect(st).toMatchObject({ available: true, may: { people: true, teams: true, roles: true } });
    if (st.available) expect(st.people.map((p) => p.name).sort()).toEqual(['Ann Author', 'Owner']);
    await boss.close();
    expect(host.penNameScope()).toEqual(['Mara Quinn']);
    expect(host.mcpArgs('records.db')).toEqual([]); // the assistant's record tools open a records file; there is none here
    expect(await host.snapshot('x')).toBe(false);
    // a change the person's role does not allow comes back with its reason
    await expect(host.call('createRole', { name: 'Sneaky', capabilities: [] })).rejects.toThrow(/not allowed/);
    // the vault works through the server
    const dir = await tmp();
    const v = host.vault({ dir: path.join(dir, 'work'), blobsDir: path.join(dir, 'blobs'), machine: 'ann-pc' })!;
    await (await import('node:fs/promises')).mkdir(path.join(dir, 'work'), { recursive: true });
    await writeFile(path.join(dir, 'work', 'a.md'), 'hello');
    expect((await v.add('a.md')).status).toBe('latest');
    expect(host.vault({ dir: path.join(dir, 'work'), blobsDir: path.join(dir, 'blobs'), machine: 'ann-pc' })).toBe(v); // the same one, so its last list is kept
    s.setOnline(false);
    expect((await v.list()).map((e) => e.path)).toEqual(['a.md']);
    expect(host.offline).toBe(true);
    void key;
    await host.close();
  });
});

describe('backing up and restoring a server Studio’s records', () => {
  it('saves every record, the owner and the projects to one file, and puts them back after they were lost', async () => {
    const s = await studio();
    const dir = await tmp();
    const svc = remoteService(s.owner).as('x');
    await s.owner.publishTree({ projects: [{ id: 'pB1', name: 'Book 1', parentId: null, kind: 'Book', status: 'active', order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] });
    await svc.catalogue.createBook({ title: 'Lead Me' });
    await svc.people.create({ name: 'Bo Lin', kind: 'contractor' });
    const a = await computer(await s.person('author', 'Ann Author'), 'ann-pc');
    await a.write('ch1.md', 'one');
    await a.vault.add('ch1.md');

    const file = path.join(dir, 'backup.json');
    const made = await backupServerRecords({ client: s.owner, file, studio: { id: 'sabc123def4', name: 'Acme' } });
    expect(made.rows).toBeGreaterThan(20);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toMatchObject({ format: 'cadrel-server-records', studio: { name: 'Acme' }, schema: 11 });
    expect(saved.tables.book).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('public_key'); // who may sign in is not in it

    // the records are lost (the server is emptied), then put back
    await s.owner.request('POST', '/v1/records/import', { phase: 'start' });
    expect((await s.owner.request<{ result: unknown }>('GET', '/v1/me').catch(() => null)) !== undefined).toBe(true);
    expect(await svc.catalogue.books()).toEqual([]);
    const back = await restoreServerRecords({ client: s.owner, file });
    expect(back.rows).toBe(made.rows);
    expect((await svc.catalogue.books()).map((b) => b.title)).toEqual(['Lead Me']);
    expect((await svc.people.list()).map((p) => p.name).sort()).toEqual(['Ann Author', 'Bo Lin', 'Owner']);
    expect((await a.vault.list()).map((e) => e.path)).toEqual(['ch1.md']);
    expect((await s.owner.tree()).projects.map((p) => p.name)).toEqual(['Book 1']);
  });

  it('refuses a file that is not a backup, one from a newer Cadrel, and anyone but the owner', async () => {
    const s = await studio();
    const dir = await tmp();
    await writeFile(path.join(dir, 'x.json'), JSON.stringify({ hello: 'world' }));
    await expect(restoreServerRecords({ client: s.owner, file: path.join(dir, 'x.json') })).rejects.toThrow(/not a backup/);
    await writeFile(path.join(dir, 'new.json'), JSON.stringify({ format: 'cadrel-server-records', schema: 99, owner: 'p', tables: {} }));
    await expect(restoreServerRecords({ client: s.owner, file: path.join(dir, 'new.json') })).rejects.toThrow(/newer Cadrel/);
    const ann = await s.person('author', 'Ann');
    await expect(backupServerRecords({ client: ann, file: path.join(dir, 'y.json'), studio: { id: 'x', name: 'x' } })).rejects.toThrow(/Only the Studio’s owner/);
  });
});
