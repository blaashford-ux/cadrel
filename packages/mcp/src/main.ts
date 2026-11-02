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
import { accessReader } from '@cadrel/write/src/shared/agent/access';
import { listOutlines, readOutline } from '@cadrel/write/src/shared/agent/tools';
import type { OutlineSource } from '@cadrel/market-library';
import type { ServerOptions as WriteOptions } from '@cadrel/write/mcp/server';
import { resolveLibraryRoot } from '@cadrel/market-mcp/src/config.js';
import { capabilitiesOf, composeInstructions, createCadrelServer, SERVER_NAME, type McpModule } from './server.js';
import { writeModule } from './modules/write.js';
import { studioModule } from './modules/studio.js';
import path from 'node:path';
import { Studio, studioFile, UserStore } from '@cadrel/studio';
import { StudioService, dbAccess } from '@cadrel/service';
import { openStudioDb, type StudioDb } from '@cadrel/store';
import { RECORDS_INSTRUCTIONS } from './modules/records.js';
import { watchLifecycle } from './lifecycle.js';
import { expandActive } from './active.js';
import { closedBookIds, initialStage } from '@cadrel/kernel';
import { makeProjectResolver } from './scope.js';
import { projectsModule, PROJECTS_INSTRUCTIONS } from './modules/projects.js';

const VERSION = process.env.CADREL_VERSION || '0.0.0';

// `--active <file>`: the app keeps that file as the arguments of the Studio it is running (see active.ts), so one unchanging configuration serves
// every Studio. Expanded before anything reads an argument. Stdout is protocol only, so what it says goes to stderr.
process.argv = [...process.argv.slice(0, 2), ...expandActive(process.argv.slice(2), undefined, (m) => process.stderr.write(`${m}\n`))];

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
}

/** What the person lets AI tools do, re-read each time it matters (see Settings → MCP in the app). */
const aiAccess = accessReader(nodeFs, flag('ai-access') ?? process.env.CADREL_AI_ACCESS);

const say = (m: string) => process.stderr.write(`${m}\n`);

/**
 * Stops cleanly, once: closes what is open, then leaves. A server that lingers holds the installed program's files open, which stops an update
 * from replacing them, so it also leaves by force if closing takes more than three seconds.
 */
let stopping = false;
function stopNow(why: string, close: () => void): never | void {
  if (stopping) return;
  stopping = true;
  say(`Cadrel MCP server stopping: ${why}.`);
  setTimeout(() => process.exit(0), 3000).unref();
  try {
    close();
  } catch {
    /* leaving anyway */
  }
  process.exit(0);
}
/** The marker Cadrel or its installer writes next to the program when an update starts (see lifecycle.ts). */
const retireFile = () => flag('retire-file') ?? path.join(path.dirname(process.execPath), '.cadrel-retire');

type Found<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The projects and notes: always there, because they need nothing but their own file. */
const studioPath = studioFile(process.argv.slice(2), process.env);
const studio = new Studio(studioPath);
/** The profile sits beside the studio file, in a folder of its own. */
const user = new UserStore(path.join(path.dirname(studioPath), 'user'));
type ClosedBooks = () => Promise<ReadonlySet<string>>;
/** Two modules served as one, so the records and the project-management tools come and go together. */
const both = (a: McpModule, b: McpModule): McpModule => ({ ...a, instructions: `${a.instructions} ${b.instructions}`, register: (server) => (a.register(server), b.register(server)) });
type Viewer = NonNullable<Parameters<typeof makeProjectResolver>[0]['view']>;
type RecordsParts = { closedBooks?: ClosedBooks; view?: Viewer; stageForNewBook?: () => Promise<{ workflowId: string; stage: string } | null> };
const studioFor = (w: Found<{ options: WriteOptions }>, r?: RecordsParts) => studioModule({ studio, user, ...(r?.closedBooks ? { closed: r.closedBooks } : {}), ...(r?.view ? { view: r.view } : {}), ...(r?.stageForNewBook ? { stageForNewBook: r.stageForNewBook } : {}), ...(w.ok ? { write: { fs: nodeFs, root: w.value.options.root } } : {}) });
/** Write's options with the Project and Book resolution of the studio's tree (which folder a Project or Book means, what came before a Book). */
const scoped = (o: WriteOptions, closed?: ClosedBooks, view?: Viewer): WriteOptions => {
  const r = makeProjectResolver({ studio, closed, view });
  return { ...o, resolve: r.resolve, earlier: r.earlier, hidden: r.hidden };
};

/**
 * The Studio's shared records (tasks, sign-offs, decisions, books, files), when the app says where they are and who the assistant acts for
 * (--records <file> --person <id> --studio-id <id>). Without all three these tools are left out. With `open: false` (the handshake) nothing is opened.
 * The assistant acts as that person under their role's permissions and needs `assistant.use`; it never migrates the file (the app does).
 */
async function findRecords(open: boolean, write?: Found<{ options: WriteOptions }>): Promise<Found<{ module: McpModule; close(): void } & RecordsParts>> {
  const file = flag('records');
  const person = flag('person');
  const studioId = flag('studio-id');
  if (!file || !person || !studioId) return { ok: false, reason: 'no records file given (Cadrel passes --records, --person and --studio-id)' };
  const stub: McpModule = { id: 'records', title: "Tasks, sign-offs, decisions, books and files (the studio's records)", instructions: `${RECORDS_INSTRUCTIONS} ${PROJECTS_INSTRUCTIONS}`, register: () => undefined };
  if (!open) return { ok: true, value: { module: stub, close: () => undefined } };
  let db: StudioDb | undefined;
  try {
    const { recordsModule } = await import('./modules/records.js');
    const { access } = await import('node:fs/promises');
    await access(file);
    db = await openStudioDb(file);
    const service = new StudioService({ db, studioId, access: dbAccess(db, studioId), projects: async () => (await studio.read()).tree });
    const d = db;
    // The Books in a Done stage, by the acting person's reading of the workflows (the same rule the app uses to hide and lock them).
    const view: Viewer = (tree) => service.as(person).visibleProjects(tree);
    // A new Book starts in the first stage of the default workflow for new books, as on the Projects page.
    const stageForNewBook = async () => {
      const wf = await service.as(person).workflows.defaultFor('subproject').catch(() => null);
      return wf ? { workflowId: wf.id, stage: initialStage(wf) } : null;
    };
    const closedBooks: ClosedBooks = async () => closedBookIds((await studio.read()).tree, await service.as(person).workflows.list().catch(() => []));
    return { ok: true, value: { module: both(recordsModule({ service, personId: person, studio, studioId, db }), projectsModule({ service, personId: person, studio, db, view, ...(write?.ok ? { write: { fs: nodeFs, root: write.value.options.root } } : {}) })), close: () => d.close(), closedBooks, view, stageForNewBook } };
  } catch (e) {
    db?.close();
    return { ok: false, reason: `the records could not be opened (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** Write: the folder that holds the projects, by Cadrel Write's own rules (--root, CADREL_WRITE_ROOT, Cadrel Write's settings, the default). */
async function findWrite(): Promise<Found<{ options: WriteOptions; root: string; source: string }>> {
  try {
    // An explicit --root (the app always passes one, for its active Studio) is the only place looked: no other Studio's projects may be found instead.
    const found = await rootCandidates({ flag: flag('root'), fs: nodeFs });
    const candidates = flag('root') ? [found[0]!] : found;
    const { root, source, tried } = await chooseRoot(candidates, async (r) => (await listProjects({ fs: nodeFs, root: r, agent: 'ai', agentName: 'AI' })).length > 0);
    if (source !== candidates[0]!.source) say(`No projects in the projects folder from ${candidates[0]!.source} (${candidates[0]!.root}); using ${root} (${source}) instead.`);
    const st = await nodeFs.stat(root);
    if (!st?.isDirectory) return { ok: false, reason: `the projects folder "${root}" (from ${source}) does not exist` };
    return { ok: true, value: { options: { fs: nodeFs, root, tried, agent: flag('agent'), version: VERSION, access: aiAccess }, root, source } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The pen names the app limits the library to (--pen-names <JSON array>); absent or unreadable means no limit. */
function penNameScope(): string[] | null {
  const raw = flag('pen-names');
  if (raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [];
  } catch {
    return []; // an unreadable limit is the safe one: show nothing rather than everything
  }
}

/**
 * Market: the library Cadrel Market keeps. A library that is missing or will not open just means these tools are left out.
 * With `open: false` (the handshake) nothing is opened, only the instructions are read.
 */
/** The outline documents in the projects folder, for the keyword tools. */
function outlinesOf(w: Found<{ options: WriteOptions }>): OutlineSource | undefined {
  if (!w.ok) return undefined;
  const ctx = { fs: nodeFs, root: w.value.options.root, agent: 'ai', agentName: 'AI' };
  return {
    list: async () => (await listOutlines(ctx)).map((o) => ({ project: o.project, file: o.file, title: o.title, words: o.words })),
    read: async (ref) => (await readOutline(ctx, ref.project, ref.file).catch(() => null))?.text ?? null
  };
}

async function findMarket(open: boolean, write?: Found<{ options: WriteOptions }>): Promise<Found<{ module: McpModule; close(): void; root: string }>> {
  const root = resolveLibraryRoot(process.argv.slice(2), process.env);
  if (!root) return { ok: false, reason: 'no market library found (choose one in Cadrel, or pass --library <folder>)' };
  try {
    const { marketModule } = await import('./modules/market.js');
    const { Library } = await import('@cadrel/market-library');
    const { embedderForModel, SERVER_INSTRUCTIONS } = await import('@cadrel/market-mcp');
    if (!open) return { ok: true, value: { module: { id: 'market', title: 'Market research (the Amazon library)', instructions: SERVER_INSTRUCTIONS, register: () => undefined }, close: () => undefined, root } };
    const lib = Library.open(root);
    return { ok: true, value: { module: marketModule({ lib, embedderFor: (m) => embedderForModel(m, root), authorScope: penNameScope(), outlines: write && outlinesOf(write), canSuggestKeywords: async () => (await aiAccess()).suggestKeywords }), close: () => lib.close(), root } };
  } catch (e) {
    return { ok: false, reason: `the market tools could not start here (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    say(
      'Cadrel MCP server\n' +
        '  --root <folder>     the folder that holds your writing projects (default: the Root Folder set in Cadrel/Cadrel Write)\n' +
        '  --library <folder>  the market research library (default: the one the app last used)\n' +
        '  --active <file>     take the arguments below from the file Cadrel keeps for its active Studio (they override any given here)\n' +
        '  --studio <file>     the studio file (projects and notes; default: the one Cadrel keeps)\n' +
        '  --records <file>    the Studio\'s records file (tasks, sign-offs, decisions, books, files); with --person <id> and --studio-id <id>\n' +
        '  --ai-access <file>  what the AI may do (written by Settings → MCP; without it files can only be read and reviewed, and no keyword suggestions are taken)\n' +
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
    const records = await findRecords(false, write);
    const modules = [studioFor(write), ...(records.ok ? [records.value.module] : []), ...(write.ok ? [writeModule(write.value.options)] : []), ...(market.ok ? [market.value.module] : [])];
    process.stdout.write(
      JSON.stringify({ serverInfo: { name: SERVER_NAME, version: VERSION }, capabilities: capabilitiesOf(modules), instructions: composeInstructions(modules), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS })
    );
    return;
  }

  if (process.argv.includes('--http')) {
    if (!write.ok) throw new Error(`--http serves the writing tools, but ${write.reason}. Pass --root <folder>.`);
    const withMarket = process.argv.includes('--with-market');
    const market = withMarket ? await findMarket(true, write) : null;
    const records = await findRecords(true, write);
    if (!records.ok && flag('records')) say(`Records tools left out: ${records.reason}.`);
    if (market && !market.ok) say(`Market tools left out: ${market.reason}.`);
    const token = flag('token') ?? process.env.CADREL_TOKEN ?? randomBytes(24).toString('base64url');
    const http = await startHttp({
      ...write.value.options,
      token,
      port: Number(flag('port') ?? 47831),
      makeServer: (o) => createCadrelServer({ version: VERSION, modules: [studioFor(write, records.ok ? records.value : undefined), ...(records.ok ? [records.value.module] : []), writeModule(scoped(o, records.ok ? records.value.closedBooks : undefined, records.ok ? records.value.view : undefined)), ...(market?.ok ? [market.value.module] : [])] })
    });
    watchLifecycle({ retireFile: retireFile(), onStop: (why) => stopNow(why, () => { records.ok && records.value.close(); market?.ok && market.value.close(); }) });
    say(`Cadrel AI access ready on http://${http.host}:${http.port}  (MCP: /mcp, REST: /api, description: /openapi.json)`);
    say(`Projects folder: ${write.value.root} (${write.value.source})${market?.ok ? `; market library: ${market.value.root}` : ''}`);
    say(`Access token: ${token}`);
    return;
  }

  const market = await findMarket(true, write);
  const records = await findRecords(true, write);
  if (!write.ok) say(`Writing tools left out: ${write.reason}.`);
  if (!records.ok && flag('records')) say(`Records tools left out: ${records.reason}.`);
  if (!market.ok) say(`Market tools left out: ${market.reason}.`);
  const closed = records.ok ? records.value.closedBooks : undefined;
  const view = records.ok ? records.value.view : undefined;
  const server = createCadrelServer({ version: VERSION, modules: [studioFor(write, records.ok ? records.value : undefined), ...(records.ok ? [records.value.module] : []), ...(write.ok ? [writeModule(scoped(write.value.options, closed, view))] : []), ...(market.ok ? [market.value.module] : [])] });
  await server.connect(new StdioServerTransport());
  const closeAll = () => {
    if (market.ok) market.value.close();
    if (records.ok) records.value.close();
  };
  // Over stdio the server lives exactly as long as the AI app's connection: when that ends, or the program that started it is gone, or an update
  // starts, it closes and leaves, so it is never left running (and never holds the app's files open).
  watchLifecycle({ stdin: process.stdin, parentPid: process.ppid, retireFile: retireFile(), onStop: (why) => stopNow(why, closeAll) });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => stopNow(`received ${sig}`, closeAll));
  say(`Cadrel MCP server ready.${write.ok ? ` Projects folder: ${write.value.root} (${write.value.source}).` : ''}${market.ok ? ` Market library: ${market.value.root}.` : ''}`);

}

main().catch((e) => {
  say(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
