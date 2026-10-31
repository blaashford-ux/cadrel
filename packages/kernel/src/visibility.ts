import { CONFIDENTIAL_CAP, can, type PermissionContext } from './permissions';
import { ancestorsOf, subtreeIds, type Project, type ProjectTree } from './projects';

/**
 * Which projects a person can see. A project is for the people assigned to it: someone with a role on the Project (a series) is assigned to
 * it and every Book under it, someone with a role on one Book is assigned to that Book only, and a role at the whole studio does not make
 * anyone assigned to a project. The people who see every project regardless are those who hold `confidential.access` at the studio (the Owner,
 * and an Admin by default), because they run the studio.
 *
 * What is visible is the assigned projects, and the Project above an assigned Book, so that the Book has somewhere to sit: that Project is
 * shown as a container (`context`), and its other Books stay hidden.
 */
export interface ProjectVisibility {
  /** Sees every project (holds `confidential.access`). */
  all: boolean;
  /** Projects the person is assigned to, directly or through a Project above. */
  assigned: Set<string>;
  /** Projects shown only because an assigned project sits under them. */
  context: Set<string>;
  /** Everything the person may see: assigned and context (every project when `all`). */
  visible: Set<string>;
}

export function projectVisibility(tree: ProjectTree, ctx: PermissionContext, studioId: string): ProjectVisibility {
  const everyone = () => new Set(tree.projects.map((p) => p.id));
  if (can(ctx, CONFIDENTIAL_CAP, { path: [{ kind: 'studio', id: studioId }] })) return { all: true, assigned: everyone(), context: new Set(), visible: everyone() };
  const assigned = new Set<string>();
  for (const a of ctx.assignments) {
    if (a.scope.kind !== 'project') continue;
    if (a.expiresAt && a.expiresAt <= ctx.now) continue;
    const mine = (a.subject.kind === 'person' && a.subject.id === ctx.actor.personId) || (a.subject.kind === 'team' && ctx.actor.teamIds.includes(a.subject.id));
    const role = ctx.roles.get(a.roleId);
    if (!mine || !role) continue;
    if (!tree.projects.some((p) => p.id === a.scope.id)) continue;
    for (const id of subtreeIds(tree, a.scope.id)) assigned.add(id);
  }
  const context = new Set<string>();
  for (const id of assigned) for (const up of ancestorsOf(tree, id)) if (!assigned.has(up.id)) context.add(up.id);
  return { all: false, assigned, context, visible: new Set([...assigned, ...context]) };
}

/** The tree as someone sees it: only their visible projects, and only the links of those. */
export function visibleTree(tree: ProjectTree, v: Pick<ProjectVisibility, 'all' | 'visible'>): ProjectTree {
  if (v.all) return tree;
  return { projects: tree.projects.filter((p: Project) => v.visible.has(p.id)), links: tree.links.filter((l) => v.visible.has(l.projectId)) };
}
