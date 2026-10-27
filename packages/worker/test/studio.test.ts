import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, generateKeyPair, signRequest, STUDIO_SCHEMA_VERSION, type KeyPair } from '@cadrel/kernel';
import worker, { type Env } from '../src/index';
import { MIGRATIONS } from '../src/migrations';
import { fakeD1 } from './d1fake';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

async function studio() {
  const owner = await generateKeyPair();
  const env: Env = { ENVIRONMENT: 'studio', DB: fakeD1(), FILES: { head: async () => null } as unknown as R2Bucket, STUDIO_ID: 'st1', OWNER_KEY: owner.publicKey };
  let now = 1_700_000_000_000;
  const call = async (method: string, path: string, key: KeyPair | null, body?: unknown) => {
    vi.setSystemTime(now); // the Worker reads the clock itself
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = key ? { ...(await signRequest({ method, path, body: text, key, now })) } : {};
    now += 1;
    const r = await worker.fetch(new Request(`https://studio.test${path}`, { method, headers, ...(text ? { body: text } : {}) }), env);
    return { status: r.status, body: (await r.json()) as Record<string, any>, replay: () => (vi.setSystemTime(now), worker.fetch(new Request(`https://studio.test${path}`, { method, headers, ...(text ? { body: text } : {}) }), env)) };
  };
  return { owner, env, call, tick: (ms: number) => (now += ms) };
}

describe('the Studio server', () => {
  it('keeps the migrations in the worker identical to the files Wrangler applies', () => {
    ['0001_vault.sql', '0002_studio.sql', '0003_catalogue.sql', '0004_people_roles.sql', '0005_workflow.sql', '0006_workflow_levels.sql', '0007_work.sql', '0008_book_project.sql', '0009_file_links.sql'].forEach((f, i) => expect(MIGRATIONS[i]).toBe(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')));
  });

  it('reports a schema version equal to the number of migrations', () => {
    expect(MIGRATIONS.length).toBe(STUDIO_SCHEMA_VERSION);
  });

  it('tells anyone which Studio it is and who owns it, builds its own database, and serves health', async () => {
    const { owner, call, env } = await studio();
    const info = await call('GET', '/v1/info', null);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ studioId: 'st1', ownerFingerprint: await fingerprint(owner.publicKey), apiVersion: 1, schemaVersion: 9 });
    const health = await worker.fetch(new Request('https://studio.test/v1/health'), env);
    expect(health.status).toBe(200);
  });

  it('lets the owner invite someone, who joins once with the code and is then a member; the code works only once', async () => {
    const { owner, call } = await studio();
    const alice = await generateKeyPair();
    const inv = await call('POST', '/v1/invites', owner, { role: 'author', label: 'Alice' });
    expect(inv.status).toBe(201);
    expect(inv.body.code).toMatch(/^[\w-]{22}$/);
    expect((await call('GET', '/v1/invites', owner)).body.invites).toHaveLength(1);

    const joined = await call('POST', '/v1/join', alice, { code: inv.body.code, name: 'Alice Author' });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ role: 'author', studioId: 'st1' });
    expect((await call('GET', '/v1/me', alice)).body).toMatchObject({ kind: 'member', role: 'author', name: 'Alice Author' });
    expect((await call('GET', '/v1/invites', owner)).body.invites).toHaveLength(0);
    expect((await call('GET', '/v1/members', owner)).body.members).toMatchObject([{ name: 'Alice Author', role: 'author', revokedAt: null }]);

    const bob = await generateKeyPair();
    const again = await call('POST', '/v1/join', bob, { code: inv.body.code, name: 'Bob' });
    expect(again.status).toBe(410);
    expect((await call('GET', '/v1/me', bob)).status).toBe(403);
  });

  it('only the owner administers: members and strangers cannot invite, list or remove', async () => {
    const { owner, call } = await studio();
    const alice = await generateKeyPair();
    const stranger = await generateKeyPair();
    const code = (await call('POST', '/v1/invites', owner, { role: 'editor', label: '' })).body.code;
    await call('POST', '/v1/join', alice, { code, name: 'Alice' });
    for (const [m, p, b] of [['POST', '/v1/invites', { role: 'author' }], ['GET', '/v1/members'], ['GET', '/v1/invites']] as const) {
      expect((await call(m, p, alice, b)).status).toBe(403);
      expect((await call(m, p, stranger, b)).status).toBe(403);
      expect((await call(m, p, null, b)).status).toBe(401);
    }
    expect((await call('POST', '/v1/invites', owner, { role: 'owner' })).status).toBe(400); // there is only one Owner
  });

  it('revoking a member shuts them out for good, and they cannot rejoin with the same key', async () => {
    const { owner, call } = await studio();
    const alice = await generateKeyPair();
    const first = (await call('POST', '/v1/invites', owner, { role: 'guest', label: '' })).body.code;
    const id = (await call('POST', '/v1/join', alice, { code: first, name: 'Alice' })).body.memberId;
    expect((await call('DELETE', `/v1/members/${id}`, owner)).status).toBe(200);
    expect((await call('GET', '/v1/me', alice)).status).toBe(403);
    const second = (await call('POST', '/v1/invites', owner, { role: 'guest', label: '' })).body.code;
    expect((await call('POST', '/v1/join', alice, { code: second, name: 'Alice' })).status).toBe(403);
    // and the second code was not burned by the refused attempt
    expect((await call('GET', '/v1/invites', owner)).body.invites).toHaveLength(1);
    expect((await call('DELETE', '/v1/members/nope', owner)).status).toBe(404);
  });

  it('refuses an expired invitation, a replayed request and a request signed long ago', async () => {
    const { owner, call, tick } = await studio();
    const alice = await generateKeyPair();
    const made = await call('POST', '/v1/invites', owner, { role: 'author', label: '' });
    const replay = await made.replay();
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toMatch(/already received/);
    tick(8 * 24 * 60 * 60 * 1000);
    const late = await call('POST', '/v1/join', alice, { code: made.body.code, name: 'Alice' });
    expect(late.status).toBe(410);
    expect(late.body.error).toMatch(/expired/);
  });

  it('a Worker with no owner key (a hand-deployed one) serves health only', async () => {
    const env: Env = { ENVIRONMENT: 'dev', DB: fakeD1(), FILES: { head: async () => null } as unknown as R2Bucket };
    expect((await worker.fetch(new Request('https://x.test/v1/info'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://x.test/v1/health'), env)).status).toBe(200);
  });
});
