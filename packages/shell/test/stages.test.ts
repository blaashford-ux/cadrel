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

/** A Project and a Book under it: only the Book has a stage. */
async function bookIn(name: string, o: { workflowId?: string | null; template?: string | null; series?: string } = {}) {
  const series = o.series ?? (await mgr.create({ name: `${name} series`, template: null })).id;
  const book = await mgr.create({ name, parentId: series, template: o.template ?? null, workflowId: o.workflowId });
  return { series, book: book.id };
}

describe('project stages', () => {
  it('gives a new Book the default workflow in its first stage, and a Project, or anything inside a Book, none', async () => {
    const s = await mgr.create({ name: 'Series', template: null });
    const b = await mgr.create({ name: 'Book', parentId: s.id, template: null });
    const inside = await mgr.create({ name: 'Cover art', parentId: b.id, template: null });
    const [def] = await wfs();
    expect(await proj(s.id)).toMatchObject({ workflowId: null, stage: null });
    expect(await proj(b.id)).toMatchObject({ workflowId: def!.id, stage: 'planning' });
    expect(await proj(inside.id)).toMatchObject({ workflowId: null, stage: null });
  });

  it('a Project gets no stage even if a workflow is asked for', async () => {
    const wf = await gated('Asked for');
    const s = await mgr.create({ name: 'Series', template: null, workflowId: wf });
    expect(await proj(s.id)).toMatchObject({ workflowId: null, stage: null });
  });

  it('lets Books use different workflows, chosen at creation, and the Book default is the one for subprojects', async () => {
    const flow = await gated('Book flow');
    const s = await mgr.create({ name: 'Series', template: null });
    const a = await mgr.create({ name: 'Book 1', parentId: s.id, template: null, workflowId: flow });
    const b = await mgr.create({ name: 'Book 2', parentId: s.id, template: null });
    expect((await proj(a.id)).workflowId).toBe(flow);
    expect((await proj(b.id)).workflowId).not.toBe(flow);
    await callWorkflow('setDefault', [flow, ['subproject']], host, stages);
    const c = await mgr.create({ name: 'Book 3', parentId: s.id, template: null });
    expect((await proj(c.id)).workflowId).toBe(flow);
    await expect(mgr.create({ name: 'Book 4', parentId: s.id, template: null, workflowId: 'nope' })).rejects.toThrow(/not there/);
  });

  it('a Project made as a standalone novel holds one Book, which has the folder and the stage', async () => {
    const r = await mgr.create({ name: 'The Lost King', kind: 'Standalone', template: 'novel' });
    const tree = (await studio.studio.read()).tree;
    const kids = tree.projects.filter((p) => p.parentId === r.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ name: 'The Lost King', kind: 'Book', stage: 'planning' });
    expect(await proj(r.id)).toMatchObject({ kind: 'Standalone', workflowId: null, stage: null });
    expect(tree.links.filter((l) => l.module === 'write').map((l) => l.projectId)).toEqual([kids[0]!.id]);
    expect(r.folder).toBeTruthy();
  });

  it('a standalone that cannot be made whole is not made at all', async () => {
    await expect(mgr.create({ name: 'Broken', kind: 'Standalone', template: 'no-such-template' })).rejects.toThrow(/template/);
    expect((await studio.studio.read()).tree.projects).toHaveLength(0);
  });

  it('moves only through the gates, and says what is in the way', async () => {
    const wf = await gated('Gated');
    const { book } = await bookIn('Plain', { workflowId: wf });
    const o = await stages.options(book);
    expect(o!.options).toEqual([expect.objectContaining({ key: 'done', category: 'done', allowed: false, reasons: [expect.stringMatching(/manuscript/i)] })]);
    await expect(stages.move(book, 'done')).rejects.toThrow(/manuscript/i);
    expect((await proj(book)).stage).toBe('open');
    const withMs = await bookIn('Booked', { workflowId: wf, template: 'novel' });
    await stages.move(withMs.book, 'done');
    expect((await proj(withMs.book)).stage).toBe('done');
    await expect(stages.move(withMs.book, 'open')).rejects.toThrow(); // no move back was built
  });

  it('keeps a Book’s workflow for good; only a project with none can be given one, once', async () => {
    const a = await gated('A');
    const { book } = await bookIn('P', { workflowId: a });
    await expect(studio.studio.adoptWorkflow(book, (await wfs())[0]!.id, 'planning')).rejects.toThrow();
    expect((await proj(book)).workflowId).toBe(a);
  });

  it('gives Books made before workflows existed the default, starting in the stage they had, and never a Project or what is inside a Book', async () => {
    const project = (await studio.createProject({ name: 'Old' } as never)) as { id: string };
    const bookA = (await studio.createProject({ name: 'Old book', parentId: project.id } as never)) as { id: string };
    const bookB = (await studio.createProject({ name: 'Older book', parentId: project.id } as never)) as { id: string };
    const inside = (await studio.createProject({ name: 'Cover', parentId: bookA.id } as never)) as { id: string };
    expect((await proj(bookA.id)).workflowId).toBeNull();
    const n = await stages.adoptLegacy(async (id) => (id === bookA.id ? 'revising' : 'nonsense'));
    expect(n).toBe(2);
    expect(await proj(bookA.id)).toMatchObject({ stage: 'revising' });
    expect(await proj(bookB.id)).toMatchObject({ stage: 'planning' });
    expect(await proj(project.id)).toMatchObject({ workflowId: null, stage: null });
    expect(await proj(inside.id)).toMatchObject({ workflowId: null, stage: null });
    expect(await stages.adoptLegacy(async () => 'drafting')).toBe(0); // never touched twice
  });

  it('moves Books out of a stage that is dropped, to where the builder said, and refuses to delete a used workflow', async () => {
    const wf = await gated('Dropping');
    const { book } = await bookIn('P', { workflowId: wf });
    expect((await stages.usage(wf)).byStage).toEqual({ open: 1 });
    const draft = { name: 'Dropping', description: '', stages: [{ key: 'done', name: 'Done', category: 'done', color: '#222222' }], transitions: [] };
    await expect(callWorkflow('save', [wf, draft], host, stages)).rejects.toThrow();
    expect((await proj(book)).stage).toBe('open');
    await callWorkflow('save', [wf, { ...draft, moveProjects: { open: 'done' } }], host, stages);
    expect((await proj(book)).stage).toBe('done');
    await expect(callWorkflow('delete', [wf], host, stages)).rejects.toThrow(/use/);
  });

  it('shows each Book’s stage for Write and the pages, and none for a Project', async () => {
    const { series, book } = await bookIn('P');
    const v = await stages.views();
    expect(v[book]).toMatchObject({ workflowName: 'Writing and publishing', stage: { key: 'planning', name: 'Planning', category: 'start' } });
    expect(v[series]).toBeUndefined();
  });
});

describe('closing and reopening Books', () => {
  it('a Book is closed when it reaches a Done stage, and only Books can be', async () => {
    const { series, book } = await bookIn('Ember');
    expect([...(await stages.closedBooks())]).toEqual([]);
    await stages.closeBook(book);
    expect((await proj(book)).stage).toBe('published');
    expect([...(await stages.closedBooks())]).toEqual([book]);
    await expect(stages.closeBook(series)).rejects.toThrow(/only a book/i);
    await expect(stages.closeBook(book)).rejects.toThrow(/already closed/);
  });

  it('an archived Book is not counted as closed (it is hidden for another reason)', async () => {
    const { book } = await bookIn('Ember');
    await stages.closeBook(book);
    await mgr.archive(book, true);
    expect([...(await stages.closedBooks())]).toEqual([]);
  });

  it('closing goes through the gates, and says what is in the way', async () => {
    const wf = await gated('Gated');
    const { book } = await bookIn('Plain', { workflowId: wf });
    await expect(stages.closeBook(book)).rejects.toThrow(/manuscript/i);
    expect((await proj(book)).stage).toBe('open');
  });

  it('says so when the workflow has no way to close from where the Book is', async () => {
    const w = (await callWorkflow('create', [{ name: 'No end' }], host, stages)) as { id: string };
    await callWorkflow('save', [w.id, { name: 'No end', description: '', stages: [{ key: 'a', name: 'A', category: 'start', color: '#111111' }, { key: 'b', name: 'B', category: 'active', color: '#222222' }], transitions: [{ from: 'a', to: 'b', roleIds: [], conditions: [] }] }], host, stages);
    const { book } = await bookIn('X', { workflowId: w.id });
    await expect(stages.closeBook(book)).rejects.toThrow(/no way to close/);
  });

  it('reopening puts a closed Book into a stage that is not a closing one', async () => {
    const { book } = await bookIn('Ember');
    await expect(stages.reopenBook(book, 'revising')).rejects.toThrow(/not closed/);
    await stages.closeBook(book);
    const from = await stages.options(book);
    const target = from!.options.find((o) => o.category !== 'done');
    if (target) {
      await stages.reopenBook(book, target.key);
      expect([...(await stages.closedBooks())]).toEqual([]);
    }
    await stages.closeBook(book).catch(() => undefined);
    await expect(stages.reopenBook(book, 'published')).rejects.toThrow(/not a closing one|not closed/);
  });
});

describe('a Project that still has a stage from before', () => {
  it('can have it removed, and a Book keeps its own', async () => {
    const wf = (await wfs())[0]!.id;
    const project = (await studio.createProject({ name: 'Old', workflowId: wf, stage: 'drafting' })) as { id: string };
    expect(await proj(project.id)).toMatchObject({ workflowId: wf, stage: 'drafting' });
    await stages.clearStage(project.id);
    expect(await proj(project.id)).toMatchObject({ workflowId: null, stage: null });
    const { book } = await bookIn('B');
    await expect(stages.clearStage(book)).rejects.toThrow(/keeps its stage/);
    expect((await proj(book)).stage).toBe('planning');
  });
});

describe('adding the first Book to an existing Project', () => {
  it('moves the manuscript folder to the Book, and the Book starts in the Project’s stage', async () => {
    const wf = (await wfs())[0]!.id;
    const old = await mgr.create({ name: 'Dragon Rider', template: 'novel' });
    await studio.studio.clearWorkflow(old.id);
    await studio.studio.adoptWorkflow(old.id, wf, 'revising'); // as a project from before had it
    const r = await mgr.addFirstBook(old.id, 'Book 1');
    const tree = (await studio.studio.read()).tree;
    const folderRef = tree.links.find((l) => l.module === 'write')!;
    expect(folderRef.projectId).toBe(r.id); // the link moved; no file did
    expect(tree.projects.find((p) => p.id === r.id)).toMatchObject({ name: 'Book 1', kind: 'Book', stage: 'revising', parentId: old.id });
    expect(await proj(old.id)).toMatchObject({ workflowId: null, stage: null });
  });

  it('a Project with no folder and no stage just gets a Book in the first stage', async () => {
    const p = await mgr.create({ name: 'Empty', template: null });
    const r = await mgr.addFirstBook(p.id);
    expect(await proj(r.id)).toMatchObject({ name: 'Empty', stage: 'planning' });
  });

  it('refuses a Project that has Books, and anything that is not a Project', async () => {
    const { series, book } = await bookIn('B');
    await expect(mgr.addFirstBook(series)).rejects.toThrow(/already has books/);
    await expect(mgr.addFirstBook(book)).rejects.toThrow(/only a project/i);
    await expect(mgr.addFirstBook('nope')).rejects.toThrow(/no such project/);
  });

  it('does not count an archived Book as one', async () => {
    const { series, book } = await bookIn('B');
    await mgr.archive(book, true);
    const r = await mgr.addFirstBook(series, 'B again');
    expect(await proj(r.id)).toMatchObject({ name: 'B again', parentId: series });
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
    const { book } = await bookIn('Book', { workflowId: wf });
    const cover = await mgr.create({ name: 'Cover', parentId: book, template: null });
    const task = (await work().call('createTask', [{ projectId: cover.id, title: 'Proof' }])) as { id: string };
    const reasons = async () => (await stages.options(book))!.options[0]!.reasons;
    expect(await reasons()).toEqual([expect.stringMatching(/1 open task/), 'Needs sign-off: “Ready”']); // what is inside the Book counts
    await work().call('setState', [task.id, 'done']);
    const me = host.me;
    const a = (await work().call('requestApproval', [{ projectId: book, label: 'Ready', approverIds: [me] }])) as { id: string };
    expect(await reasons()).toEqual(['Needs sign-off: “Ready”']);
    await work().call('respond', [a.id, 'approved']);
    expect(await reasons()).toEqual([]);
    await stages.move(book, 'done');
    expect((await proj(book)).stage).toBe('done');
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
    expect(plan.projects.find((p) => p.name === 'Series')).toMatchObject({ stage: null }); // a Project has no stage; its Books do
    expect(plan.projects.find((p) => p.name === 'Book')).toMatchObject({ path: ['Series'], stage: 'planning', openTasks: 1, late: 1, nextDue: '2020-01-01' });
    expect(plan.workflows).toHaveLength(1);
    expect(plan.workflows[0]!.stages.map((s) => s.name)).toEqual(['Planning', 'Drafting', 'Revising', 'Editing', 'Published', 'On hold']);
    expect(plan.tasks.map((t) => t.title).sort()).toEqual(['Late one', 'Launch']); // cancelled and archived work is not planned
  });
});
