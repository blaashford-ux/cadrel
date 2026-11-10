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
import { joinStudio, StudioClient, StudioOfflineError } from '../src/main/studioClient';
import { EditorialOffline } from '../src/main/offlineEditorial';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';
import { unzipSync } from 'fflate';
import { readPackManifest } from '@cadrel/market-library';
import { syncCaptures } from '../src/main/sharedCaptures';
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
    const brief = await svc.briefs.create({ projectId: 'pB1', kind: 'edit', title: 'Line edit', body: 'Tighten dialogue.' });
    await svc.briefs.revise(brief.id, { body: 'Tighten dialogue and cut filter words.', basedOn: 1 });
    const a = await computer(await s.person('author', 'Ann Author'), 'ann-pc');
    await a.write('ch1.md', 'one');
    await a.vault.add('ch1.md');

    const bo = (await svc.people.list()).find((p) => p.name === 'Owner')!; // holds every project, so may edit it
    const fileId = (await a.store.list())[0]!.id;
    const pass = await svc.passes.create({ projectId: 'pB1', kind: 'line', fileId, editorId: bo.id });
    await svc.passes.start(pass.id);
    await svc.queries.raise(pass.id, [{ kind: 'query', body: 'Why cold?', anchor: { quote: 'one', prefix: '', suffix: '', start: 0 } }, { kind: 'suggestion', replacement: '1', anchor: { quote: 'one', prefix: '', suffix: '', start: 0 } }]);
    await svc.passes.deliver(pass.id);
    const sug = (await svc.queries.list({ passId: pass.id })).find((q) => q.kind === 'suggestion')!;
    const decided = await svc.queries.decide(sug.id, { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' });

    const file = path.join(dir, 'backup.json');
    const made = await backupServerRecords({ client: s.owner, file, studio: { id: 'sabc123def4', name: 'Acme' } });
    expect(made.rows).toBeGreaterThan(20);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toMatchObject({ format: 'cadrel-server-records', studio: { name: 'Acme' }, schema: 18 });
    expect(saved.tables.book).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('public_key'); // who may sign in is not in it

    // the records are lost (the server is emptied), then put back
    await s.owner.request('POST', '/v1/records/import', { phase: 'start' });
    expect((await s.owner.request<{ result: unknown }>('GET', '/v1/me').catch(() => null)) !== undefined).toBe(true);
    expect(await svc.catalogue.books()).toEqual([]);
    const back = await restoreServerRecords({ client: s.owner, file });
    expect(back.rows).toBe(made.rows);
    expect((await svc.catalogue.books()).map((b) => b.title)).toEqual(['Lead Me']);
    expect((await svc.briefs.versions(brief.id)).map((v) => v.n)).toEqual([1, 2]);
    expect((await svc.queries.list({ passId: pass.id })).map((q) => [q.seq, q.body, q.anchor?.quote])).toEqual([[1, 'Why cold?', 'one'], [2, '', 'one']]);
    expect((await svc.queries.decisions({ passId: pass.id })).map((d) => [d.id, d.outcome, d.revisit])).toEqual([[decided.id, 'defer', '2026-12-01']]); // with its ledger entry and revisit task
    expect((await svc.work.decisions()).map((d) => d.id)).toContain(decided.ledgerId);
    expect((await svc.work.task(decided.taskId!))?.due).toBe('2026-12-01');
    expect((await svc.passes.get(pass.id))).toMatchObject({ kind: 'line', fileId, fileVersion: 1, state: 'delivered' }); // a pass keeps the exact version it covers // briefs and every version come back
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

describe('sharing Market captures through the Studio', () => {
  const put = async (root: string, rel: string, text: string) => {
    const f = path.join(root, ...rel.split('/'));
    await (await import('node:fs/promises')).mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, text);
  };
  const BOOK = 'books/B0AAAAAAA1/snapshots/20261101T100000Z';
  const LIST = 'lists/kindle/fantasy/page-1/20261101T110000Z';

  it('each computer sends what the others lack and fetches what it lacks, in the shape Market’s import reads; nothing is sent twice', async () => {
    const s = await studio();
    const analyst = await s.person('analyst', 'Ana Lyst');
    const author = await s.person('marketing', 'Mark Eting');
    const a = await tmp();
    const b = await tmp();
    await put(a, `${BOOK}/capture.json`, '{"kind":"detail"}');
    await put(a, `${BOOK}/page.html.gz`, 'gz-book');
    await put(a, 'books/B0AAAAAAA1/covers/0123456789abcdef.jpg', 'jpeg');
    await put(a, 'books/B0AAAAAAA1/notes.txt', 'not a capture file'); // left alone
    await put(b, `${LIST}/capture.json`, '{"kind":"list"}');
    await put(b, `${LIST}/page.html.gz`, 'gz-list');

    const packs: { names: string[]; id: string }[] = [];
    const importInto = (root: string) => async (file: string) => {
      const m = readPackManifest(file); // Market would refuse this if it were not a pack it knows
      const files = unzipSync(new Uint8Array(await readFile(file)));
      packs.push({ names: Object.keys(files).filter((n) => n !== 'manifest.json').sort(), id: m.id });
      for (const [n, bytes] of Object.entries(files)) if (n !== 'manifest.json') await put(root, n, Buffer.from(bytes).toString());
      return { added: Object.keys(files).length - 1, alreadyHad: 0, skipped: 0 };
    };

    const first = await syncCaptures({ client: analyst, root: a, importPack: importInto(a) });
    expect(first).toEqual({ sent: 3, fetched: 0, imported: null });
    const second = await syncCaptures({ client: author, root: b, importPack: importInto(b) });
    expect(second).toMatchObject({ sent: 2, fetched: 3, imported: { added: 3 } });
    expect(packs[0]!.names).toEqual(['books/B0AAAAAAA1/covers/0123456789abcdef.jpg', `${BOOK}/capture.json`, `${BOOK}/page.html.gz`]);
    expect(await readFile(path.join(b, ...`${BOOK}/page.html.gz`.split('/')), 'utf8')).toBe('gz-book');
    // the first computer now gets the list page; and a second run sends and fetches nothing
    const third = await syncCaptures({ client: analyst, root: a, importPack: importInto(a) });
    expect(third).toMatchObject({ sent: 0, fetched: 2 });
    expect(await syncCaptures({ client: analyst, root: a, importPack: importInto(a) })).toEqual({ sent: 0, fetched: 0, imported: null });
    expect(await syncCaptures({ client: author, root: b, importPack: importInto(b) })).toEqual({ sent: 0, fetched: 0, imported: null });
  });

  it('only people who may capture send, and only people who may see market research fetch; captures are never replaced and only capture files are accepted', async () => {
    const s = await studio();
    const guest = await s.person('guest', 'Gus');
    const analyst = await s.person('analyst', 'Ana');
    await expect(guest.putCapture(`${BOOK}/capture.json`, new TextEncoder().encode('x'))).rejects.toThrow(/not allowed/);
    await analyst.putCapture(`${BOOK}/capture.json`, new TextEncoder().encode('first'));
    await analyst.putCapture(`${BOOK}/capture.json`, new TextEncoder().encode('second'));
    expect(new TextDecoder().decode((await analyst.getCapture(`${BOOK}/capture.json`))!)).toBe('first');
    await expect(analyst.putCapture('books/..%2F..%2Fx/capture.json', new Uint8Array([1]))).rejects.toThrow(/not a capture file/);
    await expect(analyst.putCapture('books/B0AAAAAAA1/notes.txt', new Uint8Array([1]))).rejects.toThrow(/not a capture file/);
    await expect(guest.getCapture(`${BOOK}/capture.json`)).rejects.toThrow(/not allowed/);
    await expect(guest.captures()).rejects.toThrow(/not allowed/);
    expect(await analyst.getCapture(`${LIST}/capture.json`)).toBeNull();
  });
});

describe('what the app asks the Studio again', () => {
  it('keeps answers to reads until the Studio says something changed, and never keeps a change', async () => {
    const s = await studio();
    let calls = 0;
    const counting = (async (i: string | URL | Request, init?: RequestInit) => ((String(i instanceof Request ? i.url : i).endsWith('/v1/call') && calls++), s.fetchFn(i, init))) as typeof fetch;
    let clock = 1_000_000;
    const me = new StudioClient({ url: s.owner['o'].url, key: s.ownerKey, fetchFn: counting, now: () => clock });
    const other = new StudioClient({ url: s.owner['o'].url, key: s.ownerKey, fetchFn: s.fetchFn });

    await other.rpc(['catalogue', 'ips'], []); // the Studio's first request sets up its records, which is a change
    clock += 10_000;
    expect(await me.rpc<unknown[]>(['catalogue', 'ips'], [])).toEqual([]);
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i++) await me.rpc(['catalogue', 'ips'], []);
    expect(calls).toBe(1); // asked once; the other five were answered here

    clock += 10_000; // later, nothing changed on the Studio: still no need to ask for the answer again
    await me.rpc(['catalogue', 'ips'], []);
    expect(calls).toBe(1);

    await other.rpc(['catalogue', 'createIp'], [{ name: 'Dragon Rider' }]); // someone else changes it
    await me.rpc(['catalogue', 'ips'], []);
    expect(calls).toBe(1); // within the few seconds the counter is trusted for
    clock += 10_000;
    expect(((await me.rpc(['catalogue', 'ips'], [])) as { name: string }[]).map((x) => x.name)).toEqual(['Dragon Rider']);
    expect(calls).toBe(2);

    await me.rpc(['catalogue', 'createIp'], [{ name: 'Starfall' }]); // its own change is seen at once
    expect(((await me.rpc(['catalogue', 'ips'], [])) as { name: string }[]).map((x) => x.name).sort()).toEqual(['Dragon Rider', 'Starfall']);
  });
});

describe('editorial records when the Studio cannot be reached', () => {
  /** An editor (the owner) who delivers a pass of three items, and an author on another computer who has the Studio but may lose it. */
  async function setup() {
    const s = await studio();
    const dir = await tmp();
    await s.owner.publishTree({ projects: [{ id: 'pB1', name: 'Book 1', parentId: null, kind: 'Book', status: 'active', order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] });
    const editor = remoteService(s.owner).as('x');
    const annClient = await s.person('author', 'Ann Author', { projectId: 'pB1', days: 30 });
    const o = await computer(s.owner, 'owner-pc');
    await o.write('ch1.md', 'one');
    await o.vault.add('ch1.md');
    const fileId = (await o.store.list())[0]!.id;
    const pass = await editor.passes.create({ projectId: 'pB1', kind: 'line', fileId, editorId: (await s.owner.me()).personId });
    await editor.passes.start(pass.id);
    const [q1, q2, sug] = await editor.queries.raise(pass.id, [
      { kind: 'query', body: 'Why cold?', anchor: { quote: 'one', prefix: '', suffix: '', start: 0 } },
      { kind: 'query', body: 'Why now?' },
      { kind: 'suggestion', replacement: '1', anchor: { quote: 'one', prefix: '', suffix: '', start: 0 } }
    ]);
    await editor.passes.deliver(pass.id);
    const file = path.join(dir, 'editorial-offline.json');
    const eo = new EditorialOffline(remoteService(annClient), { file });
    return { s, editor, eo, me: eo.as('x'), pass, q1: q1!, q2: q2!, sug: sug!, file, annClient };
  }
  const offlineError = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);

  it('reads a pass and its items from this computer when the server cannot be reached, if it was read before', async () => {
    const { s, me, pass, q1 } = await setup();
    const online = await me.queries.list({ passId: pass.id });
    expect(online.map((q) => q.seq)).toEqual([1, 2, 3]);
    await me.passes.get(pass.id);
    s.setOnline(false);
    expect((await me.queries.list({ passId: pass.id })).map((q) => q.id)).toContain(q1.id);
    expect((await me.passes.get(pass.id))?.state).toBe('delivered');
    expect(await offlineError(me.passes.get('never-opened'))).toBeInstanceOf(StudioOfflineError); // nothing kept for a call never made
    expect(await offlineError(me.queries.list({ passId: 'another' }))).toBeInstanceOf(StudioOfflineError);
    s.setOnline(true);
    expect((await me.queries.list({ passId: pass.id })).length).toBe(3);
  });

  it('keeps the author’s answer and decision while away, shows them as made, and sends them in order when back', async () => {
    const { s, editor, eo, me, pass, q1, sug } = await setup();
    await me.queries.list({ passId: pass.id });
    await me.queries.decisions({ passId: pass.id });
    s.setOnline(false);

    const answered = await me.queries.answer(q1.id, '  Because the river is a river.  ');
    expect(answered).toMatchObject({ id: q1.id, state: 'answered', response: 'Because the river is a river.' });
    const decided = await me.queries.decide(sug.id, { outcome: 'defer', reason: 'Wait for the beta readers.', revisit: '2026-12-01' });
    expect(decided).toMatchObject({ queryId: sug.id, outcome: 'defer', revisit: '2026-12-01', taskId: null });
    expect(decided.id).toMatch(/^queued:/);
    expect(await eo.status()).toMatchObject({ offline: true, pending: 2, refused: [] });

    // what the author sees while away includes their own waiting work
    expect((await me.queries.list({ passId: pass.id })).find((q) => q.id === q1.id)).toMatchObject({ state: 'answered', response: 'Because the river is a river.' });
    expect((await me.queries.decisions({ passId: pass.id })).map((d) => [d.queryId, d.outcome])).toEqual([[sug.id, 'defer']]);
    // and the editor, online, has seen nothing yet (asked through a client of its own, so no answer of the editor's is kept)
    s.setOnline(true);
    const peek = remoteService(new StudioClient({ url: s.owner['o'].url, key: s.ownerKey, fetchFn: s.fetchFn })).as('x');
    expect((await peek.queries.list({ passId: pass.id })).every((q) => q.state === 'open')).toBe(true);
    s.setOnline(false);

    s.setOnline(true);
    expect(await eo.flush()).toEqual({ offline: false });
    expect(await eo.status()).toMatchObject({ pending: 0, refused: [] });
    const now = await editor.queries.list({ passId: pass.id });
    expect(now.find((q) => q.id === q1.id)).toMatchObject({ state: 'answered', response: 'Because the river is a river.' });
    const theirs = await editor.queries.decisions({ passId: pass.id });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ queryId: sug.id, outcome: 'defer', revisit: '2026-12-01' });
    expect(theirs[0]!.taskId).toBeTruthy(); // the revisit task was made when it was sent
  });

  it('checks what was written at once, so a mistake is told now and not when the Studio is next reached', async () => {
    const { s, me, pass, q1, sug } = await setup();
    await me.queries.list({ passId: pass.id });
    s.setOnline(false);
    await expect(me.queries.answer(q1.id, '   ')).rejects.toMatchObject({ code: 'invalid' });
    await expect(me.queries.decide(sug.id, { outcome: 'reject' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(me.queries.decide(sug.id, { outcome: 'defer', reason: 'x', revisit: '2026-02-30' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('will not keep an answer to an item this computer has never seen', async () => {
    const { s, eo, me } = await setup();
    s.setOnline(false);
    const e = await offlineError(me.queries.answer('never-seen', 'Hello'));
    expect(e).toBeInstanceOf(StudioOfflineError);
    expect(e!.message).toContain('not saved on this computer');
    expect((await eo.status()).pending).toBe(0);
  });

  it('a second answer to the same item replaces the one still waiting', async () => {
    const { s, editor, eo, me, pass, q1 } = await setup();
    await me.queries.list({ passId: pass.id });
    s.setOnline(false);
    await me.queries.answer(q1.id, 'First thought.');
    await me.queries.answer(q1.id, 'Second thought.');
    expect((await eo.status()).pending).toBe(1);
    s.setOnline(true);
    await eo.flush();
    expect((await editor.queries.list({ passId: pass.id })).find((q) => q.id === q1.id)!.response).toBe('Second thought.');
  });

  it('sends what is waiting before it reads, so the author never reads an old copy of their own work', async () => {
    const { s, me, pass, q1 } = await setup();
    await me.queries.list({ passId: pass.id });
    s.setOnline(false);
    await me.queries.answer(q1.id, 'Because.');
    s.setOnline(true);
    const list = await me.queries.list({ passId: pass.id });
    expect(list.find((q) => q.id === q1.id)).toMatchObject({ state: 'answered', respondedBy: expect.not.stringMatching(/^queued/) });
    expect((await me.queries.list({ passId: pass.id })).find((q) => q.id === q1.id)!.respondedAt).not.toBeNull();
  });

  it('an answer the server turns down when it is sent is kept aside with the reason and the author’s words, and is not retried', async () => {
    const { s, editor, eo, me, pass, q2 } = await setup();
    await me.queries.list({ passId: pass.id });
    s.setOnline(false);
    await me.queries.answer(q2.id, 'A careful answer that took a while to write.');
    s.setOnline(true);
    await editor.passes.cancel(pass.id); // called off while the author was away
    expect(await eo.flush()).toEqual({ offline: false });
    const st = await eo.status();
    expect(st.pending).toBe(0);
    expect(st.refused).toHaveLength(1);
    expect(st.refused[0]).toMatchObject({ call: 'answer', queryId: q2.id, response: 'A careful answer that took a while to write.' });
    expect(st.refused[0]!.error).toMatch(/delivered/);
    await eo.dismiss(st.refused[0]!.id);
    expect((await eo.status()).refused).toEqual([]);
  });

  it('survives the app being closed: the copy and the waiting answers are read back from the file', async () => {
    const { s, annClient, file, me, pass, q1 } = await setup();
    await me.queries.list({ passId: pass.id });
    s.setOnline(false);
    await me.queries.answer(q1.id, 'Kept on disk.');
    const again = new EditorialOffline(remoteService(annClient), { file });
    expect(await again.status()).toMatchObject({ pending: 1 });
    expect((await again.as('x').queries.list({ passId: pass.id })).find((q) => q.id === q1.id)).toMatchObject({ state: 'answered', response: 'Kept on disk.' });
    s.setOnline(true);
    await again.flush();
    expect((await again.status()).pending).toBe(0);
  });

  it('passes every other call straight through, and the things only the server can do still need it', async () => {
    const { s, me, pass } = await setup();
    expect(await me.work.tasks()).toEqual([]); // not an editorial call: straight through
    await me.queries.list({ passId: pass.id });
    s.setOnline(false);
    expect(await offlineError(me.passes.respond(pass.id))).toBeInstanceOf(StudioOfflineError); // marking a pass responded changes what the editor sees
    expect(await offlineError(me.work.tasks())).toBeInstanceOf(StudioOfflineError); // nothing is kept for it
  });

  it('the app’s Studio host keeps the editorial copy when it is given a file, and behaves as before when it is not', async () => {
    const s = await studio();
    const dir = await tmp();
    const on = new PeopleHost();
    await on.openRemote({ client: s.owner, studioId: 'sabc123def4', offlineFile: path.join(dir, 'e.json') });
    expect(on.editorialOffline).not.toBeNull();
    expect(await on.service!.as(on.me).passes.list()).toEqual([]);
    s.setOnline(false);
    expect(await on.service!.as(on.me).passes.list()).toEqual([]); // still answered with no server, from what was kept
    s.setOnline(true);
    const off = new PeopleHost();
    await off.openRemote({ client: s.owner, studioId: 'sabc123def4' });
    expect(off.editorialOffline).toBeNull();
    await on.close();
    expect(on.editorialOffline).toBeNull();
  });
});
