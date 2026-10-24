import { app } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSmokeTest } from '@cadrel/write/electron/smokeTest';
import { setAssetsDir } from '@cadrel/write/electron/export/deps';
import { extractBuffer } from '@cadrel/market-text';
import { createMarketModule } from '@cadrel/market-desktop/src/main/module.js';
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
    const library = path.join(tmp, 'library');
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

  const mcp = path.join(here, 'mcp.mjs');
  check('market: the MCP server is bundled', await fs.stat(mcp).then((s) => s.isFile() && s.size > 10_000, () => false), mcp);

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  await fs.writeFile(
    outFile,
    JSON.stringify({ ok, checks, versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }, platform: process.platform }, null, 2)
  );
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  return ok ? 0 : 1;
}
