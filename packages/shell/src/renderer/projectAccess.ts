import { ancestorsOf, getProject, type AssignmentRecord, type ProjectTree } from '@cadrel/kernel';

/** Where a role that applies on a project comes from. */
export type AccessSource = 'here' | 'above' | 'studio';

export interface HeldOn {
  assignment: AssignmentRecord;
  source: AccessSource;
  /** The project a role from above was given on (a Book's Series, say); null for the others. */
  from: string | null;
}

const rank: Record<AccessSource, number> = { here: 0, above: 1, studio: 2 };

/**
 * The roles that apply on a project: those given on it, those given on a project above it (a role given there reaches everything under it),
 * and those given for the whole Studio. A role given on a project below it, or on a file, does not reach it. Ended ones are left out.
 * Closest first, so what can be removed here comes before what can only be changed where it was given.
 */
export function accessOn(tree: ProjectTree, assignments: AssignmentRecord[], projectId: string, studioId: string, now = new Date().toISOString()): HeldOn[] {
  if (!getProject(tree, projectId)) return [];
  const above = new Set(ancestorsOf(tree, projectId).map((p) => p.id));
  const out: HeldOn[] = [];
  for (const a of assignments) {
    if (a.expiresAt && a.expiresAt <= now) continue;
    if (a.scope.kind === 'project' && a.scope.id === projectId) out.push({ assignment: a, source: 'here', from: null });
    else if (a.scope.kind === 'project' && above.has(a.scope.id)) out.push({ assignment: a, source: 'above', from: a.scope.id });
    else if (a.scope.kind === 'studio' && a.scope.id === studioId) out.push({ assignment: a, source: 'studio', from: null });
  }
  return out.sort((x, y) => rank[x.source] - rank[y.source]);
}
