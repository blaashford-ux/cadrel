/** Path helpers that work on both Windows and POSIX paths without Node's `path`. */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Returns an error message for an invalid file/folder name, or null if it is fine. */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (n === '') return 'Name cannot be empty.';
  if (n.length > 200) return 'Name is too long.';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) return 'Names cannot contain < > : " / \\ | ? *';
  if (n === '.' || n === '..') return 'Invalid name.';
  if (/[. ]$/.test(n)) return 'Names cannot end with a period or a space.';
  if (RESERVED.test(n)) return `"${n}" is a reserved name on Windows.`;
  return null;
}

export const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name);

/** "notes" -> "notes.md"; leaves existing .md/.markdown alone. */
export function withMarkdownExt(name: string): string {
  const n = name.trim();
  return isMarkdownName(n) ? n : `${n}.md`;
}

const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/');

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p : p.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + sepOf(dir) + name;
}

/** `joinPath` over several parts: joinParts(dir, 'a', 'b') → dir/a/b. */
export const joinParts = (dir: string, ...parts: string[]): string => parts.reduce(joinPath, dir);

/** If `p` is `from` or inside it, returns the same location under `to`; otherwise `p` unchanged. */
export function remapPath(p: string, from: string, to: string): string {
  if (p === from) return to;
  if (p.startsWith(from + '/') || p.startsWith(from + '\\')) return to + p.slice(from.length);
  return p;
}

export function isInside(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + '/') || p.startsWith(dir + '\\');
}
