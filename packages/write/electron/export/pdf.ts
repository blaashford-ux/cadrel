import { BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BookBuild } from '../../src/shared/export/assemble';
import { bundledFont, FONT_FILES, fontFaceCss } from '../../src/shared/export/fonts';
import { layoutWithGutter } from '../../src/shared/export/gutter';
import { buildPrintHtml, postLayoutConfig, type PrintLayout } from '../../src/shared/export/printHtml';
import { estimatePages, KDP_MAX_PAGES, KDP_MIN_PAGES, trimByKey } from '../../src/shared/export/trim';

/** Where the print pipeline finds its bundled files. */
export interface PdfResources {
  /** Folder holding one sub-folder of .ttf files per bundled font family. */
  fontsDir: string;
  /** Path to Paged.js's paged.polyfill.js. */
  pagedJsPath: string;
}

export interface PdfProgress {
  stage: 'preparing' | 'laying-out' | 'printing';
  /** Pages laid out so far (only during 'laying-out'). */
  page?: number;
  /** Which layout pass this is (the gutter may need a second pass). */
  pass?: number;
}

export interface PdfResult {
  bytes: Uint8Array;
  pages: number;
  gutter: number;
  warnings: string[];
}

/**
 * @font-face rules with the font files inlined, so the page needs no file access. Only the bundled
 * families need this; any other family is an installed font that Chromium finds by name (and embeds).
 */
export async function loadFontCss(fontsDir: string, family: string): Promise<string> {
  const bundled = bundledFont(family);
  if (!bundled) return '';
  const data = new Map<string, string>();
  for (const f of FONT_FILES) data.set(f.file, (await fs.readFile(path.join(fontsDir, bundled.slug, f.file))).toString('base64'));
  return fontFaceCss(bundled, (f) => `data:font/ttf;base64,${data.get(f.file)}`);
}

interface Rendered {
  pdf: Buffer;
  pages: number;
}

/** Lays out one HTML document with Paged.js in a hidden window and prints it to PDF. */
async function renderHtml(
  html: string,
  post: { firstBodyId: string; config: unknown },
  onProgress: (p: PdfProgress) => void,
  pass: number,
  signal?: AbortSignal
): Promise<Rendered> {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    // Offscreen rendering keeps producing frames. A merely hidden window gets none, and Paged.js waits
    // on animation frames between pages (laying out a book took ~1 s per page instead of ~20 ms).
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false, offscreen: true }
  });
  win.webContents.setFrameRate(60);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdedit-print-'));
  let poll: NodeJS.Timeout | undefined;
  // Destroying a window leaves its pending executeJavaScript/printToPDF promises unresolved, so
  // every await below is raced against this one, which rejects on cancel.
  let abort = () => undefined as void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      if (!win.isDestroyed()) win.destroy();
      reject(new Error('cancelled'));
    };
  });
  cancelled.catch(() => undefined); // never an unhandled rejection
  const guard = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, cancelled]);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort);
  try {
    const file = path.join(dir, 'book.html');
    await fs.writeFile(file, html);
    await guard(win.loadFile(file));
    await guard(win.webContents.executeJavaScript('document.fonts.ready.then(() => true)'));

    poll = setInterval(() => {
      if (win.isDestroyed()) return;
      win.webContents
        .executeJavaScript('document.querySelectorAll(".pagedjs_page").length')
        .then((n: number) => onProgress({ stage: 'laying-out', page: n, pass }))
        .catch(() => undefined);
    }, 400);
    const pages: number = await guard(
      win.webContents.executeJavaScript(
        `window.PagedPolyfill.preview().then(() => window.__mdeditPostLayout(${JSON.stringify(post.firstBodyId)}, ${JSON.stringify(post.config)}))`
      )
    );
    clearInterval(poll);
    onProgress({ stage: 'printing', pass });
    const pdf = await guard(win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: false, margins: { marginType: 'none' } }));
    return { pdf, pages };
  } finally {
    if (poll) clearInterval(poll);
    signal?.removeEventListener('abort', abort);
    if (!win.isDestroyed()) win.destroy();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Builds the KDP print-interior PDF for a book. Runs in the Electron main process. */
export async function buildPrintPdf(
  book: BookBuild,
  resources: PdfResources,
  onProgress: (p: PdfProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<PdfResult> {
  const s = book.settings.pdf;
  const trim = trimByKey(s.trim);
  onProgress({ stage: 'preparing' });
  const [fontCss, paged] = await Promise.all([loadFontCss(resources.fontsDir, s.font), fs.readFile(resources.pagedJsPath, 'utf8')]);
  const scripts = `<script>window.PagedConfig = { auto: false };</script>\n<script>${paged.replace(/<\/script/gi, '<\\/script')}</script>`;

  const estimate = estimatePages({
    words: book.totalWords,
    chapters: book.chapters.length,
    trim,
    fontSize: s.fontSize,
    outerMargin: s.outerMargin,
    topMargin: s.topMargin,
    bottomMargin: s.bottomMargin,
    frontPages: book.front.length * 2 + 2
  });

  let pass = 0;
  const result = await layoutWithGutter({
    auto: s.gutter === 'auto',
    manualGutter: s.gutter === 'auto' ? 0 : s.gutter,
    estimatedPages: estimate,
    render: async (gutter) => {
      pass++;
      const layout: PrintLayout = { trimKey: s.trim, gutter, outer: s.outerMargin, top: s.topMargin, bottom: s.bottomMargin };
      const r = await renderHtml(buildPrintHtml(book, layout, { fontCss, scripts }), { firstBodyId: book.chapters[0].id, config: postLayoutConfig(book) }, onProgress, pass, signal);
      return { output: r.pdf, pages: r.pages };
    }
  });

  const warnings: string[] = [];
  if (result.pages < KDP_MIN_PAGES) warnings.push(`The interior is ${result.pages} pages; KDP paperbacks need at least ${KDP_MIN_PAGES}.`);
  if (result.pages > KDP_MAX_PAGES) warnings.push(`The interior is ${result.pages} pages; KDP's maximum is ${KDP_MAX_PAGES}.`);
  if (s.gutter !== 'auto' && result.gutter < 0.375) warnings.push('The inside margin is narrower than KDP recommends (0.375 in minimum).');
  return { bytes: new Uint8Array(result.output), pages: result.pages, gutter: result.gutter, warnings };
}
