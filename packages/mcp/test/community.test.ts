// The community-link tools through the composed server, against the same file Write keeps them in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { Studio, UserStore } from '@cadrel/studio';
import { CommunityStore } from '@cadrel/write/electron/communityStore';
import { createCadrelServer, studioModule } from '../src/index.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-community-mcp-'));
  file = path.join(dir, 'community-links.json');
});

async function connect(withFile = true) {
  const studio = new Studio(path.join(dir, 'studio.json'));
  const server = createCadrelServer({ modules: [studioModule({ studio, user: new UserStore(path.join(dir, 'user')), ...(withFile ? { communityLinks: file } : {}) })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = r.content[0]?.text ?? '';
    return { isError: !!r.isError, text, json: () => JSON.parse(text) };
  };
  return { client, call };
}

describe('community link tools', () => {
  it('are offered only where the Studio says where its links are kept', async () => {
    const without = await connect(false);
    expect((await without.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('community'))).toEqual([]);
    const withFile = await connect();
    expect((await withFile.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('community')).sort()).toEqual(['community_add_link', 'community_delete_link', 'community_links', 'community_update_link']);
  });

  it('add, list, update and delete, and what they do is what Write reads', async () => {
    const { call } = await connect();
    expect((await call('community_links')).json().links).toEqual([]);
    const added = (await call('community_add_link', { name: 'Reader Discord', url: 'discord.gg/readers' })).json();
    expect(added.added).toMatchObject({ name: 'Reader Discord', url: 'https://discord.gg/readers' });
    await call('community_add_link', { name: 'Facebook Group', url: 'https://www.facebook.com/groups/r' });
    expect((await call('community_links')).json().links.map((l: { name: string }) => l.name)).toEqual(['Reader Discord', 'Facebook Group']);

    const upd = await call('community_update_link', { link: 'reader discord', url: 'https://discord.gg/new' });
    expect(upd.json().updated).toMatchObject({ id: added.added.id, name: 'Reader Discord', url: 'https://discord.gg/new' });
    expect((await call('community_update_link', { link: 'Facebook', name: 'Readers on Facebook' })).json().updated.name).toBe('Readers on Facebook');

    // the app's own store reads what the assistant wrote, with no restart
    const app = new CommunityStore(file);
    expect((await app.list()).map((l) => l.url)).toEqual(['https://discord.gg/new', 'https://www.facebook.com/groups/r']);

    const del = await call('community_delete_link', { link: added.added.id });
    expect(del.json()).toMatchObject({ deleted: { name: 'Reader Discord' }, remaining: 1 });
    expect((await app.list()).map((l) => l.name)).toEqual(['Readers on Facebook']);
  });

  it('keeps the app’s view current when the assistant changes the file after the app has read it', async () => {
    const { call } = await connect();
    await call('community_add_link', { name: 'A', url: 'https://a.com' });
    const app = new CommunityStore(file);
    expect(await app.list()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20)); // a later modification time
    await call('community_add_link', { name: 'B', url: 'https://b.com' });
    expect((await app.list()).map((l) => l.name)).toEqual(['A', 'B']);
  });

  it('say what is wrong instead of failing: a bad address, a repeated name, an unknown link, nothing to change', async () => {
    const { call } = await connect();
    await call('community_add_link', { name: 'Discord', url: 'https://discord.gg/a' });
    expect(await call('community_add_link', { name: 'Bad', url: 'javascript:alert(1)' })).toMatchObject({ isError: true });
    expect((await call('community_add_link', { name: 'discord', url: 'https://x.com' })).text).toMatch(/already a community link/);
    expect((await call('community_update_link', { link: 'Nope', name: 'X' })).text).toMatch(/There is no community link "Nope"/);
    expect((await call('community_update_link', { link: 'Discord' })).text).toMatch(/Say what to change/);
    expect((await call('community_delete_link', { link: 'Nope' })).isError).toBe(true);
    expect((await call('community_links')).json().links).toHaveLength(1);
  });

  it('asks for an id when a name could mean two links', async () => {
    const { call } = await connect();
    await call('community_add_link', { name: 'Reader Discord', url: 'https://discord.gg/a' });
    await call('community_add_link', { name: 'Reader Facebook', url: 'https://facebook.com/groups/a' });
    expect((await call('community_delete_link', { link: 'Reader' })).text).toMatch(/More than one community link matches "Reader"/);
  });
});
