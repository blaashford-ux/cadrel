/**
 * Where each project is in its workflow, and the moves between stages. A project (or subproject) is given a workflow when it is made and
 * keeps it; its stage changes only through here, which asks the workflow service whether the move is open to the person (the workflow has
 * the move, its gate's conditions hold, and they hold a role the gate names) before it touches the project tree.
 *
 * The tree is a file (@cadrel/studio) and the workflows are records (@cadrel/service), so this joins them. Electron-free; tested in
 * test/stages.test.ts.
 */
import { childrenOf, closedBookIds, getProject, initialStage, linksOf, subtreeIds, viewLevel, type ProjectFacts, type StageCategory, type WorkflowDraft, type WorkflowRecord, type WorkflowUsage } from '@cadrel/kernel';
import type { StudioService } from './studio';
import type { StudioWork, StudioWorkflows } from './people';

export class StageError extends Error {}
const fail = (m: string): never => {
  throw new StageError(m);
};

/** A project's workflow and stage as the pages show them. */
export interface ProjectStageView {
  workflowId: string;
  workflowName: string;
  stage: { key: string; name: string; color: string; category: StageCategory } | null;
}

export interface StageMoveOption { key: string; name: string; color: string; category: StageCategory; allowed: boolean; reasons: string[] }

export class ProjectStages {
  constructor(private readonly studio: StudioService, private readonly workflows: () => StudioWorkflows | null, private readonly work: () => StudioWork | null = () => null) {}

  private need(): StudioWorkflows {
    return this.workflows() ?? fail('This Studio’s workflows are managed by its owner.');
  }

  /**
   * Whether a project made under `parentId` is a Book: directly under a top-level Project. Only Books have stages (docs/UI-MODEL.md): a
   * Project above its Books is only active or archived, and what is inside a Book follows the Book.
   */
  private async isBookSlot(parentId: string | null | undefined): Promise<boolean> {
    if (!parentId) return false;
    return viewLevel((await this.studio.studio.read()).tree, parentId) === 'project';
  }

  /**
   * The workflow and starting stage for a project about to be made. Only a Book gets one: `chosen` is the workflow the person picked, else the
   * default for new Books (the workflows' "subproject" default). A Project, or something inside a Book, gets none. Null workflow too when this
   * computer holds no workflow records (a Studio that was only joined).
   */
  async forNewProject(parentId: string | null | undefined, chosen?: string | null): Promise<{ workflowId: string; stage: string } | { workflowId: null; stage: null }> {
    const wfs = this.workflows();
    if (!wfs || !(await this.isBookSlot(parentId))) return { workflowId: null, stage: null };
    const wf = chosen ? (await wfs.list()).find((w) => w.id === chosen) ?? fail('That workflow is not there.') : await wfs.defaultFor('subproject');
    if (!wf) return fail('There is no default workflow for new books yet. An administrator sets one under Admin → Workflows.');
    return { workflowId: wf.id, stage: initialStage(wf) };
  }

  /** What a gate can see of a project: the manuscript linked, the open notes under it, and the stage categories of its subprojects. */
  async factsOf(projectId: string): Promise<ProjectFacts> {
    const state = await this.studio.state();
    const tree = state.tree;
    const p = getProject(tree, projectId) ?? fail('There is no such project.');
    const wfs = this.workflows() ? await this.workflows()!.list() : [];
    const categoryOf = (q: { workflowId: string | null; stage: string | null }): StageCategory | null => wfs.find((w) => w.id === q.workflowId)?.stages.find((s) => s.key === q.stage)?.category ?? null;
    const work = this.work();
    const live = subtreeIds(tree, p.id).filter((id) => getProject(tree, id)?.status !== 'archived');
    return {
      openTasks: work ? await work.openTaskCount(live) : 0,
      approved: work ? await work.approvedLabels(p.id) : [],
      hasManuscript: linksOf(tree, p.id, 'write').length > 0,
      openNotes: state.openByProject[p.id] ?? 0,
      subprojects: childrenOf(tree, p.id).filter((c) => c.status !== 'archived').map(categoryOf)
    };
  }

  /** Where the project can go from its stage, and for each move whether it is open to this person now and what is in the way. */
  async options(projectId: string): Promise<{ workflow: WorkflowRecord; current: ProjectStageView['stage']; options: StageMoveOption[] } | null> {
    const wfs = this.need();
    const p = getProject(await this.studio.tree(), projectId) ?? fail('There is no such project.');
    if (!p.workflowId) return null;
    const r = await wfs.stageOptions(p.workflowId, p.stage, await this.factsOf(projectId));
    const category = (key: string): StageCategory => r.workflow.stages.find((s) => s.key === key)?.category ?? 'active';
    return { workflow: r.workflow, current: r.current && { key: r.current.key, name: r.current.name, color: r.current.color, category: r.current.category }, options: r.options.map(({ key, name, color, allowed, reasons }) => ({ key, name, color, category: category(key), allowed, reasons })) };
  }

  /** Moves the project to another stage if the workflow and the person allow it. Throws with every reason if not. */
  async move(projectId: string, to: string): Promise<void> {
    const wfs = this.need();
    const p = getProject(await this.studio.tree(), projectId) ?? fail('There is no such project.');
    if (!p.workflowId) fail(`“${p.name}” has no workflow yet.`);
    if (p.status === 'archived') fail('That project is archived. Restore it first.');
    await wfs.allowMove(p.workflowId!, p.stage, to, await this.factsOf(projectId));
    await this.studio.setStage(projectId, to);
  }

  /** The stage of every project that has one, by project id, with the workflow's name; what the pages and Write show. */
  async views(): Promise<Record<string, ProjectStageView>> {
    const wfs = this.workflows();
    if (!wfs) return {};
    const list = await wfs.list().catch(() => []); // a role that may not read the workflows sees no stages, not an error
    const out: Record<string, ProjectStageView> = {};
    for (const p of (await this.studio.studio.read()).tree.projects) {
      const wf = p.workflowId ? list.find((w) => w.id === p.workflowId) : undefined;
      if (!wf) continue;
      const s = wf.stages.find((x) => x.key === p.stage);
      out[p.id] = { workflowId: wf.id, workflowName: wf.name, stage: s ? { key: s.key, name: s.name, color: s.color, category: s.category } : null };
    }
    return out;
  }

  /**
   * The Books that are closed: not archived, directly under a Project, and in a stage whose category is Done (Published, or one the
   * studio's workflow calls done). A closed Book is hidden from the scope unless closed Books are being shown.
   */
  async closedBooks(): Promise<Set<string>> {
    const wfs = this.workflows();
    if (!wfs) return new Set();
    return closedBookIds((await this.studio.studio.read()).tree, await wfs.list());
  }

  /** Closes a Book: moves it to the first Done stage its workflow lets this person reach from where it is, through the gates. */
  async closeBook(bookId: string): Promise<void> {
    const tree = await this.studio.tree();
    if (viewLevel(tree, bookId) !== 'book') fail('Only a book can be closed.');
    const info = (await this.options(bookId)) ?? fail('This book has no stages yet.');
    if (info.current?.category === 'done') fail('That book is already closed.');
    const done = info.options.filter((o) => o.category === 'done');
    if (!done.length) fail(`The “${info.workflow.name}” workflow has no way to close a book from ${info.current?.name ?? 'here'}.`);
    const open = done.find((o) => o.allowed);
    if (!open) return fail(`It can’t be closed yet: ${done[0]!.reasons.join('; ') || 'a gate is not met'}.`);
    await this.move(bookId, open.key);
  }

  /** Reopens a closed Book into the stage chosen (one of the moves open from its Done stage). */
  async reopenBook(bookId: string, to: string): Promise<void> {
    const info = (await this.options(bookId)) ?? fail('This book has no stages yet.');
    if (info.current?.category !== 'done') fail('That book is not closed.');
    if (info.workflow.stages.find((s) => s.key === to)?.category === 'done') fail('Choose a stage that is not a closing one.');
    await this.move(bookId, to);
  }

  /** Takes the stage off a project that should not have one: a Project above its Books (made before stages moved to Books). */
  async clearStage(projectId: string): Promise<void> {
    const tree = await this.studio.tree();
    const p = getProject(tree, projectId) ?? fail('There is no such project.');
    if (viewLevel(tree, projectId) === 'book') fail('A book keeps its stage.');
    if (!p.workflowId) return;
    await this.studio.clearWorkflow(projectId);
  }

  /** The workflows with these ids (those in use, for the pipeline). */
  async workflowsInUse(ids: string[]): Promise<WorkflowRecord[]> {
    const wfs = this.workflows();
    return wfs ? (await wfs.list()).filter((w) => ids.includes(w.id)) : [];
  }

  /** How many projects use a workflow, and how many are in each of its stages. */
  async usage(workflowId: string): Promise<WorkflowUsage> {
    const used = (await this.studio.studio.read()).tree.projects.filter((p) => p.workflowId === workflowId);
    const byStage: Record<string, number> = {};
    for (const p of used) if (p.stage) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
    return { projects: used.length, byStage };
  }

  /**
   * Books made before workflows existed have none. Each is given the default for new Books, once, and starts in the stage it was in
   * (`legacy` says what stage key an earlier version recorded for it, if any) when the workflow has that stage, else in the first.
   * Returns how many were given one. A project that has a workflow is never touched, and a Project above its Books is never given one.
   */
  async adoptLegacy(legacy: (projectId: string) => Promise<string | null>): Promise<number> {
    const wfs = this.workflows();
    if (!wfs) return 0;
    let n = 0;
    const tree = (await this.studio.studio.read()).tree;
    for (const p of tree.projects) {
      if (p.workflowId || viewLevel(tree, p.id) !== 'book') continue;
      const wf = await wfs.defaultFor('subproject');
      if (!wf) continue;
      const was = await legacy(p.id).catch(() => null);
      await this.studio.studio.adoptWorkflow(p.id, wf.id, was && wf.stages.some((s) => s.key === was) ? was : initialStage(wf));
      n++;
    }
    return n;
  }

  /** Saves a workflow, and moves the projects that were in a stage it drops to the stage chosen for them. */
  async saveWorkflow(id: string, draft: WorkflowDraft): Promise<WorkflowRecord> {
    const wfs = this.need();
    const usage = await this.usage(id);
    const saved = await wfs.save(id, draft, usage);
    const dropped = Object.keys(usage.byStage).filter((k) => !saved.stages.some((s) => s.key === k));
    if (dropped.length) await this.studio.studio.moveStages(id, Object.fromEntries(dropped.map((k) => [k, draft.moveProjects![k]!])));
    return saved;
  }

  /** Deletes a workflow no project uses and that is not a default. */
  async deleteWorkflow(id: string): Promise<void> {
    await this.need().delete(id, await this.usage(id));
  }

  /** Ids of a project and everything under it (for the page's counts). */
  async subtree(projectId: string): Promise<string[]> {
    return subtreeIds(await this.studio.tree(), projectId);
  }
}
