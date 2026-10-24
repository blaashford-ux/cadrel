#!/usr/bin/env node
/**
 * Starts the Cadrel MCP server. An MCP client (Claude Desktop, Claude Code, Codex, ...) launches this as a subprocess over stdio:
 *   node mcp.mjs [--root <projects folder>] [--library <market library>] [--agent <name>]
 * With --http it listens on this PC instead (MCP at /mcp, REST at /api for the writing tools, behind a token):
 *   node mcp.mjs --http [--port 47831] [--token <secret>] [--with-market]
 * Each part is optional: with no projects folder only the market tools are served, and with no library (or one that will
 * not open) only the writing tools. The bundle needs Cadrel's own runtime, which carries Market's native modules (the
 * Claude Desktop extension starts that runtime through its launcher). Over stdio nothing but protocol messages may go to
 * stdout; diagnostics go to stderr.
 */
import { randomBytes } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { nodeFs } from '@cadrel/write/electron/nodeFs';
import { startHttp } from '@cadrel/write/mcp/http';
import { chooseRoot, rootCandidates } from '@cadrel/write/mcp/root';
import { listProjects } from '@cadrel/write/src/shared/agent/tools';
import type { ServerOptions as WriteOptions } from '@cadrel/write/mcp/server';
import { resolveLibraryRoot } from '@cadrel/market-mcp/src/config.js';
import { capabilitiesOf, composeInstructions, createCadrelServer, SERVER_NAME, type McpModule } from './server.js';
import { writeModule } from './modules/write.js';
import { studioModule } from './modules/studio.js';
import { Studio, studioFile } from '@cadrel/studio';

const VERSION = process.env.CADREL_VERSION || '0.0.0';

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
}

const say = (m: string) => process.stderr.write(`${m}\n`);

type Found<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The projects and notes: always there, because they need nothing but their own file. */
const studio = new Studio(studioFile(process.argv.slice(2), process.env));
const studioFor = (w: Found<{ options: WriteOptions }>) => studioModule({ studio, ...(w.ok ? { write: { fs: nodeFs, root: w.value.options.root } } : {}) });

/** Write: the folder that holds the projects, by MDEdit's own rules (--root, MDEDIT_ROOT, MDEdit's settings, the default). */
async function findWrite(): Promise<Found<{ options: WriteOptions; root: string; source: string }>> {
  try {
    const candidates = await rootCandidates({ flag: flag('root'), fs: nodeFs });
    const { root, source, tried } = await chooseRoot(candidates, async (r) => (await listProjects({ fs: nodeFs, root: r, agent: 'ai', agentName: 'AI' })).length > 0);
    if (source !== candidates[0]!.source) say(`No projects in the projects folder from ${candidates[0]!.source} (${candidates[0]!.root}); using ${root} (${source}) instead.`);
    const st = await nodeFs.stat(root);
    if (!st?.isDirectory) return { ok: false, reason: `the projects folder "${root}" (from ${source}) does not exist` };
    return { ok: true, value: { options: { fs: nodeFs, root, tried, agent: flag('agent'), version: VERSION }, root, source } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Market: the library BookScout keeps. A library that is missing or will not open just means these tools are left out.
 * With `open: false` (the handshake) nothing is opened, only the instructions are read.
 */
async function findMarket(open: boolean): Promise<Found<{ module: McpModule; close(): void; root: string }>> {
  const root = resolveLibraryRoot(process.argv.slice(2), process.env);
  if (!root) return { ok: false, reason: 'no market library found (choose one in Cadrel, or pass --library <folder>)' };
  try {
    const { marketModule } = await import('./modules/market.js');
    const { Library } = await import('@cadrel/market-library');
    const { embedderForModel, SERVER_INSTRUCTIONS } = await import('@cadrel/market-mcp');
    if (!open) return { ok: true, value: { module: { id: 'market', title: 'Market research (the Amazon library)', instructions: SERVER_INSTRUCTIONS, register: () => undefined }, close: () => undefined, root } };
    const lib = Library.open(root);
    return { ok: true, value: { module: marketModule({ lib, embedderFor: (m) => embedderForModel(m, root) }), close: () => lib.close(), root } };
  } catch (e) {
    return { ok: false, reason: `the market tools could not start here (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    say(
      'Cadrel MCP server\n' +
        '  --root <folder>     the folder that holds your writing projects (default: the Root Folder set in Cadrel/MDEdit)\n' +
        '  --library <folder>  the market research library (default: the one the app last used)\n' +
        '  --studio <file>     the studio file (projects and notes; default: the one Cadrel keeps)\n' +
        '  --agent <name>      how the AI is named in the Notes panel (default: taken from the connecting app)\n' +
        '  --http              listen on 127.0.0.1 instead of stdio: MCP at /mcp, REST at /api, API description at /openapi.json\n' +
        '  --port <n>          port for --http (default 47831)\n' +
        '  --token <secret>    access token for --http (default: a new random one, printed on start)\n' +
        '  --with-market       also serve the market tools over --http (off by default: it is your research library)\n' +
        '  --print-handshake   print what the server answers to `initialize` and exit'
    );
    return;
  }

  const write = await findWrite();

  // `--print-handshake`: what this server answers to `initialize`, without opening anything. The app puts it in the Claude Desktop
  // extension's launcher so Claude gets its answer at once while this process is still starting.
  if (process.argv.includes('--print-handshake')) {
    const market = await findMarket(false);
    const modules = [studioFor(write), ...(write.ok ? [writeModule(write.value.options)] : []), ...(market.ok ? [market.value.module] : [])];
    process.stdout.write(
      JSON.stringify({ serverInfo: { name: SERVER_NAME, version: VERSION }, capabilities: capabilitiesOf(modules), instructions: composeInstructions(modules), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS })
    );
    return;
  }

  if (process.argv.includes('--http')) {
    if (!write.ok) throw new Error(`--http serves the writing tools, but ${write.reason}. Pass --root <folder>.`);
    const withMarket = process.argv.includes('--with-market');
    const market = withMarket ? await findMarket(true) : null;
    if (market && !market.ok) say(`Market tools left out: ${market.reason}.`);
    const token = flag('token') ?? process.env.CADREL_TOKEN ?? randomBytes(24).toString('base64url');
    const http = await startHttp({
      ...write.value.options,
      token,
      port: Number(flag('port') ?? 47831),
      makeServer: (o) => createCadrelServer({ version: VERSION, modules: [studioFor(write), writeModule(o), ...(market?.ok ? [market.value.module] : [])] })
    });
    say(`Cadrel AI access ready on http://${http.host}:${http.port}  (MCP: /mcp, REST: /api, description: /openapi.json)`);
    say(`Projects folder: ${write.value.root} (${write.value.source})${market?.ok ? `; market library: ${market.value.root}` : ''}`);
    say(`Access token: ${token}`);
    return;
  }

  const market = await findMarket(true);
  if (!write.ok) say(`Writing tools left out: ${write.reason}.`);
  if (!market.ok) say(`Market tools left out: ${market.reason}.`);
  const server = createCadrelServer({ version: VERSION, modules: [studioFor(write), ...(write.ok ? [writeModule(write.value.options)] : []), ...(market.ok ? [market.value.module] : [])] });
  await server.connect(new StdioServerTransport());
  say(`Cadrel MCP server ready.${write.ok ? ` Projects folder: ${write.value.root} (${write.value.source}).` : ''}${market.ok ? ` Market library: ${market.value.root}.` : ''}`);
  process.on('SIGINT', () => {
    if (market.ok) market.value.close();
    process.exit(0);
  });
}

main().catch((e) => {
  say(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
