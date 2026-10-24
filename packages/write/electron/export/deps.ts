import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { bundledFont, FONT_FILES } from '../../src/shared/export/fonts';
import { writeBytesAtomic } from '../files';
import { listInstalledFonts } from '../fonts';
import { buildPrintPdf, type PdfResources } from './pdf';
import type { ExportDeps } from './run';
import { defaultAppDefaults, type AppDefaults } from '../../src/shared/appDefaults';
import { loadDetails } from './sidecar';

/** Bundled files the print pipeline needs (inside the asar when packaged). */
export function pdfResources(): PdfResources {
  return {
    fontsDir: path.join(app.getAppPath(), 'assets', 'fonts'),
    pagedJsPath: path.join(app.getAppPath(), 'assets', 'vendor', 'paged.polyfill.js')
  };
}

/** The real-file-system implementation of everything the export orchestrator needs. */
export function makeExportDeps(
  resources: PdfResources = pdfResources(),
  getDefaults: (file: string) => AppDefaults | Promise<AppDefaults> = () => defaultAppDefaults()
): ExportDeps {
  return {
    chapterLevel: async (file) => (await getDefaults(file)).chapterLevel,
    readText: (p) => fsp.readFile(p, 'utf8'),
    readBytes: async (p, max) => {
      const st = await fsp.stat(p);
      if (st.size > max) throw new Error('file too large');
      return new Uint8Array(await fsp.readFile(p));
    },
    writeBytes: writeBytesAtomic,
    loadBundledFont: async (family) => {
      const b = bundledFont(family);
      if (!b) return null;
      const out: Record<string, Uint8Array> = {};
      for (const f of FONT_FILES) out[f.file] = new Uint8Array(await fsp.readFile(path.join(resources.fontsDir, b.slug, f.file)));
      return out;
    },
    installedFonts: listInstalledFonts,
    mkdirp: (d) => fsp.mkdir(d, { recursive: true }).then(() => undefined),
    exists: (p) => fsp.lstat(p).then(() => true, () => false),
    loadDetails: async (p) => (await loadDetails(p, await getDefaults(p))).details,
    buildPdf: (book, say, signal) =>
      buildPrintPdf(
        book,
        resources,
        (p) => say(p.stage === 'laying-out' ? `Laying out pages… ${p.page ?? ''}` : p.stage === 'printing' ? 'Writing the PDF…' : 'Preparing fonts and layout…'),
        signal
      )
  };
}
