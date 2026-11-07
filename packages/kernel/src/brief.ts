/**
 * Briefs: the creative brief for a manuscript ('manuscript') and the brief an edit is asked to follow ('edit'). Records and rules over the
 * kernel's async `Db`, in the style of work.ts: nothing here decides who may do what (the service checks first), it decides what is valid.
 * A brief is never overwritten. Each revision is a new numbered version; the earlier ones stay readable, so an edit pass can name the
 * version of the brief it was run against. Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError } from './work';

export const BRIEF_KINDS = ['manuscript', 'edit'] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

const MAX_TITLE = 200;
const MAX_BODY = 100_000;
const MAX_NOTE = 500;

export interface BriefVersion {
  n: number;
  body: string;
  /** What changed, in a line (optional). */
  note: string;
  writtenAt: string;
  writtenBy: string;
}
export interface BriefRecord {
  id: string;
  projectId: string;
  kind: BriefKind;
  title: string;
  createdAt: string;
  createdBy: string;
  /** The newest version. */
  current: BriefVersion;
}
interface BriefRow {
  id: string;
  projectId: string;
  kind: BriefKind;
  title: string;
  createdAt: string;
  createdBy: string;
}
const COLS = 'id, project_id AS projectId, kind, title, created_at AS createdAt, created_by AS createdBy';
const VCOLS = 'n, body, note, written_at AS writtenAt, written_by AS writtenBy';

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
const clean = (v: unknown, what: string, max: number, required: boolean): string => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};

async function withCurrent(db: Db, row: BriefRow): Promise<BriefRecord> {
  const current = await db.first<BriefVersion>(`SELECT ${VCOLS} FROM brief_version WHERE brief_id = ? ORDER BY n DESC LIMIT 1`, [row.id]);
  return { ...row, current: current ?? fail('not-found', 'That brief has no text.') };
}

export async function getBrief(db: Db, c: Pick<Ctx, 'studioId'>, briefId: string): Promise<BriefRecord | null> {
  const r = await db.first<BriefRow>(`SELECT ${COLS} FROM brief WHERE id = ? AND studio_id = ?`, [briefId, c.studioId]);
  return r ? withCurrent(db, r) : null;
}

export interface BriefFilter {
  projectId?: string;
  /** A project and everything under it (the caller expands the tree). */
  projectIds?: string[];
  kind?: BriefKind;
}
export async function listBriefs(db: Db, c: Pick<Ctx, 'studioId'>, f: BriefFilter = {}): Promise<BriefRecord[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  const rows = await db.all<BriefRow>(`SELECT ${COLS} FROM brief WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`, params);
  return Promise.all(rows.map((r) => withCurrent(db, r)));
}

/** Every version of a brief, oldest first. */
export async function briefVersions(db: Db, c: Pick<Ctx, 'studioId'>, briefId: string): Promise<BriefVersion[]> {
  if (!(await getBrief(db, c, briefId))) return fail('not-found', 'That brief is not there.');
  return db.all<BriefVersion>(`SELECT ${VCOLS} FROM brief_version WHERE brief_id = ? ORDER BY n`, [briefId]);
}

export interface NewBrief {
  projectId: string;
  kind: BriefKind;
  title: string;
  body: string;
}
export async function createBrief(db: Db, c: Ctx, i: NewBrief): Promise<BriefRecord> {
  if (typeof i?.projectId !== 'string' || !i.projectId) fail('invalid', 'A project is needed.');
  if (!BRIEF_KINDS.includes(i.kind)) fail('invalid', 'A brief is for a manuscript or for an edit.');
  const title = clean(i.title, 'The title', MAX_TITLE, true);
  const body = clean(i.body, 'The brief', MAX_BODY, true);
  const id = newRecordId();
  await db.batch([
    { sql: 'INSERT INTO brief (id, studio_id, project_id, kind, title, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', params: [id, c.studioId, i.projectId, i.kind, title, c.now, c.actor] },
    { sql: "INSERT INTO brief_version (brief_id, n, body, note, written_at, written_by) VALUES (?, 1, ?, '', ?, ?)", params: [id, body, c.now, c.actor] },
    audit(c, 'brief.create', id, { projectId: i.projectId, kind: i.kind, title })
  ]);
  return (await getBrief(db, c, id))!;
}

/** Writes the next version. `title` may change with it. Throws `conflict` if someone revised the brief since `basedOn` was read. */
export async function reviseBrief(db: Db, c: Ctx, briefId: string, i: { body: string; note?: string; title?: string; basedOn: number }): Promise<BriefRecord> {
  const was = await getBrief(db, c, briefId);
  if (!was) return fail('not-found', 'That brief is not there.');
  if (i?.basedOn !== was.current.n) fail('conflict', 'Someone else has revised this brief since you opened it. Open the newest version and try again.');
  const body = clean(i.body, 'The brief', MAX_BODY, true);
  const note = clean(i.note ?? '', 'The note', MAX_NOTE, false);
  const title = i.title === undefined ? was.title : clean(i.title, 'The title', MAX_TITLE, true);
  if (body === was.current.body && title === was.title) fail('invalid', 'Nothing has changed.');
  const n = was.current.n + 1;
  try {
    await db.batch([
      { sql: 'INSERT INTO brief_version (brief_id, n, body, note, written_at, written_by) VALUES (?, ?, ?, ?, ?, ?)', params: [briefId, n, body, note, c.now, c.actor] },
      { sql: 'UPDATE brief SET title = ? WHERE id = ? AND studio_id = ?', params: [title, briefId, c.studioId] },
      audit(c, 'brief.revise', briefId, { n })
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_PRIMARYKEY|SQLITE_CONSTRAINT_UNIQUE/i.test(String((e as Error)?.message ?? e))) fail('conflict', 'Someone else has revised this brief since you opened it. Open the newest version and try again.');
    throw e;
  }
  return (await getBrief(db, c, briefId))!;
}
