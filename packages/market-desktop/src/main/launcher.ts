/**
 * The launcher inside BookScout.mcpb. Claude Desktop runs it with its own Node and expects an answer to the MCP `initialize` request within a
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
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Null: no early answer (the launcher only passes stdio through). */
  handshake: Handshake | null;
  logFile: string | null;
}

// Plain JavaScript for Claude Desktop's Node: no dependencies, no template strings (this file's own template would swallow them).
const SOURCE = String.raw`'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = __CONFIG__;
const hs = cfg.handshake;
const HS_ID = '__bookscout_initialize__';
const started = Date.now();

function log(message) {
  console.error('[BookScout launcher] ' + message);
  if (!cfg.logFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    try { if (fs.statSync(cfg.logFile).size > 1000000) fs.truncateSync(cfg.logFile, 0); } catch (e) { /* no file yet */ }
    fs.appendFileSync(cfg.logFile, new Date().toISOString() + ' [pid ' + process.pid + '] ' + message + '\n');
  } catch (e) { /* the log is a convenience */ }
}

log('starting ' + cfg.command + ' (' + (hs ? 'answering the handshake early' : 'passing stdio through') + ')');
const child = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, cfg.env), windowsHide: true });

let ready = !hs;
let exited = false;
let stdinEnded = false;
let answered = false;
const queue = [];
let stderrTail = '';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id: id, result: result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
const toChild = (raw) => { if (!exited && child.stdin.writable) child.stdin.write(raw + '\n'); };

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
  let m = null;
  try { m = JSON.parse(line); } catch (e) { /* not JSON: pass it on */ }
  if (m && m.id === HS_ID) {
    // the server's own answer to the initialize the launcher already answered for it
    if (m.error) log('the server refused initialize: ' + JSON.stringify(m.error));
    ready = true;
    log('the server is ready after ' + (Date.now() - started) + ' ms');
    flush();
    return;
  }
  process.stdout.write(line + '\n');
};
// without a handshake the launcher is a plain pipe; with one it reads messages by line
if (hs) child.stdout.on('data', lines(onServerLine));
else child.stdout.pipe(process.stdout);

child.stderr.on('data', (d) => {
  process.stderr.write(d);
  stderrTail = (stderrTail + d.toString('utf8')).slice(-3000);
});

child.on('error', (e) => {
  log('could not start the server (' + e.message + '). Is BookScout installed at ' + cfg.command + '? Install the extension again from BookScout > Settings.');
  process.exit(1);
});

child.on('exit', (code, sig) => {
  exited = true;
  const why = 'exit code ' + code + (sig ? ', signal ' + sig : '');
  log('the server stopped (' + why + ') after ' + (Date.now() - started) + ' ms' + (stderrTail.trim() ? '; its last output: ' + stderrTail.trim().replace(/\s+/g, ' ').slice(-600) : '; it printed nothing'));
  // requests that were waiting for it get an answer instead of silence
  for (const raw of queue.splice(0)) {
    let m = null;
    try { m = JSON.parse(raw); } catch (e) { /* skip */ }
    if (m && m.id !== undefined && m.method) fail(m.id, -32000, 'BookScout stopped before it could answer (' + why + '). ' + (cfg.logFile ? 'Details: ' + cfg.logFile : 'Open BookScout and check it is running.'));
  }
  process.exit(code == null ? (sig ? 1 : 0) : code);
});

function fromClient(line) {
  let m = null;
  try { m = JSON.parse(line); } catch (e) { /* not JSON: leave it to the server */ }
  const isRequest = m && typeof m === 'object' && !Array.isArray(m) && m.id !== undefined && typeof m.method === 'string';
  if (hs && isRequest && m.method === 'initialize' && !answered) {
    answered = true;
    const asked = m.params && m.params.protocolVersion;
    const version = hs.protocolVersions.indexOf(asked) >= 0 ? asked : hs.protocolVersions[0];
    reply(m.id, { protocolVersion: version, capabilities: hs.capabilities, serverInfo: hs.serverInfo, instructions: hs.instructions });
    log('answered initialize after ' + (Date.now() - started) + ' ms');
    toChild(JSON.stringify({ jsonrpc: '2.0', id: HS_ID, method: 'initialize', params: Object.assign({}, m.params, { protocolVersion: version }) }));
    return;
  }
  if (hs && !ready && isRequest) {
    if (m.method === 'ping') return reply(m.id, {});
    if (m.method === 'server/discover') return fail(m.id, -32601, 'Method not found');
  }
  if (ready) toChild(line);
  else queue.push(line);
}

if (hs) {
  process.stdin.on('data', lines(fromClient));
  process.stdin.on('end', () => { stdinEnded = true; if (ready && !exited) child.stdin.end(); });
} else {
  process.stdin.pipe(child.stdin);
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { if (!exited) child.kill(s); });
setTimeout(() => { if (!ready && !exited) log('the server has not finished starting after 60 s'); }, 60000).unref();
`;

export function launcherSource(cfg: LauncherConfig): string {
  return SOURCE.replace('__CONFIG__', () => JSON.stringify(cfg));
}
