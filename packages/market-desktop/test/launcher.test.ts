import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launcherSource, type Handshake } from '../src/main/launcher.js';

const HS: Handshake = {
  serverInfo: { name: 'cadrel-market', version: '9.9.9' },
  capabilities: { tools: { listChanged: true } },
  instructions: 'Be careful with text fields.',
  protocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-launch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A stand-in MCP server that starts slowly (it reads nothing for `bootMs`), then answers like the real one, or dies. */
function fakeServer(o: { bootMs: number; dieWith?: number; refuseInit?: boolean }): string {
  const f = path.join(dir, 'server.cjs');
  fs.writeFileSync(f, `
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    setTimeout(() => {
      ${o.dieWith !== undefined ? `console.error('boom: could not open the library'); process.exit(${o.dieWith});` : ''}
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = JSON.parse(line);
          if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'real-server' } } });
          else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'library_status' }] } });
          else if (m.method === 'server/discover') send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'real server: not found' } });
          else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: { echoed: m.method } });
        }
      });
      process.stdin.on('end', () => process.exit(0));
    }, ${o.bootMs});
  `);
  return f;
}

function start(server: string, handshake: Handshake | null = HS) {
  const file = path.join(dir, 'launch.js');
  const logFile = path.join(dir, 'logs', 'mcp-launcher.log');
  fs.writeFileSync(file, launcherSource({ command: process.execPath, args: [server], env: { X: '1' }, handshake, logFile }));
  const p = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out: { at: number; msg: any }[] = [];
  const t0 = Date.now();
  let buf = '';
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { out.push({ at: Date.now() - t0, msg: JSON.parse(buf.slice(0, i)) }); buf = buf.slice(i + 1); }
  });
  let err = '';
  p.stderr.on('data', (c) => (err += c));
  const send = (m: unknown) => p.stdin.write(JSON.stringify(m) + '\n');
  const exited = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
  const until = async (pred: () => boolean, ms = 8000) => { const s = Date.now(); while (!pred()) { if (Date.now() - s > ms) throw new Error('timed out; got ' + JSON.stringify(out) + ' stderr ' + err); await new Promise((r) => setTimeout(r, 20)); } };
  return { p, out, send, exited, until, err: () => err, logFile };
}
const init = (id: number, version = '2025-06-18') => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'claude', version: '1' } } });

describe('the extension launcher', () => {
  it('answers initialize at once while the server is still starting, then passes the rest through once it is ready', async () => {
    const L = start(fakeServer({ bootMs: 1500 }));
    L.send(init(0));
    await L.until(() => L.out.length >= 1);
    expect(L.out[0]!.at).toBeLessThan(1000); // well before the server could have answered
    expect(L.out[0]!.msg).toMatchObject({ id: 0, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'cadrel-market', version: '9.9.9' }, capabilities: { tools: { listChanged: true } }, instructions: 'Be careful with text fields.' } });
    // the client carries on straight away: these wait for the server
    L.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    L.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    L.send({ jsonrpc: '2.0', id: 2, method: 'ping' }); // answered by the launcher, no waiting
    await L.until(() => L.out.some((o) => o.msg.id === 2));
    expect(L.out.find((o) => o.msg.id === 2)!.at).toBeLessThan(1000);
    await L.until(() => L.out.some((o) => o.msg.id === 1));
    expect(L.out.find((o) => o.msg.id === 1)!.msg).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'library_status' }] } });
    expect(L.out.find((o) => o.msg.id === 1)!.at).toBeGreaterThan(1200);
    // the client got exactly one answer to its initialize (the server's own is swallowed)
    expect(L.out.filter((o) => o.msg.id === 0)).toHaveLength(1);
    expect(L.out.some((o) => o.msg.serverInfo?.name === 'real-server')).toBe(false);
    L.p.stdin.end();
    expect(await L.exited).toBe(0);
    const log = fs.readFileSync(L.logFile, 'utf8');
    expect(log).toMatch(/answered initialize after \d+ ms/);
    expect(log).toMatch(/the server is ready after \d+ ms/);
  });

  it('negotiates a protocol version the server knows, and refuses the discover probe at once', async () => {
    const L = start(fakeServer({ bootMs: 800 }));
    L.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: {} }); // a probe before initialize
    await L.until(() => L.out.length >= 1);
    expect(L.out[0]!.msg).toMatchObject({ id: 'd', error: { code: -32601 } });
    L.send(init(1, '2031-01-01')); // newer than anything known: the newest known is offered
    await L.until(() => L.out.length >= 2);
    expect(L.out[1]!.msg.result.protocolVersion).toBe('2025-11-25');
    L.p.stdin.end();
    await L.exited;
  });

  it('tells waiting requests why when the server dies while starting, and exits with its code', async () => {
    const L = start(fakeServer({ bootMs: 300, dieWith: 3 }));
    L.send(init(0));
    L.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(await L.exited).toBe(3);
    const failed = L.out.find((o) => o.msg.id === 7)!.msg;
    expect(failed.error.message).toMatch(/Cadrel Market stopped before it could answer \(exit code 3\)/);
    expect(failed.error.message).toContain('mcp-launcher.log');
    const log = fs.readFileSync(L.logFile, 'utf8');
    expect(log).toMatch(/the server stopped \(exit code 3\).*boom: could not open the library/);
    expect(L.err()).toMatch(/boom: could not open the library/); // also in stderr, where Claude Desktop logs it
  });

  it('says so when the server cannot be started at all', async () => {
    const file = path.join(dir, 'launch.js');
    fs.writeFileSync(file, launcherSource({ command: path.join(dir, 'no-such-program'), args: [], env: {}, handshake: HS, logFile: null }));
    const p = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    const code = await new Promise((r) => p.on('close', r));
    expect(code).toBe(1);
    expect(err).toMatch(/could not start the server .*Install the extension again/);
  });

  it('only passes stdio through when there is no handshake to answer from', async () => {
    const L = start(fakeServer({ bootMs: 100 }), null);
    L.send(init(0));
    await L.until(() => L.out.length >= 1);
    expect(L.out[0]!.msg).toMatchObject({ id: 0, result: { serverInfo: { name: 'real-server' } } }); // the server's own answer
    L.p.stdin.end();
    expect(await L.exited).toBe(0);
  });

  it('closes the server\'s input when the client goes away, even before the server was ready', async () => {
    const L = start(fakeServer({ bootMs: 600 }));
    L.send(init(0));
    L.p.stdin.end(); // the client left immediately
    expect(await L.exited).toBe(0);
  });
});
