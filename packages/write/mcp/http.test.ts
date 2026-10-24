import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../src/shared/memoryFs';
import { startHttp, tokenMatches } from './http';

const TOKEN = 'test-token-0123456789abcdef';
const BOOK = '# One\n\nShe walked slowly to the door.\n\n# Two\n\nThe river ran cold.\n';
let fs: MemoryFs;
let srv: Awaited<ReturnType<typeof startHttp>>;
let base: string;

beforeEach(async () => {
  fs = new MemoryFs();
  fs.seed('/books/Novel/.mdedit/project.json', '{"status":"editing"}');
  fs.seed('/books/Novel/Book.md', BOOK);
  srv = await startHttp({ fs, root: '/books', token: TOKEN, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
});
afterEach(() => srv.close());

const auth = { authorization: `Bearer ${TOKEN}` };
const get = (p: string, headers: Record<string, string> = auth) => fetch(base + p, { headers });
const post = (p: string, body: unknown, headers: Record<string, string> = auth) => fetch(base + p, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('access', () => {
  it('listens on this PC only, and refuses weak tokens', async () => {
    expect(srv.host).toBe('127.0.0.1');
    await expect(startHttp({ fs, root: '/books', token: 'short', port: 0 })).rejects.toThrow(/at least 16/);
  });

  it('needs the token for everything except health and the API description', async () => {
    expect((await get('/health', {})).status).toBe(200);
    expect((await get('/openapi.json', {})).status).toBe(200);
    for (const [method, p] of [['GET', '/api/projects'], ['POST', '/mcp'], ['GET', '/api/projects/Novel/notes']] as const) {
      const r = await fetch(base + p, { method });
      expect(r.status, p).toBe(401);
    }
    expect((await get('/api/projects', { authorization: 'Bearer wrong-token-0123456789' })).status).toBe(401);
    expect((await get('/api/projects', { authorization: TOKEN })).status).toBe(401); // not a Bearer header
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(await fs.readText('/books/Novel/Book.md')).toBe(BOOK);
  });

  it('turns bad requests into messages, and big or broken bodies away', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await get('/api/projects/Nope/files')).status).toBe(400);
    const r = await get('/api/projects/Novel/chapter?file=Book.md');
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/"chapter" parameter is required/);
    expect((await fetch(base + '/api/projects/Novel/notes', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{oops' })).status).toBe(400);
    expect((await fetch(base + '/api/projects/Novel/notes', { method: 'POST', headers: auth, body: 'x'.repeat(1_100_000) })).status).toBe(413);
    expect((await fetch(base + '/mcp', { headers: auth })).status).toBe(400); // no session
    const lost = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth, 'mcp-session-id': 'gone', accept: 'application/json, text/event-stream' });
    expect(lost.status).toBe(400);
  });
});

describe('hostile requests', () => {
  it('gives a web page on another site nothing: no CORS, no token in the URL, no preflight approval', async () => {
    const pre = await fetch(base + '/api/projects', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    expect(pre.status).toBe(401);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${base}/api/projects?token=${TOKEN}&access_token=${TOKEN}`)).status).toBe(401);
    expect((await get('/api/projects')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('cannot be steered outside the project through the REST routes', async () => {
    for (const p of ['..', '%2E%2E', 'Novel%2F..%2F..', '.mdedit', 'Novel%5C..']) expect([400, 404], p).toContain((await get(`/api/projects/${p}/files`)).status); // refused, never 200
    for (const file of ['../Other.md', '/etc/passwd', 'a%2F..%2F..%2Fb.md', '.mdedit/project.json']) expect([400, 404], file).toContain((await get(`/api/projects/Novel/chapters?file=${file}`)).status);
    const r = await post('/api/projects/Novel/notes', { notes: [{ file: '../../x.md', kind: 'comment', quote: 'a', body: 'b' }] });
    expect((await r.json())[0]).toMatchObject({ ok: false });
  });
});

describe('REST', () => {
  it('reads, then adds, replies to and withdraws notes', async () => {
    expect(await (await get('/api/projects')).json()).toEqual([{ project: 'Novel', status: 'editing' }]);
    expect((await (await get('/api/projects/Novel/files')).json())[0]).toMatchObject({ file: 'Book.md', chapters: 2 });
    expect((await (await get('/api/projects/Novel/chapters?file=Book.md')).json()).chapters.map((c: { title: string }) => c.title)).toEqual(['One', 'Two']);
    expect((await (await get('/api/projects/Novel/chapter?file=Book.md&chapter=1')).json()).text).toBe('Two\nThe river ran cold.');
    expect((await (await get('/api/projects/Novel/chapter?file=Book.md&chapter=One')).json()).index).toBe(0);
    expect((await (await get('/api/projects/Novel/search?query=RIVER')).json()).hits).toHaveLength(1);

    const added = await (await post('/api/projects/Novel/notes', { skill: 'Line edit', notes: [{ file: 'Book.md', kind: 'suggestion', quote: 'walked slowly', replacement: 'crept' }, { file: 'Book.md', kind: 'comment', quote: 'absent', body: 'x' }] })).json();
    expect(added.map((n: { ok: boolean }) => n.ok)).toEqual([true, false]);
    const notes = await (await get('/api/projects/Novel/notes?kind=suggestion')).json();
    expect(notes).toMatchObject([{ reviewer: 'GPT · Line edit', replacement: 'crept' }]); // REST callers are GPT unless they say otherwise
    const id = notes[0].id;
    expect((await post(`/api/projects/Novel/notes/${id}/replies`, { body: 'Because it is quieter.' })).status).toBe(200);
    expect((await get('/api/projects/Novel/notes')).status).toBe(200);
    expect((await fetch(`${base}/api/projects/Novel/notes/${id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect(await (await get('/api/projects/Novel/notes')).json()).toEqual([]);
    expect(await fs.readText('/books/Novel/Book.md')).toBe(BOOK);
  });

  it('names the caller from the x-mdedit-agent header', async () => {
    await post('/api/projects/Novel/notes', { notes: [{ file: 'Book.md', kind: 'comment', quote: 'river', body: 'Cold how?' }] }, { ...auth, 'x-mdedit-agent': 'claude' });
    expect((await (await get('/api/projects/Novel/notes')).json())[0].reviewer).toBe('Claude');
  });
});

describe('the API description', () => {
  it('points at wherever the caller reached us, and covers every route', async () => {
    const doc = await (await fetch(base + '/openapi.json', { headers: { 'x-forwarded-host': 'abc.example.com', 'x-forwarded-proto': 'https' } })).json();
    expect(doc.servers).toEqual([{ url: 'https://abc.example.com' }]);
    expect(doc.openapi).toBe('3.1.0');
    const ids = Object.values(doc.paths as Record<string, Record<string, { operationId: string; description: string }>>).flatMap((p) => Object.values(p));
    expect(ids.map((o) => o.operationId).sort()).toEqual(['addNotes', 'getNotes', 'listChapters', 'listFiles', 'listProjects', 'readChapter', 'replyToNote', 'searchText', 'setChaptersEdited', 'withdrawNote']);
    for (const o of ids) expect(o.description.length, o.operationId).toBeLessThanOrEqual(300); // Custom GPT Actions limit
    expect(doc.security).toEqual([{ bearer: [] }]);
  });
});

describe('MCP over HTTP', () => {
  it('serves the same tools to a client that sends the token', async () => {
    const client = new Client({ name: 'openai-mcp', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: auth } }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('add_notes');
    const r = (await client.callTool({ name: 'add_notes', arguments: { project: 'Novel', skill: 'Copy edit', notes: [{ file: 'Book.md', kind: 'comment', quote: 'slowly', body: 'Adverb.' }] } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0].text)[0].ok).toBe(true);
    expect((await (await get('/api/projects/Novel/notes')).json())[0].reviewer).toBe('GPT · Copy edit');
    await client.close();
  });

  it('refuses a client without the token', async () => {
    const client = new Client({ name: 'x', version: '1' });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')))).rejects.toThrow();
  });
});
