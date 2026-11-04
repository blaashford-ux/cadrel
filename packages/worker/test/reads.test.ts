import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, signRequest, type KeyPair } from '@cadrel/kernel';
import { decodeValue, encodeValue } from '@cadrel/service';
import worker, { type Env } from '../src/index';
import { fakeD1 } from './d1fake';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

/** The fake database, counting the statements that read the permission tables (D1 bills every row those return). */
async function server() {
  const owner = await generateKeyPair();
  const inner = fakeD1();
  const seen: string[] = [];
  const DB = {
    prepare: (sql: string) => (seen.push(sql), inner.prepare(sql)),
    batch: (s: unknown[]) => inner.batch(s as never)
  } as unknown as D1Database;
  const env: Env = { ENVIRONMENT: 'studio', DB, FILES: { head: async () => null } as unknown as R2Bucket, STUDIO_ID: 'st1', OWNER_KEY: owner.publicKey };
  let now = 1_800_000_000_000;
  const send = async (method: string, path: string, key: KeyPair, body = '') => {
    vi.setSystemTime(now);
    const headers = { ...(await signRequest({ method, path, body, key, now })) };
    now += 1;
    return worker.fetch(new Request(`https://studio.test${path}`, { method, headers, ...(body ? { body } : {}) }), env);
  };
  const call = async (key: KeyPair, path: string[], ...args: unknown[]) => {
    const r = await send('POST', '/v1/call', key, encodeValue({ path, args }));
    return { status: r.status, body: decodeValue(await r.text()) as Record<string, any> };
  };
  const version = async (key: KeyPair) => (await (await send('GET', '/v1/version', key)).json()) as { data: string; access: string };
  const loads = () => seen.filter((q) => /FROM role_capability/.test(q)).length;
  const join = async (role: string, name: string) => {
    const key = await generateKeyPair();
    const inv = (await (await send('POST', '/v1/invites', owner, JSON.stringify({ role, label: name }))).json()) as { code: string };
    await send('POST', '/v1/join', key, JSON.stringify({ code: inv.code, name }));
    return key;
  };
  return { owner, call, version, loads, join };
}

describe('what the Studio server reads', () => {
  it('loads who holds what once, however many calls are made, until it changes', async () => {
    const s = await server();
    await s.call(s.owner, ['catalogue', 'books']); // the first call loads it
    const first = s.loads();
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) expect((await s.call(s.owner, ['catalogue', 'books'])).status).toBe(200);
    expect(s.loads()).toBe(first);
  });

  it('is never behind a change to who may do what', async () => {
    const s = await server();
    const ann = await s.join('author', 'Ann Author');
    expect((await s.call(ann, ['people', 'roles'])).status).toBe(403); // an author does not manage people
    const me = (await s.call(s.owner, ['people', 'list'])).body.result.find((p: { name: string }) => p.name === 'Ann Author');
    const loadsBefore = s.loads();
    const granted = await s.call(s.owner, ['people', 'grant'], { subject: { kind: 'person', id: me.id }, roleId: 'role_admin', scope: { kind: 'studio', id: 'st1' } });
    expect(granted.status).toBe(200);
    expect((await s.call(ann, ['people', 'roles'])).status).toBe(200); // at once, not after some time
    expect(s.loads()).toBeGreaterThan(loadsBefore);
    await s.call(s.owner, ['people', 'revoke'], granted.body.result.id);
    expect((await s.call(ann, ['people', 'roles'])).status).toBe(403);
  });

  it('says what changed: the data counter moves on any change, the access counter only when permissions change', async () => {
    const s = await server();
    await s.call(s.owner, ['catalogue', 'books']);
    const a = await s.version(s.owner);
    await s.call(s.owner, ['catalogue', 'books']);
    expect(await s.version(s.owner)).toEqual(a); // reading changes nothing
    await s.call(s.owner, ['catalogue', 'createIp'], { name: 'Dragon Rider' });
    const b = await s.version(s.owner);
    expect(b.data).not.toBe(a.data);
    expect(b.access).toBe(a.access);
    await s.call(s.owner, ['people', 'createTeam'], 'Editors');
    const c = await s.version(s.owner);
    expect(c.data).not.toBe(b.data);
    expect(c.access).not.toBe(b.access);
  });

  it('refuses the version to someone who is not in the Studio', async () => {
    const s = await server();
    expect((await s.version(await generateKeyPair())) as unknown).toMatchObject({ error: expect.any(String) });
  });
});
