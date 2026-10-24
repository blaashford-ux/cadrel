import type { Role } from './roles';

/**
 * The permission decision. One pure function, used by the Worker (authoritative), the desktop app (to shape the
 * interface) and the tests. `can` and `explain` share one code path so they can never disagree.
 * No runtime-specific imports: this runs in Electron and in a Cloudflare Worker.
 */

/** A role applies at the studio, at a project (and so everything under it: a Series is a project, a Book a subproject), or at a file. */
export type ScopeKind = 'studio' | 'project' | 'file';

export interface ScopeRef {
  kind: ScopeKind;
  id: string;
  confidential?: boolean;
}

/** A resource is described by its path from the studio down to itself (the last element is the resource). */
export interface Resource {
  path: ScopeRef[];
  /** Capabilities the resource's current workflow state makes unavailable (for example a file in "Approved"). */
  stateDenies?: { state: string; capabilities: string[] };
}

export interface Assignment {
  id: string;
  subject: { kind: 'person' | 'team'; id: string };
  roleId: string;
  scope: { kind: ScopeKind; id: string };
  /** ISO timestamp; the assignment stops applying at this moment. */
  expiresAt?: string | null;
}

export interface Actor {
  personId: string;
  teamIds: string[];
}

export interface PermissionContext {
  actor: Actor;
  assignments: Assignment[];
  roles: Map<string, Role>;
  /** ISO timestamp for "now". Passed in so decisions are reproducible. */
  now: string;
}

export interface Grant {
  assignmentId: string;
  roleId: string;
  roleName: string;
  scope: { kind: ScopeKind; id: string };
  viaTeam?: string;
}

export type DenyReason = 'no-assignment' | 'confidential' | 'workflow-state';

export type Decision =
  | { allowed: true; grants: Grant[]; reason: string }
  | { allowed: false; why: DenyReason; reason: string };

export const CONFIDENTIAL_CAP = 'confidential.access';

function roleHas(role: Role, capability: string): boolean {
  return role.all === true || role.capabilities.includes(capability);
}

function activeFor(ctx: PermissionContext): { a: Assignment; viaTeam?: string }[] {
  const out: { a: Assignment; viaTeam?: string }[] = [];
  for (const a of ctx.assignments) {
    if (a.expiresAt && a.expiresAt <= ctx.now) continue;
    if (a.subject.kind === 'person' && a.subject.id === ctx.actor.personId) out.push({ a });
    else if (a.subject.kind === 'team' && ctx.actor.teamIds.includes(a.subject.id)) out.push({ a, viaTeam: a.subject.id });
  }
  return out;
}

function pathIndex(path: ScopeRef[], scope: { kind: ScopeKind; id: string }): number {
  return path.findIndex((p) => p.kind === scope.kind && p.id === scope.id);
}

/** Does the actor hold `capability` anywhere on `path`? Returns the grants that give it. */
function grantsFor(ctx: PermissionContext, capability: string, path: ScopeRef[], minIndex = 0): Grant[] {
  const grants: Grant[] = [];
  for (const { a, viaTeam } of activeFor(ctx)) {
    const role = ctx.roles.get(a.roleId);
    if (!role || !roleHas(role, capability)) continue;
    const i = pathIndex(path, a.scope);
    if (i < 0 || i < minIndex) continue;
    grants.push({ assignmentId: a.id, roleId: role.id, roleName: role.name, scope: a.scope, viaTeam });
  }
  return grants;
}

export function explain(ctx: PermissionContext, capability: string, resource: Resource): Decision {
  const { path } = resource;

  // Confidential nodes hide a subtree from anyone assigned above them. The deepest one decides.
  let deepestConfidential = -1;
  path.forEach((p, i) => {
    if (p.confidential) deepestConfidential = i;
  });
  const holdsConfidentialAccess = deepestConfidential >= 0 && grantsFor(ctx, CONFIDENTIAL_CAP, path.slice(0, 1)).length > 0;
  const minIndex = holdsConfidentialAccess ? 0 : Math.max(deepestConfidential, 0);

  const grants = grantsFor(ctx, capability, path, minIndex);
  if (grants.length === 0) {
    const wouldHaveWithout = deepestConfidential >= 0 && grantsFor(ctx, capability, path).length > 0;
    return wouldHaveWithout
      ? { allowed: false, why: 'confidential', reason: `${capability} is held only above a confidential project; assign a role at or below it` }
      : { allowed: false, why: 'no-assignment', reason: `no active role grants ${capability} here` };
  }

  const denied = resource.stateDenies;
  if (denied && denied.capabilities.includes(capability)) {
    return { allowed: false, why: 'workflow-state', reason: `${capability} is not available while this item is "${denied.state}"` };
  }

  const g = grants[0]!;
  return {
    allowed: true,
    grants,
    reason: `allowed by ${g.roleName} on ${g.scope.kind} ${g.scope.id}${g.viaTeam ? ` via team ${g.viaTeam}` : ''}`
  };
}

export function can(ctx: PermissionContext, capability: string, resource: Resource): boolean {
  return explain(ctx, capability, resource).allowed;
}

/** Every capability the actor holds at a scope (used by the guardrails and "View as"). '*' means all. */
export function effectiveCapabilities(ctx: PermissionContext, scope: ScopeRef[]): Set<string> {
  const caps = new Set<string>();
  for (const { a } of activeFor(ctx)) {
    const role = ctx.roles.get(a.roleId);
    if (!role || pathIndex(scope, a.scope) < 0) continue;
    if (role.all) caps.add('*');
    else role.capabilities.forEach((c) => caps.add(c));
  }
  return caps;
}
