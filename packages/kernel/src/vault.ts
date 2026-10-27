/**
 * Vault check-out / check-in, the PDM model. The server is the only authority on locks; this module is the logic,
 * written against a tiny async SQL interface so it runs on D1 (Worker) and on node:sqlite (tests): both are SQLite.
 *
 * Every state change that must be atomic is either one statement or one `batch` (a transaction in D1).
 * The lock is a row in `checkout` keyed by file id, so two simultaneous check-outs cannot both insert it.
 */

export interface Db {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run statements in order as one transaction; return each one's change count. */
  batch(statements: { sql: string; params?: unknown[] }[]): Promise<{ changes: number }[]>;
}

export interface LockInfo {
  fileId: string;
  personId: string;
  machine: string;
  since: string;
  baseVersion: number;
}

export type CheckOutResult = { ok: true; baseVersion: number } | { ok: false; reason: 'locked'; heldBy: LockInfo } | { ok: false; reason: 'no-such-file' };

export async function getLock(db: Db, fileId: string): Promise<LockInfo | null> {
  return db.first<LockInfo>('SELECT file_id AS fileId, person_id AS personId, machine, since, base_version AS baseVersion FROM checkout WHERE file_id = ?', [fileId]);
}

/** Take the lock. One conditional insert: it succeeds only if nobody holds the file. */
export async function checkOut(db: Db, a: { fileId: string; personId: string; machine: string; now: string }): Promise<CheckOutResult> {
  const r = await db.run(
    `INSERT INTO checkout (file_id, person_id, machine, since, base_version)
       SELECT id, ?, ?, ?, current_version FROM vault_file WHERE id = ?
     ON CONFLICT(file_id) DO NOTHING`,
    [a.personId, a.machine, a.now, a.fileId]
  );
  if (r.changes === 1) {
    await db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [a.now, a.personId, 'file.checkout', a.fileId, a.machine]);
    const lock = await getLock(db, a.fileId);
    return { ok: true, baseVersion: lock?.baseVersion ?? 0 };
  }
  const held = await getLock(db, a.fileId);
  if (held) return { ok: false, reason: 'locked', heldBy: held };
  return { ok: false, reason: 'no-such-file' };
}

export type CheckInResult = { ok: true; version: number } | { ok: false; reason: 'not-holder' };

/**
 * Save a new version and release the lock, only if this person and machine still hold it. The version insert is
 * guarded by the lock row itself, so a force-release landing between the caller's check and this batch makes
 * the insert write nothing and the call report `not-holder`; the caller's file is then an orphan, never lost.
 */
export async function checkIn(db: Db, a: { fileId: string; personId: string; machine: string; hash: string; size: number; comment: string; now: string }): Promise<CheckInResult> {
  const [ins] = await db.batch([
    {
      sql: `INSERT INTO file_version (file_id, n, hash, size, author, comment, created_at)
              SELECT f.id, f.current_version + 1, ?, ?, ?, ?, ?
              FROM vault_file f
              WHERE f.id = ? AND EXISTS (SELECT 1 FROM checkout c WHERE c.file_id = f.id AND c.person_id = ? AND c.machine = ?)`,
      params: [a.hash, a.size, a.personId, a.comment, a.now, a.fileId, a.personId, a.machine]
    },
    { sql: 'UPDATE vault_file SET current_version = COALESCE((SELECT MAX(n) FROM file_version WHERE file_id = ?), 0) WHERE id = ?', params: [a.fileId, a.fileId] },
    {
      sql: 'DELETE FROM checkout WHERE file_id = ? AND person_id = ? AND machine = ? AND EXISTS (SELECT 1 FROM file_version v WHERE v.file_id = ? AND v.hash = ? AND v.created_at = ?)',
      params: [a.fileId, a.personId, a.machine, a.fileId, a.hash, a.now]
    }
  ]);
  if (!ins || ins.changes !== 1) return { ok: false, reason: 'not-holder' };
  const f = await db.first<{ current_version: number }>('SELECT current_version FROM vault_file WHERE id = ?', [a.fileId]);
  await db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [a.now, a.personId, 'file.checkin', a.fileId, a.comment]);
  return { ok: true, version: f?.current_version ?? 0 };
}

/** The holder abandons their changes. */
export async function undoCheckOut(db: Db, a: { fileId: string; personId: string; machine: string; now: string }): Promise<boolean> {
  const r = await db.run('DELETE FROM checkout WHERE file_id = ? AND person_id = ? AND machine = ?', [a.fileId, a.personId, a.machine]);
  if (r.changes === 1) await db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [a.now, a.personId, 'file.undo-checkout', a.fileId, a.machine]);
  return r.changes === 1;
}

export type ForceResult = { ok: true; released: LockInfo } | { ok: false; reason: 'reason-required' | 'not-locked' };

/**
 * An administrator breaks someone else's lock. The holder's uncommitted work is not in the vault, so it is lost to
 * the vault: the lock becomes an `orphan` record telling the holder's machine to keep its copy aside, flagged. The
 * caller must already have checked the `vault.force` capability; this refuses without a typed reason.
 */
export async function forceRelease(db: Db, a: { fileId: string; adminId: string; reason: string; now: string }): Promise<ForceResult> {
  if (a.reason.trim().length === 0) return { ok: false, reason: 'reason-required' };
  const held = await getLock(db, a.fileId);
  if (!held) return { ok: false, reason: 'not-locked' };
  await db.batch([
    {
      sql: `INSERT INTO orphan (file_id, person_id, machine, base_version, removed_by, removed_at, reason)
              SELECT file_id, person_id, machine, base_version, ?, ?, ? FROM checkout WHERE file_id = ? AND person_id = ? AND machine = ?`,
      params: [a.adminId, a.now, a.reason, a.fileId, held.personId, held.machine]
    },
    { sql: 'DELETE FROM checkout WHERE file_id = ? AND person_id = ? AND machine = ?', params: [a.fileId, held.personId, held.machine] },
    {
      sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
      params: [a.now, a.adminId, 'file.force-release', a.fileId, JSON.stringify({ holder: held.personId, machine: held.machine, reason: a.reason })]
    }
  ]);
  return { ok: true, released: held };
}

/** Orphans a person's machines should keep aside (and tell them about) the next time they connect. */
export async function pendingOrphans(db: Db, personId: string): Promise<{ fileId: string; machine: string; baseVersion: number; removedBy: string; removedAt: string; reason: string }[]> {
  return db.all('SELECT file_id AS fileId, machine, base_version AS baseVersion, removed_by AS removedBy, removed_at AS removedAt, reason FROM orphan WHERE person_id = ? AND acknowledged_at IS NULL', [personId]);
}

// ---- files: paths, kinds, listing --------------------------------------------------------------------------------------------

export type VaultKind = 'manuscript' | 'asset';
/** Listed for documentation: these are assets, as is every other extension. */
export const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'psd', 'ai', 'indd', 'eps', 'pdf', 'kra', 'xcf', 'otf', 'ttf', 'woff', 'woff2', 'mp3', 'wav', 'm4a', 'm4b', 'mp4', 'mov', 'zip']);
/**
 * What kind of file this is, which decides the capability that governs it (docs/PERMISSIONS.md: for file edits the vault adds the lock rule on
 * top of the permission for the kind of thing the file is). Text and documents are manuscripts; images, design files, fonts, audio and video are
 * assets; anything else is treated as an asset too, as the narrower default for files nobody classified.
 */
export function fileKind(path: string): VaultKind {
  const name = path.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (ext === '') return 'manuscript'; // a file with no extension is plain text until someone says otherwise
  if (['md', 'markdown', 'txt', 'rtf', 'doc', 'docx', 'odt', 'epub', 'fountain', 'html', 'htm', 'json', 'csv'].includes(ext)) return 'manuscript';
  return 'asset';
}

/** A vault path: relative, "/" separated, no "." or ".." parts, no characters Windows refuses, no name Windows reserves. Returns the cleaned path or a reason it is refused. */
export function cleanVaultPath(raw: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'A path is text.' };
  const p = raw.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/{2,}/g, '/');
  if (!p || p.length > 400) return { ok: false, reason: 'A path is 1 to 400 characters.' };
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return { ok: false, reason: 'A path cannot contain . or .. parts.' };
    if (/[<>:"|?*\x00-\x1f]/.test(part)) return { ok: false, reason: `“${part}” contains a character that is not allowed in a file name.` };
    if (/[. ]$/.test(part)) return { ok: false, reason: `“${part}” ends with a dot or a space.` };
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part)) return { ok: false, reason: `“${part}” is a name Windows reserves.` };
  }
  if (parts[0] === '.cadrel-vault') return { ok: false, reason: 'That folder is Cadrel’s own.' };
  return { ok: true, path: p };
}

export interface VaultFileRow {
  id: string;
  path: string;
  currentVersion: number;
  state: string;
  /** The hash of the current version, or null before the first check-in. */
  hash: string | null;
  size: number | null;
  lock: Pick<LockInfo, 'personId' | 'machine' | 'since' | 'baseVersion'> | null;
}

/** Puts a new, empty file in the vault (version 0, no lock). A path is unique in a studio, ignoring case, as on Windows. */
export async function addVaultFile(db: Db, a: { studioId: string; path: string; personId: string; now: string; id: string }): Promise<{ ok: true; id: string } | { ok: false; reason: 'exists' }> {
  const clash = await db.first<{ id: string }>('SELECT id FROM vault_file WHERE studio_id = ? AND lower(path) = lower(?)', [a.studioId, a.path]);
  if (clash) return { ok: false, reason: 'exists' };
  try {
    await db.batch([
      { sql: 'INSERT INTO vault_file (id, studio_id, path) VALUES (?, ?, ?)', params: [a.id, a.studioId, a.path] },
      { sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', params: [a.now, a.personId, 'file.add', a.id, a.path] }
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String((e as Error)?.message ?? e))) return { ok: false, reason: 'exists' };
    throw e;
  }
  return { ok: true, id: a.id };
}

export async function listVaultFiles(db: Db, studioId: string): Promise<VaultFileRow[]> {
  const rows = await db.all<{ id: string; path: string; currentVersion: number; state: string; hash: string | null; size: number | null; lp: string | null; lm: string | null; ls: string | null; lb: number | null }>(
    `SELECT f.id, f.path, f.current_version AS currentVersion, f.state, v.hash, v.size, c.person_id AS lp, c.machine AS lm, c.since AS ls, c.base_version AS lb
       FROM vault_file f LEFT JOIN file_version v ON v.file_id = f.id AND v.n = f.current_version LEFT JOIN checkout c ON c.file_id = f.id
      WHERE f.studio_id = ? ORDER BY lower(f.path)`, [studioId]);
  return rows.map((r) => ({ id: r.id, path: r.path, currentVersion: r.currentVersion, state: r.state, hash: r.hash, size: r.size, lock: r.lp ? { personId: r.lp, machine: r.lm!, since: r.ls!, baseVersion: r.lb! } : null }));
}

export interface FileVersion { n: number; hash: string; size: number; author: string; comment: string; createdAt: string }
export async function fileVersions(db: Db, fileId: string): Promise<FileVersion[]> {
  return db.all<FileVersion>('SELECT n, hash, size, author, comment, created_at AS createdAt FROM file_version WHERE file_id = ? ORDER BY n DESC', [fileId]);
}

/** The holder's machine has kept its copy aside: mark that lock removal as seen. */
export async function acknowledgeOrphans(db: Db, a: { personId: string; machine: string; fileId: string; now: string }): Promise<void> {
  await db.run('UPDATE orphan SET acknowledged_at = ? WHERE person_id = ? AND machine = ? AND file_id = ? AND acknowledged_at IS NULL', [a.now, a.personId, a.machine, a.fileId]);
}
