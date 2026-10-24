/**
 * Windows-compliant names, enforced on every device that syncs (desktop and phone). One rule set so a file made on
 * Android is always storable on Windows: no illegal characters, no reserved device names, no trailing dot or space,
 * Unicode NFC, case-insensitive uniqueness and a length cap that keeps paths under Windows' 260-character limit.
 * Pure: no Node APIs, so it runs in the renderer, the main process and the phone.
 */
import { validateName } from '../paths';

export const MAX_NAME_LENGTH = 120;

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** The key two names are compared by: NFC and case-folded, because Windows treats "Ch1.md" and "ch1.md" as one file. */
export const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();

/** Splits "chapter.draft.md" into ["chapter.draft", ".md"]; a leading dot is part of the stem (".mdedit" → [".mdedit", ""]). */
function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
}

/** An error message for a name that is not Windows-compliant, or null. Stricter than `validateName` (length cap, NFC, leading space). */
export function complianceError(name: string): string | null {
  const base = validateName(name);
  if (base) return base;
  if (name !== name.trim()) return 'Names cannot start or end with a space.';
  if (name !== name.normalize('NFC')) return 'Names must be Unicode-normalised (NFC).';
  if (name.length > MAX_NAME_LENGTH) return `Names can be at most ${MAX_NAME_LENGTH} characters.`;
  return null;
}

export const isCompliantName = (name: string): boolean => complianceError(name) === null;

/** Turns any name into a compliant one with the fewest changes. Idempotent: a compliant name comes back unchanged. */
export function toCompliantName(name: string): string {
  let n = name.normalize('NFC').replace(ILLEGAL, '_').trim();
  n = n.replace(/[. ]+$/, '');
  if (n === '' || n === '.' || n === '..') return 'Untitled';
  // Windows reserves the part before the FIRST dot ("PRN.tar.gz" is as reserved as "PRN").
  if (RESERVED.test(n)) n = n.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, '$1_');
  if (n.length > MAX_NAME_LENGTH) {
    const [stem, ext] = splitExt(n);
    n = stem.slice(0, MAX_NAME_LENGTH - ext.length).replace(/[. ]+$/, '') + ext;
    if (n === '' || n.startsWith('.') && n.length === ext.length) n = 'Untitled' + ext;
  }
  return n;
}

/** `name` made unique against `taken` (compared with `nameKey`) by inserting " 2", " 3"… before the extension. */
export function uniqueCompliantName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(nameKey(t));
  const first = toCompliantName(name);
  if (!used.has(nameKey(first))) return first;
  const [stem, ext] = splitExt(first);
  for (let n = 2; n < 10_000; n++) {
    const suffix = ` ${n}`;
    const candidate = toCompliantName(stem.slice(0, MAX_NAME_LENGTH - ext.length - suffix.length) + suffix + ext);
    if (!used.has(nameKey(candidate))) return candidate;
  }
  return toCompliantName(`${stem} ${Date.now()}${ext}`);
}

/** Compliant-izes every segment of a "/"-separated relative path. */
export function toCompliantPath(rel: string): string {
  return rel.split('/').map(toCompliantName).join('/');
}

export const isCompliantPath = (rel: string): boolean => rel.split('/').every(isCompliantName);

/** "Chapter 3.md" → "Chapter 3 (conflict - Pixel - 2026-10-05).md", unique against `taken` (names in the same folder). */
export function conflictCopyName(fileName: string, device: string, date: string, taken: Iterable<string> = []): string {
  const [stem, ext] = splitExt(fileName);
  const tag = ` (conflict - ${toCompliantName(device).replace(/[()]/g, '')} - ${date})`;
  const room = Math.max(1, MAX_NAME_LENGTH - ext.length - tag.length);
  return uniqueCompliantName(stem.slice(0, room).replace(/[. ]+$/, '') + tag + ext, taken);
}

/** True for a name made by `conflictCopyName`, so scans and the UI can list conflicts. */
export const isConflictCopyName = (name: string): boolean => /\(conflict - .+ - \d{4}-\d{2}-\d{2}\)( \d+)?(\.[^.]*)?$/.test(name);
