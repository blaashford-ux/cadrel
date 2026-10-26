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
