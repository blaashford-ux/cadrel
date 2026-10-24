import { app } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyEpub } from '../src/shared/export/epub';
import { sanitizeBookDetails } from '../src/shared/export/model';
import { makeExportDeps } from './export/deps';
import { runExport } from './export/run';
import { saveDetails } from './export/sidecar';

const SAMPLE = Array.from(
  { length: 6 },
  (_, c) =>
    `# Chapter ${c + 1}: Smoke ${c + 1}\n\n` +
    Array.from({ length: 8 }, () => '"Hello there," she said. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(5)).join('\n\n')
).join('\n\n');

/**
 * Headless self-test of the installed app: exports a small book to EPUB, PDF and DOCX with the real
 * bundled fonts and Paged.js, then checks the files. Run it as `MDEdit.exe --smoke-test=<result.json>`.
 * CI uses it to prove a freshly built Windows package can really export (it can't be tested any
 * other way off-Windows). Returns the process exit code.
 */
export async function runSmokeTest(outFile: string): Promise<number> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  let result: unknown = null;
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdedit-smoke-'));
    const md = path.join(dir, 'smoke.md');
    await fs.writeFile(md, SAMPLE);
    const details = sanitizeBookDetails({ title: 'Smoke Test Book', author: 'MDEdit', export: { outputs: { epub: true, pdf: true, docx: true }, outputDir: 'out' } });
    await saveDetails(md, details);

    const r = await runExport(md, makeExportDeps());
    result = r;
    check('export finished without errors', r.ok, r.errors.join('; '));
    const by = Object.fromEntries(r.outputs.map((o) => [o.kind, o]));
    for (const kind of ['epub', 'pdf', 'docx'] as const) check(`${kind} was written`, !!by[kind] && by[kind].bytes > 1000, by[kind] ? `${by[kind].bytes} bytes` : 'missing');
    if (by.epub) {
      const bytes = new Uint8Array(await fs.readFile(by.epub.path));
      const problems = verifyEpub(bytes);
      check('EPUB passes the structure check', problems.length === 0, problems.join('; '));
    }
    if (by.pdf) {
      const head = (await fs.readFile(by.pdf.path)).subarray(0, 5).toString('latin1');
      check('PDF is a PDF', head === '%PDF-', head);
      check('PDF has pages and embedded fonts (size)', (by.pdf.pages ?? 0) >= 6 && by.pdf.bytes > 30_000, `${by.pdf.pages} pages, ${by.pdf.bytes} bytes`);
    }
    if (by.docx) {
      const head = (await fs.readFile(by.docx.path)).subarray(0, 2).toString('latin1');
      check('DOCX is a zip', head === 'PK', head);
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  } catch (e) {
    check('no exception', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  const ok = checks.length > 0 && checks.every((c) => c.ok);
  await fs.writeFile(
    outFile,
    JSON.stringify({ ok, checks, versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }, platform: process.platform, result }, null, 2)
  );
  return ok ? 0 : 1;
}
