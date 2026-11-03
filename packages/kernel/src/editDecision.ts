/**
 * The author's decision on an item raised in an editorial pass (see editQuery.ts): accept, reject or defer. Reject and defer need a reason; a
 * deferral needs a date to come back to and makes a task for it. Each decision is also entered in the studio's decision ledger, in the same
 * batch, so the ledger and the pass never disagree. Decisions are append-only: a changed mind is a new decision that supersedes the old one,
 * and cancels the revisit task the old one made. Decisions are made while the pass is delivered, before it is marked responded.
 * Errors are `WorkError`s, so they cross the wire like the rest of the work records.
 */
import { newRecordId } from './ids';
import type { Ctx } from './catalogue';
import type { Db } from './vault';
import { WorkError, cleanDate } from './work';
import { getPass } from './editPass';
import { getQuery, type QueryRecord } from './editQuery';

export const DECISION_OUTCOMES = ['accept', 'reject', 'defer'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
const REASON_MAX = 2000;

export interface EditDecisionRecord {
  id: string;
  queryId: string;
  outcome: DecisionOutcome;
  reason: string;
  /** Deferrals: the date to come back to (2026-11-30). */
  revisit: string | null;
  /** The entry in the studio's decision ledger. */
  ledgerId: string;
  /** Deferrals: the task made for the revisit. */
  taskId: string | null;
  supersedesId: string | null;
  decidedBy: string;
  decidedAt: string;
}
const COLS = 'id, query_id AS queryId, outcome, reason, revisit, ledger_id AS ledgerId, task_id AS taskId, supersedes_id AS supersedesId, decided_by AS decidedBy, decided_at AS decidedAt';

const fail = (code: ConstructorParameters<typeof WorkError>[0], m: string): never => {
  throw new WorkError(code, m);
};

export async function getEditDecision(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<EditDecisionRecord | null> {
  return db.first<EditDecisionRecord>(`SELECT ${COLS} FROM edit_decision WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}

export interface EditDecisionFilter {
  queryId?: string;
  passId?: string;
  passIds?: string[];
  /** Only the decision each item stands on now (the default), or the whole history. */
  history?: boolean;
}
export async function listEditDecisions(db: Db, c: Pick<Ctx, 'studioId'>, f: EditDecisionFilter = {}): Promise<EditDecisionRecord[]> {
  const where = ['d.studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (f.queryId) (where.push('d.query_id = ?'), params.push(f.queryId));
  if (f.passId) (where.push('q.pass_id = ?'), params.push(f.passId));
  if (f.passIds) {
    if (!f.passIds.length) return [];
    where.push(`q.pass_id IN (${f.passIds.map(() => '?').join(',')})`);
    params.push(...f.passIds);
  }
  if (!f.history) where.push('NOT EXISTS (SELECT 1 FROM edit_decision n WHERE n.supersedes_id = d.id)');
  const cols = COLS.split(', ').map((x) => 'd.' + x).join(', ');
  return db.all<EditDecisionRecord>(`SELECT ${cols} FROM edit_decision d JOIN edit_query q ON q.id = d.query_id WHERE ${where.join(' AND ')} ORDER BY q.pass_id, q.seq, d.decided_at, d.rowid`, params);
}

export interface NewEditDecision {
  outcome: DecisionOutcome;
  /** Required to reject or defer. */
  reason?: string;
  /** Required to defer. */
  revisit?: string;
}

const brief = (q: QueryRecord) => (q.anchor?.quote ?? q.body).replace(/\s+/g, ' ').slice(0, 60);

export async function decideQuery(db: Db, c: Ctx, queryId: string, i: NewEditDecision): Promise<EditDecisionRecord> {
  const q = await getQuery(db, c, queryId);
  if (!q) return fail('not-found', 'That item is not there.');
  const pass = (await getPass(db, c, q.passId))!;
  if (pass.state !== 'delivered') fail('conflict', 'Decisions are made after the editor has delivered the pass and before it is marked responded.');
  if (q.state === 'withdrawn') fail('conflict', 'That item was withdrawn.');
  if (!DECISION_OUTCOMES.includes(i?.outcome)) fail('invalid', 'A decision is to accept, reject or defer.');
  const reason = typeof i.reason === 'string' ? i.reason.replace(/\r\n/g, '\n').trim() : '';
  if (reason.length > REASON_MAX) fail('invalid', `The reason is too long (${REASON_MAX} characters at most).`);
  if (i.outcome !== 'accept' && !reason) fail('invalid', `Say why you ${i.outcome === 'reject' ? 'reject it' : 'defer it'}.`);
  const revisit = i.outcome === 'defer' ? cleanDate(i.revisit, 'The revisit date') : null;
  if (i.outcome === 'defer' && !revisit) fail('invalid', 'A deferral needs a date to come back to.');
  if (i.outcome !== 'defer' && i.revisit) fail('invalid', 'Only a deferral has a revisit date.');

  const before = await db.first<EditDecisionRecord>(
    `SELECT ${COLS} FROM edit_decision d WHERE d.query_id = ? AND d.studio_id = ? AND NOT EXISTS (SELECT 1 FROM edit_decision n WHERE n.supersedes_id = d.id)`,
    [queryId, c.studioId]
  );
  const id = newRecordId();
  const ledger = newRecordId();
  const taskId = i.outcome === 'defer' ? newRecordId() : null;
  const label = `${pass.title}, item ${q.seq}: ${brief(q)}`;
  const context = [`${q.kind === 'suggestion' ? 'Suggestion' : q.kind === 'query' ? 'Query' : 'Comment'}: ${q.body || '(no text)'}`, q.replacement !== null ? `Replace with: ${q.replacement}` : '', q.response ? `Author's answer: ${q.response}` : ''].filter(Boolean).join('\n').slice(0, 5000);
  const outcomeText = { accept: 'Accepted', reject: 'Rejected', defer: `Deferred to ${revisit}` }[i.outcome] + (reason ? `: ${reason}` : '');
  const audit = (action: string, target: string, detail: unknown) => ({
    sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
    params: [c.now, c.actor, action, target, JSON.stringify(detail)]
  });
  const stmts = [
    { sql: 'INSERT INTO decision (id, studio_id, project_id, title, context, outcome, supersedes_id, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?)', params: [ledger, c.studioId, pass.projectId, label.slice(0, 200), context, outcomeText.slice(0, 2000), before?.ledgerId ?? null, c.actor, c.now] },
    ...(taskId
      ? [{ sql: 'INSERT INTO task (id, studio_id, project_id, kind, title, notes, assignee_id, due, state, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [taskId, c.studioId, pass.projectId, 'task', `Revisit: ${label}`.slice(0, 200), reason, c.actor, revisit, 'open', c.now, c.actor, c.now, c.actor] }, audit('task.create', taskId, { projectId: pass.projectId, from: 'edit.defer' })]
      : []),
    // a changed mind cancels the revisit task the old deferral made
    ...(before?.taskId ? [{ sql: "UPDATE task SET state = 'cancelled', updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ? AND state = 'open'", params: [c.now, c.actor, before.taskId, c.studioId] }] : []),
    { sql: 'INSERT INTO edit_decision (id, studio_id, query_id, outcome, reason, revisit, ledger_id, task_id, supersedes_id, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, queryId, i.outcome, reason, revisit, ledger, taskId, before?.id ?? null, c.actor, c.now] },
    audit('decision.record', ledger, { projectId: pass.projectId, supersedes: before?.ledgerId ?? null }),
    audit('query.decide', queryId, { passId: q.passId, seq: q.seq, outcome: i.outcome, supersedes: before?.id ?? null })
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String((e as Error)?.message ?? e))) fail('conflict', 'Someone else has just decided on this item. Open it again.');
    throw e;
  }
  return (await getEditDecision(db, c, id))!;
}
