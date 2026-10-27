/**
 * The studio's people and roles on this computer: the Studio's records file, the permission-checked service over it, and the one person using
 * the app (the Studio's Owner, in a Studio this person owns). Electron-free; tested in test/people.test.ts.
 *
 * A Studio this person only joined has its people and roles on its server (M2), so there is nothing here to manage and the page says so.
 */
import { bootstrapStudio } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { openStudioDb, type StudioDb } from '@cadrel/store';
import type { PeopleState, WorkflowState } from '../shared/api';

/** The operations the page may ask for: the service's `people` methods that change things, by the page's names. Nothing else is reachable. */
const CALLS: Record<string, string> = {
  createPerson: 'create', updatePerson: 'update', setPersonActive: 'setActive', createPenName: 'createPenName', setPenNamePeople: 'setPenNamePeople',
  createTeam: 'createTeam', renameTeam: 'renameTeam', setTeamMember: 'setTeamMember', deleteTeam: 'deleteTeam',
  createRole: 'createRole', updateRole: 'updateRole', resetRole: 'resetRole', deleteRole: 'deleteRole', acknowledgeCapabilities: 'acknowledgeCapabilities',
  grant: 'grant', revoke: 'revoke', setExpiry: 'setExpiry'
};
export type StudioWorkflows = ReturnType<StudioService['as']>['workflows'];
export const PEOPLE_CALLS = Object.keys(CALLS);

/** The workflow builder's operations that need only the records, by the page's names (`save` and `delete` also move projects, so they go through `ProjectStages`). */
const WORKFLOW_CALLS: Record<string, string> = { create: 'create', setDefault: 'setDefault' };

export class PeopleHost {
  private db: StudioDb | null = null;
  private svc: StudioService | null = null;
  private meId = '';
  private studioId = '';
  private why = 'The people and roles of this Studio are managed by its owner.';

  /** Opens (or creates) the records file. An owned Studio starts with its twelve default roles and this person as Owner; a joined one has none here. */
  async open(o: { file: string; studioId: string; owned: boolean; ownerName: string; now?: () => Date }): Promise<void> {
    await this.close();
    this.studioId = o.studioId;
    if (!o.owned) return;
    this.db = await openStudioDb(o.file);
    const at = (o.now?.() ?? new Date()).toISOString();
    await bootstrapStudio(this.db, { studioId: o.studioId, actor: 'system', now: at }, { id: crypto.randomUUID(), name: o.ownerName.trim() || 'Owner' });
    // the person using this computer is the Owner who holds the studio-wide Owner role first
    const row = await this.db.first<{ id: string }>("SELECT subject_id AS id FROM assignment WHERE studio_id = ? AND role_id = 'role_owner' AND scope_kind = 'studio' AND subject_kind = 'person' ORDER BY granted_at, id LIMIT 1", [o.studioId]);
    this.meId = row!.id;
    this.svc = new StudioService({ db: this.db, studioId: o.studioId, access: dbAccess(this.db, o.studioId), now: o.now });
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.svc = null;
    this.meId = '';
  }

  /** The workflow operations as the person using the app, for the project stages; null where this computer holds no records for the Studio. */
  get workflows(): StudioWorkflows | null {
    return this.svc ? (this.svc.as(this.meId).workflows as StudioWorkflows) : null;
  }

  /** The Studio's records, for other parts of the app (the catalogue) that read them through the same service. */
  get service(): StudioService | null {
    return this.svc;
  }
  get me(): string {
    return this.meId;
  }

  async state(): Promise<PeopleState> {
    if (!this.svc || !this.db) return { available: false, reason: this.why };
    const p = this.svc.as(this.meId);
    const [people, deactivated, teams, penNames, roles, assignments] = await Promise.all([p.people.list(), p.people.list({ deactivated: true }), p.people.teams(), p.people.penNames(), p.people.roles(), p.people.assignments()]);
    const may = { people: await p.can('people.manage'), teams: await p.can('teams.manage'), roles: await p.can('roles.manage') };
    return { available: true, me: this.meId, studioId: this.studioId, people, deactivated, teams, penNames, roles, assignments, review: may.roles ? await p.people.capabilityReview() : [], may };
  }

  /** Runs one change as the person using the app. A refusal carries its reason; anything else is the service's own error text. */
  async call(name: string, ...args: unknown[]): Promise<unknown> {
    const method = Object.hasOwn(CALLS, name) ? CALLS[name] : undefined; // not inherited names such as `constructor`
    if (!method) throw new Error('That is not something the People page can do.');
    if (!this.svc) throw new Error(this.why);
    const people = this.svc.as(this.meId).people as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return people[method]!(...args);
  }

  async workflowState(): Promise<Exclude<WorkflowState, { available: true }> | Omit<Extract<WorkflowState, { available: true }>, 'usage'>> {
    if (!this.svc) return { available: false, reason: this.why };
    const p = this.svc.as(this.meId);
    const [workflows, roles, may] = await Promise.all([p.workflows.list(), p.people.roles().catch(() => []), p.can('workflow.design')]);
    return { available: true, workflows, roles: roles.map((r) => ({ id: r.id, name: r.name })), may };
  }

  /** One workflow-builder change as the person using the app. */
  async workflowCall(name: string, ...args: unknown[]): Promise<unknown> {
    const method = Object.hasOwn(WORKFLOW_CALLS, name) ? WORKFLOW_CALLS[name] : undefined;
    if (!method) throw new Error('That is not something the workflow builder can do.');
    if (!this.svc) throw new Error(this.why);
    const w = this.svc.as(this.meId).workflows as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return w[method]!(...args);
  }

  async effective(personId: string, projectId?: string | null): Promise<string[]> {
    if (!this.svc) throw new Error(this.why);
    const path = projectId ? [{ kind: 'studio' as const, id: this.studioId }, { kind: 'project' as const, id: String(projectId) }] : undefined;
    return this.svc.as(this.meId).people.effectiveCapabilities(String(personId), path);
  }

  async explain(personId: string, capability: string, projectId?: string | null): Promise<{ allowed: boolean; reason: string }> {
    if (!this.svc) throw new Error(this.why);
    const path = projectId ? [{ kind: 'studio' as const, id: this.studioId }, { kind: 'project' as const, id: projectId }] : undefined;
    const d = await this.svc.as(this.meId).people.explainAccess(String(personId), String(capability), path);
    return { allowed: d.allowed, reason: d.reason };
  }
}

