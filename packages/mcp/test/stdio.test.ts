// The real built bundle as a child process, the way Claude Desktop / Claude Code launch it, and over HTTP.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Library } from '@cadrel/market-library';

const PKG = path.resolve(__dirname, '..');
const BUNDLE = path.join(PKG, 'dist', 'mcp.mjs');
const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const VERSION = fs.readFileSync(path.join(PKG, '..', '..', 'VERSION'), 'utf8').trim();

let tmp: string;
let projects: string;
let library: string;
/** An environment in which neither app's settings can be found, so only the flags decide what is served. */
let cleanEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-mcp-e2e-'));
  projects = path.join(tmp, 'books');
  fs.mkdirSync(path.join(projects, 'Novel', '.mdedit'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'Novel', '.mdedit', 'project.json'), '{"status":"drafting"}');
  fs.writeFileSync(path.join(projects, 'Novel', 'Book.md'), '# One\n\nShe walked slowly to the door.\n\n# Two\n\nThe river ran cold.\n');
  library = path.join(tmp, 'library');
  const lib = Library.open(library);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-17T00:00:00Z' } as never);
  lib.close();
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  cleanEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config'), MDEDIT_ROOT: '', BOOKSCOUT_LIBRARY: '' };
}, 90_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(process.execPath, [BUNDLE, ...args], { env: cleanEnv, encoding: 'utf8', timeout: 30_000 });

async function connect(args: string[]) {
  const client = new Client({ name: 'claude-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE, ...args], env: cleanEnv as Record<string, string>, stderr: 'pipe' }));
  return client;
}
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

describe('the Cadrel MCP bundle over stdio', () => {
  it('serves both modules from one process when given both folders', async () => {
    const client = await connect(['--root', projects, '--library', library]);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'cadrel', version: VERSION });
      const tools = await names(client);
      expect(tools).toEqual(expect.arrayContaining(['read_chapter', 'add_notes', 'search_text', 'top_books', 'search_book_text', 'library_status']));
      const r = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(r.content[0]!.text)).toEqual([{ project: 'Novel', status: 'drafting' }]);
      const m = (await client.callTool({ name: 'list_categories', arguments: {} })) as { isError?: boolean };
      expect(m.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 60_000);

  it('serves only the writing tools when there is no library', async () => {
    const client = await connect(['--root', projects]);
    try {
      const tools = await names(client);
      expect(tools).toContain('read_chapter');
      expect(tools).not.toContain('top_books');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('serves only the market tools when there is no projects folder', async () => {
    const client = await connect(['--root', path.join(tmp, 'nowhere'), '--library', library]);
    try {
      const tools = await names(client);
      expect(tools).not.toContain('read_chapter');
      expect(tools).toContain('top_books');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('with neither folder it still serves the studio’s projects and notes, from the studio file it is given', async () => {
    const studio = path.join(tmp, 'only-studio', 'studio.json');
    const client = await connect(['--root', path.join(tmp, 'nowhere'), '--library', path.join(tmp, 'no-library'), '--studio', studio]);
    try {
      const tools = await names(client);
      expect(tools).toContain('studio_projects');
      expect(tools).not.toContain('read_chapter');
      const made = (await client.callTool({ name: 'studio_create_project', arguments: { name: 'Dragon Rider', kind: 'Series' } })) as { content: { text: string }[] };
      expect(JSON.parse(made.content[0]!.text)).toMatchObject({ name: 'Dragon Rider', kind: 'Series' });
      // and it is on disk where the app will look
      expect(JSON.parse(fs.readFileSync(studio, 'utf8')).tree.projects).toHaveLength(1);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('--print-handshake answers `initialize` without opening anything, for the Claude Desktop launcher', () => {
    const r = run(['--root', projects, '--library', library, '--print-handshake']);
    expect(r.status).toBe(0);
    const h = JSON.parse(r.stdout);
    expect(h.serverInfo).toEqual({ name: 'cadrel', version: VERSION });
    expect(h.capabilities).toMatchObject({ tools: {}, prompts: {} });
    expect(h.instructions).toContain('Writing (manuscripts');
    expect(h.instructions).toContain('Market research');
    expect(h.protocolVersions.length).toBeGreaterThan(0);
    // and it does not claim a part that is not there
    const w = JSON.parse(run(['--root', projects, '--print-handshake']).stdout);
    expect(w.instructions).not.toContain('Market research');
  });
});

describe('the Cadrel MCP bundle over HTTP', () => {
  const request = (port: number, method: string, url: string, token?: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });

  /** Starts the server on a free port and resolves with the port once it says it is ready. */
  function start(extra: string[]): Promise<{ port: number; stop(): void }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BUNDLE, '--http', '--port', '0', '--token', 'test-token-0123456789abcdef', '--root', projects, '--library', library, ...extra], { env: cleanEnv, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr!.on('data', (d) => {
        err += d;
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(err);
        if (m) resolve({ port: Number(m[1]), stop: () => child.kill() });
      });
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
      setTimeout(() => reject(new Error('did not start: ' + err)), 20_000).unref();
    });
  }

  it('needs the token, serves the writing REST API, and leaves the market library out unless asked', async () => {
    const s = await start([]);
    try {
      expect((await request(s.port, 'GET', '/health')).status).toBe(200);
      expect((await request(s.port, 'GET', '/api/projects')).status).toBe(401);
      const projectsOut = await request(s.port, 'GET', '/api/projects', 'test-token-0123456789abcdef');
      expect(projectsOut.status).toBe(200);
      const init = await request(s.port, 'POST', '/mcp', 'test-token-0123456789abcdef', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-test', version: '0' } } });
      expect(init.status).toBe(200);
      expect(init.json.result.serverInfo.name).toBe('cadrel');
      expect(init.json.result.instructions).not.toContain('Market research');
    } finally {
      s.stop();
    }
  }, 60_000);

  it('serves the market tools over HTTP only with --with-market', async () => {
    const s = await start(['--with-market']);
    try {
      const init = await request(s.port, 'POST', '/mcp', 'test-token-0123456789abcdef', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-test', version: '0' } } });
      expect(init.json.result.instructions).toContain('Market research');
    } finally {
      s.stop();
    }
  }, 60_000);
});
