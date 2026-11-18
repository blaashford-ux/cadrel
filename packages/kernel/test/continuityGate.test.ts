import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONDITION_KINDS, checkMove, cleanConditions, continuityFacts, createPerson, createWorkflow, decideFinding, decideProposal, deliverCheck, ensureDefaultWorkflow, listEntries, listFacts, listWorkflows, makeAnchor,
  proposeChange, raiseFindings, saveWorkflow, startCheck, unmetConditions, type Ctx, type Db, type ProjectFacts, type WorkflowDraft
} from '../src/index';
import { memoryDb } from './sqlite';

let db: Db, ana: string, eyes: string, clock = 0;
const at = (actor: string): Ctx => ({ studioId: 's1', actor, now: `2026-11-18T10:00:${String(clock++).padStart(2, '0')}Z` });
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ hasManuscript: false, openNotes: 0, subprojects: [], openTasks: 0, approved: [], ...over });
const TEXT = 'Mara had green eyes. She counted nine days.';
const finding = (quote: string, severity: 'low' | 'medium' | 'high') => ({ kind: 'contradiction' as const, severity, confidence: 'high' as const, body: 'x', anchor: makeAnchor(TEXT, TEXT.indexOf(quote), TEXT.indexOf(quote) + quote.length), factIds: [eyes] });

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  ana = (await createPerson(db, { studioId: 's1', actor: 'system', now: '2026-11-18T09:00:00Z' }, { name: 'Ana' })).id;
  await ensureDefaultWorkflow(db, at(ana));
  for (const id of ['f1', 'f2']) await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, 's1', ?, 1)", [id, `${id}.md`]);
  const e = await proposeChange(db, at(ana), 'series', { change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
  await decideProposal(db, at(ana), e.id, { approve: true });
  const f = await proposeChange(db, at(ana), 'series', { change: 'add_fact', entryId: (await listEntries(db, at(ana), { projectId: 'series' }))[0]!.id, text: 'Mara has grey eyes.' });
  await decideProposal(db, at(ana), f.id, { approve: true });
  eyes = (await listFacts(db, at(ana), { projectId: 'series' }))[0]!.id;
});

describe('the continuity gate condition', () => {
  it('is a condition an administrator can add, with no label to give', () => {
    expect(CONDITION_KINDS.continuity_clear).toMatch(/no open high-severity finding/);
    expect(cleanConditions([{ kind: 'continuity_clear' }, { kind: 'continuity_clear' }])).toEqual([{ kind: 'continuity_clear' }]);
  });

  it('asks for a check first, then waits for one that is being made, then for no open high-severity finding', () => {
    const cond = [{ kind: 'continuity_clear' as const }];
    expect(unmetConditions(facts(), cond)).toEqual(['Needs a continuity check']);
    expect(unmetConditions(facts({ continuity: { checked: 0, underway: 0, openHigh: 0 } }), cond)).toEqual(['Needs a continuity check']);
    expect(unmetConditions(facts({ continuity: { checked: 1, underway: 1, openHigh: 0 } }), cond)).toEqual(['A continuity check is still being made']);
    expect(unmetConditions(facts({ continuity: { checked: 2, underway: 2, openHigh: 0 } }), cond)).toEqual(['2 continuity checks are still being made']);
    expect(unmetConditions(facts({ continuity: { checked: 1, underway: 0, openHigh: 1 } }), cond)).toEqual(['1 high-severity continuity finding is still open']);
    expect(unmetConditions(facts({ continuity: { checked: 1, underway: 0, openHigh: 3 } }), cond)).toEqual(['3 high-severity continuity findings are still open']);
    expect(unmetConditions(facts({ continuity: { checked: 1, underway: 0, openHigh: 0 } }), cond)).toEqual([]);
  });
});

describe('what a gate sees of a project’s continuity checks', () => {
  const start = (project: string, file: string) => startCheck(db, at(ana), { projectId: project, seriesId: 'series', fileId: file });

  it('is nothing before any check, and counts only the newest check of each manuscript', async () => {
    expect(await continuityFacts(db, at(ana), ['book'])).toEqual({ checked: 0, underway: 0, openHigh: 0 });
    expect(await continuityFacts(db, at(ana), [])).toEqual({ checked: 0, underway: 0, openHigh: 0 });
    const first = await start('book', 'f1');
    await raiseFindings(db, at(ana), first.id, [finding('green eyes', 'high')]);
    await deliverCheck(db, at(ana), first.id);
    expect(await continuityFacts(db, at(ana), ['book'])).toEqual({ checked: 1, underway: 0, openHigh: 1 });
    // dismissed, closed, and a newer check of the same manuscript: the old high finding no longer counts, and the new one is being made
    const [f] = await (await import('../src/index')).listFindings(db, at(ana), { checkId: first.id });
    await decideFinding(db, at(ana), f!.id, { outcome: 'dismiss', reason: 'Intended.' });
    expect(await continuityFacts(db, at(ana), ['book'])).toEqual({ checked: 1, underway: 0, openHigh: 0 });
    await (await import('../src/index')).closeCheck(db, at(ana), first.id);
    const second = await start('book', 'f1');
    expect(await continuityFacts(db, at(ana), ['book'])).toEqual({ checked: 0, underway: 1, openHigh: 0 });
    await raiseFindings(db, at(ana), second.id, [finding('nine days', 'medium'), finding('green eyes', 'low')]);
    await deliverCheck(db, at(ana), second.id);
    expect(await continuityFacts(db, at(ana), ['book'])).toEqual({ checked: 1, underway: 0, openHigh: 0 }); // medium and low advise, they do not hold
  });

  it('sums over the manuscripts of the project and what is under it, and not another project’s', async () => {
    const a = await start('book', 'f1');
    const b = await start('sub', 'f2');
    await raiseFindings(db, at(ana), a.id, [finding('green eyes', 'high')]);
    await raiseFindings(db, at(ana), b.id, [finding('nine days', 'high')]);
    await deliverCheck(db, at(ana), a.id);
    expect(await continuityFacts(db, at(ana), ['book', 'sub'])).toEqual({ checked: 1, underway: 1, openHigh: 2 });
    expect(await continuityFacts(db, at(ana), ['sub'])).toEqual({ checked: 0, underway: 1, openHigh: 1 });
    expect(await continuityFacts(db, at(ana), ['elsewhere'])).toEqual({ checked: 0, underway: 0, openHigh: 0 });
  });

  it('holds a stage move through the workflow until the check is clear', async () => {
    const [base] = await listWorkflows(db, at(ana));
    const draft = { name: 'Checked', description: '', stages: base!.stages.map((s) => ({ key: s.key, name: s.name, category: s.category, color: s.color })), transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'continuity_clear' }] }] } as unknown as WorkflowDraft;
    const wf = await saveWorkflow(db, at(ana), (await createWorkflow(db, at(ana), { name: 'Checked' })).id, draft);
    const move = async () => checkMove(wf, 'editing', 'published', facts({ continuity: await continuityFacts(db, at(ana), ['book']) }), () => true);
    expect(await move().then(() => 'ok', (e) => (e as Error).message)).toMatch(/Needs a continuity check/);
    const k = await start('book', 'f1');
    expect(await move().then(() => 'ok', (e) => (e as Error).message)).toMatch(/still being made/);
    await raiseFindings(db, at(ana), k.id, [finding('green eyes', 'high')]);
    await deliverCheck(db, at(ana), k.id);
    expect(await move().then(() => 'ok', (e) => (e as Error).message)).toMatch(/1 high-severity continuity finding is still open/);
    const [f] = await (await import('../src/index')).listFindings(db, at(ana), { checkId: k.id });
    await decideFinding(db, at(ana), f!.id, { outcome: 'dismiss', reason: 'Intended.' });
    expect(await move()).toBeUndefined();
  });
});
