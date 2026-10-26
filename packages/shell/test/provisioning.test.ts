// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, generateKeyPair, STUDIO_API_VERSION, STUDIO_SCHEMA_VERSION } from '@cadrel/kernel';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio, Cloudflare, CloudflareError, namesFor, upgradeStudio } from '../src/main/cloudflare';
import { Secrets, SecretsError } from '../src/main/secrets';
import { joinStudio, StudioApiError, StudioClient } from '../src/main/studioClient';

const build = async (over: Partial<Parameters<typeof buildStudio>[1]> = {}) => {
  const key = await generateKeyPair();
  return { key, b: { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: key.publicKey, workerSource: '// the studio server', ...over } };
};
const fast = { sleep: async () => undefined };

describe('building a Studio in Cloudflare', () => {
  it('makes a database, a file store and a Worker of its own, tells the Worker who owns it, and finds the Studio answering', async () => {
    const cf = fakeCloudflare();
    const { key, b } = await build();
    const steps: string[] = [];
    const built = await buildStudio({ fetchFn: cf.fetchFn, step: (t) => steps.push(t), ...fast }, b);
    const n = namesFor('sabc123def4');
    expect(n.worker).toBe('cadrel-studio-sabc123def4');
    expect(built.url).toBe(`https://${n.worker}.me.workers.dev`);
    expect(built.resources).toEqual({ worker: n.worker, d1Id: 'uuid-1', d1Name: n.d1, bucket: n.bucket });
    expect(built.server).toEqual({ api: STUDIO_API_VERSION, schema: STUDIO_SCHEMA_VERSION });
    expect([...cf.buckets]).toEqual([n.bucket]);
    expect(cf.workers.get(n.worker)!.bindings).toEqual(expect.arrayContaining([{ type: 'd1', name: 'DB', id: 'uuid-1' }, { type: 'r2_bucket', name: 'FILES', bucket_name: n.bucket }, { type: 'plain_text', name: 'OWNER_KEY', text: key.publicKey }]));
    expect(steps).toEqual(expect.arrayContaining([expect.stringMatching(/database/), expect.stringMatching(/file store/), expect.stringMatching(/server/)]));
    // the Studio is the owner's: its server says whose key it holds
    const info = (await (await cf.fetchFn(`${built.url}/v1/info`)).json()) as { ownerFingerprint: string };
    expect(info.ownerFingerprint).toBe(await fingerprint(key.publicKey));
  });

  it('pressing Provision again after a stop finishes the job and makes nothing twice', async () => {
    const cf = fakeCloudflare();
    const { b } = await build();
    await buildStudio({ fetchFn: cf.fetchFn, ...fast }, b);
    const first = cf.calls.length;
    await buildStudio({ fetchFn: cf.fetchFn, ...fast }, b);
    expect(cf.db.size).toBe(1);
    expect(cf.buckets.size).toBe(1);
    expect(cf.calls.slice(first).filter((c) => c.startsWith('POST /client/v4/accounts/A/d1') || c.startsWith('POST /client/v4/accounts/A/r2'))).toEqual([]);
  });

  it('says in words what went wrong, and never repeats the token', async () => {
    const { b } = await build();
    await expect(buildStudio({ fetchFn: fakeCloudflare({ allowedToken: 'something-else-entirely' }).fetchFn, ...fast }, b)).rejects.toThrow(/did not accept that API token/);
    await expect(buildStudio({ fetchFn: fakeCloudflare({ subdomain: null }).fetchFn, ...fast }, b)).rejects.toThrow(/Workers & Pages/);
    await expect(buildStudio({ fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, ...fast }, b)).rejects.toThrow(/Could not reach Cloudflare/);
    const failing = (async () => new Response(JSON.stringify({ success: false, result: null, errors: [{ message: 'boom' }] }), { status: 500 })) as unknown as typeof fetch;
    const e = await buildStudio({ fetchFn: failing, ...fast }, b).catch((x: Error) => x);
    expect(e).toBeInstanceOf(CloudflareError);
    expect((e as Error).message).not.toContain(TOKEN);
    expect((e as Error).message).not.toContain(ACCOUNT);
  });

  it('refuses a Studio that answers as someone else', async () => {
    const cf = fakeCloudflare();
    const { b } = await build();
    const other = await generateKeyPair();
    await buildStudio({ fetchFn: cf.fetchFn, ...fast }, b);
    await expect(buildStudio({ fetchFn: cf.fetchFn, ...fast }, { ...b, ownerKey: other.publicKey })).resolves.toBeTruthy(); // uploading replaces it: the new key is what the Worker now holds
    const cfx = new Cloudflare({ fetchFn: cf.fetchFn, ...fast }, TOKEN);
    await expect(cfx.waitUntilAnswering(`https://${namesFor('sabc123def4').worker}.me.workers.dev`, 'AAAA-AAAA-AAAA-AAAA', 2)).rejects.toThrow(/different Studio/);
  });

  it('upgrades by uploading again, and never takes a Studio backwards', async () => {
    const cf = fakeCloudflare();
    const { b } = await build();
    const built = await buildStudio({ fetchFn: cf.fetchFn, ...fast }, b);
    const upgraded = await upgradeStudio({ fetchFn: cf.fetchFn, ...fast }, { ...b, workerSource: '// newer' }, { url: built.url, resources: built.resources });
    expect(upgraded.url).toBe(built.url);
    expect(cf.workers.get(built.resources.worker)!.source).toBe('// newer');
    // a Studio ahead of this app is left alone
    const ahead = (async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith('/v1/info') ? Response.json({ apiVersion: STUDIO_API_VERSION, schemaVersion: STUDIO_SCHEMA_VERSION + 5, ownerFingerprint: 'x' }) : cf.fetchFn(input, init))) as unknown as typeof fetch;
    await expect(upgradeStudio({ fetchFn: ahead, ...fast }, b, { url: built.url, resources: built.resources })).rejects.toThrow(/newer than this version of Cadrel/);
    await expect(upgradeStudio({ fetchFn: cf.fetchFn, ...fast }, b, { url: null, resources: null })).rejects.toThrow(/never fully built/);
  });
});

describe('inviting and joining, against the real Studio server', () => {
  it('an owner invites, someone joins from the link and is a member, and the owner can see and remove them', async () => {
    const cf = fakeCloudflare();
    const { key, b } = await build();
    const built = await buildStudio({ fetchFn: cf.fetchFn, ...fast }, b);
    const owner = new StudioClient({ url: built.url, key, fetchFn: cf.fetchFn });

    const { link } = await owner.invite('author', 'Alice', 'Acme Books');
    expect(link).toMatch(/^cadrel:\/\/join\?/);
    expect((await owner.people()).invites).toMatchObject([{ role: 'author', label: 'Alice' }]);

    const joined = await joinStudio({ link, yourName: 'Alice Author', fetchFn: cf.fetchFn });
    expect(joined).toMatchObject({ url: built.url, role: 'author', studioName: 'Acme Books', fingerprint: await fingerprint(key.publicKey) });
    const alice = new StudioClient({ url: built.url, key: joined.key, fetchFn: cf.fetchFn });
    expect(await alice.me()).toMatchObject({ kind: 'member', role: 'author', name: 'Alice Author' });
    await expect(alice.people()).rejects.toThrow(/Only the Studio’s owner/);

    const { members, invites } = await owner.people();
    expect(invites).toEqual([]);
    expect(members).toMatchObject([{ name: 'Alice Author', role: 'author' }]);
    await owner.removeMember(members[0]!.id);
    await expect(alice.me()).rejects.toThrow(/not a member/);
  });

  it('refuses a link that is not one, a code used twice, and a Studio that is not the owner the link names', async () => {
    const cf = fakeCloudflare();
    const { key, b } = await build();
    const built = await buildStudio({ fetchFn: cf.fetchFn, ...fast }, b);
    const owner = new StudioClient({ url: built.url, key, fetchFn: cf.fetchFn });
    const { link } = await owner.invite('editor', '', 'Acme');
    await expect(joinStudio({ link: 'https://example.com', yourName: 'A', fetchFn: cf.fetchFn })).rejects.toThrow(/not a Cadrel invitation/);
    await joinStudio({ link, yourName: 'First', fetchFn: cf.fetchFn });
    await expect(joinStudio({ link, yourName: 'Second', fetchFn: cf.fetchFn })).rejects.toThrow(StudioApiError);
    // the same address answering as another owner is refused before anything is sent
    const forged = link.replace(/f=[^&]+/, 'f=0000-0000-0000-0000');
    const sent: string[] = [];
    const spy = (async (i: string | URL | Request, init?: RequestInit) => (sent.push(`${init?.method ?? 'GET'} ${new URL(String(i)).pathname}`), cf.fetchFn(i, init))) as unknown as typeof fetch;
    await expect(joinStudio({ link: forged, yourName: 'X', fetchFn: spy })).rejects.toThrow(/does not belong to the owner/);
    expect(sent).toEqual(['GET /v1/info']);
  });
});

describe('secrets', () => {
  const cipher = { available: () => true, encrypt: (s: string) => Buffer.from(s.split('').reverse().join('')), decrypt: (b: Buffer) => b.toString().split('').reverse().join('') };

  it('keeps a secret encrypted, reads it back, and forgets it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-secrets-'));
    const s = new Secrets(dir, cipher);
    await s.put('cf-token', TOKEN);
    expect(await s.get('cf-token')).toBe(TOKEN);
    expect(await readFile(path.join(dir, 'cf-token.bin'), 'utf8')).not.toContain(TOKEN);
    await s.delete('cf-token');
    expect(await s.get('cf-token')).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps nothing when there is no secure store, unless it is a test', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-secrets-'));
    const none = { ...cipher, available: () => false };
    await expect(new Secrets(dir, none).put('k', 'v')).rejects.toThrow(SecretsError);
    const t = new Secrets(dir, none, true);
    await t.put('k', 'v');
    expect(await t.get('k')).toBe('v');
    expect(await new Secrets(dir, none).get('k')).toBeNull(); // a plain file is never trusted outside a test
    await expect(t.put('../escape', 'v')).rejects.toThrow(/name a secret/);
  });
});
