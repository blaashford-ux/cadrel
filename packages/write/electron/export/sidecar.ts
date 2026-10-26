import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { defaultAppDefaults, type AppDefaults } from '../../src/shared/appDefaults';
import { applyOverrides, BOOK_ONLY, diffOverrides, LEAF_PATHS, pickOverrides, sanitizeOverrides, type Origin } from '../../src/shared/export/layers';
import { sanitizeBookDetails, type BookDetails } from '../../src/shared/export/model';
import { sidecarPathFor, stemOf } from '../../src/shared/export/sidecar';
import { writeFileAtomic } from '../files';

export interface LoadedDetails {
  /** The book as it exports: the app's settings, the project's, then this book's own. */
  details: BookDetails;
  /** What the book would be with none of its own settings (no title yet). */
  inherited: BookDetails;
  /** For each field the book does not set itself: whether the project or the app supplies it. */
  origins: Record<string, Origin>;
  /** The fields this book sets itself (paths into BookDetails). */
  overrides: string[];
  /** False when no sidecar exists yet (the details are fresh defaults). */
  exists: boolean;
  /** True when the file was unreadable/corrupt; it is backed up before the next save. */
  damaged: boolean;
}

/**
 * What is on disk: the book's identity, and only the fields it sets itself. Everything else is read from
 * the project and the app each time, so changing those reaches the book. (Files written before layering
 * held a whole book; they are converted on first read.)
 */
interface SidecarFile {
  version: 1;
  marked: boolean;
  title: string;
  subtitle: string;
  overrides: Record<string, unknown>;
}

const seedFor = (mdPath: string) => ({ title: stemOf(basename(mdPath)) });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The app's settings with the project's laid over them (already merged in `defaults`), made ready for one book. */
function inheritedFor(defaults: AppDefaults, now: Date): BookDetails {
  const d = structuredClone(defaults.book);
  d.title = '';
  d.subtitle = '';
  d.marked = true;
  if (!d.copyright.year.trim()) d.copyright.year = String(now.getFullYear());
  return d;
}

function originsFor(projectFields: readonly string[]): Record<string, Origin> {
  const fromProject = new Set(projectFields);
  return Object.fromEntries(LEAF_PATHS.map((p) => [p, fromProject.has(p) ? 'project' : 'app'] as const));
}

function resolve(inherited: BookDetails, file: SidecarFile): BookDetails {
  return { ...applyOverrides(inherited, file.overrides), marked: file.marked, title: file.title, subtitle: file.subtitle };
}

/** The fields to store for `details`: the listed ones, plus anything book-only that differs from the blank starting point. */
function toSidecar(details: BookDetails, paths: readonly string[], inherited: BookDetails): SidecarFile {
  const all = new Set(paths);
  for (const p of Object.keys(diffOverrides(inherited, details))) if (BOOK_ONLY.has(p)) all.add(p);
  return { version: 1, marked: details.marked, title: details.title, subtitle: details.subtitle, overrides: pickOverrides(details, [...all]) };
}

const stringify = (f: SidecarFile) => JSON.stringify(f, null, 2) + '\n';

/**
 * `defaults` is the app's settings with the enclosing project's laid over them; `projectFields` names the fields
 * the project sets (so the book can show where each inherited value comes from).
 */
export async function loadDetails(
  mdPath: string,
  defaults: AppDefaults = defaultAppDefaults(),
  projectFields: readonly string[] = [],
  now: Date = new Date()
): Promise<LoadedDetails> {
  const file = sidecarPathFor(mdPath);
  const inherited = inheritedFor(defaults, now);
  const origins = originsFor(projectFields);
  const freshFile = (): SidecarFile => ({
    version: 1,
    marked: true,
    ...seedFor(mdPath),
    subtitle: '',
    // the year is pinned when a book is first set up, so it doesn't change when the calendar does
    overrides: { 'copyright.year': inherited.copyright.year }
  });
  const result = (f: SidecarFile, exists: boolean, damaged: boolean): LoadedDetails => ({
    details: resolve(inherited, f),
    inherited,
    origins,
    overrides: Object.keys(f.overrides),
    exists,
    damaged
  });

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return result(freshFile(), false, false);
    throw e;
  }
  try {
    const parsed = JSON.parse(text);
    let stored: SidecarFile;
    if (isObj(parsed) && isObj(parsed.overrides)) {
      stored = {
        version: 1,
        marked: typeof parsed.marked === 'boolean' ? parsed.marked : true,
        title: typeof parsed.title === 'string' ? parsed.title.slice(0, 500) : seedFor(mdPath).title,
        subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle.slice(0, 500) : '',
        overrides: sanitizeOverrides(parsed.overrides)
      };
    } else {
      // A file from before layering: keep what differs from what the book would inherit, and pin the year.
      const whole = sanitizeBookDetails(parsed, seedFor(mdPath));
      stored = toSidecar(whole, ['copyright.year', ...Object.keys(diffOverrides(inherited, whole))], inherited);
      await fs.copyFile(file, file + '.v1.bak', fs.constants.COPYFILE_EXCL).catch(() => undefined);
    }
    // Tidy up files written by older versions (renamed or dropped keys, missing new ones) the first time they are read.
    if (JSON.stringify(parsed) !== JSON.stringify(stored)) await writeFileAtomic(file, stringify(stored)).catch(() => undefined);
    return result(stored, true, false);
  } catch {
    return result(freshFile(), true, true);
  }
}

/**
 * Saves atomically. `overrides` names the fields this book sets itself (default: those already set, plus any
 * that differ from what it inherits). A damaged existing file is kept as `.bak` first, never silently overwritten.
 */
export async function saveDetails(mdPath: string, details: BookDetails, overrides?: readonly string[], defaults: AppDefaults = defaultAppDefaults()): Promise<void> {
  const file = sidecarPathFor(mdPath);
  try {
    JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await fs.copyFile(file, file + '.bak').catch(() => undefined);
  }
  const clean = sanitizeBookDetails(details, seedFor(mdPath));
  const inherited = inheritedFor(defaults, new Date());
  const paths = overrides
    ? overrides.filter((p) => LEAF_PATHS.includes(p))
    : [...new Set([...(await loadDetails(mdPath, defaults)).overrides, ...Object.keys(diffOverrides(inherited, clean))])];
  await writeFileAtomic(file, stringify(toSidecar(clean, paths, inherited)));
}

/** Returns whether unreadable existing settings were replaced (their content is kept as `.bak`). */
export async function setMarked(mdPath: string, marked: boolean, defaults?: AppDefaults, projectFields?: readonly string[]): Promise<{ backedUp: boolean }> {
  const loaded = await loadDetails(mdPath, defaults, projectFields);
  if (!marked && !loaded.exists) return { backedUp: false }; // nothing to unmark
  await saveDetails(mdPath, { ...loaded.details, marked }, loaded.overrides, defaults);
  return { backedUp: loaded.damaged };
}

/** Keeps the sidecar with its manuscript when the file is renamed in the app. */
export async function renameSidecar(oldMd: string, newMd: string): Promise<void> {
  const from = sidecarPathFor(oldMd);
  const to = sidecarPathFor(newMd);
  if (from === to) return;
  try {
    await fs.lstat(from);
  } catch {
    return; // no sidecar
  }
  try {
    await fs.lstat(to);
    return; // never overwrite someone else's export settings
  } catch {
    await fs.rename(from, to);
  }
}

/** Path of the sidecar if one exists (so it can be moved to the Recycle Bin with its manuscript). */
export async function existingSidecar(mdPath: string): Promise<string | null> {
  const p = sidecarPathFor(mdPath);
  try {
    await fs.lstat(p);
    return p;
  } catch {
    return null;
  }
}
