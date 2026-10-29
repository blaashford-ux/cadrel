/**
 * References between vault files, where-used, and data cards. Records over the kernel's `Db`; who may do what is the caller's business
 * (the local vault checks the capability for the kind of file).
 *
 * A reference says "this file uses that one", optionally at a version. "Where used" is the same rows read the other way. A data card is a
 * handful of text facts about a file (trim size, licence, purpose…) and the project it belongs to.
 */
import type { Db } from './vault';

export class FileLinkError extends Error {
  constructor(readonly code: 'invalid' | 'not-found' | 'exists', message: string) {
    super(message);
  }
}
const fail = (code: FileLinkError['code'], m: string): never => {
  throw new FileLinkError(code, m);
};
const audit = (a: { now: string; actor: string }, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [a.now, a.actor, action, target, JSON.stringify(detail)]
});

export interface FileRef {
  fileId: string;
  path: string;
  /** The version the reference names, or null for "the latest". */
  version: number | null;
  /** The newest version of the file referred to. */
  currentVersion: number;
  note: string;
  /** True when the reference names a version and a newer one exists: a person decides whether to update it. */
  stale: boolean;
}

interface RefRow { fileId: string; path: string; version: number | null; currentVersion: number; note: string }
const toRef = (r: RefRow): FileRef => ({ ...r, stale: r.version !== null && r.version < r.currentVersion });

/** `fileId` uses `refersToId`, at a version or the latest. Refused for itself, for a file that is not there, or a version that does not exist. */
export async function addReference(db: Db, a: { fileId: string; refersToId: string; version?: number | null; note?: string; actor: string; now: string }): Promise<void> {
  if (a.fileId === a.refersToId) fail('invalid', 'A file cannot refer to itself.');
  const to = await db.first<{ current_version: number }>('SELECT current_version FROM vault_file WHERE id = ?', [a.refersToId]);
  if (!to || !(await db.first('SELECT 1 AS x FROM vault_file WHERE id = ?', [a.fileId]))) return fail('not-found', 'That file is not in the vault.');
  const version = a.version ?? null;
  if (version !== null && (!Number.isInteger(version) || version < 1 || version > to.current_version)) fail('invalid', 'That version does not exist.');
  const note = (a.note ?? '').trim();
  if (note.length > 300) fail('invalid', 'A note is 300 characters at most.');
  try {
    await db.batch([
      { sql: 'INSERT INTO file_reference (file_id, refers_to_id, version, note, created_at, created_by) VALUES (?,?,?,?,?,?)', params: [a.fileId, a.refersToId, version, note, a.now, a.actor] },
      audit(a, 'file.reference', a.fileId, { refersToId: a.refersToId, version })
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed|PRIMARY KEY|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message ?? e))) fail('exists', 'It already refers to that file. Change the version instead.');
    throw e;
  }
}

/** Points an existing reference at another version (or the latest with null). The only way a reference changes. */
export async function setReferenceVersion(db: Db, a: { fileId: string; refersToId: string; version: number | null; actor: string; now: string }): Promise<void> {
  const to = await db.first<{ current_version: number }>('SELECT current_version FROM vault_file WHERE id = ?', [a.refersToId]);
  if (!to) return fail('not-found', 'That file is not in the vault.');
  if (a.version !== null && (!Number.isInteger(a.version) || a.version < 1 || a.version > to.current_version)) fail('invalid', 'That version does not exist.');
  const r = await db.batch([
    { sql: 'UPDATE file_reference SET version = ? WHERE file_id = ? AND refers_to_id = ?', params: [a.version, a.fileId, a.refersToId] },
    audit(a, 'file.reference-version', a.fileId, { refersToId: a.refersToId, version: a.version })
  ]);
  if (r[0]!.changes !== 1) fail('not-found', 'There is no such reference.');
}

export async function removeReference(db: Db, a: { fileId: string; refersToId: string; actor: string; now: string }): Promise<void> {
  await db.batch([{ sql: 'DELETE FROM file_reference WHERE file_id = ? AND refers_to_id = ?', params: [a.fileId, a.refersToId] }, audit(a, 'file.unreference', a.fileId, { refersToId: a.refersToId })]);
}

/** What a file uses. */
export async function referencesOf(db: Db, fileId: string): Promise<FileRef[]> {
  return (await db.all<RefRow>('SELECT f.id AS fileId, f.path, r.version, f.current_version AS currentVersion, r.note FROM file_reference r JOIN vault_file f ON f.id = r.refers_to_id WHERE r.file_id = ? ORDER BY lower(f.path)', [fileId])).map(toRef);
}

/** Where a file is used: the files that refer to it, and whether each still names an older version of it. */
export async function whereUsed(db: Db, fileId: string): Promise<FileRef[]> {
  const cur = (await db.first<{ current_version: number }>('SELECT current_version FROM vault_file WHERE id = ?', [fileId]))?.current_version ?? 0;
  return (await db.all<Omit<RefRow, 'currentVersion'>>('SELECT f.id AS fileId, f.path, r.version, r.note FROM file_reference r JOIN vault_file f ON f.id = r.file_id WHERE r.refers_to_id = ? ORDER BY lower(f.path)', [fileId])).map((r) => toRef({ ...r, currentVersion: cur }));
}

// ---- data cards ---------------------------------------------------------------------------------------------------------------

export interface DataCard { fileId: string; projectId: string | null; fields: Record<string, string>; updatedAt: string | null; updatedBy: string | null }
const MAX_FIELDS = 30;

export function cleanFields(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid', 'A data card’s fields are a list of names and values.');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim().replace(/\s+/g, ' ');
    if (!key || key.length > 40 || /^(__proto__|constructor|prototype)$/.test(key)) fail('invalid', 'A field name is 1 to 40 characters.');
    if (typeof v !== 'string') fail('invalid', `“${key}” needs text.`);
    const val = (v as string).trim();
    if (val.length > 500) fail('invalid', `“${key}” is too long (500 characters at most).`);
    if (val !== '') Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true }); // an empty value removes the field
  }
  if (Object.keys(out).length > MAX_FIELDS) fail('invalid', `A data card has at most ${MAX_FIELDS} fields.`);
  return out;
}

export async function getCard(db: Db, fileId: string): Promise<DataCard> {
  const r = await db.first<{ projectId: string | null; fields: string; updatedAt: string; updatedBy: string }>('SELECT project_id AS projectId, fields, updated_at AS updatedAt, updated_by AS updatedBy FROM file_card WHERE file_id = ?', [fileId]);
  return r ? { fileId, projectId: r.projectId, fields: JSON.parse(r.fields) as Record<string, string>, updatedAt: r.updatedAt, updatedBy: r.updatedBy } : { fileId, projectId: null, fields: {}, updatedAt: null, updatedBy: null };
}

export async function setCard(db: Db, a: { fileId: string; fields: unknown; projectId?: string | null; actor: string; now: string }): Promise<DataCard> {
  if (!(await db.first('SELECT 1 AS x FROM vault_file WHERE id = ?', [a.fileId]))) fail('not-found', 'That file is not in the vault.');
  const fields = cleanFields(a.fields);
  await db.batch([
    { sql: 'INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES (?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET project_id = excluded.project_id, fields = excluded.fields, updated_at = excluded.updated_at, updated_by = excluded.updated_by', params: [a.fileId, a.projectId ?? null, JSON.stringify(fields), a.now, a.actor] },
    audit(a, 'file.card', a.fileId, { fields: Object.keys(fields), projectId: a.projectId ?? null })
  ]);
  return getCard(db, a.fileId);
}

/** Files whose card has this value for a field (case-insensitive, whole value) or whose card has the project: how cards are searched. */
export async function findByCard(db: Db, studioId: string, q: { field?: string; value?: string; projectId?: string }): Promise<{ fileId: string; path: string }[]> {
  const rows = await db.all<{ fileId: string; path: string; fields: string; projectId: string | null }>('SELECT f.id AS fileId, f.path, c.fields, c.project_id AS projectId FROM file_card c JOIN vault_file f ON f.id = c.file_id WHERE f.studio_id = ? ORDER BY lower(f.path)', [studioId]);
  return rows.filter((r) => (!q.projectId || r.projectId === q.projectId) && (!q.field || (() => {
    const f = JSON.parse(r.fields) as Record<string, string>;
    const key = Object.keys(f).find((k) => k.toLowerCase() === q.field!.toLowerCase());
    return key !== undefined && (q.value === undefined || f[key]!.toLowerCase() === q.value.toLowerCase());
  })())).map(({ fileId, path }) => ({ fileId, path }));
}
