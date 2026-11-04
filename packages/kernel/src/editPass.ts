/**
 * Editorial passes. A pass is one editor's developmental, line, copy or proof read of one exact version of a manuscript file, optionally under
 * one exact version of a brief. Records and rules over the kernel's async `Db`, in the style of work.ts: nothing here decides who may do what
 * (the service checks first); it decides what is valid.
 *
 * planned -> in_progress (the editor starts) -> delivered (the editor hands it back) -> responded (the author has answered) -> closed (approved).
 * Any pass that is not closed can be cancelled. Closed and cancelled are final, and a file has one live pass of each kind at a time.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';

export const PASS_KINDS = ['developmental', 'line', 'copy', 'proof'] as const;
export type PassKind = (typeof PASS_KINDS)[number];
export const PASS_STATES = ['planned', 'in_progress', 'delivered', 'responded', 'closed', 'cancelled'] as const;
export type PassState = (typeof PASS_STATES)[number];

/** Where each state may go next. Anything not closed or cancelled may also be cancelled. */
export const PASS_NEXT: Record<PassState, readonly PassState[]> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['delivered', 'cancelled'],
  delivered: ['responded', 'cancelled'],
  responded: ['closed', 'cancelled'],
  closed: [],
  cancelled: []
};

export interface PassRecord {
  id: string;
  projectId: string;
  kind: PassKind;
  title: string;
  fileId: string;
  /** The file's path in the vault now (null if it is no longer there). */
  filePath: string | null;
  /** The exact version of the file this pass covers. */
  fileVersion: number;
  briefId: string | null;
  briefVersion: number | null;
  editorId: string;
  state: PassState;
  createdAt: string;
  createdBy: string;
  startedAt: string | null;
  deliveredAt: string | null;
  respondedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  updatedAt: string;
}
const COLS =
  "id, project_id AS projectId, kind, title, file_id AS fileId, (SELECT path FROM vault_file f WHERE f.id = file_id) AS filePath, file_version AS fileVersion, brief_id AS briefId, brief_version AS briefVersion, editor_id AS editorId, state, created_at AS createdAt, created_by AS createdBy, started_at AS startedAt, delivered_at AS deliveredAt, responded_at AS respondedAt, closed_at AS closedAt, closed_by AS closedBy, updated_at AS updatedAt";

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

export async function getPass(db: Db, c: Pick<Ctx, 'studioId'>, passId: string): Promise<PassRecord | null> {
  return db.first<PassRecord>(`SELECT ${COLS} FROM edit_pass WHERE id = ? AND studio_id = ?`, [passId, c.studioId]);
}

export interface PassFilter {
  projectId?: string;
  /** A project and everything under it (the caller expands the tree). */
  projectIds?: string[];
  fileId?: string;
  editorId?: string;
  kind?: PassKind;
  /** One state, 'live' (not closed or cancelled; the default), or 'any'. */
  state?: PassState | 'live' | 'any';
}
export async function listPasses(db: Db, c: Pick<Ctx, 'studioId'>, f: PassFilter = {}): Promise<PassRecord[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.fileId) (where.push('file_id = ?'), params.push(f.fileId));
  if (f.editorId) (where.push('editor_id = ?'), params.push(f.editorId));
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  const state = f.state ?? 'live';
  if (state === 'live') where.push("state NOT IN ('closed', 'cancelled')");
  else if (state !== 'any') (where.push('state = ?'), params.push(state));
  return db.all<PassRecord>(`SELECT ${COLS} FROM edit_pass WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`, params);
}

export interface NewPass {
  projectId: string;
  kind: PassKind;
  title?: string;
  fileId: string;
  /** The version to cover; the file's current version when absent. */
  fileVersion?: number;
  briefId?: string | null;
  /** The brief version to follow; the brief's current version when absent. */
  briefVersion?: number | null;
  editorId: string;
}
const KIND_TITLE: Record<PassKind, string> = { developmental: 'Developmental edit', line: 'Line edit', copy: 'Copy edit', proof: 'Proofread' };

export async function createPass(db: Db, c: Ctx, i: NewPass): Promise<PassRecord> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A project is needed.');
  if (!PASS_KINDS.includes(i.kind)) fail('invalid', 'A pass is developmental, line, copy or proof.');
  if (typeof i.fileId !== 'string' || !i.fileId) fail('invalid', 'A manuscript file is needed.');
  if (typeof i.editorId !== 'string' || !i.editorId) fail('invalid', 'An editor is needed.');
  const title = typeof i.title === 'string' && i.title.trim() ? i.title.trim() : KIND_TITLE[i.kind];
  if (title.length > 200) fail('invalid', 'The title is too long (200 characters at most).');

  const file = await db.first<{ current: number }>('SELECT current_version AS current FROM vault_file WHERE id = ? AND studio_id = ?', [i.fileId, c.studioId]);
  if (!file) return fail('not-found', 'That file is not there.');
  const fileVersion = i.fileVersion ?? file.current;
  if (!Number.isInteger(fileVersion) || fileVersion < 1 || fileVersion > file.current) return fail('not-found', 'That version of the file is not there.');

  let briefId: string | null = null;
  let briefVersion: number | null = null;
  if (i.briefId) {
    const b = await db.first<{ projectId: string; kind: string; n: number }>(
      'SELECT b.project_id AS projectId, b.kind AS kind, MAX(v.n) AS n FROM brief b JOIN brief_version v ON v.brief_id = b.id WHERE b.id = ? AND b.studio_id = ? GROUP BY b.id',
      [i.briefId, c.studioId]
    );
    if (!b) return fail('not-found', 'That brief is not there.');
    if (b.kind !== 'edit') fail('invalid', 'A pass follows an edit brief.');
    if (b.projectId !== i.projectId) fail('invalid', 'That brief belongs to another project.');
    briefId = i.briefId;
    briefVersion = i.briefVersion ?? b.n;
    if (!Number.isInteger(briefVersion) || briefVersion < 1 || briefVersion > b.n) return fail('not-found', 'That version of the brief is not there.');
  }

  const person = await db.first<{ gone: string | null }>('SELECT deactivated_at AS gone FROM person WHERE id = ? AND studio_id = ?', [i.editorId, c.studioId]);
  if (!person) return fail('not-found', 'That editor is not there.');
  if (person.gone) fail('invalid', 'That person is no longer active.');

  const id = newRecordId();
  try {
    await db.batch([
      {
        sql: `INSERT INTO edit_pass (id, studio_id, project_id, kind, title, file_id, file_version, brief_id, brief_version, editor_id, state, created_at, created_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`,
        params: [id, c.studioId, i.projectId, i.kind, title, i.fileId, fileVersion, briefId, briefVersion, i.editorId, c.now, c.actor, c.now]
      },
      audit(c, 'pass.create', id, { projectId: i.projectId, kind: i.kind, fileId: i.fileId, fileVersion, briefId, briefVersion, editorId: i.editorId })
    ]);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(m)) fail('exists', `This file already has a ${i.kind} pass under way. Close or cancel it first.`);
    if (/FOREIGN KEY/i.test(m)) fail('not-found', 'Something this refers to is not there any more.');
    throw e;
  }
  return (await getPass(db, c, id))!;
}

/** Hands a pass that has not been delivered to another editor. */
export async function assignEditor(db: Db, c: Ctx, passId: string, editorId: string): Promise<PassRecord> {
  const p = await getPass(db, c, passId);
  if (!p) return fail('not-found', 'That pass is not there.');
  if (p.state !== 'planned' && p.state !== 'in_progress') fail('conflict', 'Only a pass that is planned or under way can change editor.');
  if (typeof editorId !== 'string' || !editorId) fail('invalid', 'An editor is needed.');
  const person = await db.first<{ gone: string | null }>('SELECT deactivated_at AS gone FROM person WHERE id = ? AND studio_id = ?', [editorId, c.studioId]);
  if (!person) return fail('not-found', 'That editor is not there.');
  if (person.gone) fail('invalid', 'That person is no longer active.');
  if (editorId === p.editorId) return p;
  await db.batch([
    { sql: 'UPDATE edit_pass SET editor_id = ?, updated_at = ? WHERE id = ? AND studio_id = ?', params: [editorId, c.now, passId, c.studioId] },
    audit(c, 'pass.assign', passId, { from: p.editorId, to: editorId })
  ]);
  return (await getPass(db, c, passId))!;
}

const STAMP: Partial<Record<PassState, string>> = { in_progress: 'started_at', delivered: 'delivered_at', responded: 'responded_at', closed: 'closed_at' };

/** Moves a pass along its path. A move the path does not have is a `conflict`, naming where the pass can go. */
export async function movePass(db: Db, c: Ctx, passId: string, to: PassState): Promise<PassRecord> {
  if (!PASS_STATES.includes(to)) fail('invalid', 'That is not a state a pass can be in.');
  const p = await getPass(db, c, passId);
  if (!p) return fail('not-found', 'That pass is not there.');
  if (!PASS_NEXT[p.state].includes(to)) {
    const next = PASS_NEXT[p.state];
    fail('conflict', next.length ? `A pass that is ${p.state.replace('_', ' ')} can go to: ${next.map((s) => s.replace('_', ' ')).join(', ')}.` : `A pass that is ${p.state} cannot change.`);
  }
  if (to === 'responded') {
    const open = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM edit_query WHERE pass_id = ? AND kind = 'query' AND state = 'open'", [passId]);
    if (open?.n) fail('conflict', `${open.n === 1 ? '1 query is' : `${open.n} queries are`} still unanswered. Answer ${open.n === 1 ? 'it' : 'them'} first.`);
    const undecided = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM edit_query q WHERE q.pass_id = ? AND q.kind = 'suggestion' AND q.state = 'open' AND NOT EXISTS (SELECT 1 FROM edit_decision d WHERE d.query_id = q.id)",
      [passId]
    );
    if (undecided?.n) fail('conflict', `${undecided.n === 1 ? '1 suggestion has' : `${undecided.n} suggestions have`} no decision yet. Accept, reject or defer ${undecided.n === 1 ? 'it' : 'them'} first.`);
  }
  const sets = ['state = ?', 'updated_at = ?'];
  const params: unknown[] = [to, c.now];
  const stamp = STAMP[to];
  if (stamp) (sets.push(`${stamp} = ?`), params.push(c.now));
  if (to === 'closed' || to === 'cancelled') (sets.push('closed_by = ?'), params.push(c.actor));
  if (to === 'cancelled') (sets.push('closed_at = ?'), params.push(c.now));
  // `AND state = ?` makes a move atomic: two people moving the same pass cannot both succeed
  const res = await db.batch([
    { sql: `UPDATE edit_pass SET ${sets.join(', ')} WHERE id = ? AND studio_id = ? AND state = ?`, params: [...params, passId, c.studioId, p.state] },
    audit(c, 'pass.' + to, passId, { from: p.state })
  ]);
  if (!res[0]?.changes) fail('conflict', 'Someone else has just moved this pass. Open it again.');
  return (await getPass(db, c, passId))!;
}
