/**
 * Tasks, deadlines, approvals and decisions. Records and rules over the kernel's async `Db`: every change is one batch with its audit row.
 * Nothing here decides who may do what (the service checks `can` first); it does decide what is *valid*: a task cannot be finished while
 * something it depends on is open, a dependency cannot make a loop, an approval is decided only by someone it names, and a decision, once
 * recorded, is never edited or removed (a later decision supersedes it).
 *
 * Everything belongs to a project or subproject of the project tree, by id. The tree is a file, so the caller checks the project exists.
 * A **deadline** is a task of kind 'deadline' with a date. An **approval** is a sign-off on a project, under a label ("Cover approved",
 * "Ready to publish"), that a workflow gate can ask for (see `approved` in workflow.ts).
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';

export type WorkCode = 'invalid' | 'exists' | 'not-found' | 'conflict' | 'blocked';
export class WorkError extends Error {
  constructor(readonly code: WorkCode, message: string, readonly reasons: string[] = []) {
    super(message);
  }
}
const fail = (code: WorkCode, m: string, reasons: string[] = []): never => {
  throw new WorkError(code, m, reasons);
};
const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});
async function write(db: Db, stmts: { sql: string; params?: unknown[] }[], onUnique: string): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(m)) fail('exists', onUnique);
    if (/FOREIGN KEY/i.test(m)) fail('not-found', 'Something this refers to is not there any more.');
    throw e;
  }
}

const text = (v: unknown, what: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.trim().replace(/[ \t]+/g, ' ') : '';
  if (required && !s) return fail('invalid', `${what} cannot be empty.`);
  return s.length > max ? fail('invalid', `${what} is too long (${max} characters at most).`) : s;
};
/** A calendar date, written 2026-11-30. */
export function cleanDate(v: unknown, what = 'A date'): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return fail('invalid', `${what} is written 2026-11-30.`);
  return v;
}
const id = (v: unknown, what: string): string => (typeof v === 'string' && v ? v : fail('invalid', `${what} is needed.`));

// ---- tasks and deadlines -----------------------------------------------------------------------------------------------------

export const TASK_KINDS = ['task', 'deadline'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATES = ['open', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface TaskRecord {
  id: string;
  projectId: string;
  kind: TaskKind;
  title: string;
  notes: string;
  assigneeId: string | null;
  /** 2026-11-30, or null. A deadline always has one. */
  due: string | null;
  state: TaskState;
  doneAt: string | null;
  /** The tasks that must be done first. */
  dependsOn: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}
interface TaskRow extends Omit<TaskRecord, 'dependsOn'> {}
const TASK_COLS = 'id, project_id AS projectId, kind, title, notes, assignee_id AS assigneeId, due, state, done_at AS doneAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt';

async function withDeps(db: Db, rows: TaskRow[]): Promise<TaskRecord[]> {
  if (!rows.length) return [];
  const deps = await db.all<{ taskId: string; dependsOnId: string }>('SELECT task_id AS taskId, depends_on_id AS dependsOnId FROM task_dependency');
  return rows.map((r) => ({ ...r, dependsOn: deps.filter((d) => d.taskId === r.id).map((d) => d.dependsOnId).sort() }));
}

export async function getTask(db: Db, c: Pick<Ctx, 'studioId'>, taskId: string): Promise<TaskRecord | null> {
  const r = await db.first<TaskRow>(`SELECT ${TASK_COLS} FROM task WHERE id = ? AND studio_id = ?`, [taskId, c.studioId]);
  return r ? (await withDeps(db, [r]))[0]! : null;
}

export interface TaskFilter {
  projectId?: string;
  /** A project and everything under it (the caller expands the tree). */
  projectIds?: string[];
  assigneeId?: string;
  state?: TaskState | 'any';
  kind?: TaskKind;
  /** Open and due before this date (2026-11-30): what is late. */
  overdueBefore?: string;
}
export async function listTasks(db: Db, c: Pick<Ctx, 'studioId'>, f: TaskFilter = {}): Promise<TaskRecord[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.assigneeId) (where.push('assignee_id = ?'), params.push(f.assigneeId));
  if (f.kind) (where.push('kind = ?'), params.push(f.kind));
  const state = f.state ?? 'open';
  if (state !== 'any') (where.push('state = ?'), params.push(state));
  if (f.overdueBefore) (where.push("state = 'open' AND due IS NOT NULL AND due < ?"), params.push(cleanDate(f.overdueBefore)));
  return withDeps(db, await db.all<TaskRow>(`SELECT ${TASK_COLS} FROM task WHERE ${where.join(' AND ')} ORDER BY due IS NULL, due, created_at`, params));
}

export interface NewTask {
  projectId: string;
  title: string;
  notes?: string;
  assigneeId?: string | null;
  due?: string | null;
  kind?: TaskKind;
  dependsOn?: string[];
}
export async function createTask(db: Db, c: Ctx, input: NewTask): Promise<TaskRecord> {
  const kind = input?.kind ?? 'task';
  if (!(TASK_KINDS as readonly string[]).includes(kind)) fail('invalid', 'A task is a task or a deadline.');
  const due = cleanDate(input?.due, 'A due date');
  if (kind === 'deadline' && !due) fail('invalid', 'A deadline needs a date.');
  const taskId = newRecordId();
  const deps = [...new Set(input?.dependsOn ?? [])];
  for (const d of deps) if (!(await getTask(db, c, d))) fail('not-found', 'A task it depends on is not there.');
  await write(db, [
    { sql: 'INSERT INTO task (id, studio_id, project_id, kind, title, notes, assignee_id, due, state, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [taskId, c.studioId, id(input?.projectId, 'A project'), kind, text(input?.title, 'A title', 200), text(input?.notes, 'Notes', 5000, false), input?.assigneeId || null, due, 'open', c.now, c.actor, c.now, c.actor] },
    ...deps.map((d) => ({ sql: 'INSERT INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)', params: [taskId, d] })),
    audit(c, 'task.create', taskId, { projectId: input.projectId, kind, assigneeId: input.assigneeId ?? null, due })
  ], 'That task already exists.');
  return (await getTask(db, c, taskId))!;
}

export interface TaskPatch { title?: string; notes?: string; assigneeId?: string | null; due?: string | null }
export async function updateTask(db: Db, c: Ctx, taskId: string, patch: TaskPatch): Promise<TaskRecord> {
  const t = (await getTask(db, c, taskId)) ?? fail('not-found', 'That task is not there.');
  if (t.state !== 'open') fail('conflict', 'Only an open task can be changed. Reopen it first.');
  const next = {
    title: patch.title === undefined ? t.title : text(patch.title, 'A title', 200),
    notes: patch.notes === undefined ? t.notes : text(patch.notes, 'Notes', 5000, false),
    assigneeId: patch.assigneeId === undefined ? t.assigneeId : patch.assigneeId || null,
    due: patch.due === undefined ? t.due : cleanDate(patch.due, 'A due date')
  };
  if (t.kind === 'deadline' && !next.due) fail('invalid', 'A deadline needs a date.');
  await write(db, [
    { sql: 'UPDATE task SET title = ?, notes = ?, assignee_id = ?, due = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [next.title, next.notes, next.assigneeId, next.due, c.now, c.actor, taskId, c.studioId] },
    audit(c, 'task.update', taskId, patch)
  ], 'That task already exists.');
  return (await getTask(db, c, taskId))!;
}

/** Done, cancelled, or open again. A task cannot be marked done while something it depends on is still open. */
export async function setTaskState(db: Db, c: Ctx, taskId: string, state: TaskState): Promise<TaskRecord> {
  if (!(TASK_STATES as readonly string[]).includes(state)) fail('invalid', 'A task is open, done or cancelled.');
  const t = (await getTask(db, c, taskId)) ?? fail('not-found', 'That task is not there.');
  if (t.state === state) return t;
  if (state === 'done') {
    const waiting = (await Promise.all(t.dependsOn.map((d) => getTask(db, c, d)))).filter((d): d is TaskRecord => !!d && d.state === 'open');
    if (waiting.length) fail('blocked', `Waiting on: ${waiting.map((w) => w.title).join(', ')}.`, waiting.map((w) => w.title));
  }
  await db.batch([
    { sql: 'UPDATE task SET state = ?, done_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [state, state === 'done' ? c.now : null, c.now, c.actor, taskId, c.studioId] },
    audit(c, `task.${state === 'open' ? 'reopen' : state}`, taskId, { from: t.state })
  ]);
  return (await getTask(db, c, taskId))!;
}

/** `taskId` waits for `dependsOnId`. Refused when it would make a loop (a task waiting, however indirectly, on itself). */
export async function addDependency(db: Db, c: Ctx, taskId: string, dependsOnId: string): Promise<TaskRecord> {
  if (taskId === dependsOnId) fail('invalid', 'A task cannot wait for itself.');
  const [a, b] = await Promise.all([getTask(db, c, taskId), getTask(db, c, dependsOnId)]);
  if (!a || !b) return fail('not-found', 'That task is not there.');
  if (a.projectId !== b.projectId) fail('invalid', 'A task can wait only for a task in the same project.');
  const all = await db.all<{ taskId: string; dependsOnId: string }>('SELECT task_id AS taskId, depends_on_id AS dependsOnId FROM task_dependency');
  const reach = new Set<string>();
  const walk = (x: string) => {
    for (const d of all.filter((e) => e.taskId === x)) if (!reach.has(d.dependsOnId)) (reach.add(d.dependsOnId), walk(d.dependsOnId));
  };
  walk(dependsOnId);
  if (reach.has(taskId)) fail('conflict', `“${b.title}” already waits, directly or not, for “${a.title}”.`);
  await write(db, [{ sql: 'INSERT OR IGNORE INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)', params: [taskId, dependsOnId] }, audit(c, 'task.depend', taskId, { dependsOnId })], 'Already waiting for that task.');
  return (await getTask(db, c, taskId))!;
}
export async function removeDependency(db: Db, c: Ctx, taskId: string, dependsOnId: string): Promise<TaskRecord> {
  if (!(await getTask(db, c, taskId))) fail('not-found', 'That task is not there.');
  await db.batch([{ sql: 'DELETE FROM task_dependency WHERE task_id = ? AND depends_on_id = ?', params: [taskId, dependsOnId] }, audit(c, 'task.undepend', taskId, { dependsOnId })]);
  return (await getTask(db, c, taskId))!;
}

/** How many tasks (not deadlines) are open across these projects: what a gate asks. */
export async function openTaskCount(db: Db, c: Pick<Ctx, 'studioId'>, projectIds: string[]): Promise<number> {
  if (!projectIds.length) return 0;
  return (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM task WHERE studio_id = ? AND state = 'open' AND kind = 'task' AND project_id IN (${projectIds.map(() => '?').join(',')})`, [c.studioId, ...projectIds]))!.n;
}

// ---- approvals ---------------------------------------------------------------------------------------------------------------

export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export interface ApprovalRecord {
  id: string;
  projectId: string;
  label: string;
  note: string;
  required: number;
  state: ApprovalState;
  requestedBy: string;
  requestedAt: string;
  closedAt: string | null;
  approvers: { personId: string; response: 'approved' | 'rejected' | null; reason: string; respondedAt: string | null }[];
}
interface ApprovalRow extends Omit<ApprovalRecord, 'approvers'> {}
const APPROVAL_COLS = 'id, project_id AS projectId, label, note, required, state, requested_by AS requestedBy, requested_at AS requestedAt, closed_at AS closedAt';

async function withApprovers(db: Db, rows: ApprovalRow[]): Promise<ApprovalRecord[]> {
  if (!rows.length) return [];
  const all = await db.all<{ approvalId: string; personId: string; response: 'approved' | 'rejected' | null; reason: string; respondedAt: string | null }>('SELECT approval_id AS approvalId, person_id AS personId, response, reason, responded_at AS respondedAt FROM approval_approver ORDER BY rowid');
  return rows.map((r) => ({ ...r, approvers: all.filter((a) => a.approvalId === r.id).map(({ personId, response, reason, respondedAt }) => ({ personId, response, reason, respondedAt })) }));
}
export async function getApproval(db: Db, c: Pick<Ctx, 'studioId'>, approvalId: string): Promise<ApprovalRecord | null> {
  const r = await db.first<ApprovalRow>(`SELECT ${APPROVAL_COLS} FROM approval WHERE id = ? AND studio_id = ?`, [approvalId, c.studioId]);
  return r ? (await withApprovers(db, [r]))[0]! : null;
}
export async function listApprovals(db: Db, c: Pick<Ctx, 'studioId'>, f: { projectId?: string; projectIds?: string[]; approverId?: string; state?: ApprovalState | 'any' } = {}): Promise<ApprovalRecord[]> {
  const where = ['a.studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('a.project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`a.project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.approverId) (where.push('a.id IN (SELECT approval_id FROM approval_approver WHERE person_id = ?)'), params.push(f.approverId));
  if ((f.state ?? 'any') !== 'any') (where.push('a.state = ?'), params.push(f.state));
  return withApprovers(db, await db.all<ApprovalRow>(`SELECT ${APPROVAL_COLS.split(', ').map((x) => `a.${x}`).join(', ')} FROM approval a WHERE ${where.join(' AND ')} ORDER BY a.requested_at DESC, a.id DESC`, params));
}

/** The approvals waiting for this person to answer. */
export async function approvalsWaitingFor(db: Db, c: Pick<Ctx, 'studioId'>, personId: string): Promise<ApprovalRecord[]> {
  return (await listApprovals(db, c, { approverId: personId, state: 'pending' })).filter((a) => a.approvers.some((x) => x.personId === personId && x.response === null));
}

export interface NewApproval { projectId: string; label: string; note?: string; approverIds: string[]; /** How many must approve; all of them by default. */ required?: number }
export async function requestApproval(db: Db, c: Ctx, input: NewApproval): Promise<ApprovalRecord> {
  const approvers = [...new Set(input?.approverIds ?? [])];
  if (!approvers.length) fail('invalid', 'Name at least one person to approve.');
  const required = input.required ?? approvers.length;
  if (!Number.isInteger(required) || required < 1 || required > approvers.length) fail('invalid', `Between 1 and ${approvers.length} approvals are needed.`);
  const label = text(input.label, 'An approval’s label', 40);
  const aid = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO approval (id, studio_id, project_id, label, note, required, state, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?,?)', params: [aid, c.studioId, id(input.projectId, 'A project'), label, text(input.note, 'The note', 2000, false), required, 'pending', c.actor, c.now] },
    ...approvers.map((p) => ({ sql: 'INSERT INTO approval_approver (approval_id, person_id) VALUES (?, ?)', params: [aid, p] })),
    audit(c, 'approval.request', aid, { projectId: input.projectId, label, approverIds: approvers, required })
  ], `“${label}” is already waiting for an answer on this project.`);
  return (await getApproval(db, c, aid))!;
}

/** The named approver answers. Rejecting needs a reason. Enough approvals approve it; one rejection rejects it. */
export async function respondToApproval(db: Db, c: Ctx, approvalId: string, response: 'approved' | 'rejected', reason = ''): Promise<ApprovalRecord> {
  if (response !== 'approved' && response !== 'rejected') fail('invalid', 'Answer approved or rejected.');
  const a = (await getApproval(db, c, approvalId)) ?? fail('not-found', 'That approval is not there.');
  const me = a.approvers.find((x) => x.personId === c.actor);
  if (!me) fail('conflict', 'You are not one of the people this approval asks.');
  if (a.state !== 'pending') fail('conflict', `This approval is already ${a.state}.`);
  if (me!.response) fail('conflict', 'You have already answered this.');
  const why = text(reason, 'The reason', 1000, false);
  if (response === 'rejected' && !why) fail('invalid', 'Say why you are rejecting it.');
  const approvedNow = a.approvers.filter((x) => x.response === 'approved').length + (response === 'approved' ? 1 : 0);
  const state: ApprovalState = response === 'rejected' ? 'rejected' : approvedNow >= a.required ? 'approved' : 'pending';
  await db.batch([
    { sql: 'UPDATE approval_approver SET response = ?, reason = ?, responded_at = ? WHERE approval_id = ? AND person_id = ? AND response IS NULL', params: [response, why, c.now, approvalId, c.actor] },
    { sql: "UPDATE approval SET state = ?, closed_at = ? WHERE id = ? AND state = 'pending'", params: [state, state === 'pending' ? null : c.now, approvalId] },
    audit(c, `approval.${response}`, approvalId, { reason: why, state })
  ]);
  return (await getApproval(db, c, approvalId))!;
}

/** Whoever asked for it (or an administrator, the service decides) takes a pending request back. */
export async function withdrawApproval(db: Db, c: Ctx, approvalId: string): Promise<ApprovalRecord> {
  const a = (await getApproval(db, c, approvalId)) ?? fail('not-found', 'That approval is not there.');
  if (a.state !== 'pending') fail('conflict', `This approval is already ${a.state}.`);
  await db.batch([{ sql: "UPDATE approval SET state = 'withdrawn', closed_at = ? WHERE id = ? AND state = 'pending'", params: [c.now, approvalId] }, audit(c, 'approval.withdraw', approvalId, {})]);
  return (await getApproval(db, c, approvalId))!;
}

/** The labels a project currently stands approved under: for each label, the latest request that was decided, if it was approved. A later rejection takes an approval away. */
export async function approvedLabels(db: Db, c: Pick<Ctx, 'studioId'>, projectId: string): Promise<string[]> {
  const rows = await listApprovals(db, c, { projectId });
  const latest = new Map<string, ApprovalRecord>();
  for (const a of rows) if (a.state === 'approved' || a.state === 'rejected') if (!latest.has(a.label.toLowerCase())) latest.set(a.label.toLowerCase(), a); // newest first
  return [...latest.values()].filter((a) => a.state === 'approved').map((a) => a.label).sort();
}

// ---- decisions ---------------------------------------------------------------------------------------------------------------

export interface DecisionRecord {
  id: string;
  projectId: string | null;
  title: string;
  context: string;
  outcome: string;
  supersedesId: string | null;
  /** Set when a later decision replaced this one. */
  supersededBy: string | null;
  decidedBy: string;
  decidedAt: string;
}
const DECISION_COLS = 'id, project_id AS projectId, title, context, outcome, supersedes_id AS supersedesId, decided_by AS decidedBy, decided_at AS decidedAt';

async function withSuperseded(db: Db, rows: Omit<DecisionRecord, 'supersededBy'>[]): Promise<DecisionRecord[]> {
  const links = await db.all<{ id: string; by: string }>('SELECT supersedes_id AS id, id AS by FROM decision WHERE supersedes_id IS NOT NULL');
  return rows.map((r) => ({ ...r, supersededBy: links.find((l) => l.id === r.id)?.by ?? null }));
}
export async function listDecisions(db: Db, c: Pick<Ctx, 'studioId'>, f: { projectId?: string; projectIds?: string[]; current?: boolean } = {}): Promise<DecisionRecord[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.projectId) (where.push('project_id = ?'), params.push(f.projectId));
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  const rows = await withSuperseded(db, await db.all<Omit<DecisionRecord, 'supersededBy'>>(`SELECT ${DECISION_COLS} FROM decision WHERE ${where.join(' AND ')} ORDER BY decided_at DESC, id DESC`, params));
  return f.current ? rows.filter((r) => !r.supersededBy) : rows;
}
export async function getDecision(db: Db, c: Pick<Ctx, 'studioId'>, decisionId: string): Promise<DecisionRecord | null> {
  const r = await db.first<Omit<DecisionRecord, 'supersededBy'>>(`SELECT ${DECISION_COLS} FROM decision WHERE id = ? AND studio_id = ?`, [decisionId, c.studioId]);
  return r ? (await withSuperseded(db, [r]))[0]! : null;
}

/** Records a decision. Giving `supersedes` replaces an earlier one (which stays on the record, marked as replaced); each decision is replaced at most once. */
export async function recordDecision(db: Db, c: Ctx, input: { projectId?: string | null; title: string; context?: string; outcome: string; supersedes?: string | null }): Promise<DecisionRecord> {
  if (input?.supersedes) {
    const old = (await getDecision(db, c, input.supersedes)) ?? fail('not-found', 'The decision to replace is not there.');
    if (old.supersededBy) fail('conflict', 'That decision has already been replaced by a later one.');
  }
  const did = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO decision (id, studio_id, project_id, title, context, outcome, supersedes_id, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?)', params: [did, c.studioId, input?.projectId || null, text(input?.title, 'A title', 200), text(input?.context, 'The context', 5000, false), text(input?.outcome, 'The outcome', 2000), input?.supersedes || null, c.actor, c.now] },
    audit(c, 'decision.record', did, { projectId: input?.projectId ?? null, supersedes: input?.supersedes ?? null })
  ], 'That decision has already been replaced by a later one.');
  return (await getDecision(db, c, did))!;
}
