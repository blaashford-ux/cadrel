import { execFile } from 'node:child_process';

/**
 * The launcher inside Cadrel Market.mcpb. Claude Desktop runs it with its own Node and expects an answer to the MCP `initialize` request within a
 * fraction of a second, but the real server (the installed app's runtime loading the library) takes a few hundred milliseconds on a fast
 * computer and longer on a slow or busy one, and a server that is late is dropped as "couldn't start". So the launcher starts the server at
 * once, answers the handshake itself from what the server reported (`--print-handshake`), holds the client's other messages until the server
 * has finished starting, and then passes everything through. If the server dies, waiting requests get an error that says why, and what
 * happened is written to stderr (which Claude Desktop logs) and to a log file.
 */

export interface Handshake {
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  instructions: string;
  protocolVersions: string[];
}

export interface LauncherConfig {
  /** The product's name in log lines and error messages. Default "Cadrel Market". */
  label?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Null: no early answer (the launcher only passes stdio through). */
  handshake: Handshake | null;
  logFile: string | null;
  /** A file to watch: when its contents change the server is started again (the server reads its arguments from it; see mcp/src/active.ts). */
  followFile?: string;
}

// Plain JavaScript for Claude Desktop's Node: no dependencies, no template strings (this file's own template would swallow them).
const SOURCE = String.raw`'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = __CONFIG__;
const label = cfg.label || 'Cadrel Market';
const hs = cfg.handshake;
const HS_ID = '__cadrelMarket_initialize__';
const RE_ID = '__cadrelMarket_reinitialize__';
const started = Date.now();
// With a file to follow (the active Studio) the launcher reads messages by line, so it can start the server again and carry on the conversation.
const lineMode = !!hs || !!cfg.followFile;

function log(message) {
  console.error('[' + label + ' launcher] ' + message);
  if (!cfg.logFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    try { if (fs.statSync(cfg.logFile).size > 1000000) fs.truncateSync(cfg.logFile, 0); } catch (e) { /* no file yet */ }
    fs.appendFileSync(cfg.logFile, new Date().toISOString() + ' [pid ' + process.pid + '] ' + message + '\n');
  } catch (e) { /* the log is a convenience */ }
}

log('starting ' + cfg.command + ' ' + cfg.args.join(' ') + ' (' + (hs ? 'answering the handshake early' : 'passing stdio through') + (cfg.followFile ? ', following ' + cfg.followFile : '') + ')');

let child = null;
let gen = 0;
let ready = !hs;
let exited = false;
let stdinEnded = false;
let answered = false;
let initMsg = null;
let clientReady = false;
let restarting = false;
const queue = [];
const pending = new Set();
let stderrTail = '';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id: id, result: result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
const parse = (raw) => { try { return JSON.parse(raw); } catch (e) { return null; } };
const isRequest = (m) => !!m && typeof m === 'object' && !Array.isArray(m) && m.id !== undefined && typeof m.method === 'string';
const toChild = (raw) => {
  if (exited || !child.stdin.writable) return;
  if (lineMode) { const m = parse(raw); if (isRequest(m) && m.id !== HS_ID && m.id !== RE_ID) pending.add(m.id); }
  child.stdin.write(raw + '\n');
};

function flush() {
  while (queue.length) toChild(queue.shift());
  if (stdinEnded && !exited) child.stdin.end();
}

function lines(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
  };
}

const onServerLine = (line) => {
  const m = parse(line);
  if (m && m.id === HS_ID) {
    // the server's own answer to the initialize the launcher already answered for it
    if (m.error) log('the server refused initialize: ' + JSON.stringify(m.error));
    ready = true;
    log('the server is ready after ' + (Date.now() - started) + ' ms');
    flush();
    return;
  }
  if (m && m.id === RE_ID) {
    // the new server's answer to the replayed initialize: the client already has its answer, so this one is only the cue to carry on
    if (m.error) log('the new server refused initialize: ' + JSON.stringify(m.error));
    restarting = false;
    ready = true;
    if (clientReady) toChild(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    log('the new server is ready');
    if (clientReady) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    flush();
    return;
  }
  if (m && m.id !== undefined && !m.method) pending.delete(m.id);
  process.stdout.write(line + '\n');
};

function launch() {
  const mine = ++gen;
  exited = false;
  stderrTail = '';
  // arguments the client adds (an extension's settings, such as --root) go to the server after the fixed ones
  const c = spawn(cfg.command, cfg.args.concat(process.argv.slice(2)), { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, cfg.env), windowsHide: true });
  child = c;
  // without a handshake or a file to follow the launcher is a plain pipe; otherwise it reads messages by line
  if (lineMode) c.stdout.on('data', lines((l) => { if (mine === gen) onServerLine(l); }));
  else c.stdout.pipe(process.stdout);

  c.stderr.on('data', (d) => {
    process.stderr.write(d);
    if (mine === gen) stderrTail = (stderrTail + d.toString('utf8')).slice(-3000);
  });

  c.on('error', (e) => {
    log('could not start the server (' + e.message + '). Is ' + label + ' installed at ' + cfg.command + '? Install the extension again from ' + label + '.');
    process.exit(1);
  });

  c.on('exit', (code, sig) => {
    if (mine !== gen) return; // a server this launcher replaced on purpose
    exited = true;
    const why = 'exit code ' + code + (sig ? ', signal ' + sig : '');
    log('the server stopped (' + why + ') after ' + (Date.now() - started) + ' ms' + (stderrTail.trim() ? '; its last output: ' + stderrTail.trim().replace(/\s+/g, ' ').slice(-600) : '; it printed nothing'));
    // requests that were waiting for it get an answer instead of silence
    for (const raw of queue.splice(0)) {
      const m = parse(raw);
      if (isRequest(m)) fail(m.id, -32000, label + ' stopped before it could answer (' + why + '). ' + (cfg.logFile ? 'Details: ' + cfg.logFile : 'Open ' + label + ' and check it is running.'));
    }
    process.exit(code == null ? (sig ? 1 : 0) : code);
  });
}

launch();

function fromClient(line) {
  const m = parse(line);
  if (isRequest(m) && m.method === 'initialize') initMsg = m;
  if (m && m.method === 'notifications/initialized') clientReady = true;
  if (hs && isRequest(m) && m.method === 'initialize' && !answered) {
    answered = true;
    const asked = m.params && m.params.protocolVersion;
    const version = hs.protocolVersions.indexOf(asked) >= 0 ? asked : hs.protocolVersions[0];
    initMsg = Object.assign({}, m, { params: Object.assign({}, m.params, { protocolVersion: version }) });
    reply(m.id, { protocolVersion: version, capabilities: hs.capabilities, serverInfo: hs.serverInfo, instructions: hs.instructions });
    log('answered initialize after ' + (Date.now() - started) + ' ms');
    toChild(JSON.stringify({ jsonrpc: '2.0', id: HS_ID, method: 'initialize', params: initMsg.params }));
    return;
  }
  if (!ready && isRequest(m)) {
    if (m.method === 'ping') return reply(m.id, {});
    if (hs && m.method === 'server/discover') return fail(m.id, -32601, 'Method not found');
  }
  if (ready) toChild(line);
  else queue.push(line);
}

if (lineMode) {
  process.stdin.on('data', lines(fromClient));
  process.stdin.on('end', () => { stdinEnded = true; if (ready && !exited) child.stdin.end(); });
} else {
  process.stdin.pipe(child.stdin);
}

// Following a file: when it changes (Cadrel started in another Studio) the server is stopped and started again, which makes it read the new
// arguments; it is told what the client told the first one, so the client's connection carries on as if nothing happened.
function readFollowed() { try { return fs.readFileSync(cfg.followFile, 'utf8'); } catch (e) { return null; } }
let followed = cfg.followFile ? readFollowed() : null;
function restart() {
  const now = readFollowed();
  if (now === null || now === followed || stdinEnded) return;
  followed = now;
  log('the active Studio changed; starting the server again');
  const old = child;
  for (const id of pending) fail(id, -32000, label + ' switched Studio while this was running. Ask again.');
  pending.clear();
  restarting = true;
  launch(); // bumps the generation first, so the old server's exit is ignored
  try { old.kill(); } catch (e) { /* already gone */ }
  if (initMsg) {
    ready = false;
    child.stdin.write(JSON.stringify(Object.assign({}, initMsg, { id: RE_ID })) + '\n');
  } else {
    ready = !hs;
    restarting = false;
  }
}
if (cfg.followFile) {
  let timer = null;
  fs.watchFile(cfg.followFile, { interval: 1000, persistent: false }, () => { clearTimeout(timer); timer = setTimeout(restart, 300); });
}

for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => { if (!exited) child.kill(); });
// The server must never outlive this launcher (it holds the installed program's files open, and an update cannot replace them): when the client is
// gone give the server a moment to finish by itself, then stop it; and whenever this process leaves, take the server with it.
process.stdin.on('end', () => setTimeout(() => { if (!exited) { log('the client closed its connection; stopping the server'); child.kill(); } }, 3000).unref());
process.on('exit', () => { try { if (!exited) child.kill(); } catch (e) { /* already gone */ } });
setTimeout(() => { if (!ready && !exited) log('the server has not finished starting after 60 s'); }, 60000).unref();
`;

/** Ask an MCP server what it answers to `initialize` (it prints that and exits without opening anything). Null if it cannot say. */
export function readHandshake(c: { command: string; args: string[]; env: Record<string, string> }): Promise<Handshake | null> {
  return new Promise((resolve) => {
    execFile(c.command, [c.args[0] ?? '', '--print-handshake'], { env: { ...process.env, ...c.env }, timeout: 20000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const h = JSON.parse(stdout) as Handshake;
        const ok =
          typeof h?.serverInfo?.name === 'string' &&
          typeof h.serverInfo.version === 'string' &&
          typeof h.instructions === 'string' &&
          !!h.capabilities &&
          typeof h.capabilities === 'object' &&
          Array.isArray(h.protocolVersions) &&
          h.protocolVersions.length > 0;
        resolve(ok ? h : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export function launcherSource(cfg: LauncherConfig): string {
  return SOURCE.replace('__CONFIG__', () => JSON.stringify(cfg));
}
