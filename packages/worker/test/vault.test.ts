import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, hex, sha256, signRequest, type KeyPair } from '@cadrel/kernel';
import { decodeValue, encodeValue } from '@cadrel/service';
import worker, { type Env } from '../src/index';
import { fakeD1 } from './d1fake';
import { fakeR2 } from './r2fake';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const enc = new TextEncoder();
const hashOf = async (text: string) => hex(await sha256(enc.encode(text)));

async function server() {
  const owner = await generateKeyPair();
  const files = fakeR2();
  const env: Env = { ENVIRONMENT: 'studio', DB: fakeD1(), FILES: files, STUDIO_ID: 'st1', OWNER_KEY: owner.publicKey };
  let now = 1_800_000_000_000;
  const send = async (method: string, path: string, key: KeyPair | null, body?: string | Uint8Array) => {
    vi.setSystemTime(now);
    const headers: Record<string, string> = key ? { ...(await signRequest({ method, path, body: body ?? '', key, now })) } : {};
    now += 1;
    return worker.fetch(new Request(`https://studio.test${path}`, { method, headers, ...(body !== undefined && body !== '' ? { body: body as BodyInit } : {}) }), env);
  };
  const call = async (key: KeyPair, path: string[], ...args: unknown[]) => {
    const r = await send('POST', '/v1/call', key, encodeValue({ path, args }));
    const text = await r.text();
    return { status: r.status, body: decodeValue(text) as Record<string, any> };
  };
  const vault = async (key: KeyPair, method: string, arg?: unknown) => {
    const r = await send('POST', '/v1/vault', key, encodeValue({ method, args: [arg] }));
    return { status: r.status, body: decodeValue(await r.text()) as Record<string, any> };
  };
  const put = async (key: KeyPair, text: string) => (await send('PUT', `/v1/blobs/${await hashOf(text)}`, key, enc.encode(text))).status;
  const get = async (key: KeyPair, text: string) => {
    const r = await send('GET', `/v1/blobs/${await hashOf(text)}`, key);
    return { status: r.status, text: r.status === 200 ? new TextDecoder().decode(await r.arrayBuffer()) : null };
  };
  const join = async (role: string, name: string, extra: Record<string, unknown> = {}) => {
    const key = await generateKeyPair();
    const inv = (await (await send('POST', '/v1/invites', owner, JSON.stringify({ role, label: name, ...extra }))).json()) as { code: string };
    const r = await send('POST', '/v1/join', key, JSON.stringify({ code: inv.code, name }));
    return { key, status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const tick = (ms: number) => (now += ms);
  return { owner, env, files, send, call, vault, put, get, join, tick };
}

const TREE = { projects: [{ id: 'pS', name: 'Dragon Rider', parentId: null, kind: 'Series' }, { id: 'pB1', name: 'Book 1', parentId: 'pS', kind: 'Book' }, { id: 'pB2', name: 'Book 2', parentId: 'pS', kind: 'Book' }], links: [] };

/** Makes a file in the vault as `key`, with its contents, as version 1. */
async function addFile(s: Awaited<ReturnType<typeof server>>, key: KeyPair, path: string, text: string, projectId?: string) {
  expect(await s.put(key, text)).toBe(200);
  const r = await s.vault(key, 'addFile', { path, hash: await hashOf(text), size: text.length, comment: 'First version', machine: 'pc', ...(projectId ? { projectId } : {}) });
  return r;
}

describe('the Studio server: records', () => {
  it('has the owner as a person with the Owner role, the twelve default roles, and answers the service’s calls as whoever signed', async () => {
    const s = await server();
    const me = await s.send('GET', '/v1/me', s.owner);
    const who = (await me.json()) as { personId: string; kind: string };
    expect(who.kind).toBe('owner');
    const people = await s.call(s.owner, ['people', 'list']);
    expect(people.status).toBe(200);
    expect(people.body.result.map((p: { id: string }) => p.id)).toEqual([who.personId]);
    expect((await s.call(s.owner, ['people', 'roles'])).body.result).toHaveLength(12);
  });

  it('makes a member a person with the invited role, and the service refuses them what their role does not allow', async () => {
    const s = await server();
    const author = await s.join('author', 'Ann Author');
    expect(author.status).toBe(200);
    const people = await s.call(s.owner, ['people', 'list']);
    expect(people.body.result.map((p: { name: string }) => p.name).sort()).toEqual(['Ann Author', 'Owner']);
    // an Author may not change roles
    const denied = await s.call(author.key, ['people', 'createRole'], { name: 'Sneaky', capabilities: ['vault.force'] });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ kind: 'PermissionDenied' });
    // and the owner may make a book, which the Author then reads
    const made = await s.call(s.owner, ['catalogue', 'createBook'], { title: 'Lead Me' });
    expect(made.status).toBe(200);
    expect((await s.call(author.key, ['catalogue', 'books'])).body.result.map((b: { title: string }) => b.title)).toEqual(['Lead Me']);
  });

  it('shows who is in the Studio by name to anyone who holds a role, even one given a single project, and the rest of a person’s record to those who may see people', async () => {
    const s = await server();
    await s.send('PUT', '/v1/tree', s.owner, JSON.stringify(TREE));
    const guest = await s.join('guest', 'Gus Guest', { projectId: 'pB1' });
    const names = (await s.call(guest.key, ['people', 'directory'])).body.result as { id: string; name: string }[];
    expect(names.map((n) => n.name).sort()).toEqual(['Gus Guest', 'Owner']);
    expect(Object.keys(names[0]!).sort()).toEqual(['id', 'name']);
    expect((await s.call(guest.key, ['people', 'list'])).status).toBe(403);
    expect((await s.call(s.owner, ['people', 'list'])).status).toBe(200);
  });

  it('refuses names that are not the service’s calls, and signed-in strangers', async () => {
    const s = await server();
    const stranger = await generateKeyPair();
    expect((await s.call(stranger, ['catalogue', 'books'])).status).toBe(403);
    for (const path of [['constructor'], ['__proto__', 'x'], ['catalogue', 'constructor'], ['catalogue'], ['o'], ['people', 'list', 'x']]) expect((await s.call(s.owner, path)).status).toBe(400);
    const unsigned = await s.send('POST', '/v1/call', null, encodeValue({ path: ['people', 'list'], args: [] }));
    expect(unsigned.status).toBe(401);
  });

  it('keeps the project tree the owner publishes, and shows each person only their own projects', async () => {
    const s = await server();
    const author = await s.join('author', 'Ann');
    expect((await s.send('PUT', '/v1/tree', author.key, JSON.stringify(TREE))).status).toBe(403);
    expect((await s.send('PUT', '/v1/tree', s.owner, JSON.stringify(TREE))).status).toBe(200);
    const seen = async (key: KeyPair) => ((decodeValue(await (await s.send('GET', '/v1/tree', key)).text()) as { result: { projects: { id: string }[] } }).result.projects.map((p) => p.id));
    expect(await seen(s.owner)).toEqual(['pS', 'pB1', 'pB2']);
    const guest = await s.join('guest', 'Gus Guest', { projectId: 'pB1' });
    expect((await seen(guest.key)).sort()).toEqual(['pB1', 'pS']); // the book, and the series it sits in as a container
    // an invitation to a project that is not in the published tree is refused
    expect((await s.send('POST', '/v1/invites', s.owner, JSON.stringify({ role: 'guest', label: '', projectId: 'pNope' }))).status).toBe(400);
  });
});

describe('the Studio server: the vault', () => {
  it('the exit test: the author checks a chapter out, the editor sees the lock, the author checks in, the editor gets the new version', async () => {
    const s = await server();
    const author = await s.join('author', 'Ann Author');
    const editor = await s.join('editor', 'Ed Editor');
    expect((await addFile(s, author.key, 'Book 1/ch1.md', 'Chapter one, first draft.')).body.result).toMatchObject({ ok: true, version: 1 });
    const file = (await s.vault(editor.key, 'list')).body.result[0];
    expect(file).toMatchObject({ path: 'Book 1/ch1.md', currentVersion: 1, lock: null });

    // the author takes it; the editor sees who holds it and cannot take it too
    expect((await s.vault(author.key, 'checkOut', { fileId: file.id, machine: 'ann-pc' })).body.result).toMatchObject({ ok: true, baseVersion: 1 });
    const seen = (await s.vault(editor.key, 'list')).body.result[0];
    expect(seen.lock).toMatchObject({ machine: 'ann-pc' });
    expect(seen.lock.personId).toBe((await (await s.send('GET', '/v1/me', author.key)).json() as { personId: string }).personId);
    expect((await s.vault(editor.key, 'checkOut', { fileId: file.id, machine: 'ed-pc' })).body.result).toMatchObject({ ok: false, reason: 'locked' });

    // only the holder, on the machine that holds it, checks in; contents must be uploaded first
    const second = 'Chapter one, second draft.';
    const unsent = await s.vault(author.key, 'checkIn', { fileId: file.id, machine: 'ann-pc', hash: await hashOf(second), size: second.length, comment: 'Revised' });
    expect(unsent.status).toBe(422);
    expect(unsent.body.error).toMatch(/not been uploaded/);
    expect(await s.put(author.key, second)).toBe(200);
    expect((await s.vault(editor.key, 'checkIn', { fileId: file.id, machine: 'ed-pc', hash: await hashOf(second), size: second.length, comment: 'Not mine' })).body.result).toMatchObject({ ok: false, reason: 'not-holder' });
    expect((await s.vault(author.key, 'checkIn', { fileId: file.id, machine: 'ann-pc', hash: await hashOf(second), size: second.length, comment: 'Revised' })).body.result).toMatchObject({ ok: true, version: 2 });

    // the editor sees version 2, reads its contents, and the history
    expect((await s.vault(editor.key, 'list')).body.result[0]).toMatchObject({ currentVersion: 2, lock: null });
    expect(await s.get(editor.key, second)).toEqual({ status: 200, text: second });
    expect((await s.vault(editor.key, 'versions', file.id)).body.result.map((v: { n: number }) => v.n)).toEqual([2, 1]);
  });

  it('an administrator forces a lock off: the holder’s late check-in is refused and the removal is waiting for their machine', async () => {
    const s = await server();
    const author = await s.join('author', 'Ann Author');
    const editor = await s.join('editor', 'Ed Editor');
    await addFile(s, author.key, 'ch1.md', 'v1');
    const f = (await s.vault(author.key, 'list')).body.result[0];
    await s.vault(author.key, 'checkOut', { fileId: f.id, machine: 'ann-pc' });
    // an Editor may not force; the owner may, and must say why
    expect((await s.vault(editor.key, 'forceRelease', { fileId: f.id, reason: 'I want it' })).status).toBe(403);
    expect((await s.vault(s.owner, 'forceRelease', { fileId: f.id, reason: '' })).body.result).toMatchObject({ ok: false, reason: 'reason-required' });
    expect((await s.vault(s.owner, 'forceRelease', { fileId: f.id, reason: 'Ann is on leave' })).body.result).toMatchObject({ ok: true });
    expect(await s.put(author.key, 'late work')).toBe(200);
    expect((await s.vault(author.key, 'checkIn', { fileId: f.id, machine: 'ann-pc', hash: await hashOf('late work'), size: 9, comment: '' })).body.result).toMatchObject({ ok: false, reason: 'not-holder' });
    const waiting = (await s.vault(author.key, 'orphans')).body.result;
    expect(waiting).toMatchObject([{ fileId: f.id, machine: 'ann-pc', reason: 'Ann is on leave' }]);
    await s.vault(author.key, 'acknowledgeOrphans', { fileId: f.id, machine: 'ann-pc' });
    expect((await s.vault(author.key, 'orphans')).body.result).toEqual([]);
  });

  it('a guest given one book sees that book’s files and nothing else, and cannot add any', async () => {
    const s = await server();
    expect((await s.send('PUT', '/v1/tree', s.owner, JSON.stringify(TREE))).status).toBe(200);
    await addFile(s, s.owner, 'b1/cover.psd', 'cover one', 'pB1');
    await addFile(s, s.owner, 'b2/cover.psd', 'cover two', 'pB2');
    await addFile(s, s.owner, 'studio/notes.md', 'studio-wide');
    const guest = await s.join('guest', 'Gus Guest', { projectId: 'pB1', days: 7 });
    expect(guest.status).toBe(200);
    const list = (await s.vault(guest.key, 'list')).body.result;
    expect(list.map((f: { path: string }) => f.path)).toEqual(['b1/cover.psd']);
    expect(await s.get(guest.key, 'cover one')).toMatchObject({ status: 200 });
    expect((await s.get(guest.key, 'cover two')).status).toBe(404);
    expect((await s.get(guest.key, 'studio-wide')).status).toBe(404);
    const other = (await s.vault(s.owner, 'list')).body.result.find((f: { path: string }) => f.path === 'b2/cover.psd');
    expect((await s.vault(guest.key, 'versions', other.id)).status).toBe(422); // absent, not forbidden: its existence is not given away
    expect((await s.vault(guest.key, 'checkOut', { fileId: other.id, machine: 'g' })).status).toBe(422);
    // a guest cannot write at all
    expect(await s.put(guest.key, 'x')).toBe(403);
    expect((await s.vault(guest.key, 'addFile', { path: 'b1/mine.md', hash: await hashOf('x'), size: 1, comment: '', machine: 'g', projectId: 'pB1' })).status).toBe(403);
    // the grant was for a week
    s.tick(8 * 24 * 60 * 60 * 1000);
    expect((await s.vault(guest.key, 'list')).body.result).toEqual([]);
  });

  it('a project-scoped author may add and change files on their project only', async () => {
    const s = await server();
    await s.send('PUT', '/v1/tree', s.owner, JSON.stringify(TREE));
    const lead = await s.join('author', 'Pat', { projectId: 'pB1' });
    expect((await addFile(s, lead.key, 'b1/ch1.md', 'one', 'pB1')).body.result).toMatchObject({ ok: true });
    expect((await addFile(s, lead.key, 'b2/ch1.md', 'two', 'pB2')).status).toBe(403);
    expect((await addFile(s, lead.key, 'loose.md', 'three')).status).toBe(403);
    expect((await s.vault(lead.key, 'list')).body.result.map((f: { path: string }) => f.path)).toEqual(['b1/ch1.md']);
  });

  it('stores contents by their hash, refuses contents that do not match it, and does not give a file to someone who may not read it', async () => {
    const s = await server();
    const author = await s.join('author', 'Ann');
    const wrong = await s.send('PUT', `/v1/blobs/${await hashOf('right')}`, author.key, enc.encode('wrong'));
    expect(wrong.status).toBe(400);
    expect(await s.put(author.key, 'right')).toBe(200);
    expect(await s.put(author.key, 'right')).toBe(200); // again: stored once
    expect(s.files.keys()).toHaveLength(1);
    // contents nobody's file has are not served
    expect((await s.get(author.key, 'right')).status).toBe(404);
    expect((await s.send('GET', '/v1/blobs/' + 'a'.repeat(64), s.owner)).status).toBe(404);
  });

  it('keeps references and data cards, and shows only the files a person may read', async () => {
    const s = await server();
    await s.send('PUT', '/v1/tree', s.owner, JSON.stringify(TREE));
    await addFile(s, s.owner, 'b1/cover.psd', 'psd', 'pB1');
    await addFile(s, s.owner, 'b1/cover.png', 'png', 'pB1');
    await addFile(s, s.owner, 'b2/secret.psd', 'secret', 'pB2');
    const all = (await s.vault(s.owner, 'list')).body.result as { id: string; path: string }[];
    const id = (p: string) => all.find((f) => f.path === p)!.id;
    await s.vault(s.owner, 'addReference', { fileId: id('b1/cover.png'), refersToId: id('b1/cover.psd') });
    await s.vault(s.owner, 'addReference', { fileId: id('b1/cover.png'), refersToId: id('b2/secret.psd') });
    expect((await s.vault(s.owner, 'references', id('b1/cover.png'))).body.result.map((r: { path: string }) => r.path).sort()).toEqual(['b1/cover.psd', 'b2/secret.psd']);
    const guest = await s.join('guest', 'Gus', { projectId: 'pB1' });
    expect((await s.vault(guest.key, 'references', id('b1/cover.png'))).body.result.map((r: { path: string }) => r.path)).toEqual(['b1/cover.psd']);
    expect((await s.vault(s.owner, 'setCard', { fileId: id('b1/cover.png'), fields: { artist: 'Dana' }, projectId: 'pB1' })).body.result).toMatchObject({ fields: { artist: 'Dana' } });
    expect((await s.vault(guest.key, 'card', id('b1/cover.png'))).body.result).toMatchObject({ fields: { artist: 'Dana' } });
  });
});
