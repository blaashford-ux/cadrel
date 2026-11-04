import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, answerQuery, createPass, createPerson, decideQuery, getTask, listDecisions, listEditDecisions, makeAnchor, movePass, raiseQueries, withdrawQuery, type Ctx, type QueryRecord
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db, ana: string, bo: string, pass: string, sug: QueryRecord, qry: QueryRecord, com: QueryRecord;
const TEXT = 'The river ran cold. She walked slowly to the river.';
const at = (actor: string, now = '2026-11-03T10:00:00.000Z'): Ctx => ({ studioId: 's1', actor, now });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
const a = (q: string) => makeAnchor(TEXT, TEXT.indexOf(q), TEXT.indexOf(q) + q.length);

beforeEach(async () => {
  db = memoryDb();
  const c = { studioId: 's1', actor: 'system', now: '2026-11-03T09:00:00.000Z' };
  ana = (await createPerson(db, c, { name: 'Ana' })).id;
  bo = (await createPerson(db, c, { name: 'Bo' })).id;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 's1', 'book.md', 1)");
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 1, 'h', 1, 'x', '2026-11-01T00:00:00.000Z')");
  pass = (await createPass(db, at(bo), { projectId: 'p1', kind: 'line', fileId: 'f1', editorId: bo })).id;
  await movePass(db, at(bo), pass, 'in_progress');
  [sug, qry, com] = await raiseQueries(db, at(bo), pass, [
    { kind: 'suggestion', anchor: a('walked slowly'), replacement: 'crept', body: 'Stronger verb.' },
    { kind: 'query', body: 'Cold how?', anchor: a('ran cold') },
    { kind: 'comment', body: 'Nice.' }
  ]) as [QueryRecord, QueryRecord, QueryRecord];
});
const deliver = () => movePass(db, at(bo), pass, 'delivered');

describe('decisions on items in a pass', () => {
  it('accepts with no reason needed, and enters it in the ledger', async () => {
    await deliver();
    const d = await decideQuery(db, at(ana), sug.id, { outcome: 'accept' });
    expect(d).toMatchObject({ queryId: sug.id, outcome: 'accept', reason: '', revisit: null, taskId: null, supersedesId: null, decidedBy: ana });
    const [entry] = await listDecisions(db, at(ana), { projectId: 'p1' });
    expect(entry).toMatchObject({ id: d.ledgerId, projectId: 'p1', outcome: 'Accepted' });
    expect(entry!.title).toContain('item 1: walked slowly');
    expect(entry!.context).toContain('Replace with: crept');
  });

  it('needs a reason to reject or defer, and a date to defer', async () => {
    await deliver();
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'reject' }))).toBe('invalid');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'reject', reason: '  ' }))).toBe('invalid');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'defer', reason: 'later' }))).toBe('invalid');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'defer', reason: 'later', revisit: '2026-02-30' }))).toBe('invalid');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'accept', revisit: '2026-12-01' }))).toBe('invalid');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'maybe' as never }))).toBe('invalid');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'reject', reason: 'x'.repeat(2001) }))).toBe('invalid');
    expect(await listEditDecisions(db, at(ana))).toEqual([]);
    expect(await listDecisions(db, at(ana), {})).toEqual([]); // nothing half-written
  });

  it('a deferral makes a task for the revisit, assigned to whoever decided', async () => {
    await deliver();
    const d = await decideQuery(db, at(ana), sug.id, { outcome: 'defer', reason: 'Wait for the beta readers.', revisit: '2026-12-01' });
    expect(d).toMatchObject({ outcome: 'defer', revisit: '2026-12-01' });
    const t = (await getTask(db, at(ana), d.taskId!))!;
    expect(t).toMatchObject({ projectId: 'p1', assigneeId: ana, due: '2026-12-01', state: 'open', notes: 'Wait for the beta readers.' });
    expect(t.title).toMatch(/^Revisit: Line edit, item 1: walked slowly/);
  });

  it('changing your mind supersedes the old decision, keeps both on record, and cancels a revisit task', async () => {
    await deliver();
    const first = await decideQuery(db, at(ana), sug.id, { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' });
    const second = await decideQuery(db, at(ana, '2026-11-04T10:00:00.000Z'), sug.id, { outcome: 'reject', reason: 'Keeps the voice.' });
    expect(second.supersedesId).toBe(first.id);
    expect((await listEditDecisions(db, at(ana), { queryId: sug.id })).map((d) => d.id)).toEqual([second.id]); // the one standing now
    expect((await listEditDecisions(db, at(ana), { queryId: sug.id, history: true })).map((d) => d.outcome)).toEqual(['defer', 'reject']);
    expect((await getTask(db, at(ana), first.taskId!))!.state).toBe('cancelled');
    const ledger = await listDecisions(db, at(ana), { projectId: 'p1' });
    expect(ledger.find((l) => l.id === first.ledgerId)!.supersededBy).toBe(second.ledgerId);
    const third = await decideQuery(db, at(ana), sug.id, { outcome: 'accept' });
    expect(third.supersedesId).toBe(second.id);
    expect(await listEditDecisions(db, at(ana), { passId: pass })).toHaveLength(1);
  });

  it('decides only on a delivered pass and only on items still standing', async () => {
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'accept' }))).toBe('conflict'); // still in progress
    await withdrawQuery(db, at(bo), com.id);
    await deliver();
    expect(await code(decideQuery(db, at(ana), com.id, { outcome: 'accept' }))).toBe('conflict'); // withdrawn
    expect(await code(decideQuery(db, at(ana), 'nope', { outcome: 'accept' }))).toBe('not-found');
    await answerQuery(db, at(ana), qry.id, 'Freezing.');
    await decideQuery(db, at(ana), sug.id, { outcome: 'accept' });
    await movePass(db, at(ana), pass, 'responded');
    expect(await code(decideQuery(db, at(ana), sug.id, { outcome: 'reject', reason: 'x' }))).toBe('conflict'); // too late
  });

  it('a pass cannot be marked responded while a suggestion has no decision', async () => {
    await deliver();
    await answerQuery(db, at(ana), qry.id, 'Freezing.');
    const err = (await movePass(db, at(ana), pass, 'responded').catch((e) => e)) as WorkError;
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err.message).toContain('1 suggestion has no decision');
    await decideQuery(db, at(ana), sug.id, { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' });
    expect(await code(movePass(db, at(ana), pass, 'responded'))).toBe('ok'); // a deferral counts as decided
  });

  it('is in the audit log, and one studio cannot see another’s decisions', async () => {
    await deliver();
    const d = await decideQuery(db, at(ana), sug.id, { outcome: 'accept' });
    const log = await db.all<{ action: string }>("SELECT action FROM audit WHERE action IN ('query.decide', 'decision.record') ORDER BY rowid");
    expect(log.map((l) => l.action)).toEqual(['decision.record', 'query.decide']);
    expect(await listEditDecisions(db, { studioId: 's2' }, { history: true })).toEqual([]);
    expect(d.id).toBeTruthy();
  });
});
