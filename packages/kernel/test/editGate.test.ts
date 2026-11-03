import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkflowError, checkMove, cleanConditions, createPass, createPerson, createWorkflow, decideQuery, editorialFacts, ensureDefaultWorkflow, listWorkflows, makeAnchor, movePass, raiseQueries, answerQuery,
  saveWorkflow, stageOptions, unmetConditions, type Ctx, type ProjectFacts, type WorkflowDraft
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db, ana: string, bo: string;
const at = (actor: string): Ctx => ({ studioId: 's1', actor, now: '2026-11-03T10:00:00.000Z' });
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ hasManuscript: false, openNotes: 0, subprojects: [], openTasks: 0, approved: [], ...over });
const anyone = () => true;

beforeEach(async () => {
  db = memoryDb();
  const c = { studioId: 's1', actor: 'system', now: '2026-11-03T09:00:00.000Z' };
  ana = (await createPerson(db, c, { name: 'Ana' })).id;
  bo = (await createPerson(db, c, { name: 'Bo' })).id;
  await ensureDefaultWorkflow(db, at(ana));
  for (const [id, n] of [['f1', 1], ['f2', 1]] as const) {
    await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, 's1', ?, 1)", [id, `${id}.md`]);
    await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, ?, ?, 1, 'x', '2026-11-01T00:00:00.000Z')", [id, n, `h${id}`]);
  }
});

/** Takes a pass all the way to closed. */
async function closedPass(projectId: string, kind: 'developmental' | 'line' | 'copy' | 'proof', fileId = 'f1') {
  const p = await createPass(db, at(ana), { projectId, kind, fileId, editorId: bo });
  for (const s of ['in_progress', 'delivered', 'responded', 'closed'] as const) await movePass(db, at(ana), p.id, s);
  return p;
}

describe('editorial gate conditions', () => {
  it('accepts a pass gate for developmental, line and copy, once each, and a queries gate', () => {
    expect(cleanConditions([{ kind: 'pass_closed', passKind: 'line' }, { kind: 'pass_closed', passKind: 'line' }, { kind: 'pass_closed', passKind: 'copy' }, { kind: 'queries_resolved' }, { kind: 'queries_resolved' }])).toEqual([
      { kind: 'pass_closed', passKind: 'line' }, { kind: 'pass_closed', passKind: 'copy' }, { kind: 'queries_resolved' }
    ]);
  });

  it('refuses a proofread gate, and a pass gate that names no kind', () => {
    expect(() => cleanConditions([{ kind: 'pass_closed', passKind: 'proof' }])).toThrow(/proofread only advises/);
    expect(() => cleanConditions([{ kind: 'pass_closed' }])).toThrow(/asks for one of/);
    expect(() => cleanConditions([{ kind: 'pass_closed', passKind: 'rewrite' }])).toThrow(WorkflowError);
  });

  it('says what is missing, and tells "not closed yet" from "never run"', () => {
    const gate = [{ kind: 'pass_closed' as const, passKind: 'developmental' as const }];
    expect(unmetConditions(facts(), gate)).toEqual(['Needs a closed developmental edit']);
    expect(unmetConditions(facts({ editorial: { closed: [], live: ['developmental'], unansweredQueries: 0 } }), gate)).toEqual(['The developmental edit is still under way. It needs closing first.']);
    expect(unmetConditions(facts({ editorial: { closed: ['developmental'], live: [], unansweredQueries: 0 } }), gate)).toEqual([]);
    expect(unmetConditions(facts({ editorial: { closed: ['developmental'], live: ['developmental'], unansweredQueries: 0 } }), gate)).toHaveLength(1); // a new round is under way
    const q = [{ kind: 'queries_resolved' as const }];
    expect(unmetConditions(facts({ editorial: { closed: [], live: [], unansweredQueries: 1 } }), q)).toEqual(['1 editor’s query is still unanswered']);
    expect(unmetConditions(facts({ editorial: { closed: [], live: [], unansweredQueries: 3 } }), q)).toEqual(['3 editor’s queries are still unanswered']);
  });

  it('a Studio with no editorial records: no pass is closed, no query waits', () => {
    expect(unmetConditions(facts(), [{ kind: 'queries_resolved' }])).toEqual([]);
    expect(unmetConditions(facts(), [{ kind: 'pass_closed', passKind: 'copy' }])).toEqual(['Needs a closed copy edit']);
  });
});

describe('what a gate sees of a project’s passes', () => {
  it('reads the kinds closed and live, and the queries waiting, across the projects it is given', async () => {
    expect(await editorialFacts(db, at(ana), [])).toEqual({ closed: [], live: [], unansweredQueries: 0 });
    await closedPass('p1', 'developmental');
    const live = await createPass(db, at(ana), { projectId: 'p1', kind: 'line', fileId: 'f1', editorId: bo });
    await movePass(db, at(ana), live.id, 'in_progress');
    await raiseQueries(db, at(bo), live.id, [{ kind: 'query', body: 'Why?' }, { kind: 'comment', body: 'FYI' }]);
    const cancelled = await createPass(db, at(ana), { projectId: 'p1', kind: 'copy', fileId: 'f1', editorId: bo });
    await movePass(db, at(ana), cancelled.id, 'cancelled');
    expect(await editorialFacts(db, at(ana), ['p1'])).toEqual({ closed: ['developmental'], live: ['line'], unansweredQueries: 1 });
    expect(await editorialFacts(db, at(ana), ['p2'])).toEqual({ closed: [], live: [], unansweredQueries: 0 }); // another project
    expect(await editorialFacts(db, at(ana), ['p2', 'p1'])).toMatchObject({ closed: ['developmental'] }); // a project and its subprojects
    expect(await editorialFacts(db, { studioId: 's2' }, ['p1'])).toEqual({ closed: [], live: [], unansweredQueries: 0 });
  });

  it('an answered query stops holding the gate', async () => {
    const p = await createPass(db, at(ana), { projectId: 'p1', kind: 'line', fileId: 'f1', editorId: bo });
    await movePass(db, at(ana), p.id, 'in_progress');
    const [q] = await raiseQueries(db, at(bo), p.id, [{ kind: 'query', body: 'Why?' }]);
    await movePass(db, at(ana), p.id, 'delivered');
    expect((await editorialFacts(db, at(ana), ['p1'])).unansweredQueries).toBe(1);
    await answerQuery(db, at(ana), q!.id, 'Because.');
    expect((await editorialFacts(db, at(ana), ['p1'])).unansweredQueries).toBe(0);
  });

  it('a proofread that is closed or live never matters to a gate, because no gate can ask for it', async () => {
    await closedPass('p1', 'proof');
    expect(() => cleanConditions([{ kind: 'pass_closed', passKind: 'proof' }])).toThrow();
    expect(unmetConditions(facts({ editorial: await editorialFacts(db, at(ana), ['p1']) }), [{ kind: 'pass_closed', passKind: 'copy' }])).toHaveLength(1);
  });
});

describe('a stage gate that asks for editing to be finished', () => {
  it('holds the move to Published until the line and copy edits are closed, then lets it through', async () => {
    const [base] = await listWorkflows(db, at(ana));
    const draft: WorkflowDraft = {
      name: 'With editing', description: '',
      stages: base!.stages.map((s) => ({ key: s.key, name: s.name, category: s.category, color: s.color })),
      transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'pass_closed', passKind: 'line' }, { kind: 'pass_closed', passKind: 'copy' }, { kind: 'queries_resolved' }] }]
    } as never;
    const wf = await createWorkflow(db, at(ana), { name: 'With editing' });
    const saved = await saveWorkflow(db, at(ana), wf.id, { ...draft, name: 'With editing' } as never);
    const look = async () => ({ ...facts({ editorial: await editorialFacts(db, at(ana), ['p1']) }) });

    expect(() => checkMove(saved, 'editing', 'published', facts(), anyone)).toThrow(/Needs a closed line edit/);
    await closedPass('p1', 'line');
    const f1 = await look();
    expect(() => checkMove(saved, 'editing', 'published', f1, anyone)).toThrow(/Needs a closed copy edit/);
    const copy = await createPass(db, at(ana), { projectId: 'p1', kind: 'copy', fileId: 'f1', editorId: bo });
    await movePass(db, at(ana), copy.id, 'in_progress');
    const [q, s] = await raiseQueries(db, at(bo), copy.id, [{ kind: 'query', body: 'Why?' }, { kind: 'suggestion', anchor: makeAnchor('a b', 0, 1), replacement: 'c' }]);
    await movePass(db, at(ana), copy.id, 'delivered');
    const blocked = stageOptions(saved, 'editing', await look(), anyone).options.find((o) => o.key === 'published')!;
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(' ')).toMatch(/copy edit is still under way/);
    expect(blocked.reasons.join(' ')).toMatch(/1 editor’s query is still unanswered/);

    await answerQuery(db, at(ana), q!.id, 'Because.');
    await decideQuery(db, at(ana), s!.id, { outcome: 'accept' });
    await movePass(db, at(ana), copy.id, 'responded');
    await movePass(db, at(ana), copy.id, 'closed');
    const f2 = await look();
    expect(() => checkMove(saved, 'editing', 'published', f2, anyone)).not.toThrow();
  });
});
