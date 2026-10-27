/**
 * Where each project is in its workflow, and the moves between stages. A project (or subproject) is given a workflow when it is made and
 * keeps it; its stage changes only through here, which asks the workflow service whether the move is open to the person (the workflow has
 * the move, its gate's conditions hold, and they hold a role the gate names) before it touches the project tree.
 *
 * The tree is a file (@cadrel/studio) and the workflows are records (@cadrel/service), so this joins them. Electron-free; tested in
 * test/stages.test.ts.
 */
import { childrenOf, getProject, initialStage, linksOf, subtreeIds, type ProjectFacts, type ProjectLevel, type StageCategory, type WorkflowDraft, type WorkflowRecord, type WorkflowUsage } from '@cadrel/kernel';
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

export interface StageMoveOption { key: string; name: string; color: string; allowed: boolean; reasons: string[] }

export class ProjectStages {
  constructor(private readonly studio: StudioService, private readonly workflows: () => StudioWorkflows | null, private readonly work: () => StudioWork | null = () => null) {}

  private need(): StudioWorkflows {
    return this.workflows() ?? fail('This Studio’s workflows are managed by its owner.');
  }

  /** Which default a new project gets: the one for a top-level project, or the one for a subproject. */
  levelOf(parentId: string | null | undefined): ProjectLevel {
    return parentId ? 'subproject' : 'project';
  }

  /**
   * The workflow and starting stage for a project about to be made. `chosen` is the workflow the person picked; without one the default
   * for its level is used. Null workflow when this computer holds no workflow records (a Studio that was only joined).
   */
  async forNewProject(parentId: string | null | undefined, chosen?: string | null): Promise<{ workflowId: string; stage: string } | { workflowId: null; stage: null }> {
    const wfs = this.workflows();
    if (!wfs) return { workflowId: null, stage: null };
    const wf = chosen ? (await wfs.list()).find((w) => w.id === chosen) ?? fail('That workflow is not there.') : await wfs.defaultFor(this.levelOf(parentId));
    if (!wf) return fail('There is no default workflow for new projects yet. An administrator sets one under Admin → Workflows.');
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
    const p = getProject((await this.studio.studio.read()).tree, projectId) ?? fail('There is no such project.');
    if (!p.workflowId) return null;
    const r = await wfs.stageOptions(p.workflowId, p.stage, await this.factsOf(projectId));
    return { workflow: r.workflow, current: r.current && { key: r.current.key, name: r.current.name, color: r.current.color, category: r.current.category }, options: r.options.map(({ key, name, color, allowed, reasons }) => ({ key, name, color, allowed, reasons })) };
  }

  /** Moves the project to another stage if the workflow and the person allow it. Throws with every reason if not. */
  async move(projectId: string, to: string): Promise<void> {
    const wfs = this.need();
    const p = getProject((await this.studio.studio.read()).tree, projectId) ?? fail('There is no such project.');
    if (!p.workflowId) fail(`“${p.name}” has no workflow yet.`);
    if (p.status === 'archived') fail('That project is archived. Restore it first.');
    await wfs.allowMove(p.workflowId!, p.stage, to, await this.factsOf(projectId));
    await this.studio.setStage(projectId, to);
  }

  /** The stage of every project that has one, by project id, with the workflow's name; what the pages and Write show. */
  async views(): Promise<Record<string, ProjectStageView>> {
    const wfs = this.workflows();
    if (!wfs) return {};
    const list = await wfs.list();
    const out: Record<string, ProjectStageView> = {};
    for (const p of (await this.studio.studio.read()).tree.projects) {
      const wf = p.workflowId ? list.find((w) => w.id === p.workflowId) : undefined;
      if (!wf) continue;
      const s = wf.stages.find((x) => x.key === p.stage);
      out[p.id] = { workflowId: wf.id, workflowName: wf.name, stage: s ? { key: s.key, name: s.name, color: s.color, category: s.category } : null };
    }
    return out;
  }

  /** How many projects use a workflow, and how many are in each of its stages. */
  async usage(workflowId: string): Promise<WorkflowUsage> {
    const used = (await this.studio.studio.read()).tree.projects.filter((p) => p.workflowId === workflowId);
    const byStage: Record<string, number> = {};
    for (const p of used) if (p.stage) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
    return { projects: used.length, byStage };
  }

  /**
   * Projects made before workflows existed have none. Each is given the default for its level, once, and starts in the stage it was in
   * (`legacy` says what stage key an earlier version recorded for it, if any) when the workflow has that stage, else in the first.
   * Returns how many were given one. A project that has a workflow is never touched.
   */
  async adoptLegacy(legacy: (projectId: string) => Promise<string | null>): Promise<number> {
    const wfs = this.workflows();
    if (!wfs) return 0;
    let n = 0;
    for (const p of (await this.studio.studio.read()).tree.projects) {
      if (p.workflowId) continue;
      const wf = await wfs.defaultFor(this.levelOf(p.parentId));
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
    return subtreeIds((await this.studio.studio.read()).tree, projectId);
  }
}
