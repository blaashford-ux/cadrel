/**
 * Book settings come in layers: the app's settings, then the project's, then the book's own. A layer
 * above the app stores only the fields it changes (an "overrides" map from field path to value);
 * every other field is read from the layer below at the moment it is needed, so editing a project
 * default reaches every book in the project that has not set that field itself.
 *
 * A field path is the dotted path of a leaf in BookDetails ("export.pdf.chapterSink"). Arrays
 * (extra lines, link lists, excluded chapters) are leaves: they are overridden whole.
 */

import { defaultAppDefaults } from '../appDefaults';
import { defaultBookDetails, sanitizeBookDetails, type BookDetails } from './model';

/** Field path → value. Only the fields a layer sets itself. */
export type Overrides = Record<string, unknown>;

/** Where an inherited value comes from. */
export type Origin = 'app' | 'project';

/** Identity of one book: never layered (stored beside the overrides). */
export const IDENTITY_KEYS = ['version', 'marked', 'title', 'subtitle'] as const;
/** Fields that belong to one book alone: a project or the app never supplies them. */
export const BOOK_ONLY = new Set(['export.excludedChapters', 'export.epub.coverImage']);

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function flatten(obj: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v)) flatten(v, path, out);
    else out.push(path);
  }
}

/** Every layerable field. */
export const LEAF_PATHS: readonly string[] = (() => {
  const out: string[] = [];
  flatten(defaultBookDetails() as unknown as Record<string, unknown>, '', out);
  return out.filter((p) => !(IDENTITY_KEYS as readonly string[]).includes(p));
})();
const LEAF_SET = new Set(LEAF_PATHS);

export const isLayerPath = (p: string): boolean => LEAF_SET.has(p);
/** Whether a project or the app can supply this field (false = it is set on each book). */
export const inheritable = (p: string): boolean => !BOOK_ONLY.has(p);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!isPlain(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlain(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `base` with the overrides laid over it, validated. Unknown paths are ignored. */
export function applyOverrides(base: BookDetails, overrides: Overrides): BookDetails {
  const d = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [p, v] of Object.entries(overrides)) if (LEAF_SET.has(p)) setPath(d, p, structuredClone(v));
  return sanitizeBookDetails(d);
}

/** Only the known fields of untrusted input, each value validated the way a saved book's would be. */
export function sanitizeOverrides(raw: unknown): Overrides {
  if (!isPlain(raw)) return {};
  const picked: Overrides = {};
  for (const [p, v] of Object.entries(raw)) if (LEAF_SET.has(p) && v !== undefined) picked[p] = v;
  const clean = applyOverrides(defaultBookDetails(), picked);
  const out: Overrides = {};
  for (const p of Object.keys(picked)) out[p] = getPath(clean, p);
  return out;
}

/** The fields where `details` differs from `base`. */
export function diffOverrides(base: BookDetails, details: BookDetails): Overrides {
  const out: Overrides = {};
  for (const p of LEAF_PATHS) {
    const v = getPath(details, p);
    if (!same(v, getPath(base, p))) out[p] = structuredClone(v);
  }
  return out;
}

/** The values of the listed fields, as an overrides map (unknown paths dropped). */
export function pickOverrides(details: BookDetails, paths: readonly string[]): Overrides {
  const out: Overrides = {};
  for (const p of paths) if (LEAF_SET.has(p)) out[p] = structuredClone(getPath(details, p));
  return out;
}

/** What a project can supply: its overrides without the book-only fields. */
export function projectLayer(overrides: Overrides): Overrides {
  return Object.fromEntries(Object.entries(overrides).filter(([p]) => inheritable(p)));
}

/** Projects saved before layering held a whole book; keep what it changed relative to the built-in app defaults. */
export function overridesFromLegacyBook(raw: unknown): Overrides {
  return projectLayer(diffOverrides(defaultAppDefaults().book, sanitizeBookDetails(raw)));
}

export interface Inherited {
  /** The book as the project and the app would make it (no title yet; a blank year means this year). */
  details: BookDetails;
  origins: Record<string, Origin>;
}

/** What a book in this project starts from: the app's settings with the project's overrides laid over them. */
export function resolveInherited(app: BookDetails, projectOverrides: Overrides, now: Date = new Date()): Inherited {
  const layer = projectLayer(sanitizeOverrides(projectOverrides));
  const details = applyOverrides(app, layer);
  details.title = '';
  details.subtitle = '';
  details.marked = true;
  if (!details.copyright.year.trim()) details.copyright.year = String(now.getFullYear());
  const origins: Record<string, Origin> = {};
  for (const p of LEAF_PATHS) origins[p] = p in layer ? 'project' : 'app';
  return { details, origins };
}

/** A short readable name for a field path ("export.pdf.chapterSink" → "PDF › Chapter sink"). */
export function pathLabel(path: string): string {
  const words = (s: string) => s.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const top: Record<string, string> = { epub: 'EPUB', pdf: 'PDF', docx: 'DOCX', back: 'Back matter', copyright: 'Copyright page' };
  const parts = path.split('.').filter((p, i) => !(i === 0 && p === 'export'));
  return parts.map((p, i) => (i === 0 && top[p] ? top[p] : words(p))).join(' › ');
}

/** A short preview of a field's value for lists. */
export function valueLabel(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) return v.length === 0 ? 'None' : `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'string') return v.trim() === '' ? '(blank)' : v.length > 48 ? v.slice(0, 45) + '…' : v;
  return String(v);
}
