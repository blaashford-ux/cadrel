// The composed server in-process: what it offers, that the two sides' tools both still work through it, and that a clash fails loudly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Library } from '@cadrel/market-library';
import { TOOLS as MARKET_TOOLS } from '@cadrel/market-mcp';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { capabilitiesOf, composeInstructions, createCadrelServer, writeModule, type McpModule } from '../src/index.js';
import { marketModule } from '../src/modules/market.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const BOOK = '# One\n\nShe walked slowly to the door.\n\n# Two\n\nThe river ran cold.\n';

const WRITE_TOOLS = ['add_notes', 'get_notes', 'list_chapters', 'list_files', 'list_projects', 'read_chapter', 'reply_to_note', 'search_text', 'set_chapters_edited', 'withdraw_note'];

let libRoot: string;
let lib: Library;

beforeAll(() => {
  libRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-mcp-'));
  lib = Library.open(libRoot);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-17T00:00:00Z' } as never);
});
afterAll(() => {
  lib?.close();
  fs.rmSync(libRoot, { recursive: true, force: true });
});

function memoryFs(): MemoryFs {
  const fs = new MemoryFs();
  fs.seed('/books/Novel/.mdedit/project.json', '{"status":"editing"}');
  fs.seed('/books/Novel/Book.md', BOOK);
  return fs;
}

async function connect(modules: McpModule[], clientName = 'claude-ai') {
  const server = createCadrelServer({ version: '9.9.9', modules });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    const text = r.content.find((c) => c.type === 'text')?.text ?? '';
    return { isError: !!r.isError, text, json: () => JSON.parse(text) };
  };
  return { server, client, call };
}

const both = (fs = memoryFs()) => [writeModule({ fs, root: '/books' }), marketModule({ lib, embedderFor: async () => null })];

describe('the Cadrel MCP server', () => {
  it('is one server, named cadrel, that says what each part is for', async () => {
    const { client } = await connect(both());
    expect(client.getServerVersion()).toMatchObject({ name: 'cadrel', version: '9.9.9' });
    const text = client.getInstructions() ?? '';
    expect(text).toContain('Cadrel is a book studio');
    expect(text).toContain('## Writing (manuscripts and review notes)');
    expect(text).toContain('read_chapter');
    expect(text).toContain('## Market research (the Amazon library)');
  });

  it('offers all of MDEdit\'s tools and all of BookScout\'s, each once', async () => {
    const { client } = await connect(both());
    const names = (await client.listTools()).tools.map((t) => t.name);
    const market = MARKET_TOOLS.map((t) => t.name);
    expect(market.length).toBeGreaterThanOrEqual(38);
    expect([...names].sort()).toEqual([...WRITE_TOOLS, ...market].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('the one name both apps used is now unambiguous: search_text stays MDEdit\'s, BookScout\'s is search_book_text', async () => {
    const { client } = await connect(both());
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'search_text')?.description).toMatch(/manuscript/i);
    expect(tools.find((t) => t.name === 'search_book_text')?.description).toMatch(/blurbs|reviews/i);
  });

  it('keeps MDEdit\'s tools and their read-only markings exactly', async () => {
    const { client } = await connect(both());
    const tools = (await client.listTools()).tools;
    for (const n of ['list_projects', 'list_files', 'list_chapters', 'read_chapter', 'search_text', 'get_notes']) expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).toBe(true);
    for (const n of ['add_notes', 'reply_to_note', 'set_chapters_edited']) expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).toBe(false);
    expect(tools.find((t) => t.name === 'withdraw_note')?.annotations?.destructiveHint).toBe(true);
  });

  it('writing tools work through it: read a chapter, leave a note signed with the connecting AI, manuscript untouched', async () => {
    const fs = memoryFs();
    const { call } = await connect(both(fs));
    expect((await call('list_projects')).json()).toEqual([{ project: 'Novel', status: 'editing' }]);
    expect((await call('read_chapter', { project: 'Novel', file: 'Book.md', chapter: 1 })).json().text).toBe('Two\nThe river ran cold.');
    const added = await call('add_notes', { project: 'Novel', skill: 'line', notes: [{ file: 'Book.md', kind: 'suggestion', quote: 'river ran cold', replacement: 'river ran icy' }] });
    expect(added.json()[0]).toMatchObject({ ok: true, chapter: 1 });
    expect((await call('get_notes', { project: 'Novel' })).json()).toMatchObject([{ kind: 'suggestion', reviewer: 'Claude · Line edit' }]);
    expect(await fs.readText('/books/Novel/Book.md')).toBe(BOOK);
  });

  it('market tools work through it, on the same connection', async () => {
    const { call } = await connect(both());
    const status = await call('library_status');
    expect(status.isError).toBe(false);
    expect(status.json()).toBeTruthy();
    expect((await call('list_categories')).isError).toBe(false);
  });

  it('prompts carry MDEdit\'s three editing skills', async () => {
    const { client } = await connect(both());
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['copy_edit', 'developmental_edit', 'line_edit']);
  });

  it('serves just the part that exists', async () => {
    const w = await connect([writeModule({ fs: memoryFs(), root: '/books' })]);
    expect((await w.client.listTools()).tools.map((t) => t.name).sort()).toEqual(WRITE_TOOLS);
    const m = await connect([marketModule({ lib, embedderFor: async () => null })]);
    const names = (await m.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('read_chapter');
    expect(names).toContain('top_books');
    expect(m.client.getInstructions()).not.toContain('Writing (manuscripts');
  });

  it('a module that reuses another module\'s tool name fails at start-up, not at call time', () => {
    const clash: McpModule = {
      id: 'notes',
      title: 'Notes',
      instructions: 'x',
      register: (server: McpServer) => server.registerTool('read_chapter', { description: 'a clash', inputSchema: { id: z.string() } }, async () => ({ content: [] }))
    };
    expect(() => createCadrelServer({ modules: [writeModule({ fs: memoryFs(), root: '/books' }), clash] })).toThrow(/read_chapter/);
  });

  it('advertises prompts only when a module has them', () => {
    expect(capabilitiesOf([])).toEqual({ tools: { listChanged: true } });
    expect(capabilitiesOf([writeModule({ fs: memoryFs(), root: '/books' })])).toEqual({ tools: { listChanged: true }, prompts: { listChanged: true } });
  });

  it('says plainly when there is nothing to serve', () => {
    expect(composeInstructions([])).toContain('no tools yet');
  });
});
