import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, addDependency, approvalsWaitingFor, approvedLabels, cleanDate, createPerson, createTask, listApprovals, listDecisions, listTasks, openTaskCount, recordDecision, removeDependency, requestApproval,
  respondToApproval, setTaskState, updateTask, withdrawApproval, type Ctx
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db, ana: string, bo: string, cy: string;
const at = (actor: string, now = '2026-10-27T10:00:00.000Z'): Ctx => ({ studioId: 's1', actor, now });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
beforeEach(async () => {
  db = memoryDb();
  const c = { studioId: 's1', actor: 'system', now: '2026-10-27T09:00:00.000Z' };
  [ana, bo, cy] = await Promise.all(['Ana', 'Bo', 'Cy'].map(async (name) => (await createPerson(db, c, { name })).id));
});

describe('tasks and deadlines', () => {
  it('makes tasks and deadlines for a project, oldest due first, and filters them', async () => {
    const a = await createTask(db, at(ana), { projectId: 'p1', title: 'Write blurb', assigneeId: bo, due: '2026-11-05' });
    await createTask(db, at(ana), { projectId: 'p1', title: 'Launch', kind: 'deadline', due: '2026-11-01' });
    await createTask(db, at(ana), { projectId: 'p2', title: 'Elsewhere' });
    expect((await listTasks(db, at(ana), { projectId: 'p1' })).map((t) => t.title)).toEqual(['Launch', 'Write blurb']);
    expect((await listTasks(db, at(ana), { projectIds: ['p1', 'p2'] })).map((t) => t.title)).toEqual(['Launch', 'Write blurb', 'Elsewhere']); // undated last
    expect((await listTasks(db, at(ana), { assigneeId: bo })).map((t) => t.id)).toEqual([a.id]);
    expect((await listTasks(db, at(ana), { overdueBefore: '2026-11-03' })).map((t) => t.title)).toEqual(['Launch']);
    expect(await listTasks(db, at(ana), { projectIds: [] })).toEqual([]);
  });

  it('checks what it is given', async () => {
    expect(await code(createTask(db, at(ana), { projectId: 'p1', title: '  ' }))).toBe('invalid');
    expect(await code(createTask(db, at(ana), { projectId: 'p1', title: 'x', due: '2026-02-30' }))).toBe('invalid');
    expect(await code(createTask(db, at(ana), { projectId: 'p1', title: 'x', kind: 'deadline' }))).toBe('invalid'); // a deadline needs a date
    expect(await code(createTask(db, at(ana), { projectId: '', title: 'x' }))).toBe('invalid');
    expect(await code(createTask(db, at(ana), { projectId: 'p1', title: 'x', dependsOn: ['nope'] }))).toBe('not-found');
    expect(cleanDate('2028-02-29')).toBe('2028-02-29');
    expect(cleanDate('')).toBeNull();
  });

  it('edits an open task only, and a deadline always keeps its date', async () => {
    const t = await createTask(db, at(ana), { projectId: 'p1', title: 'Old', due: '2026-11-05' });
    expect((await updateTask(db, at(bo), t.id, { title: 'New', assigneeId: cy, due: null })).due).toBeNull();
    const d = await createTask(db, at(ana), { projectId: 'p1', title: 'D', kind: 'deadline', due: '2026-11-05' });
    expect(await code(updateTask(db, at(ana), d.id, { due: null }))).toBe('invalid');
    await setTaskState(db, at(ana), t.id, 'cancelled');
    expect(await code(updateTask(db, at(ana), t.id, { title: 'Again' }))).toBe('conflict');
    expect((await setTaskState(db, at(ana), t.id, 'open')).state).toBe('open');
  });

  it('will not finish a task while what it waits for is open, and will not make a loop', async () => {
    const a = await createTask(db, at(ana), { projectId: 'p1', title: 'Cover' });
    const b = await createTask(db, at(ana), { projectId: 'p1', title: 'Upload', dependsOn: [a.id] });
    const err = await setTaskState(db, at(ana), b.id, 'done').catch((e) => e as WorkError);
    expect(err).toMatchObject({ code: 'blocked', reasons: ['Cover'] });
    expect(await code(addDependency(db, at(ana), a.id, b.id))).toBe('conflict');
    expect(await code(addDependency(db, at(ana), a.id, a.id))).toBe('invalid');
    const other = await createTask(db, at(ana), { projectId: 'p2', title: 'Else' });
    expect(await code(addDependency(db, at(ana), b.id, other.id))).toBe('invalid'); // same project only
    await setTaskState(db, at(ana), a.id, 'done');
    expect((await setTaskState(db, at(ana), b.id, 'done')).doneAt).toBe('2026-10-27T10:00:00.000Z');
    const c2 = await createTask(db, at(ana), { projectId: 'p1', title: 'C2' });
    expect((await addDependency(db, at(ana), c2.id, b.id)).dependsOn).toEqual([b.id]);
    expect((await removeDependency(db, at(ana), c2.id, b.id)).dependsOn).toEqual([]);
  });

  it('counts open tasks, not deadlines or finished work', async () => {
    const t = await createTask(db, at(ana), { projectId: 'p1', title: 'A' });
    await createTask(db, at(ana), { projectId: 'p2', title: 'B' });
    await createTask(db, at(ana), { projectId: 'p1', title: 'D', kind: 'deadline', due: '2026-11-01' });
    expect(await openTaskCount(db, at(ana), ['p1', 'p2'])).toBe(2);
    await setTaskState(db, at(ana), t.id, 'done');
    expect(await openTaskCount(db, at(ana), ['p1'])).toBe(0);
    expect(await openTaskCount(db, at(ana), [])).toBe(0);
  });

  it('writes an audit row with each change, in the same batch', async () => {
    const t = await createTask(db, at(ana), { projectId: 'p1', title: 'A' });
    await setTaskState(db, at(bo), t.id, 'done');
    expect((await db.all<{ action: string; actor: string }>("SELECT action, actor FROM audit WHERE action LIKE 'task.%' ORDER BY rowid")).map((r) => [r.action, r.actor])).toEqual([['task.create', ana], ['task.done', bo]]);
  });
});

describe('approvals', () => {
  it('asks named people; enough approvals approve it, and the project stands approved under that label', async () => {
    const a = await requestApproval(db, at(ana), { projectId: 'p1', label: 'Cover approved', approverIds: [bo, cy], required: 2 });
    expect(a).toMatchObject({ state: 'pending', required: 2 });
    expect((await approvalsWaitingFor(db, at(bo), bo)).map((x) => x.id)).toEqual([a.id]);
    expect((await respondToApproval(db, at(bo), a.id, 'approved')).state).toBe('pending');
    expect(await approvedLabels(db, at(ana), 'p1')).toEqual([]);
    expect(await approvalsWaitingFor(db, at(bo), bo)).toEqual([]); // answered
    const done = await respondToApproval(db, at(cy, '2026-10-27T11:00:00.000Z'), a.id, 'approved');
    expect(done).toMatchObject({ state: 'approved', closedAt: '2026-10-27T11:00:00.000Z' });
    expect(await approvedLabels(db, at(ana), 'p1')).toEqual(['Cover approved']);
    expect(await approvedLabels(db, at(ana), 'p2')).toEqual([]);
  });

  it('is decided only by someone it names, once, and a rejection needs a reason and closes it', async () => {
    const a = await requestApproval(db, at(ana), { projectId: 'p1', label: 'Legal', approverIds: [bo, cy] });
    expect(await code(respondToApproval(db, at(ana), a.id, 'approved'))).toBe('conflict'); // not asked
    expect(await code(respondToApproval(db, at(bo), a.id, 'rejected'))).toBe('invalid');
    expect((await respondToApproval(db, at(bo), a.id, 'rejected', 'Trademark clash')).state).toBe('rejected');
    expect(await code(respondToApproval(db, at(cy), a.id, 'approved'))).toBe('conflict'); // already closed
    expect(await approvedLabels(db, at(ana), 'p1')).toEqual([]);
  });

  it('allows one pending request per label, a new request after the last was decided, and a later rejection takes the approval away', async () => {
    const a = await requestApproval(db, at(ana, '2026-10-27T10:00:00.000Z'), { projectId: 'p1', label: 'Ready', approverIds: [bo] });
    expect(await code(requestApproval(db, at(ana), { projectId: 'p1', label: 'READY', approverIds: [cy] }))).toBe('exists');
    await respondToApproval(db, at(bo, '2026-10-27T10:30:00.000Z'), a.id, 'approved');
    expect(await approvedLabels(db, at(ana), 'p1')).toEqual(['Ready']);
    const b = await requestApproval(db, at(ana, '2026-10-28T10:00:00.000Z'), { projectId: 'p1', label: 'Ready', approverIds: [bo] });
    expect(await approvedLabels(db, at(ana), 'p1')).toEqual(['Ready']); // still pending: the earlier approval stands until it is answered
    await respondToApproval(db, at(bo, '2026-10-28T11:00:00.000Z'), b.id, 'rejected', 'Cover changed');
    expect(await approvedLabels(db, at(ana), 'p1')).toEqual([]);
  });

  it('can be withdrawn while pending, and asks for people and a sensible count', async () => {
    const a = await requestApproval(db, at(ana), { projectId: 'p1', label: 'X', approverIds: [bo] });
    expect((await withdrawApproval(db, at(ana), a.id)).state).toBe('withdrawn');
    expect(await code(withdrawApproval(db, at(ana), a.id))).toBe('conflict');
    expect(await code(requestApproval(db, at(ana), { projectId: 'p1', label: 'X', approverIds: [] }))).toBe('invalid');
    expect(await code(requestApproval(db, at(ana), { projectId: 'p1', label: 'X', approverIds: [bo], required: 2 }))).toBe('invalid');
    expect(await code(requestApproval(db, at(ana), { projectId: 'p9', label: 'Y', approverIds: ['ghost'] }))).toBe('not-found'); // someone who is not a person here
    expect((await listApprovals(db, at(ana), { projectId: 'p1', state: 'withdrawn' })).map((x) => x.id)).toEqual([a.id]);
  });
});

describe('the decision ledger', () => {
  it('records decisions, never edits them, and lets a later one replace an earlier one once', async () => {
    const d1 = await recordDecision(db, at(ana), { projectId: 'p1', title: 'Cover direction', context: 'Two concepts', outcome: 'Go with concept B' });
    const d2 = await recordDecision(db, at(bo, '2026-10-28T10:00:00.000Z'), { projectId: 'p1', title: 'Cover direction', outcome: 'Back to concept A', supersedes: d1.id });
    expect((await listDecisions(db, at(ana), { projectId: 'p1' })).map((d) => [d.id, d.supersededBy])).toEqual([[d2.id, null], [d1.id, d2.id]]);
    expect((await listDecisions(db, at(ana), { projectId: 'p1', current: true })).map((d) => d.id)).toEqual([d2.id]);
    expect(await code(recordDecision(db, at(cy), { projectId: 'p1', title: 'x', outcome: 'y', supersedes: d1.id }))).toBe('conflict');
    expect(await code(recordDecision(db, at(cy), { title: 'x', outcome: ' ' }))).toBe('invalid');
    expect(await code(recordDecision(db, at(cy), { title: 'x', outcome: 'y', supersedes: 'nope' }))).toBe('not-found');
    expect((await recordDecision(db, at(cy), { title: 'Studio-wide', outcome: 'ok' })).projectId).toBeNull();
  });
});
