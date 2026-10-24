/**
 * Which chapters are marked as edited, kept in a small file of their own (`.mdedit/edited.json`) so two devices can
 * merge their marks instead of one overwriting the other. Every chapter remembers when it was last marked or unmarked,
 * and the newest answer wins per chapter: a mark made on one device and a different mark made on the other both
 * survive (a union), and an unmark is kept as a note so the mark does not come back from the other device.
 */

export const EDITED_FILE = 'edited.json';

export interface Mark {
  edited: boolean;
  /** When it was last changed (ms since the epoch). */
  at: number;
}

export interface EditedMarks {
  version: 1;
  /** File (relative to the project, "/" separated) → chapter id → mark. */
  files: Record<string, Record<string, Mark>>;
}

export const emptyMarks = (): EditedMarks => ({ version: 1, files: {} });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Defensive parse of the file. */
export function sanitizeMarks(raw: unknown): EditedMarks {
  const out = emptyMarks();
  if (!isObj(raw) || !isObj(raw.files)) return out;
  for (const [file, chapters] of Object.entries(raw.files).slice(0, 5000)) {
    if (!isObj(chapters)) continue;
    const marks: Record<string, Mark> = {};
    for (const [id, m] of Object.entries(chapters).slice(0, 5000)) {
      if (id.length <= 500 && isObj(m) && typeof m.edited === 'boolean' && typeof m.at === 'number' && Number.isFinite(m.at)) marks[id] = { edited: m.edited, at: m.at };
    }
    if (Object.keys(marks).length) out.files[file] = marks;
  }
  return out;
}

/** The chapters currently marked edited, per file (what the app works with). */
export function marksToMap(marks: EditedMarks): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [file, chapters] of Object.entries(marks.files)) {
    const ids = Object.entries(chapters).filter(([, m]) => m.edited).map(([id]) => id);
    if (ids.length) out[file] = ids;
  }
  return out;
}

/** Records the difference between what is marked now and `next` (stamped `at`). Returns the same object when nothing changed. */
export function applyMap(marks: EditedMarks, next: Record<string, readonly string[]>, at: number): EditedMarks {
  const now = marksToMap(marks);
  const files = { ...marks.files };
  let changed = false;
  const set = (file: string, id: string, edited: boolean) => {
    files[file] = { ...(files[file] ?? {}), [id]: { edited, at } };
    changed = true;
  };
  for (const [file, ids] of Object.entries(now)) for (const id of ids) if (!next[file]?.includes(id)) set(file, id, false);
  for (const [file, ids] of Object.entries(next)) for (const id of ids) if (!now[file]?.includes(id)) set(file, id, true);
  return changed ? { version: 1, files } : marks;
}

/** Merges two devices' marks: every chapter either side knows about; where both do, the newer change wins (a tie keeps the mark). */
export function mergeMarks(a: EditedMarks, b: EditedMarks): EditedMarks {
  const files: Record<string, Record<string, Mark>> = {};
  for (const src of [a, b]) {
    for (const [file, chapters] of Object.entries(src.files)) {
      const into = (files[file] ??= {});
      for (const [id, m] of Object.entries(chapters)) {
        const mine = into[id];
        if (!mine || m.at > mine.at || (m.at === mine.at && m.edited)) into[id] = m;
      }
    }
  }
  return { version: 1, files };
}
