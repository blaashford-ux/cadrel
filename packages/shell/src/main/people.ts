/**
 * The studio's people and roles on this computer: the Studio's records file, the permission-checked service over it, and the one person using
 * the app (the Studio's Owner, in a Studio this person owns). Electron-free; tested in test/people.test.ts.
 *
 * A Studio whose records are on its server (every Studio this person joined, and an owned one that was moved there) is the same service sent
 * over the wire: nothing else in the app needs to know. A joined Studio that cannot be reached says so until it can.
 */
import { bootstrapStudio, STUDIO_API_VERSION, STUDIO_SCHEMA_VERSION, type ProjectTree, type ProjectVisibility } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { DirBlobs, LocalVault, openStudioDb, type StudioDb } from '@cadrel/store';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from './remote';
import { StudioOfflineError, type StudioClient } from './studioClient';
import path from 'node:path';
import type { PeopleState, WorkflowState } from '../shared/api';

/** The operations the page may ask for: the service's `people` methods that change things, by the page's names. Nothing else is reachable. */
const CALLS: Record<string, string> = {
  createPerson: 'create', updatePerson: 'update', setPersonActive: 'setActive', createPenName: 'createPenName', setPenNamePeople: 'setPenNamePeople',
  createTeam: 'createTeam', renameTeam: 'renameTeam', setTeamMember: 'setTeamMember', deleteTeam: 'deleteTeam',
  createRole: 'createRole', updateRole: 'updateRole', resetRole: 'resetRole', deleteRole: 'deleteRole', acknowledgeCapabilities: 'acknowledgeCapabilities',
  grant: 'grant', revoke: 'revoke', setExpiry: 'setExpiry'
};
export type StudioWorkflows = ReturnType<StudioService['as']>['workflows'];
export type StudioWork = ReturnType<StudioService['as']>['work'];
export const PEOPLE_CALLS = Object.keys(CALLS);

/** The workflow builder's operations that need only the records, by the page's names (`save` and `delete` also move projects, so they go through `ProjectStages`). */
const WORKFLOW_CALLS: Record<string, string> = { create: 'create', setDefault: 'setDefault' };

export class PeopleHost {
  private db: StudioDb | null = null;
  private svc: StudioService | null = null;
  private meId = '';
  private studioId = '';
  private why = 'The people and roles of this Studio are managed by its owner.';
  private penScope: string[] | null = null;
  /** Set when the Studio's records are on its server: this computer's way to it. */
  private remote: StudioClient | null = null;
  private remoteVault: { vault: LocalVault; store: OfflineAwareStore; key: string } | null = null;
  private projects: (() => Promise<ProjectTree | null>) | null = null;

  /** Tells the records where the Studio's project tree is, so tasks and sign-offs follow who is assigned to what. */
  setProjects(tree: () => Promise<ProjectTree | null>): void {
    this.projects = tree;
  }

  /** Opens (or creates) the records file. An owned Studio starts with its twelve default roles and this person as Owner; a joined one has none here. */
  async open(o: { file: string; studioId: string; owned: boolean; ownerName: string; now?: () => Date }): Promise<void> {
    await this.close();
    this.studioId = o.studioId;
    this.penScope = null;
    if (!o.owned) return;
    this.db = await openStudioDb(o.file);
    // One records file belongs to one Studio and keeps the Studio id it was made with. A Studio restored from a backup has a new id of its own
    // but its old records, so the records' id is the one to use: asking for the new one would find nothing and try to start a second Studio in the file.
    const made = await this.db.first<{ studio_id: string }>('SELECT studio_id FROM person ORDER BY created_at, id LIMIT 1');
    if (made) this.studioId = made.studio_id;
    const at = (o.now?.() ?? new Date()).toISOString();
    await bootstrapStudio(this.db, { studioId: this.studioId, actor: 'system', now: at }, { id: crypto.randomUUID(), name: o.ownerName.trim() || 'Owner' });
    // the person using this computer is the Owner who holds the studio-wide Owner role first
    const row = await this.db.first<{ id: string }>("SELECT subject_id AS id FROM assignment WHERE studio_id = ? AND role_id = 'role_owner' AND scope_kind = 'studio' AND subject_kind = 'person' ORDER BY granted_at, id LIMIT 1", [this.studioId]);
    this.meId = row!.id;
    this.svc = new StudioService({ db: this.db, studioId: this.studioId, access: dbAccess(this.db, this.studioId), now: o.now, projects: async () => (this.projects ? this.projects() : null) });
    await this.refreshPenNames();
  }

  /**
   * Opens the Studio whose records are on its server. Who this person is comes from the server (the one the key belongs to). If the server cannot
   * be reached the Studio stays closed, saying so; call again to retry.
   */
  async openRemote(o: { client: StudioClient; studioId: string }): Promise<{ ok: boolean }> {
    await this.close();
    this.studioId = o.studioId;
    try {
      // a Studio newer than this Cadrel is left alone: it may mean things this version would get wrong
      const info = await o.client.info();
      if ((info.apiVersion ?? 0) > STUDIO_API_VERSION || (info.schemaVersion ?? 0) > STUDIO_SCHEMA_VERSION) {
        this.why = 'This Studio has been upgraded past this version of Cadrel. Update Cadrel to open it.';
        return { ok: false };
      }
      const me = await o.client.me();
      this.meId = me.personId;
    } catch (e) {
      this.why = e instanceof StudioOfflineError ? 'This Studio cannot be reached right now. Check your internet connection; it will be tried again.' : e instanceof Error ? e.message : 'This Studio could not be opened.';
      return { ok: false };
    }
    this.remote = o.client;
    this.svc = remoteService(o.client);
    await this.refreshPenNames().catch(() => undefined);
    return { ok: true };
  }

  /** The records are on the Studio's server, not in a file here. */
  get isRemote(): boolean {
    return !!this.remote;
  }

  /** The last request to the Studio's server found it unreachable (the Files page says it is showing what it last knew). */
  get offline(): boolean {
    return this.remoteVault?.store.offline ?? false;
  }

  /**
   * The pen names this Studio publishes under, for limiting what Market imports and shows. Null where this computer holds no records for the
   * Studio (nothing to limit by); an empty list where it does but no pen name has been added yet.
   */
  penNameScope(): readonly string[] | null {
    return this.penScope;
  }

  private async refreshPenNames(): Promise<void> {
    if (this.remote && this.svc) this.penScope = await this.svc.as(this.meId).people.penNameNames();
    else this.penScope = this.db ? (await this.db.all<{ n: string }>('SELECT display_name AS n FROM pen_name WHERE studio_id = ? ORDER BY lower(display_name)', [this.studioId])).map((r) => r.n) : null;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.svc = null;
    this.remote = null;
    this.remoteVault = null;
    this.meId = '';
    this.penScope = null;
  }

  /** A consistent copy of the records for a backup, written to `dest`. False where this computer holds no records. */
  async snapshot(dest: string): Promise<boolean> {
    if (!this.db) return false;
    await this.db.snapshot(dest);
    return true;
  }

  /** The workflow operations as the person using the app, for the project stages; null where this computer holds no records for the Studio. */
  get workflows(): StudioWorkflows | null {
    return this.svc ? (this.svc.as(this.meId).workflows as StudioWorkflows) : null;
  }

  /** The Studio's records, for other parts of the app (the catalogue) that read them through the same service. */
  get service(): StudioService | null {
    return this.svc;
  }
  /** What the AI server needs to open the Studio's records as this person: the file, who, and which Studio. Empty where this computer holds none. */
  mcpArgs(file: string): string[] {
    return this.svc && this.meId && !this.remote ? ['--records', file, '--person', this.meId, '--studio-id', this.studioId] : [];
  }
  get me(): string {
    return this.meId;
  }

  async state(): Promise<PeopleState> {
    if (!this.svc || (!this.db && !this.remote)) return { available: false, reason: this.why };
    const p = this.svc.as(this.meId);
    if (!(await p.can('people.read'))) return { available: false, reason: 'Your role does not let you see the people and roles of this Studio.' };
    const [people, deactivated, teams, penNames, roles, assignments] = await Promise.all([p.people.list(), p.people.list({ deactivated: true }), p.people.teams(), p.people.penNames(), p.people.roles(), p.people.assignments()]);
    const may = { people: await p.can('people.manage'), teams: await p.can('teams.manage'), roles: await p.can('roles.manage') };
    return { available: true, me: this.meId, studioId: this.studioId, people, deactivated, teams, penNames, roles, assignments, review: may.roles ? await p.people.capabilityReview() : [], may };
  }

  /** Tasks, approvals and decisions as the person using the app; null where this computer holds no records for the Studio. */
  get work(): StudioWork | null {
    return this.svc ? (this.svc.as(this.meId).work as StudioWork) : null;
  }

  /**
   * The local vault for this Studio: the working folder `dir`, the contents of every version under `blobsDir`, this computer as `machine`.
   * Every operation is checked against what the person using the app may do with that kind of file. Null where this computer holds no records.
   */
  vault(o: { dir: string; blobsDir: string; machine: string }): LocalVault | null {
    if (this.remote && this.svc) {
      // on the server the rules are enforced there; the list already holds only what this person may read
      const key = `${o.dir}|${o.blobsDir}|${o.machine}`;
      if (this.remoteVault?.key !== key) {
        const store = new OfflineAwareStore(new RemoteVaultStore(this.remote), path.join(path.dirname(o.blobsDir), 'vault-list.json'));
        const vault = new LocalVault({ store, blobs: new RemoteBlobs(this.remote, new DirBlobs(o.blobsDir)), dir: o.dir, personId: this.meId, machine: o.machine });
        this.remoteVault = { vault, store, key };
      }
      return this.remoteVault.vault;
    }
    if (!this.db || !this.svc) return null;
    const as = this.svc.as(this.meId);
    return new LocalVault({ db: this.db, studioId: this.studioId, blobs: new DirBlobs(o.blobsDir), dir: o.dir, personId: this.meId, machine: o.machine, can: (c) => as.can(c) });
  }

  /**
   * The projects the person using the app can see, or null where this computer holds no records for the Studio (a Studio only joined: its
   * people and roles are on its server, so there is nothing here to limit by). The Owner and an Admin see every project.
   */
  async myVisibility(tree: ProjectTree): Promise<ProjectVisibility | null> {
    return this.svc ? this.svc.as(this.meId).visibleProjects(tree) : null;
  }

  /** What another person can see, for the People page ("what would they see?"). Only for someone who may manage people. */
  async visibilityOf(personId: string, tree: ProjectTree): Promise<{ all: boolean; assigned: string[]; context: string[] }> {
    if (!this.svc) throw new Error(this.why);
    if (!(await this.svc.as(this.meId).can('people.manage')) && !(await this.svc.as(this.meId).can('roles.manage'))) throw new Error('Only someone who manages people and roles can see what another person can see.');
    const v = await this.svc.as(String(personId)).visibleProjects(tree);
    return { all: v.all, assigned: v.all ? [] : [...v.assigned], context: [...v.context] };
  }

  /** Whether the person using the app holds a capability at the studio. */
  async may(capability: string): Promise<boolean> {
    return this.svc ? this.svc.as(this.meId).can(capability) : false;
  }

  /** Whether the person using the app holds a capability on a project (or anywhere, with none). */
  async mayOn(capability: string, projectId?: string | null): Promise<boolean> {
    return this.svc ? this.svc.as(this.meId).canOn(capability, projectId) : false;
  }

  /** The active people a task or sign-off on this project may be given to: those assigned to it. */
  async assignable(projectId: string): Promise<{ id: string; name: string }[]> {
    return this.svc ? this.svc.as(this.meId).work.assignable(projectId) : [];
  }

  /** The active people, for naming an assignee or an approver. */
  async peopleList(): Promise<{ id: string; name: string }[]> {
    return this.svc ? this.svc.as(this.meId).people.directory() : [];
  }

  /** Runs one change as the person using the app. A refusal carries its reason; anything else is the service's own error text. */
  async call(name: string, ...args: unknown[]): Promise<unknown> {
    const method = Object.hasOwn(CALLS, name) ? CALLS[name] : undefined; // not inherited names such as `constructor`
    if (!method) throw new Error('That is not something the People page can do.');
    if (!this.svc) throw new Error(this.why);
    const people = this.svc.as(this.meId).people as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const done = await people[method]!(...args);
    await this.refreshPenNames(); // a pen name may have been added, renamed or removed
    return done;
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

