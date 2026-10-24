import { app } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSmokeTest } from '@cadrel/write/electron/smokeTest';
import { setAssetsDir } from '@cadrel/write/electron/export/deps';
import { extractBuffer } from '@cadrel/market-text';
import { createMarketModule } from '@cadrel/market-desktop/src/main/module.js';
import { Studio } from '@cadrel/studio';
import { samplePdf } from './pdf';

/**
 * Headless self-test of the installed app, run as `Cadrel.exe --smoke-test=<result.json>`. CI uses it to prove a freshly
 * built package works where it cannot be driven by hand: Write exports EPUB, PDF and DOCX with the bundled fonts and Paged.js,
 * and Market's native pieces (database, vector extension, image library, PDF reader) load from the installed layout.
 * `here` is the folder holding main.mjs. Returns the process exit code.
 */
export async function runShellSmoke(outFile: string, here: string): Promise<number> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cadrel-smoke-'));
  const library = path.join(tmp, 'library');
  const books = path.join(tmp, 'books');

  try {
    // Write: the whole export pipeline.
    setAssetsDir(path.join(here, 'assets'));
    const writeFile = path.join(tmp, 'write.json');
    await runSmokeTest(writeFile);
    const w = JSON.parse(await fs.readFile(writeFile, 'utf8')) as { checks: { name: string; ok: boolean; detail?: string }[] };
    for (const c of w.checks) check(`write: ${c.name}`, c.ok, c.detail);
  } catch (e) {
    check('write: no exception', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }

  try {
    // Market: its library, vector extension and capture server, on a throwaway library and a spare port.
    const dataDir = path.join(tmp, 'market-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(library);
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ libraryRoot: null, port: 49000 + Math.floor(Math.random() * 900) }));
    const market = createMarketModule({
      getWindow: () => null,
      getContents: () => null,
      dataDir,
      codeDir: here,
      resourcesDir: path.join(here, 'resources'),
      iconFile: () => path.join(here, 'assets', 'icon.png'),
      version: app.getVersion(),
      willQuit: () => undefined,
      updatesDisabledReason: 'smoke test'
    });
    try {
      await market.service.setLibrary(library);
      check('market: the library opens', market.service.status().libraryRoot === library);
      check('market: the capture server is listening', market.service.status().serverRunning === true, market.service.status().serverError ?? undefined);
      check('market: vector search (sqlite-vec) loads', (await market.service.indexStatus()).vectorSearch === true);
    } finally {
      await market.stop();
    }
  } catch (e) {
    check('market: no exception', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }

  try {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
    check('market: the image library (sharp) works', png.length > 20 && png.subarray(1, 4).toString('latin1') === 'PNG');
  } catch (e) {
    check('market: the image library (sharp) works', false, e instanceof Error ? e.message : String(e));
  }

  try {
    const got = await extractBuffer(samplePdf('Cadrel smoke test: this text layer is readable by the PDF reader.'), 'pdf');
    check('market: the PDF reader extracts text', got.text.includes('text layer is readable'), got.text.slice(0, 80));
  } catch (e) {
    check('market: the PDF reader extracts text', false, e instanceof Error ? e.message : String(e));
  }

  // The one MCP server, started the way an AI app starts it: this runtime acting as Node, on a project and a library.
  try {
    await fs.mkdir(path.join(books, 'Smoke', '.mdedit'), { recursive: true });
    await fs.writeFile(path.join(books, 'Smoke', '.mdedit', 'project.json'), '{"status":"drafting"}');
    await fs.writeFile(path.join(books, 'Smoke', 'Book.md'), '# One\n\nShe walked slowly to the door.\n');
    // A project the app makes is one the AI server sees: both read the same studio file.
    const studioFile = path.join(tmp, 'studio.json');
    const svc = new Studio(studioFile);
    const series = await svc.createProject({ name: 'Dragon Rider', kind: 'Series' });
    await svc.createProject({ name: 'Book 1', parentId: series.id, kind: 'Book' });
    const s = await mcpSession(path.join(here, 'mcp.mjs'), ['--root', books, '--library', library, '--studio', studioFile]);
    check('mcp: the one server starts and names itself cadrel', s.name === 'cadrel', s.name);
    check('mcp: it carries both modules\' tools', ['read_chapter', 'add_notes', 'top_books', 'search_book_text'].every((t) => s.tools.includes(t)), `${s.tools.length} tools`);
    check('mcp: a writing tool reads the project', s.project === 'Smoke', s.project);
    check('mcp: the studio tools see the project tree the app keeps', s.studio.join('|') === 'Dragon Rider|Dragon Rider / Book 1', s.studio.join('|'));
  } catch (e) {
    check('mcp: the one server starts', false, e instanceof Error ? e.message : String(e));
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  await fs.writeFile(
    outFile,
    JSON.stringify({ ok, checks, versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }, platform: process.platform }, null, 2)
  );
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  return ok ? 0 : 1;
}

/** A minimal MCP client over stdio: initialize, list the tools, call list_projects. */
async function mcpSession(script: string, args: string[]): Promise<{ name: string; tools: string[]; project: string; studio: string[] }> {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const pending = new Map<number, (m: any) => void>();
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) pending.get(m.id)?.(m);
      } catch {
        /* not a message */
      }
    }
  });
  const exited = new Promise<never>((_, reject) => child.on('exit', (code) => reject(new Error(`the server exited (${code}): ${err.trim().slice(-300)}`))));
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
  const request = (id: number, method: string, params: object = {}) =>
    Promise.race([
      new Promise<any>((resolve) => {
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      }),
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer to ${method} after 40 s: ${err.trim().slice(-300)}`)), 40_000).unref())
    ]);
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await request(2, 'tools/list');
    const call = await request(3, 'tools/call', { name: 'list_projects', arguments: {} });
    const projects = JSON.parse(call.result.content[0].text) as { project: string }[];
    const tree = await request(4, 'tools/call', { name: 'studio_projects', arguments: {} });
    const studio = (JSON.parse(tree.result.content[0].text).projects ?? []).map((p: { path: string }) => p.path) as string[];
    return { name: init.result.serverInfo.name, tools: list.result.tools.map((t: { name: string }) => t.name), project: projects[0]?.project ?? '', studio };
  } finally {
    child.kill();
  }
}
