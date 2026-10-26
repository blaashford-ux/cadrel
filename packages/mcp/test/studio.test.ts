// The studio tools through the composed server: projects, links and notes across modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { Studio, UserStore } from '@cadrel/studio';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { createCadrelServer, studioModule, writeModule } from '../src/index.js';

const NAMES = ['studio_user', 'studio_user_file', 'studio_add_note', 'studio_create_project', 'studio_link', 'studio_notes', 'studio_projects', 'studio_update_note', 'studio_update_project'];

let studio: Studio;
let user: UserStore;
let mem: MemoryFs;
beforeEach(() => {
  studio = new Studio(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-studio-mcp-')), 'studio.json'));
  user = new UserStore(path.join(path.dirname(studio.file), 'user'));
  mem = new MemoryFs();
  mem.seed('/books/DR1/.cadrel/project.json', '{"status":"editing"}');
  mem.seed('/books/DR1/Book.md', '# One\n\nShe walked slowly to the door.\n');
});

async function connect(clientName = 'claude-ai') {
  const server = createCadrelServer({ modules: [studioModule({ studio, user, write: { fs: mem, root: '/books' } }), writeModule({ fs: mem, root: '/books' })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = r.content[0]?.text ?? '';
    return { isError: !!r.isError, text, json: () => JSON.parse(text) };
  };
  return { client, call };
}

describe('studio tools', () => {
  it('studio_user gives the assistant the person’s name, pen names and bio, never email or files', async () => {
    const { call } = await connect();
    await user.update({ displayName: 'Blake Ashford', email: 'blake@example.com', penNames: ['Ashe Wilder'], bio: 'Writes fantasy.' });
    const r = await call('studio_user');
    expect(r.json()).toEqual({ name: 'Blake Ashford', penNames: ['Ashe Wilder'], about: 'Writes fantasy.', files: [] });
    expect(r.text).not.toContain('blake@example.com');
  });

  it('the assistant sees the attached files and can open them; the person can hide any file, one by one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-att-'));
    const bio = path.join(dir, 'Author bio.md');
    const secret = path.join(dir, 'Tax form.txt');
    const pic = path.join(dir, 'me.png');
    fs.writeFileSync(bio, '# Blake\nWrites fantasy about dragons.');
    fs.writeFileSync(secret, 'SSN 000');
    fs.writeFileSync(pic, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const a = await user.attach(bio, 'Short bio for covers');
    const s = await user.attach(secret, 'Tax');
    await user.attach(pic);
    await user.attach(path.join(dir, 'Author bio.md'));
    const { call, client } = await connect('claude-ai');

    const listed = (await call('studio_user')).json().files as { id: string; name: string; for: string | null }[];
    expect(listed.map((f) => f.name)).toEqual(['Author bio.md', 'Tax form.txt', 'me.png', 'Author bio.md']);
    expect(listed[0]).toMatchObject({ for: 'Short bio for covers', addedBy: 'the person' });

    // reading text, an image, and what cannot be read
    expect((await call('studio_user_file', { id: a.id })).text).toContain('Writes fantasy about dragons.');
    const img = (await client.callTool({ name: 'studio_user_file', arguments: { id: listed[2]!.id } })) as { content: { type: string }[] };
    expect(img.content[0]!.type).toBe('image');

    // every read is recorded for the person to see
    const reads = (await user.read()).assistantReads;
    expect(reads.map((r) => [r.name, r.by])).toEqual([['Author bio.md', 'Claude'], ['me.png', 'Claude']]);

    // one file hidden from the assistant: it is gone from the list and cannot be opened by id
    await user.editAttachment(s.id, { assistant: false });
    expect(((await call('studio_user')).json().files as { name: string }[]).map((f) => f.name)).not.toContain('Tax form.txt');
    const denied = await call('studio_user_file', { id: s.id });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/no such file/);

    // hiding every file leaves the assistant with the profile only: no list, nothing to open, and nothing logged
    for (const f of (await user.read()).attachments) await user.editAttachment(f.id, { assistant: false });
    const none = (await call('studio_user')).json();
    expect(none.files).toEqual([]);
    expect(JSON.stringify(none)).not.toContain('Author bio');
    expect((await call('studio_user_file', { id: a.id })).isError).toBe(true);
    expect((await user.read()).assistantReads).toHaveLength(2);

    // and one file shown again is the only one it sees
    await user.editAttachment(a.id, { assistant: true });
    expect(((await call('studio_user')).json().files as { id: string }[]).map((f) => f.id)).toEqual([a.id]);
  });

  it('sit beside Write’s tools without clashing', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of NAMES) expect(names).toContain(n);
    expect(names).toContain('add_notes');
    expect(new Set(names).size).toBe(names.length);
  });

  it('builds a Series with Books and shows the tree with links', async () => {
    const { call } = await connect();
    expect((await call('studio_projects')).json().message).toMatch(/No projects yet/);
    const s = (await call('studio_create_project', { name: 'Dragon Rider', kind: 'Series' })).json();
    const b = (await call('studio_create_project', { name: 'Book 1', parent: 'Dragon Rider', kind: 'Book' })).json();
    expect(b.path).toBe('Dragon Rider / Book 1');
    await call('studio_link', { module: 'write', record: 'DR1', project: 'Dragon Rider / Book 1' });
    await call('studio_link', { module: 'market', record: 'epic-fantasy', project: s.id });
    const tree = (await call('studio_projects')).json().projects;
    expect(tree.map((p: { name: string; depth: number }) => [p.name, p.depth])).toEqual([['Dragon Rider', 0], ['Book 1', 1]]);
    expect(tree[1].links).toEqual([{ module: 'write', record: 'DR1' }]);
    // one branch
    expect((await call('studio_projects', { project: 'Book 1' })).json().projects).toHaveLength(1);
  });

  it('renames, moves, archives; refuses mistakes with a message instead of crashing', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'A' });
    await call('studio_create_project', { name: 'B' });
    expect((await call('studio_update_project', { project: 'B', parent: 'A', name: 'B2' })).json().path).toBe('A / B2');
    const loop = await call('studio_update_project', { project: 'A', parent: 'B2' });
    expect(loop.isError).toBe(true);
    expect(loop.text).toMatch(/into itself/);
    expect((await call('studio_update_project', { project: 'nope', name: 'x' })).text).toMatch(/There is no project "nope"/);
    expect((await call('studio_update_project', { project: 'A', archived: true })).json().status).toBe('archived');
    expect((await call('studio_projects')).json().message).toMatch(/No projects/);
    expect((await call('studio_projects', { include_archived: true })).json().projects).toHaveLength(2);
  });

  it('ambiguous names ask for a fuller path', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'S1' });
    await call('studio_create_project', { name: 'S2' });
    await call('studio_create_project', { name: 'Book 1', parent: 'S1' });
    await call('studio_create_project', { name: 'Book 1', parent: 'S2' });
    const r = await call('studio_projects', { project: 'Book 1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/matches 2 projects/);
    expect((await call('studio_projects', { project: 'S2 / Book 1' })).json().projects).toHaveLength(1);
  });

  it('there is no way to delete a project', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.some((t) => /delete|remove/.test(t.name))).toBe(false);
  });

  it('notes: the AI leaves one on a linked record; it is labelled as AI and appears with the manuscript’s notes', async () => {
    const { call } = await connect('claude-ai');
    await call('studio_create_project', { name: 'Book 1' });
    await call('studio_link', { module: 'market', record: 'epic-fantasy', project: 'Book 1' });
    await call('studio_link', { module: 'write', record: 'DR1', project: 'Book 1' });
    const n = (await call('studio_add_note', { body: 'Prices are climbing here.', module: 'market', kind: 'category', record: 'epic-fantasy', label: 'Epic fantasy', topic: 'Pricing' })).json();
    expect(n).toMatchObject({ project: 'Book 1', by: 'Claude (AI)', topic: 'pricing', status: 'open', on: { module: 'market', id: 'epic-fantasy' } });
    await call('add_notes', { project: 'DR1', notes: [{ file: 'Book.md', kind: 'comment', quote: 'walked slowly', body: 'Stronger verb?' }] });

    const all = (await call('studio_notes')).json();
    expect(all.total).toBe(2);
    expect(all.notes.map((x: { on: { module: string } }) => x.on.module).sort()).toEqual(['market', 'write']);
    expect(all.notes.find((x: { on: { module: string } }) => x.on.module === 'write').project).toBe('Book 1');
    expect((await call('studio_notes', { module: 'market' })).json().total).toBe(1);
    expect((await call('studio_notes', { project: 'Book 1', origin: 'ai' })).json().total).toBe(1);
  });

  it('notes on a project include its subprojects; replying and resolving work; manuscript notes are redirected', async () => {
    const { call } = await connect();
    await call('studio_create_project', { name: 'Series' });
    await call('studio_create_project', { name: 'Book 1', parent: 'Series' });
    const n = (await call('studio_add_note', { body: 'Check timeline.', project: 'Series / Book 1' })).json();
    expect((await call('studio_notes', { project: 'Series' })).json().total).toBe(1);
    expect((await call('studio_add_note', { body: 'Nothing to attach to.' })).isError).toBe(true);
    expect((await call('studio_add_note', { body: 'x', record: 'r1' })).text).toMatch(/needs the module/);
    await call('studio_update_note', { id: n.id, reply: 'Done in chapter 3.', status: 'resolved' });
    expect((await call('studio_notes', { status: 'resolved' })).json().notes[0].replies).toEqual([{ by: 'Claude', body: 'Done in chapter 3.' }]);
    expect((await call('studio_notes')).json().total).toBe(0);
    expect((await call('studio_update_note', { id: 'write:DR1:x', status: 'resolved' })).text).toMatch(/reply_to_note/);
  });
});
