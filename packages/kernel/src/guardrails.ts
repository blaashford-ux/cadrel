import { allCapabilities } from './capabilities';
import { effectiveCapabilities, type Assignment, type PermissionContext, type ScopeRef } from './permissions';
import type { Role } from './roles';

/** Rules that stop administrators from escalating or locking everyone out. Each returns a reason when it refuses. */
export type Check = { ok: true } | { ok: false; reason: string };

const ok: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

/**
 * Governance capabilities control who can do what, or break glass. You cannot hand out any of these that you do
 * not hold yourself. Content capabilities (writing, approving, reading finance) are not in this list: an Admin who
 * can only read manuscripts must still be able to make someone an Author.
 */
export const GOVERNANCE = new Set([
  'people.invite', 'people.manage', 'roles.manage', 'teams.manage',
  'studio.settings', 'security.policy', 'workflow.design',
  'vault.force', 'confidential.access', 'audit.read'
]);

const KNOWN = new Set(allCapabilities());

function unknownOrUnheld(caps: Set<string>, wanted: string[]): string | null {
  const unknown = wanted.find((c) => !KNOWN.has(c));
  if (unknown) return `${unknown} is not a known capability`;
  if (caps.has('*')) return null;
  const missing = wanted.find((c) => GOVERNANCE.has(c) && !caps.has(c));
  return missing ? `you cannot hand out ${missing} because you do not hold it` : null;
}

/**
 * May the granter give `role` at `scope`? Needs roles.manage; only an Owner grants Owner; governance capabilities
 * in the role must be held by the granter; nobody grants themselves a role (an Owner excepted).
 */
export function canGrantRole(ctx: PermissionContext, role: Role, scopePath: ScopeRef[], targetPersonId?: string): Check {
  const caps = effectiveCapabilities(ctx, scopePath);
  const owner = caps.has('*');
  if (!owner && !caps.has('roles.manage')) return no('granting roles needs roles.manage');
  if (role.all) return owner ? ok : no('only an Owner can assign the Owner role');
  if (!owner && targetPersonId !== undefined && targetPersonId === ctx.actor.personId) return no('you cannot grant a role to yourself');
  const problem = unknownOrUnheld(caps, role.capabilities);
  return problem ? no(problem) : ok;
}

/** May the editor add these capabilities to a role? Same governance rule; the Owner role is fixed. */
export function canEditRole(ctx: PermissionContext, before: Role, afterCapabilities: string[], studioPath: ScopeRef[]): Check {
  const caps = effectiveCapabilities(ctx, studioPath);
  if (!caps.has('*') && !caps.has('roles.manage')) return no('editing roles needs roles.manage');
  if (before.all) return no('the Owner role cannot be edited');
  const added = afterCapabilities.filter((c) => !before.capabilities.includes(c));
  const problem = unknownOrUnheld(caps, added);
  return problem ? no(problem) : ok;
}

/** Removing, expiring or demoting this assignment must leave at least one active Owner. */
export function keepsAnOwner(assignments: Assignment[], roles: Map<string, Role>, changingId: string, now: string): Check {
  const active = (a: Assignment) => a.subject.kind === 'person' && a.scope.kind === 'studio' && (!a.expiresAt || a.expiresAt > now) && roles.get(a.roleId)?.all === true;
  const remaining = assignments.filter((a) => a.id !== changingId && active(a));
  return remaining.length > 0 ? ok : no('there must always be at least one Owner');
}

/** A role that is still assigned cannot be deleted. */
export function canDeleteRole(assignments: Assignment[], roleId: string): Check {
  return assignments.some((a) => a.roleId === roleId) ? no('the role is still assigned; reassign those people first') : ok;
}
