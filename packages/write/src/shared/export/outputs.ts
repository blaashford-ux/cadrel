import { dirname, joinPath } from '../paths';

export type OutputKind = 'epub' | 'pdf' | 'docx';

/** Characters Windows (and most file systems) don't allow in file names, plus control characters. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Makes a book title safe to use in a file name without changing it more than necessary:
 * illegal characters become spaces, runs of spaces collapse, and trailing dots/spaces go.
 */
export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return cleaned.slice(0, 120).trim() || 'Book';
}

export const OUTPUT_LABELS: Record<OutputKind, string> = {
  epub: 'EPUB (KDP ebook)',
  pdf: 'Print PDF (KDP paperback interior)',
  docx: 'DOCX (Reedsy / Kindle Create import)'
};

/** `<Title> - Ebook.epub`, `<Title> - Print Interior.pdf`, `<Title> - Ebook.docx` (the skill's naming). */
export function outputFileName(kind: OutputKind, title: string): string {
  const base = sanitizeFileName(title);
  return kind === 'epub' ? `${base} - Ebook.epub` : kind === 'pdf' ? `${base} - Print Interior.pdf` : `${base} - Ebook.docx`;
}

const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);

/** The folder the outputs go to: absolute as given, or relative to the manuscript's folder. */
export function resolveOutputDir(manuscriptPath: string, outputDir: string): string {
  const dir = outputDir.trim();
  if (!dir) return dirname(manuscriptPath);
  if (isAbsolute(dir)) return dir.replace(/[\\/]+$/, '') || dir;
  return joinPath(dirname(manuscriptPath), dir.replace(/^[.][\\/]/, '').replace(/[\\/]+$/, ''));
}

/** Rough size description for the results list: 1.2 MB, 340 KB. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
