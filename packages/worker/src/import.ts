/**
 * Bringing a Studio's records across from the owner's computer, once, when the owner moves the Studio's records to its server. Rows arrive
 * table by table (parents first), replacing whatever the server held, in batches that each succeed or fail whole; running it again starts
 * over. Only the record tables can be written this way: who may sign in (members, invitations) stays as it is.
 */
import type { Db } from '@cadrel/kernel';
import { d1Db } from './d1';
import { forgetRecords, type RecordsEnv } from './records';

/** Parents before the tables that refer to them. Deleting goes the other way round. */
export const RECORD_TABLES = [
  'person', 'pen_name', 'pen_name_person', 'team', 'team_member', 'role', 'role_capability', 'assignment', 'capability_seen',
  'workflow', 'workflow_stage', 'workflow_transition', 'workflow_transition_role',
  'ip', 'series', 'book', 'edition', 'book_project', 'task', 'task_dependency', 'approval', 'approval_approver', 'decision',
  'vault_file', 'file_version', 'checkout', 'orphan', 'file_reference', 'file_card',
  'contribution', 'credit', 'rights', 'revenue_share', 'audit'
] as const;

const BATCH = 40;

async function columnsOf(db: Db, table: string): Promise<Set<string>> {
  return new Set((await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name));
}

export type ImportRequest = { phase: 'start' } | { phase: 'rows'; table: string; rows: Record<string, unknown>[] } | { phase: 'finish'; owner: string };

export async function importRecords(env: RecordsEnv, req: ImportRequest): Promise<{ ok: true; count?: number } | { ok: false; error: string }> {
  const db = d1Db(env.DB);
  if (req.phase === 'start') {
    for (let i = RECORD_TABLES.length - 1; i >= 0; i--) await db.run(`DELETE FROM ${RECORD_TABLES[i]}`);
    await forgetRecords(env);
    return { ok: true };
  }
  if (req.phase === 'rows') {
    if (!(RECORD_TABLES as readonly string[]).includes(req.table) || !Array.isArray(req.rows)) return { ok: false, error: 'That is not a table of the Studio’s records.' };
    if (!req.rows.length) return { ok: true, count: 0 };
    const known = await columnsOf(db, req.table);
    const cols = Object.keys(req.rows[0]!);
    if (!cols.length || cols.some((c) => !/^[a-z_][a-z0-9_]*$/.test(c) || !known.has(c))) return { ok: false, error: `The columns of ${req.table} are not the server’s.` };
    const sql = `INSERT OR REPLACE INTO ${req.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    // the records carry the id of the Studio they were made in (on the owner's computer, often just 'local'); here the Studio has its own
    const here = (r: Record<string, unknown>): Record<string, unknown> => {
      const row = { ...r };
      if ('studio_id' in row) row.studio_id = env.STUDIO_ID;
      if (req.table === 'assignment' && row.scope_kind === 'studio') row.scope_id = env.STUDIO_ID;
      return row;
    };
    for (let i = 0; i < req.rows.length; i += BATCH) {
      const part = req.rows.slice(i, i + BATCH).map(here);
      await db.batch(part.map((r) => ({ sql, params: cols.map((c) => (r[c] === undefined ? null : r[c])) })));
    }
    return { ok: true, count: req.rows.length };
  }
  if (req.phase === 'finish') {
    if (typeof req.owner !== 'string' || !req.owner) return { ok: false, error: 'Say which person is the owner.' };
    await db.run("INSERT INTO studio_meta (key, value) VALUES ('owner_person', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [req.owner]);
    await forgetRecords(env);
    return { ok: true };
  }
  return { ok: false, error: 'That is not a step of the move.' };
}

const PAGE = 400;

/** One page of one table, for the owner's backup. Who may sign in (members, invitations) is not part of it. */
export async function exportRecords(env: RecordsEnv, req: { table: string; offset: number }): Promise<{ ok: true; rows: Record<string, unknown>[]; next: number | null } | { ok: false; error: string }> {
  if (!(RECORD_TABLES as readonly string[]).includes(req.table)) return { ok: false, error: 'That is not a table of the Studio’s records.' };
  const offset = Number.isInteger(req.offset) && req.offset >= 0 ? req.offset : 0;
  const db = d1Db(env.DB);
  const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${req.table} ORDER BY rowid LIMIT ? OFFSET ?`, [PAGE, offset]);
  return { ok: true, rows, next: rows.length === PAGE ? offset + PAGE : null };
}

/** Who the owner is in the records, for a backup that can be put back. */
export async function ownerOf(env: RecordsEnv): Promise<string | null> {
  return (await d1Db(env.DB).first<{ value: string }>("SELECT value FROM studio_meta WHERE key = 'owner_person'"))?.value ?? null;
}
