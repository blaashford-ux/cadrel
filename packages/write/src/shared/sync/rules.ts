/**
 * What syncs and how a conflict is resolved, by file type. See docs/sync-rules.md section 4.
 * Paths are relative to the Root Folder, "/"-separated, e.g. "The Lost King/Manuscript/Ch 1.md".
 */

export type FileClass =
  /** Chapter text and notes: keep both versions on conflict. */
  | 'prose'
  /** Per-day writing history: merged day by day. */
  | 'progress'
  /** Edited-chapter marks: merged chapter by chapter, newest change wins. */
  | 'marks'
  /** A reviewer's notes file (.mdedit/review/<id>.json): merged note by note, so notes made on two devices both survive. */
  | 'notes'
  /** Project / export settings: last writer wins (a conflict copy would confuse the project scan). */
  | 'meta'
  /** Anything else small (images…): last writer wins. */
  | 'asset';

const MARKDOWN = /\.(md|markdown)$/i;

/** Temp and backup files that atomic writes leave behind, and OS litter. Never synced. */
/** Local folder (inside the Root) for projects other people shared for review. */
export const SHARED_WITH_ME = 'Shared With Me';

const JUNK = [/\.tmp$/i, /\.bak$/i, /\.partial$/i, /^~/, /^\.~lock\./, /^thumbs\.db$/i, /^desktop\.ini$/i, /^\.ds_store$/i, /\.mdedit-\d+\.tmp$/i];

/** Output folders that are large and regenerable (Exports/ directly inside a project). */
const isExportsFolder = (segments: string[]) => segments.length >= 3 && segments[1].toLowerCase() === 'exports';

/**
 * The class of a relative path, or null when it must never sync. `includeExports` is the optional toggle for
 * EPUB/PDF/DOCX outputs.
 */
export function classify(rel: string, opts: { includeExports?: boolean } = {}): FileClass | null {
  const segments = rel.split('/');
  if (segments[0] === SHARED_WITH_ME) return null; // other people's projects never go into your own Drive
  const name = segments[segments.length - 1];
  if (JUNK.some((re) => re.test(name))) return null;
  if (!opts.includeExports && isExportsFolder(segments)) return null;

  // Inside a hidden `.mdedit` folder only the known files travel; anything else there is per device (drafts, caches).
  const hidden = segments.findIndex((s) => s.toLowerCase() === '.mdedit');
  if (hidden >= 0) {
    // Review notes: one file per reviewer (and per AI pass) in .mdedit/review.
    if (hidden === segments.length - 3 && segments[hidden + 1].toLowerCase() === 'review') return /^[\w.-]+\.json$/i.test(name) ? 'notes' : null;
    if (hidden !== segments.length - 2) return null;
    if (/^progress(-[0-9a-f]+)?\.json$/i.test(name)) return 'progress';
    if (/^edited\.json$/i.test(name)) return 'marks';
    if (/^(project|settings)\.json$/i.test(name)) return 'meta';
    return null;
  }
  if (segments.some((s) => s.startsWith('.'))) return null; // .git and friends
  if (MARKDOWN.test(name)) return 'prose';
  if (/\.export\.json$/i.test(name)) return 'meta';
  return 'asset';
}

/** Longest relative path the app will sync, leaving room for the Root Folder's own path under Windows' 260 limit. */
export const MAX_REL_PATH = 200;
