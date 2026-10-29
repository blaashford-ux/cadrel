import { describe, expect, it } from 'vitest';
import { MDEDIT_STAGES } from '@cadrel/kernel';

// The default workflow is MDEdit's own list, which Write no longer duplicates: Write shows whatever stage Cadrel gives a project.
describe('the default workflow', () => {
  it('ships MDEdit’s stages, in order', () => {
    expect(MDEDIT_STAGES.map((s) => s.name)).toEqual(['Planning', 'Drafting', 'Revising', 'Editing', 'Published', 'On hold']);
  });
  it('has exactly one stage that turns on Write’s editing pass', () => {
    expect(MDEDIT_STAGES.filter((s) => s.category === 'review').map((s) => s.name)).toEqual(['Editing']);
  });
});

// ---- the stages of projects, against a real records file and a real project tree ----

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { getProject } from '@cadrel/kernel';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { ProjectManager, type WriteFolders } from '../src/main/manage';
import { PeopleHost } from '../src/main/people';
import { ProjectStages } from '../src/main/stages';
import { ProjectWork } from '../src/main/projectWork';
import { StudioService } from '../src/main/studio';
import { callWorkflow } from '../src/main/workflowCalls';

let dir: string, host: PeopleHost, studio: StudioService, stages: ProjectStages, mgr: ProjectManager;
const folders = new Set<string>();
const write: WriteFolders = {
  projectsRoot: () => '/w',
  templates: () => [{ id: 'novel', name: 'Novel', description: '' }],
  listFolders: async () => ({ projects: [], others: [] }),
  createProject: async (n) => (folders.add(n), { path: `/w/${n}` }),
  renameProject: async (p) => p,
  duplicateProject: async (_p, n) => (folders.add(n), { path: `/w/${n}` }),
  deleteProject: async () => undefined,
  readProject: async () => null,
  updateProject: async () => undefined,
  convertFolder: async () => undefined,
  addMissingTemplateParts: async () => [],
  openProject: () => undefined
};
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-stages-'));
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  studio = new StudioService({ file: path.join(dir, 'studio.json'), author: () => 'Ana', writeRoot: async () => null, fs: new MemoryFs() });
  stages = new ProjectStages(studio, () => host.workflows, () => host.work);
  mgr = new ProjectManager(studio, write, stages);
  folders.clear();
});
afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});
const proj = async (id: string) => getProject((await studio.studio.read()).tree, id)!;
const wfs = async () => ((await host.workflowState()) as { workflows: { id: string; name: string; defaultFor: string[] }[] }).workflows;

/** A two-stage workflow: Open, then Done, which needs a manuscript. */
async function gated(name: string) {
  const w = (await callWorkflow('create', [{ name }], host, stages)) as { id: string };
  await callWorkflow('save', [w.id, {
    name, description: '',
    stages: [{ key: 'open', name: 'Open', category: 'start', color: '#111111' }, { key: 'done', name: 'Done', category: 'done', color: '#222222' }],
    transitions: [{ from: 'open', to: 'done', roleIds: [], conditions: [{ kind: 'has_manuscript' }] }]
  }], host, stages);
  return w.id;
}

describe('project stages', () => {
  it('gives a new project its level’s default workflow, in its first stage', async () => {
    const s = await mgr.create({ name: 'Series', template: null });
    const b = await mgr.create({ name: 'Book', parentId: s.id, template: null });
    const [def] = await wfs();
    expect(await proj(s.id)).toMatchObject({ workflowId: def!.id, stage: 'planning' });
    expect(await proj(b.id)).toMatchObject({ workflowId: def!.id, stage: 'planning' });
  });

  it('lets series and books use different workflows, chosen at creation', async () => {
    const seriesWf = await gated('Series flow');
    const s = await mgr.create({ name: 'Series', template: null, workflowId: seriesWf });
    const b = await mgr.create({ name: 'Book', parentId: s.id, template: null });
    expect((await proj(s.id)).workflowId).toBe(seriesWf);
    expect((await proj(b.id)).workflowId).not.toBe(seriesWf); // the subproject default, not the parent's
    await callWorkflow('setDefault', [seriesWf, ['subproject']], host, stages);
    const b2 = await mgr.create({ name: 'Book 2', parentId: s.id, template: null });
    expect((await proj(b2.id)).workflowId).toBe(seriesWf);
    await expect(mgr.create({ name: 'X', template: null, workflowId: 'nope' })).rejects.toThrow(/not there/);
  });

  it('moves only through the gates, and says what is in the way', async () => {
    const wf = await gated('Gated');
    const p = await mgr.create({ name: 'Plain', template: null, workflowId: wf });
    const o = await stages.options(p.id);
    expect(o!.options).toEqual([expect.objectContaining({ key: 'done', allowed: false, reasons: [expect.stringMatching(/manuscript/i)] })]);
    await expect(stages.move(p.id, 'done')).rejects.toThrow(/manuscript/i);
    expect((await proj(p.id)).stage).toBe('open');
    const withMs = await mgr.create({ name: 'Booked', template: 'novel', workflowId: wf });
    await stages.move(withMs.id, 'done');
    expect((await proj(withMs.id)).stage).toBe('done');
    await expect(stages.move(withMs.id, 'open')).rejects.toThrow(); // no move back was built
  });

  it('keeps a project’s workflow for good; only a project with none can be given one, once', async () => {
    const a = await gated('A');
    const p = await mgr.create({ name: 'P', template: null, workflowId: a });
    await expect(studio.studio.adoptWorkflow(p.id, (await wfs())[0]!.id, 'planning')).rejects.toThrow();
    expect((await proj(p.id)).workflowId).toBe(a);
  });

  it('gives projects made before workflows existed the default, starting in the stage they had', async () => {
    const t = await studio.createProject({ name: 'Old' } as never);
    const t2 = await studio.createProject({ name: 'Older' } as never);
    expect((await proj((t as { id: string }).id)).workflowId).toBeNull();
    const n = await stages.adoptLegacy(async (id) => (id === (t as { id: string }).id ? 'revising' : 'nonsense'));
    expect(n).toBe(2);
    expect(await proj((t as { id: string }).id)).toMatchObject({ stage: 'revising' });
    expect(await proj((t2 as { id: string }).id)).toMatchObject({ stage: 'planning' });
    expect(await stages.adoptLegacy(async () => 'drafting')).toBe(0); // never touched twice
  });

  it('moves projects out of a stage that is dropped, to where the builder said, and refuses to delete a used workflow', async () => {
    const wf = await gated('Dropping');
    const p = await mgr.create({ name: 'P', template: null, workflowId: wf });
    expect((await stages.usage(wf)).byStage).toEqual({ open: 1 });
    const draft = { name: 'Dropping', description: '', stages: [{ key: 'done', name: 'Done', category: 'done', color: '#222222' }], transitions: [] };
    await expect(callWorkflow('save', [wf, draft], host, stages)).rejects.toThrow();
    expect((await proj(p.id)).stage).toBe('open');
    await callWorkflow('save', [wf, { ...draft, moveProjects: { open: 'done' } }], host, stages);
    expect((await proj(p.id)).stage).toBe('done');
    await expect(callWorkflow('delete', [wf], host, stages)).rejects.toThrow(/use/);
  });

  it('shows each project’s stage for Write and the pages', async () => {
    const p = await mgr.create({ name: 'P', template: null });
    expect((await stages.views())[p.id]).toMatchObject({ workflowName: 'Writing and publishing', stage: { key: 'planning', name: 'Planning', category: 'start' } });
  });
});

describe('gates that ask for finished tasks and sign-off', () => {
  /** Open, then Done once there are no open tasks and "Ready" is signed off. */
  async function signedOff() {
    const w = (await callWorkflow('create', [{ name: 'Signed' }], host, stages)) as { id: string };
    await callWorkflow('save', [w.id, {
      name: 'Signed', description: '',
      stages: [{ key: 'open', name: 'Open', category: 'start', color: '#111111' }, { key: 'done', name: 'Done', category: 'done', color: '#222222' }],
      transitions: [{ from: 'open', to: 'done', roleIds: [], conditions: [{ kind: 'no_open_tasks' }, { kind: 'approved', label: 'Ready' }] }]
    }], host, stages);
    return w.id;
  }
  const work = () => new ProjectWork(studio, host);

  it('holds a move until the tasks under the project are done and the sign-off stands', async () => {
    const wf = await signedOff();
    const series = await mgr.create({ name: 'Series', template: null, workflowId: wf });
    const book = await mgr.create({ name: 'Book', parentId: series.id, template: null, workflowId: wf });
    const task = (await work().call('createTask', [{ projectId: book.id, title: 'Proof' }])) as { id: string };
    const reasons = async () => (await stages.options(series.id))!.options[0]!.reasons;
    expect(await reasons()).toEqual([expect.stringMatching(/1 open task/), 'Needs sign-off: “Ready”']); // the subproject's task counts
    await work().call('setState', [task.id, 'done']);
    const me = host.me;
    const a = (await work().call('requestApproval', [{ projectId: series.id, label: 'Ready', approverIds: [me] }])) as { id: string };
    expect(await reasons()).toEqual(['Needs sign-off: “Ready”']);
    await work().call('respond', [a.id, 'approved']);
    expect(await reasons()).toEqual([]);
    await stages.move(series.id, 'done');
    expect((await proj(series.id)).stage).toBe('done');
  });

  it('shows a project’s work with its subprojects’, and what waits on me', async () => {
    const s = await mgr.create({ name: 'Series', template: null });
    const b = await mgr.create({ name: 'Book', parentId: s.id, template: null });
    await work().call('createTask', [{ projectId: b.id, title: 'Cover', assigneeId: host.me, due: '2026-11-01' }]);
    await work().call('requestApproval', [{ projectId: s.id, label: 'Plan', approverIds: [host.me] }]);
    const st = await work().state(s.id);
    if (!st.available) throw new Error('expected work');
    expect(st.tasks.map((t) => [t.title, t.projectName])).toEqual([['Cover', 'Book']]);
    expect(st.may).toEqual({ edit: true, assign: true, manage: true });
    const mine = await work().mine();
    expect(mine.tasks.map((t) => t.title)).toEqual(['Cover']);
    expect(mine.approvals.map((a) => [a.label, a.projectName])).toEqual([['Plan', 'Series']]);
  });

  it('works on projects that exist and are not archived, and only the changes it lists', async () => {
    const p = await mgr.create({ name: 'P', template: null });
    await expect(work().call('createTask', [{ projectId: 'nope', title: 'x' }])).rejects.toThrow(/no such project/);
    await mgr.archive(p.id, true);
    await expect(work().call('createTask', [{ projectId: p.id, title: 'x' }])).rejects.toThrow(/archived/);
    for (const bad of ['tasks', 'constructor', '__proto__', 'state']) await expect(work().call(bad, [])).rejects.toThrow(/not something/);
  });

  it('plans: each live project in its workflow and stage with its open work, late work counted, archived ones left out', async () => {
    const series = await mgr.create({ name: 'Series', template: null });
    const book = await mgr.create({ name: 'Book', parentId: series.id, template: null });
    const old = await mgr.create({ name: 'Old', template: null });
    const w = work();
    await w.call('createTask', [{ projectId: book.id, title: 'Late one', due: '2020-01-01' }]);
    await w.call('createTask', [{ projectId: book.id, title: 'Launch', kind: 'deadline', due: '2999-01-01' }]);
    const gone = (await w.call('createTask', [{ projectId: book.id, title: 'Dropped' }])) as { id: string };
    await w.call('setState', [gone.id, 'cancelled']);
    await w.call('createTask', [{ projectId: old.id, title: 'Hidden' }]);
    await mgr.archive(old.id, true);
    const plan = await new ProjectWork(studio, host, stages).plan();
    if (!plan.available) throw new Error('expected a plan');
    expect(plan.projects.map((p) => p.name).sort()).toEqual(['Book', 'Series']);
    expect(plan.projects.find((p) => p.name === 'Book')).toMatchObject({ path: ['Series'], stage: 'planning', openTasks: 1, late: 1, nextDue: '2020-01-01' });
    expect(plan.workflows).toHaveLength(1);
    expect(plan.workflows[0]!.stages.map((s) => s.name)).toEqual(['Planning', 'Drafting', 'Revising', 'Editing', 'Published', 'On hold']);
    expect(plan.tasks.map((t) => t.title).sort()).toEqual(['Late one', 'Launch']); // cancelled and archived work is not planned
  });
});
