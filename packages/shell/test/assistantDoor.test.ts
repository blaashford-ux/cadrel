// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
//
// The assistant on a Studio whose records are on its server (docs/GAPS-PLAN.md, slice A). The assistant's own process never holds the device key: it
// asks the app's local door, which signs and forwards. Here the door is real, the Studio is the real Worker code in the stand-in Cloudflare, and the
// assistant's tools are the real MCP modules, used as an Editor, as an Author and as someone whose role does not include the assistant.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair } from '@cadrel/kernel';
import { LocalVault, DirBlobs, type BlobStore } from '@cadrel/store';
import { DoorClient } from '@cadrel/studio-client';
import { createCadrelServer } from '../../mcp/src/server';
import { editorialModule } from '../../mcp/src/modules/editorial';
import { recordsModule } from '../../mcp/src/modules/records';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';
import { AssistantDoor } from '../src/main/assistantDoor';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-door-'));
  dirs.push(d);
  return d;
};

const PROJECT = 'pBook';
const T = '2026-01-01T00:00:00.000Z';
const TREE = { projects: [{ id: PROJECT, name: 'Lead Me', parentId: null, kind: 'Book', status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: T, updatedAt: T }], links: [] } as never;
const BOOK = 'Mara left the village at dawn.\n\nNobody saw her go, which was the point.\n\nShe crossed the ford and slept in a barn.';

async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  const fetchFn = cf.fetchFn as typeof fetch;
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn, now });
  const person = async (role: string, name: string) => {
    const { link } = await owner.invite(role, name, 'Acme', { projectId: PROJECT, days: 60 });
    const j = await joinStudio({ link, yourName: name, fetchFn });
    return new StudioClient({ url: built.url, key: j.key, fetchFn, now });
  };
  return { owner, person, advance: () => (clock.t += 10_000) };
}

/** The assistant's tools for one person, reached through the door and nothing else. */
async function assistantFor(door: AssistantDoor, personId: string) {
  const client = new DoorClient({ url: door.url!, token: door.token, fetchFn: fetch });
  const service = remoteService(client);
  const blobs: BlobStore = { put: () => Promise.reject(new Error('no')), has: async (h) => (await client.getBlob(h)) !== null, get: (h) => client.getBlob(h) };
  const vault = new RemoteVaultStore(client);
  const studioStub = { read: async () => ({ tree: TREE }) } as never;
  const server = createCadrelServer({ modules: [recordsModule({ service, personId, studio: studioStub, studioId: 'sabc123def4', vault }), editorialModule({ service, personId, studio: studioStub, vault, blobs })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content[0]!.text };
  };
}

describe('the assistant on a Studio whose records are on its server', () => {
  it('reads the pinned version and raises an item as the Editor, through the app’s door; the Author cannot raise; the key never leaves the app', async () => {
    const s = await studio();
    await s.owner.publishTree(TREE);
    const eveClient = await s.person('editor', 'Eve Editor');
    const annClient = await s.person('author', 'Ann Author');
    const eve = remoteService(eveClient).as('x');

    // the manuscript is in the vault, and the Editor has a pass in progress on its first version
    const root = await tmp();
    const store = new OfflineAwareStore(new RemoteVaultStore(s.owner), path.join(root, 'cache.json'));
    const vault = new LocalVault({ store, blobs: new RemoteBlobs(s.owner, new DirBlobs(path.join(root, 'blobs'))), dir: path.join(root, 'work'), personId: (await s.owner.me()).personId, machine: 'owner-pc' });
    await (await import('node:fs/promises')).mkdir(path.join(root, 'work'), { recursive: true });
    await writeFile(path.join(root, 'work', 'book.md'), BOOK);
    await vault.add('book.md', 'First draft');
    await vault.setCard('book.md', {}, PROJECT);
    const fileId = (await vault.status('book.md')).fileId!;
    const eveId = (await eveClient.me()).personId;
    const pass = await eve.passes.create({ projectId: PROJECT, kind: 'line', fileId, editorId: eveId });
    await eve.passes.start(pass.id);
    s.advance();

    // the door, as the app runs it: the Editor's client behind it
    let target: StudioClient | null = eveClient;
    const door = new AssistantDoor(() => target);
    await door.start();
    try {
      const asEve = await assistantFor(door, eveId);

      // the assistant lists the Editor's pass, reads the exact pinned text, and raises a query on a quote from it
      expect(JSON.parse((await asEve('edit_passes', { mine: true })).text)).toMatchObject([{ id: pass.id, state: 'in_progress', file: 'book.md' }]);
      const read = await asEve('edit_read', { pass: pass.id });
      expect(read.error).toBe(false);
      expect(read.text).toContain('Nobody saw her go, which was the point.');
      const raised = await asEve('edit_raise', { pass: pass.id, items: [{ kind: 'query', text: 'Why does nobody see her?', quote: 'Nobody saw her go' }] });
      expect(raised.error).toBe(false);
      s.advance();
      expect((await eve.queries.list({ passId: pass.id })).map((q) => q.body)).toEqual(['Why does nobody see her?']);

      // a refusal from the Studio arrives through the door as the same kind of error, with its reason: this Editor holds a role on one book, not the whole vault
      const files = await asEve('files_list', {});
      expect(files).toMatchObject({ error: true });
      expect(files.text).toMatch(/not allowed.*manuscript\.read/);

      // the Studio's administrators turn the assistant off: its tools refuse for the Editor too, whatever their role holds, and work again when it is back on
      const owner = remoteService(s.owner).as('x');
      await owner.policy.set({ assistantEnabled: false });
      s.advance();
      const off = await asEve('edit_passes', { mine: true });
      expect(off).toMatchObject({ error: true });
      expect(off.text).toMatch(/turned the assistant off/);
      await owner.policy.set({ assistantEnabled: true });
      s.advance();
      expect((await asEve('edit_passes', { mine: true })).error).toBe(false);

      // the Author, through the same kind of door, can read the pass but not raise on it, and the assistant cannot answer or decide at all
      target = annClient;
      const annId = (await annClient.me()).personId;
      const asAnn = await assistantFor(door, annId);
      const refused = await asAnn('edit_raise', { pass: pass.id, items: [{ kind: 'comment', text: 'Hi' }] });
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/not allowed|editor|cannot|in progress/i);
    } finally {
      await door.stop();
    }
  });

  it('the door is shut to anyone without the token, to a browser page, and to anything the assistant may not do', async () => {
    const s = await studio();
    const calls: string[] = [];
    const fake = { rpc: async (p: string[]) => (calls.push(p.join('.')), 'ok'), vault: async (m: string) => (calls.push(`vault.${m}`), []), getBlob: async () => null } as never;
    const door = new AssistantDoor(() => fake);
    await door.start();
    try {
      const url = door.url!;
      const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'x-cadrel-door': door.token, ...headers }, body: JSON.stringify(body) });
      expect((await fetch(`${url}/call`, { method: 'POST', body: '{}' })).status).toBe(403); // no token
      expect((await post('/call', { path: ['passes', 'list'], args: [] }, { 'x-cadrel-door': 'wrong' })).status).toBe(403);
      expect((await post('/call', { path: ['passes', 'list'], args: [] }, { origin: 'https://evil.example' })).status).toBe(403); // a web page
      expect((await post('/call', { path: ['passes', 'list'], args: [] })).status).toBe(200);
      expect((await post('/call', { path: ['secrets', 'all'], args: [] })).status).toBe(400); // not a namespace the Studio has
      expect((await post('/call', { path: ['constructor'], args: [] })).status).toBe(400);
      expect((await post('/vault', { method: 'checkIn', args: [{}] })).status).toBe(400); // the assistant only reads the vault
      expect((await post('/vault', { method: 'list', args: [] })).status).toBe(200);
      expect((await fetch(`${url}/blob/not-a-hash`, { headers: { 'x-cadrel-door': door.token } })).status).toBe(400);
      expect(calls).toEqual(['passes.list', 'vault.list']);
    } finally {
      await door.stop();
    }
    expect(door.url).toBeNull();
    void s;
  });
});
