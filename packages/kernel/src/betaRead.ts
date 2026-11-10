/**
 * Beta reading: which chapters of a manuscript file a Beta Reader is sent. The author switches chapters on; everything else, including a chapter
 * added later, stays off, so nothing reaches a beta reader unless it was turned on. Records over the kernel's `Db`; who may change them is the
 * caller's business (`VaultAs` needs the right to write the manuscript).
 */
import type { Db } from './vault';

export class BetaReadError extends Error {
  constructor(readonly code: 'invalid' | 'not-found', message: string) {
    super(message);
  }
}

export interface BetaRead {
  fileId: string;
  /** The heading level chapters are split at. */
  level: number;
  /** Keys of the chapters that are on, as `chapterKeys` names them (the preamble is `''`-keyed by the caller's convention). */
  chapters: string[];
}

const MAX_KEYS = 2000;
const MAX_KEY_LENGTH = 300;

/** The chapters switched on for a file: none when it has never been set up. */
export async function getBetaRead(db: Db, fileId: string): Promise<BetaRead> {
  const row = await db.first<{ level: number; chapters: string }>('SELECT level, chapters FROM beta_read WHERE file_id = ?', [fileId]);
  if (!row) return { fileId, level: 1, chapters: [] };
  let chapters: string[] = [];
  try {
    const raw = JSON.parse(row.chapters) as unknown;
    if (Array.isArray(raw)) chapters = raw.filter((k): k is string => typeof k === 'string');
  } catch {
    /* unreadable: treated as nothing on, which is the safe reading */
  }
  return { fileId, level: row.level, chapters };
}

/** Replaces the chapters that are on. An empty list turns beta reading of the file off. */
export async function setBetaRead(db: Db, a: { fileId: string; level: number; chapters: string[]; actor: string; now: string }): Promise<BetaRead> {
  if (!Number.isInteger(a.level) || a.level < 1 || a.level > 6) throw new BetaReadError('invalid', 'The chapter heading level must be from 1 to 6.');
  if (a.chapters.length > MAX_KEYS || a.chapters.some((k) => typeof k !== 'string' || k.length > MAX_KEY_LENGTH)) throw new BetaReadError('invalid', 'Those chapters are not valid.');
  if (!(await db.first('SELECT 1 AS x FROM vault_file WHERE id = ?', [a.fileId]))) throw new BetaReadError('not-found', 'That file is not in the vault.');
  const chapters = [...new Set(a.chapters)];
  await db.batch([
    {
      sql: 'INSERT INTO beta_read (file_id, level, chapters, updated_at, updated_by) VALUES (?,?,?,?,?) ON CONFLICT (file_id) DO UPDATE SET level = excluded.level, chapters = excluded.chapters, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      params: [a.fileId, a.level, JSON.stringify(chapters), a.now, a.actor]
    },
    { sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', params: [a.now, a.actor, 'file.beta-read', a.fileId, JSON.stringify({ level: a.level, chapters: chapters.length })] }
  ]);
  return { fileId: a.fileId, level: a.level, chapters };
}
