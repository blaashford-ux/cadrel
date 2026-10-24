/**
 * Test harness (not part of the app): runs the real print pipeline inside Electron.
 *   electron pdfSmoke.js <manuscript.md> <details.json> <out.pdf> <repoRoot>
 * Writes <out.pdf> and <out.pdf>.json with { pages, gutter, warnings, passes }.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assembleBook } from '../../src/shared/export/assemble';
import { sanitizeBookDetails } from '../../src/shared/export/model';
import { buildPrintPdf } from './pdf';

app.disableHardwareAcceleration();
// The hidden render windows are destroyed after each pass; don't let that quit the harness.
app.on('window-all-closed', () => undefined);
app.whenReady().then(async () => {
  const [md, detailsFile, out, root] = process.argv.slice(-4);
  try {
    const details = sanitizeBookDetails(JSON.parse(await fs.readFile(detailsFile, 'utf8')));
    const assembled = assembleBook(await fs.readFile(md, 'utf8'), details);
    if (!assembled.build) throw new Error(assembled.errors.join('; '));
    const started = Date.now();
    let maxPass = 0;
    const log: string[] = [];
    const r = await buildPrintPdf(
      assembled.build,
      { fontsDir: path.join(root, 'assets', 'fonts'), pagedJsPath: path.join(root, 'node_modules', 'pagedjs', 'dist', 'paged.polyfill.js') },
      (p) => {
        maxPass = Math.max(maxPass, p.pass ?? 0);
        if (p.stage !== 'laying-out') log.push(`${Date.now() - started}ms ${p.stage} pass ${p.pass ?? '-'}`);
        else if (!log.some((l) => l.includes('first page poll'))) log.push(`${Date.now() - started}ms first page poll (${p.page} pages)`);
      }
    );
    await fs.writeFile(out, r.bytes);
    await fs.writeFile(out + '.json', JSON.stringify({ pages: r.pages, gutter: r.gutter, warnings: r.warnings, passes: maxPass, ms: Date.now() - started, log }));
    app.exit(0);
  } catch (e) {
    await fs.writeFile(out + '.error', String(e instanceof Error ? e.stack : e));
    app.exit(1);
  }
});
