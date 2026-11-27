import type { ExportKind, ExportOutput, ExportPlan, ExportProgress, ExportResult } from '../../src/shared/api';
import { assembleBook, type BookBuild } from '../../src/shared/export/assemble';
import type { AuthorLinks } from '../../src/shared/export/matter';
import { buildDocx } from '../../src/shared/export/docx';
import { buildEpub, verifyEpub, type EpubCover, type EpubFamilyFiles, type EpubFonts } from '../../src/shared/export/epub';
import { bundledFont, DEFAULT_FONT, headingFamily } from '../../src/shared/export/fonts';
import type { BookDetails } from '../../src/shared/export/model';
import { composeOmnibus, describeBook, type OmnibusBook, type OmnibusBookInfo, type OmnibusRecipe } from '../../src/shared/export/omnibus';
import { outputFileName, resolveOutputDir } from '../../src/shared/export/outputs';
import { joinParts, joinPath } from '../../src/shared/paths';

/** Everything the orchestrator needs from the outside world, so it can be tested without Electron. */
export interface ExportDeps {
  readText(path: string): Promise<string>;
  readBytes(path: string, maxBytes: number): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  loadDetails(manuscript: string): Promise<BookDetails>;
  buildPdf(
    book: BookBuild,
    onProgress: (message: string) => void,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; pages: number; gutter: number; warnings: string[] }>;
  /** The files of a bundled font family (keyed by FONT_FILES names), for embedding in the EPUB. */
  loadBundledFont?(family: string): Promise<EpubFamilyFiles | null>;
  /** Families installed on this computer; empty or absent when that can't be known. */
  installedFonts?(): Promise<string[]>;
  /** The heading level that starts a chapter (default 1). */
  chapterLevel?(file: string): number | Promise<number>;
  /** The author's profile links (their Patreon), for back-matter pages that use them. */
  author?(): Promise<AuthorLinks | null>;
  now?(): Date;
  uuid?(): string;
}

const KINDS: ExportKind[] = ['epub', 'pdf', 'docx'];
const MAX_COVER_BYTES = 20 * 1024 * 1024;

/** Where an export would write. `unsaved` (the dialog's current edits) is used instead of the saved details if given. */
export async function planExport(file: string, deps: Pick<ExportDeps, 'loadDetails' | 'exists'>, unsaved?: BookDetails): Promise<ExportPlan> {
  const d = unsaved ?? (await deps.loadDetails(file));
  const dir = resolveOutputDir(file, d.export.outputDir);
  const outputs = [];
  for (const kind of KINDS) {
    if (!d.export.outputs[kind]) continue;
    const p = joinPath(dir, outputFileName(kind, d.title));
    outputs.push({ kind, path: p, exists: await deps.exists(p) });
  }
  return { dir, outputs };
}

function detectCover(bytes: Uint8Array): EpubCover['ext'] | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

/**
 * Runs an export: reads the manuscript as saved on disk and the book's saved details, builds every
 * enabled output, and writes each one atomically. One failing output doesn't stop the others.
 */
export async function runExport(
  file: string,
  deps: ExportDeps,
  onProgress: (p: ExportProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<ExportResult> {
  const result: ExportResult = { ok: false, errors: [], warnings: [], outputs: [] };
  const say = (kind: ExportProgress['kind'], message: string) => onProgress({ kind, message });
  const cancelled = () => signal?.aborted === true;

  say('prepare', 'Reading the manuscript…');
  const details = await deps.loadDetails(file);
  const wanted = KINDS.filter((k) => details.export.outputs[k]);
  if (wanted.length === 0) {
    result.errors.push('Choose at least one output to build.');
    return result;
  }
  const assembled = assembleBook(await deps.readText(file), details, { now: deps.now?.(), uuid: deps.uuid, chapterLevel: await deps.chapterLevel?.(file), author: await deps.author?.().catch(() => null) });
  if (!assembled.build) {
    result.errors.push(...assembled.errors);
    return result;
  }
  const book = assembled.build;
  result.warnings.push(...book.warnings);

  // Fonts: a family the profile names but this computer no longer has falls back to the default, loudly.
  let installed: string[] | null = null;
  const isInstalled = async (family: string) => {
    installed ??= (await deps.installedFonts?.().catch(() => [])) ?? [];
    return installed.length === 0 || installed.some((f) => f.toLowerCase() === family.toLowerCase());
  };
  if (wanted.includes('pdf')) {
    const family = book.settings.pdf.font;
    if (!bundledFont(family) && !(await isInstalled(family))) {
      result.warnings.push(`The font “${family}” isn’t installed on this computer, so the print PDF used ${DEFAULT_FONT} instead.`);
      book.settings = { ...book.settings, pdf: { ...book.settings.pdf, font: DEFAULT_FONT } };
    }
    const head = book.settings.pdf.headingFont;
    if (head && !bundledFont(head) && !(await isInstalled(head))) {
      result.warnings.push(`The heading font “${head}” isn’t installed on this computer, so the print PDF used the body font for headings.`);
      book.settings = { ...book.settings, pdf: { ...book.settings.pdf, headingFont: '' } };
    }
  }
  let epubFonts: EpubFonts | undefined;
  if (wanted.includes('epub')) {
    for (const family of new Set([book.settings.epub.font, headingFamily(book.settings.epub)])) {
      const bundled = bundledFont(family);
      if (bundled) {
        const files = (await deps.loadBundledFont?.(family).catch(() => null)) ?? undefined;
        if (files) (epubFonts ??= {})[bundled.family.toLowerCase()] = files;
        else result.warnings.push(`The font files for “${family}” couldn’t be read, so the EPUB doesn’t embed them.`);
      } else {
        result.warnings.push(
          `“${family}” is installed on your computer but isn’t embedded in the EPUB (its licence may not allow it), so e-readers will use their own font unless they have it. Pick one of the bundled fonts to embed it.`
        );
      }
    }
  }

  const dir = resolveOutputDir(file, details.export.outputDir);
  try {
    await deps.mkdirp(dir);
  } catch (e) {
    result.errors.push(`Could not create the output folder ${dir}: ${e instanceof Error ? e.message : e}`);
    return result;
  }

  for (const kind of wanted) {
    if (cancelled()) {
      result.errors.push('The export was cancelled.');
      break;
    }
    const target = joinPath(dir, outputFileName(kind, book.meta.title));
    const out: ExportOutput = { kind, path: target, bytes: 0, warnings: [] };
    try {
      let bytes: Uint8Array;
      if (kind === 'epub') {
        say('epub', 'Building the EPUB…');
        let cover: EpubCover | undefined;
        const coverPath = details.export.epub.coverImage.trim();
        if (coverPath) {
          try {
            const data = await deps.readBytes(coverPath, MAX_COVER_BYTES);
            const ext = detectCover(data);
            if (ext) cover = { bytes: data, ext };
            else out.warnings.push('The cover image isn’t a JPEG or PNG, so it was left out.');
          } catch {
            out.warnings.push(`The cover image couldn’t be read (${coverPath}), so it was left out.`);
          }
        }
        bytes = buildEpub(book, cover, epubFonts);
        const problems = verifyEpub(bytes);
        if (problems.length) throw new Error(`the EPUB failed its self-check: ${problems.join('; ')}`);
      } else if (kind === 'pdf') {
        say('pdf', 'Laying out the print interior…');
        const r = await deps.buildPdf(book, (m) => say('pdf', m), signal);
        bytes = r.bytes;
        out.pages = r.pages;
        out.gutter = r.gutter;
        out.warnings.push(...r.warnings);
        if (cancelled()) throw new Error('cancelled');
      } else {
        say('docx', 'Building the DOCX…');
        bytes = await buildDocx(book);
      }
      say(kind, 'Saving…');
      await deps.writeBytes(target, bytes);
      out.bytes = bytes.length;
      result.outputs.push(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(cancelled() ? 'The export was cancelled.' : `${kind.toUpperCase()}: ${msg}`);
    }
  }
  result.ok = result.errors.length === 0 && result.outputs.length === wanted.length;
  return result;
}


// ---- an omnibus: several manuscripts as one book ----------------------------------------------------------------------------------

/** The name the composed book goes by while it is built; never a file that exists. It sits in the project's folder so relative paths resolve there. */
const OMNIBUS_FILE = '.omnibus.md';

async function readBooks(projectDir: string, files: string[], deps: Pick<ExportDeps, 'readText' | 'loadDetails' | 'chapterLevel'>): Promise<{ books: OmnibusBook[]; errors: string[] }> {
  const books: OmnibusBook[] = [];
  const errors: string[] = [];
  for (const rel of files) {
    const abs = joinParts(projectDir, ...rel.split('/'));
    try {
      books.push({ path: rel, source: await deps.readText(abs), details: await deps.loadDetails(abs), chapterLevel: (await deps.chapterLevel?.(abs)) ?? 1 });
    } catch (e) {
      errors.push(`${rel} could not be read (${e instanceof Error ? e.message : e}).`);
    }
  }
  return { books, errors };
}

/** What the dialog shows for each manuscript: its Book Details (title, subtitle, author) and how much text it has. Files that cannot be read are left out. */
export async function omnibusBooks(projectDir: string, files: string[], deps: Pick<ExportDeps, 'readText' | 'loadDetails' | 'chapterLevel' | 'exists'>): Promise<OmnibusBookInfo[]> {
  const out: OmnibusBookInfo[] = [];
  for (const rel of files) {
    const abs = joinParts(projectDir, ...rel.split('/'));
    try {
      if (!(await deps.exists(abs))) continue;
      const details = await deps.loadDetails(abs);
      out.push(describeBook(rel, await deps.readText(abs), details, (await deps.chapterLevel?.(abs)) ?? 1));
    } catch {
      // a file that cannot be read is not offered
    }
  }
  return out;
}

/** The deps with the composed text and details answering for the omnibus's own file name. */
function omnibusDeps(deps: ExportDeps, file: string, composed: { source: string; details: BookDetails; chapterLevel: number }): ExportDeps {
  return {
    ...deps,
    readText: (p) => (p === file ? Promise.resolve(composed.source) : deps.readText(p)),
    loadDetails: (p) => (p === file ? Promise.resolve(composed.details) : deps.loadDetails(p)),
    chapterLevel: (p) => (p === file ? composed.chapterLevel : deps.chapterLevel?.(p) ?? 1)
  };
}

/**
 * Where the omnibus's files would be written: next to where the first book's own export goes (its Book Details' output folder), named after the
 * omnibus. The output folder is made absolute here, so it does not depend on where the composed book is said to be.
 */
async function composeFor(projectDir: string, recipe: OmnibusRecipe, deps: ExportDeps) {
  const { books, errors } = await readBooks(projectDir, recipe.files, deps);
  const composed = composeOmnibus(recipe, books);
  composed.errors.unshift(...errors);
  if (books[0]) composed.details.export.outputDir = resolveOutputDir(joinParts(projectDir, ...books[0].path.split('/')), books[0].details.export.outputDir);
  return composed;
}

export async function planOmnibus(projectDir: string, recipe: OmnibusRecipe, deps: ExportDeps): Promise<ExportPlan & { errors: string[]; warnings: string[] }> {
  const c = await composeFor(projectDir, recipe, deps);
  const plan = await planExport(joinPath(projectDir, OMNIBUS_FILE), deps, c.details);
  return { ...plan, errors: c.errors, warnings: c.warnings };
}

/** Builds the omnibus's enabled outputs, as one book. */
export async function runOmnibus(
  projectDir: string,
  recipe: OmnibusRecipe,
  deps: ExportDeps,
  onProgress: (p: ExportProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<ExportResult> {
  onProgress({ kind: 'prepare', message: 'Reading the manuscripts…' });
  const c = await composeFor(projectDir, recipe, deps);
  if (c.errors.length) return { ok: false, errors: c.errors, warnings: c.warnings, outputs: [] };
  const file = joinPath(projectDir, OMNIBUS_FILE);
  const result = await runExport(file, omnibusDeps(deps, file, c), onProgress, signal);
  result.warnings.unshift(...c.warnings);
  return result;
}
