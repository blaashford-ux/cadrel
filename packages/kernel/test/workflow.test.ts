import { beforeEach, describe, expect, it } from 'vitest';
import {
  MDEDIT_STAGES, PROJECT_LEVELS, WorkflowError, adoptWorkflow, checkMove, createProject, createRole, createWorkflow, defaultWorkflow, deleteRole, deleteWorkflow, ensureDefaultWorkflow, initialStage,
  listWorkflows, newStageKey, saveWorkflow, setDefaultWorkflow, setProjectStage, stageOptions, unmetConditions, updateProject, emptyTree, ProjectError, sanitizeTree,
  type Ctx, type ProjectFacts, type WorkflowDraft, type WorkflowRecord
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ studioId: 's1', actor: 'ana', now: '2026-10-27T10:00:00.000Z', ...over });
beforeEach(async () => {
  db = memoryDb();
  await ensureDefaultWorkflow(db, ctx());
});
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkflowError ? e.code : `other:${(e as Error).message}`));
const anyone = () => true;
const nobody = () => false;
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ hasManuscript: false, openNotes: 0, subprojects: [], openTasks: 0, approved: [], ...over });
const asDraft = (w: WorkflowRecord): WorkflowDraft => ({ name: w.name, description: w.description, stages: w.stages.map((s) => ({ key: s.key, name: s.name, category: s.category, color: s.color })), transitions: w.transitions });

describe('the shipped default', () => {
  it('is MDEdit’s stages in its order with every move open, and the default for projects and for subprojects', async () => {
    const [w] = await listWorkflows(db, ctx());
    expect(w).toMatchObject({ name: 'Writing and publishing', defaultFor: ['project', 'subproject'], templateKey: 'mdedit' });
    expect(w!.stages.map((s) => [s.key, s.name])).toEqual([['planning', 'Planning'], ['drafting', 'Drafting'], ['revising', 'Revising'], ['editing', 'Editing'], ['published', 'Published'], ['paused', 'On hold']]);
    expect(w!.transitions).toHaveLength(30);
    expect(w!.transitions.every((t) => t.roleIds.length === 0 && t.conditions.length === 0)).toBe(true);
    expect((await defaultWorkflow(db, ctx(), 'project'))!.id).toBe(w!.id);
    expect((await defaultWorkflow(db, ctx(), 'subproject'))!.id).toBe(w!.id);
    expect(MDEDIT_STAGES.map((s) => s.key)).toEqual(w!.stages.map((s) => s.key));
    expect(initialStage(w!)).toBe('planning');
  });

  it('is made once, and does not come back when an administrator has replaced it', async () => {
    expect(await ensureDefaultWorkflow(db, ctx())).toBe(false);
    const mine = await createWorkflow(db, ctx(), { name: 'Mine' });
    await setDefaultWorkflow(db, ctx(), mine.id);
    const old = (await listWorkflows(db, ctx())).find((w) => w.templateKey === 'mdedit')!;
    await deleteWorkflow(db, ctx(), old.id);
    expect(await ensureDefaultWorkflow(db, ctx())).toBe(false);
    expect((await listWorkflows(db, ctx())).map((w) => w.name)).toEqual(['Mine']);
  });
});

describe('several workflows, with a default for each level', () => {
  it('lets a Series live by one workflow and its Books by another: each level has its own default', async () => {
    const series = await createWorkflow(db, ctx(), { name: 'Series lifecycle', copyFrom: 'workflow_default' });
    const book = await createWorkflow(db, ctx(), { name: 'Book production' });
    await setDefaultWorkflow(db, ctx(), series.id, ['project']);
    await setDefaultWorkflow(db, ctx(), book.id, ['subproject']);
    expect((await defaultWorkflow(db, ctx(), 'project'))!.name).toBe('Series lifecycle');
    expect((await defaultWorkflow(db, ctx(), 'subproject'))!.name).toBe('Book production');
    const all = await listWorkflows(db, ctx());
    expect(all.find((w) => w.id === 'workflow_default')!.defaultFor).toEqual([]);
    expect(all.filter((w) => w.defaultFor.includes('project'))).toHaveLength(1);
    expect(all.filter((w) => w.defaultFor.includes('subproject'))).toHaveLength(1);
    await setDefaultWorkflow(db, ctx(), series.id); // both
    expect((await defaultWorkflow(db, ctx(), 'subproject'))!.name).toBe('Series lifecycle');
    expect(await code(setDefaultWorkflow(db, ctx(), series.id, []))).toBe('invalid');
    expect(await code(setDefaultWorkflow(db, ctx(), series.id, ['galaxy' as never]))).toBe('invalid');
    expect(await code(setDefaultWorkflow(db, ctx(), 'nope'))).toBe('not-found');
    expect([...PROJECT_LEVELS]).toEqual(['project', 'subproject']);
  });

  it('refuses to delete a default (for either level) or a workflow projects use, and deletes an unused one cleanly', async () => {
    const a = await createWorkflow(db, ctx(), { name: 'A' });
    expect(await code(deleteWorkflow(db, ctx(), 'workflow_default'))).toBe('conflict');
    await setDefaultWorkflow(db, ctx(), a.id, ['subproject']);
    expect(await code(deleteWorkflow(db, ctx(), a.id))).toBe('conflict');
    await setDefaultWorkflow(db, ctx(), 'workflow_default');
    expect(await code(deleteWorkflow(db, ctx(), a.id, { projects: 2, byStage: {} }))).toBe('conflict'); // two projects use it
    await deleteWorkflow(db, ctx(), a.id, { projects: 0, byStage: {} });
    expect(await db.all('SELECT 1 FROM workflow_stage WHERE workflow_id = ?', [a.id])).toEqual([]);
    expect(await code(deleteWorkflow(db, ctx(), 'nope'))).toBe('not-found');
  });

  it('makes a blank one with a single stage, or a copy; never a default until chosen; unique names', async () => {
    const blank = await createWorkflow(db, ctx(), { name: 'Audio', description: 'Narration' });
    expect(blank).toMatchObject({ defaultFor: [], templateKey: null, stages: [{ key: 'start', name: 'Start', category: 'start' }], transitions: [] });
    const copy = await createWorkflow(db, ctx(), { name: 'Copy', copyFrom: 'workflow_default' });
    expect(copy.stages).toHaveLength(6);
    expect(copy.transitions).toHaveLength(30);
    expect(await code(createWorkflow(db, ctx(), { name: 'audio' }))).toBe('exists');
    expect(await code(createWorkflow(db, ctx(), { name: ' ' }))).toBe('invalid');
    expect(await code(createWorkflow(db, ctx(), { name: 'X', copyFrom: 'nope' }))).toBe('not-found');
  });
});

describe('building a workflow', () => {
  it('saves a whole definition: new stages get keys from their names, existing keys are kept, renaming and reordering keep the keys', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const d = asDraft(w);
    d.stages = [{ key: 'planning', name: 'Concept' }, { name: 'Proof reading', category: 'review', color: '#aabbcc' }, ...d.stages.slice(1)];
    d.transitions = [...w.transitions, { from: 'planning', to: 'proof-reading' }, { from: 'proof-reading', to: 'drafting' }];
    const saved = await saveWorkflow(db, ctx(), w.id, d);
    expect(saved.stages.map((s) => [s.key, s.name])).toEqual([['planning', 'Concept'], ['proof-reading', 'Proof reading'], ['drafting', 'Drafting'], ['revising', 'Revising'], ['editing', 'Editing'], ['published', 'Published'], ['paused', 'On hold']]);
    expect(saved.stages[1]).toMatchObject({ category: 'review', color: '#aabbcc', position: 1 });
    expect(saved.defaultFor).toEqual(['project', 'subproject']); // saving keeps what it is the default for
  });

  it('lets a new stage bring its own key so a move can name it in the same save, and gives clashing names different keys', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const d = asDraft(w);
    const saved = await saveWorkflow(db, ctx(), w.id, { ...d, stages: [...d.stages, { key: 'proof', name: 'Proofing' }, { name: 'Drafting 2' }], transitions: [...d.transitions, { from: 'editing', to: 'proof' }] });
    expect(saved.stages.map((s) => s.key).slice(-2)).toEqual(['proof', 'drafting-2']);
    expect(saved.transitions.some((t) => t.from === 'editing' && t.to === 'proof')).toBe(true);
    expect(newStageKey('Drafting', ['drafting', 'drafting-2'])).toBe('drafting-3');
    expect(newStageKey('  ', [])).toBe('stage');
  });

  it('validates a draft: names, keys, moves, colours, categories and sizes', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const d = asDraft(w);
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [...d.stages, { name: 'drafting' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [{ key: 'Not A Key', name: 'Ghost' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, transitions: [{ from: 'planning', to: 'nowhere' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, transitions: [{ from: 'planning', to: 'planning' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, transitions: [{ from: 'planning', to: 'drafting' }, { from: 'planning', to: 'drafting' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [{ key: 'planning', name: 'A', color: 'red' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [{ key: 'planning', name: 'A', category: 'nope' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: Array.from({ length: 31 }, (_, i) => ({ name: `S${i}` })) }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, name: '' }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), 'nope', d))).toBe('not-found');
    const other = await createWorkflow(db, ctx(), { name: 'Other' });
    expect(await code(saveWorkflow(db, ctx(), other.id, { ...asDraft(other), name: 'Writing and publishing' }))).toBe('exists');
    expect((await defaultWorkflow(db, ctx()))!.stages).toHaveLength(6); // a refused save changed nothing
  });

  it('removing a stage that projects are in needs a stage for them to go to', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const without = { ...asDraft(w), stages: asDraft(w).stages.filter((s) => s.key !== 'planning'), transitions: w.transitions.filter((t) => t.from !== 'planning' && t.to !== 'planning') };
    const usage = { projects: 3, byStage: { planning: 2, drafting: 1 } };
    expect(await code(saveWorkflow(db, ctx(), w.id, without, usage))).toBe('conflict');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...without, moveProjects: { planning: 'nowhere' } }, usage))).toBe('invalid');
    await saveWorkflow(db, ctx(), w.id, { ...without, moveProjects: { planning: 'drafting' } }, usage);
    expect((await defaultWorkflow(db, ctx()))!.stages.map((s) => s.key)).not.toContain('planning');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...asDraft((await defaultWorkflow(db, ctx()))!), stages: [{ key: 'published', name: 'Published' }], transitions: [] }, { projects: 1, byStage: { editing: 0 } }))).toBe('ok'); // an unused stage may go
  });

  it('keeps a gate’s roles and conditions, validates them, and one saved workflow does not touch another', async () => {
    const role = await createRole(db, ctx(), { name: 'Series Lead', capabilities: ['catalogue.read'] });
    const a = await createWorkflow(db, ctx(), { name: 'A', copyFrom: 'workflow_default' });
    const b = await createWorkflow(db, ctx(), { name: 'B', copyFrom: 'workflow_default' });
    const d = asDraft(a);
    d.transitions = d.transitions.map((t) => (t.from === 'editing' && t.to === 'published' ? { ...t, roleIds: [role.id], conditions: [{ kind: 'no_open_notes' as const }, { kind: 'has_manuscript' as const }, { kind: 'no_open_notes' as const }] } : t));
    const saved = await saveWorkflow(db, ctx(), a.id, d);
    const gate = saved.transitions.find((t) => t.from === 'editing' && t.to === 'published')!;
    expect(gate.roleIds).toEqual([role.id]);
    expect(gate.conditions).toEqual([{ kind: 'no_open_notes' }, { kind: 'has_manuscript' }]); // the repeat was dropped
    expect((await listWorkflows(db, ctx())).find((w) => w.id === b.id)!.transitions.find((t) => t.from === 'editing' && t.to === 'published')).toMatchObject({ roleIds: [], conditions: [] });
    const bad = (conditions: unknown, roleIds: string[] = []) => code(saveWorkflow(db, ctx(), a.id, { ...d, transitions: [{ from: 'editing', to: 'published', roleIds, conditions: conditions as never }] }));
    expect(await bad([{ kind: 'vibes' }])).toBe('invalid');
    expect(await bad([{ kind: 'asin' }])).toBe('invalid'); // a catalogue check from an earlier design is not a condition any more
    expect(await bad('no_open_notes')).toBe('invalid');
    expect(await bad([], ['no-such-role'])).toBe('not-found');
    expect(await bad([{ kind: 'constructor' }])).toBe('invalid');
  });

  it('a role a gate names is replaced, not dropped, when the role is deleted (dropping it would open the gate to everyone)', async () => {
    const lead = await createRole(db, ctx(), { name: 'Lead', capabilities: ['catalogue.read'] });
    const other = await createRole(db, ctx(), { name: 'Other', capabilities: ['catalogue.read'] });
    const w = (await defaultWorkflow(db, ctx()))!;
    await saveWorkflow(db, ctx(), w.id, { ...asDraft(w), transitions: w.transitions.map((t) => (t.to === 'published' ? { ...t, roleIds: [lead.id] } : t)) });
    await expect(deleteRole(db, ctx(), lead.id)).rejects.toThrow(/named in 5 workflow gates/);
    await deleteRole(db, ctx(), lead.id, other.id);
    const after = (await defaultWorkflow(db, ctx()))!;
    expect(after.transitions.filter((t) => t.to === 'published').every((t) => t.roleIds.length === 1 && t.roleIds[0] === other.id)).toBe(true);
  });
});

describe('moving a project through its stages', () => {
  const wf = async () => (await defaultWorkflow(db, ctx()))!;

  it('moves freely in the shipped workflow, as MDEdit did, forward and back', async () => {
    const w = await wf();
    expect(() => checkMove(w, 'planning', 'drafting', facts(), anyone)).not.toThrow();
    expect(() => checkMove(w, 'drafting', 'published', facts(), anyone)).not.toThrow();
    expect(() => checkMove(w, 'published', 'planning', facts(), anyone)).not.toThrow();
    expect(() => checkMove(w, 'planning', 'planning', facts(), anyone)).toThrow(/already in Planning/);
    expect(() => checkMove(w, 'planning', 'nowhere', facts(), anyone)).toThrow(/not in this project’s workflow/);
    const { current, options } = stageOptions(w, 'planning', facts(), anyone);
    expect(current).toMatchObject({ key: 'planning' });
    expect(options.map((o) => o.name)).toEqual(['Drafting', 'Revising', 'Editing', 'Published', 'On hold']);
  });

  it('refuses a move the workflow does not have, and one whose gate is closed, saying every reason', async () => {
    const w0 = await wf();
    const w = await saveWorkflow(db, ctx(), w0.id, {
      ...asDraft(w0),
      transitions: [
        { from: 'planning', to: 'drafting' }, { from: 'drafting', to: 'editing' },
        { from: 'editing', to: 'published', conditions: [{ kind: 'has_manuscript' }, { kind: 'no_open_notes' }, { kind: 'subprojects_done' }] }
      ]
    });
    expect(() => checkMove(w, 'planning', 'published', facts(), anyone)).toThrow(/no move from Planning to Published/);
    let err: WorkflowError | null = null;
    try { checkMove(w, 'editing', 'published', facts({ openNotes: 3, subprojects: ['done', 'active'] }), anyone); } catch (e) { err = e as WorkflowError; }
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err!.code).toBe('gated');
    expect(err!.reasons).toEqual(['A manuscript is linked to it', '3 open notes to resolve first (it and its subprojects have no open notes)', 'Every subproject has reached a Done stage']);
    expect(err!.message).toMatch(/Published is not open yet/);
    expect(() => checkMove(w, 'editing', 'published', facts({ hasManuscript: true, subprojects: ['done', 'done'] }), anyone)).not.toThrow();
  });

  it('lets only the roles a gate names make the move, and says so in the options', async () => {
    const role = await createRole(db, ctx(), { name: 'Series Lead', capabilities: ['catalogue.read'] });
    const w0 = await wf();
    const w = await saveWorkflow(db, ctx(), w0.id, { ...asDraft(w0), transitions: w0.transitions.map((t) => (t.from === 'editing' && t.to === 'published' ? { ...t, roleIds: [role.id] } : t)) });
    const asOther = stageOptions(w, 'editing', facts(), nobody);
    expect(asOther.options.find((o) => o.key === 'published')).toMatchObject({ allowed: false, reasons: ['Only people with certain roles can make this move'] });
    expect(asOther.options.find((o) => o.key === 'revising')!.allowed).toBe(true);
    expect(() => checkMove(w, 'editing', 'published', facts(), nobody)).toThrow(/Published is not open yet/);
    expect(stageOptions(w, 'editing', facts(), (ids) => ids.includes(role.id)).options.find((o) => o.key === 'published')!.allowed).toBe(true);
  });

  it('answers every condition in words, from facts alone', () => {
    expect(unmetConditions(facts(), [])).toEqual([]);
    expect(unmetConditions(facts(), [{ kind: 'has_subprojects' }, { kind: 'subprojects_done' }])).toEqual(['It has at least one subproject', 'Every subproject has reached a Done stage']); // no subprojects is not "all done"
    expect(unmetConditions(facts({ subprojects: ['done', null] }), [{ kind: 'subprojects_done' }])).toEqual(['Every subproject has reached a Done stage']); // one with no workflow is not done
    expect(unmetConditions(facts({ openNotes: 1 }), [{ kind: 'no_open_notes' }])).toEqual(['1 open note to resolve first (it and its subprojects have no open notes)']);
  });

  it('keeps one studio’s workflows from another’s', async () => {
    const other = ctx({ studioId: 's2' });
    expect(await listWorkflows(db, other)).toEqual([]);
    expect(await code(saveWorkflow(db, other, 'workflow_default', { name: 'Hijack', stages: [{ name: 'X' }], transitions: [] }))).toBe('not-found');
    expect(await code(setDefaultWorkflow(db, other, 'workflow_default'))).toBe('not-found');
    expect(await code(deleteWorkflow(db, other, 'workflow_default'))).toBe('not-found');
  });
});

describe('projects hold a workflow and a stage, and the workflow never changes', () => {
  const NOW = '2026-10-27T00:00:00.000Z';
  it('gives a project its workflow and starting stage at creation, and a subproject its own', () => {
    let t = emptyTree();
    const s = createProject(t, { name: 'Salt Road', workflowId: 'wf-series', stage: 'planning', now: NOW });
    t = s.tree;
    const b = createProject(t, { name: 'Landfall', parentId: s.project.id, workflowId: 'wf-book', stage: 'drafting', now: NOW });
    expect(s.project).toMatchObject({ workflowId: 'wf-series', stage: 'planning' });
    expect(b.project).toMatchObject({ workflowId: 'wf-book', stage: 'drafting', parentId: s.project.id });
    expect(createProject(t, { name: 'Legacy', now: NOW }).project).toMatchObject({ workflowId: null, stage: null });
    expect(() => createProject(t, { name: 'No stage', workflowId: 'wf', now: NOW })).toThrow(ProjectError);
    expect(() => createProject(t, { name: 'Bad stage', workflowId: 'wf', stage: 'Not A Key', now: NOW })).toThrow(ProjectError);
  });

  it('changes the stage, but not the workflow: renaming, moving and the stage move leave it, and nothing offers a way to change it', () => {
    let t = createProject(emptyTree(), { name: 'Salt Road', workflowId: 'wf-series', stage: 'planning', now: NOW }).tree;
    const id = t.projects[0]!.id;
    t = setProjectStage(t, id, 'drafting', NOW);
    expect(t.projects[0]).toMatchObject({ workflowId: 'wf-series', stage: 'drafting' });
    t = updateProject(t, id, { name: 'Salt Road Saga', kind: 'Series' });
    expect(t.projects[0]).toMatchObject({ workflowId: 'wf-series', stage: 'drafting', name: 'Salt Road Saga' });
    const smuggled = updateProject(t, id, { name: 'X', workflowId: 'other' } as never);
    expect(smuggled.projects[0]!.workflowId).toBe('wf-series');
    expect(() => adoptWorkflow(t, id, 'other', 'planning')).toThrow(/cannot be changed/);
    expect(() => setProjectStage(createProject(emptyTree(), { name: 'Old', now: NOW }).tree, 'x', 'drafting')).toThrow(ProjectError);
  });

  it('gives a project made before workflows existed one, once', () => {
    const old = createProject(emptyTree(), { name: 'Old book', now: NOW });
    expect(() => setProjectStage(old.tree, old.project.id, 'drafting')).toThrow(/no workflow yet/);
    const t = adoptWorkflow(old.tree, old.project.id, 'wf-default', 'editing', NOW);
    expect(t.projects[0]).toMatchObject({ workflowId: 'wf-default', stage: 'editing' });
    expect(() => adoptWorkflow(t, old.project.id, 'wf-other', 'planning')).toThrow(/already has a workflow/);
  });

  it('survives a trip through the file: kept as written, and a stage with no workflow is dropped', () => {
    const t = createProject(emptyTree(), { name: 'Salt Road', workflowId: 'wf', stage: 'drafting', now: NOW }).tree;
    expect(sanitizeTree(JSON.parse(JSON.stringify(t))).projects[0]).toMatchObject({ workflowId: 'wf', stage: 'drafting' });
    expect(sanitizeTree({ projects: [{ id: 'a', name: 'A', stage: 'drafting' }, { id: 'b', name: 'B', workflowId: 'wf', stage: 'BAD KEY' }] }).projects.map((p) => [p.workflowId, p.stage])).toEqual([[null, null], ['wf', null]]);
  });
});

describe('gates that ask about tasks and sign-off', () => {
  it('names the open tasks and the missing sign-off', () => {
    expect(unmetConditions(facts({ openTasks: 2 }), [{ kind: 'no_open_tasks' }])).toEqual(['2 open tasks to finish first (it and its subprojects have no open tasks)']);
    expect(unmetConditions(facts(), [{ kind: 'no_open_tasks' }])).toEqual([]);
    expect(unmetConditions(facts(), [{ kind: 'approved', label: 'Cover approved' }])).toEqual(['Needs sign-off: “Cover approved”']);
    expect(unmetConditions(facts({ approved: ['cover approved'] }), [{ kind: 'approved', label: 'Cover approved' }])).toEqual([]); // labels compare without case
  });
  it('keeps a sign-off gate only with a label, and one gate per label', async () => {
    const w0 = (await listWorkflows(db, ctx()))[0]!;
    const save = (conditions: unknown) => saveWorkflow(db, ctx(), w0.id, { ...asDraft(w0), transitions: w0.transitions.map((t) => (t.from === 'editing' && t.to === 'published' ? { ...t, conditions: conditions as never } : t)) });
    expect(await code(save([{ kind: 'approved' }]))).toBe('invalid');
    expect(await code(save([{ kind: 'approved', label: 'x'.repeat(41) }]))).toBe('invalid');
    const w = await save([{ kind: 'approved', label: ' Ready  to publish ' }, { kind: 'approved', label: 'ready to publish' }, { kind: 'approved', label: 'Legal' }]);
    expect(w.transitions.find((t) => t.from === 'editing' && t.to === 'published')!.conditions).toEqual([{ kind: 'approved', label: 'Ready to publish' }, { kind: 'approved', label: 'Legal' }]);
  });
});
