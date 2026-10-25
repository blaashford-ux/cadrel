import { basename, dirname, joinPath, isMarkdownName } from '../paths';

/** `book.md` / `book.markdown` → `book.export.json`, in the same folder. */
export const SIDECAR_SUFFIX = '.export.json';

export const stemOf = (fileName: string) => fileName.replace(/\.(md|markdown)$/i, '');

export function sidecarPathFor(mdPath: string): string {
  return joinPath(dirname(mdPath), stemOf(basename(mdPath)) + SIDECAR_SUFFIX);
}

export const isSidecarName = (name: string) => name.toLowerCase().endsWith(SIDECAR_SUFFIX);

/** `book.export.json` → `book` */
export const sidecarStem = (name: string) => name.slice(0, -SIDECAR_SUFFIX.length);

/** Which of several same-named files owns the sidecar: `.md` wins over `.markdown`. */
export function sidecarOwner(names: string[]): string | undefined {
  const md = names.filter(isMarkdownName);
  return md.find((n) => /\.md$/i.test(n)) ?? md[0];
}
