import type { ExportKind, ExportOutput, ExportPlan, ExportProgress, ExportResult } from '../../src/shared/api';
import { assembleBook, type BookBuild } from '../../src/shared/export/assemble';
import { buildDocx } from '../../src/shared/export/docx';
import { buildEpub, verifyEpub, type EpubCover, type EpubFonts } from '../../src/shared/export/epub';
import { bundledFont, DEFAULT_FONT } from '../../src/shared/export/fonts';
import type { BookDetails } from '../../src/shared/export/model';
import { outputFileName, resolveOutputDir } from '../../src/shared/export/outputs';
import { joinPath } from '../../src/shared/paths';

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
  loadBundledFont?(family: string): Promise<EpubFonts | null>;
  /** Families installed on this computer; empty or absent when that can't be known. */
  installedFonts?(): Promise<string[]>;
  /** The heading level that starts a chapter (default 1). */
  chapterLevel?(file: string): number | Promise<number>;
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
  const assembled = assembleBook(await deps.readText(file), details, { now: deps.now?.(), uuid: deps.uuid, chapterLevel: await deps.chapterLevel?.(file) });
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
  }
  let epubFonts: EpubFonts | undefined;
  if (wanted.includes('epub')) {
    const family = book.settings.epub.font;
    if (bundledFont(family)) {
      epubFonts = (await deps.loadBundledFont?.(family).catch(() => null)) ?? undefined;
      if (!epubFonts) {
        result.warnings.push(`The font files for “${family}” couldn’t be read, so the EPUB doesn’t embed them.`);
      }
    } else {
      result.warnings.push(
        `“${family}” is installed on your computer but isn’t embedded in the EPUB (its licence may not allow it), so e-readers will use their own font unless they have it. Pick one of the bundled fonts to embed it.`
      );
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
