/**
 * Tasks, deadlines, approvals and decisions as the pages see them: the records (in the Studio's records file, through the permission-checked
 * service) joined to the project tree (a file) for names and for "this project and its subprojects". Electron-free; tested in
 * test/projectWork.test.ts.
 */
import { getProject, subtreeIds } from '@cadrel/kernel';
import type { WorkState, MineState } from '../shared/api';
import type { PeopleHost } from './people';
import type { StudioService } from './studio';

export class WorkError extends Error {}

/** The changes the pages may ask for, by name. A list, so inherited names such as `constructor` are not reachable. */
export const WORK_CALL_NAMES = ['createTask', 'updateTask', 'setState', 'addDependency', 'removeDependency', 'requestApproval', 'respond', 'withdraw', 'record'] as const;
const NEEDS_PROJECT = new Set(['createTask', 'requestApproval', 'record']);

export class ProjectWork {
  constructor(private readonly studio: StudioService, private readonly people: PeopleHost) {}

  private async tree() {
    return (await this.studio.studio.read()).tree;
  }

  /** What the project's page shows: its own work and its subprojects', each labelled with the project it is on. */
  async state(projectId: string): Promise<WorkState> {
    const work = this.people.work;
    if (!work) return { available: false, reason: 'Tasks and sign-offs for this Studio are managed by its owner.' };
    const tree = await this.tree();
    if (!getProject(tree, projectId)) throw new WorkError('There is no such project.');
    const ids = subtreeIds(tree, projectId);
    const name = (id: string | null) => (id ? getProject(tree, id)?.name ?? '(removed project)' : '');
    const [tasks, approvals, decisions, approved, people, edit, assign, manage] = await Promise.all([
      work.tasks({ projectIds: ids, state: 'any' }), work.approvals({ projectIds: ids }), work.decisions({ projectIds: ids }), work.approvedLabels(projectId), this.people.peopleList(),
      this.people.may('task.edit'), this.people.may('task.assign'), this.people.may('task.manage')
    ]);
    return {
      available: true, me: this.people.me, people, may: { edit, assign, manage }, approved,
      tasks: tasks.map((t) => ({ ...t, projectName: name(t.projectId) })),
      approvals: approvals.map((a) => ({ ...a, projectName: name(a.projectId) })),
      decisions: decisions.map((d) => ({ ...d, projectName: name(d.projectId) }))
    };
  }

  /** Work that waits on the person using the app, across every project: their open tasks, and the sign-offs they are asked for. */
  async mine(): Promise<MineState> {
    const work = this.people.work;
    if (!work) return { available: false, tasks: [], approvals: [] };
    const tree = await this.tree();
    const name = (id: string) => getProject(tree, id)?.name ?? '(removed project)';
    const [tasks, approvals] = await Promise.all([work.tasks({ assigneeId: this.people.me }), work.waitingForMe()]);
    return {
      available: true,
      tasks: tasks.filter((t) => getProject(tree, t.projectId)).map((t) => ({ ...t, projectName: name(t.projectId) })),
      approvals: approvals.filter((a) => getProject(tree, a.projectId)).map((a) => ({ ...a, projectName: name(a.projectId) }))
    };
  }

  async call(name: string, args: unknown[]): Promise<unknown> {
    if (!(WORK_CALL_NAMES as readonly string[]).includes(name)) throw new WorkError('That is not something the tasks page can do.');
    const work = this.people.work;
    if (!work) throw new WorkError('Tasks and sign-offs for this Studio are managed by its owner.');
    if (NEEDS_PROJECT.has(name)) {
      const projectId = (args[0] as { projectId?: unknown } | undefined)?.projectId;
      const p = typeof projectId === 'string' ? getProject(await this.tree(), projectId) : undefined;
      if (!p) throw new WorkError('There is no such project.');
      if (p.status === 'archived') throw new WorkError('That project is archived. Restore it first.');
    }
    return (work as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args);
  }
}
