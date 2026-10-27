/**
 * The studio's service: the one place records are read and changed on behalf of a person. Every call names an actor, is checked with the
 * kernel's `can` (the same function the Worker runs), and only then reaches the record code, so no screen, tool or transport can skip the
 * check. In M1 the transport is in-process (the app calls it directly); in M2 the Worker runs the same class behind HTTP.
 *
 * Catalogue records are studio-wide for now, so the permission resource is the studio. Scoped assignments (a role on one project) take part
 * once a book is linked to a project; until then they do not reach catalogue calls, which is the safe way round.
 */
import {
  acknowledgeCapabilities, addEdition, createWorkflow, deleteWorkflow, listWorkflows, saveWorkflow, setBookStage, setDefaultWorkflow, stageOptions, bookByAsin, can, canEditRole, canGrantRole, capabilityReview, createBook, createIp, createPenName, createPerson, createRole, createSeries, createTeam, defaultRole,
  deleteRole, deleteTeam, effectiveCapabilities, explain, getBook, getPerson, getRole, grantRole, keepsAnOwner, listAssignments, listBooks, listIps, listPenNames, listPeople, listRoles, listSeries, listTeams,
  loadAccess, moveBook, renameTeam, resetRole, revokeAssignment, setAssignmentExpiry, setCatalogueArchived, setPenNamePeople, setPersonActive, setTeamMember, updateBook, updateEdition,
  updatePerson, updateRole, defaultRoles,
  type Assignment, type AssignmentRecord, type Actor, type Book, type BookWithEditions, type Db, type Decision, type Edition, type Ip, type PenName, type PermissionContext, type Person, type Resource, type Role,
  type RoleRecord, type Series, type Team, type ScopeKind, type ScopeRef, type WorkflowDraft, type WorkflowRecord, type StageOption, type Stage
} from '@cadrel/kernel';

export class PermissionDenied extends Error {
  constructor(readonly capability: string, readonly reason: string) {
    super(`You are not allowed to do that (${capability}): ${reason}.`);
  }
}

/** What the service needs to know about who may do what. Read on every call, so a role change takes effect at once. */
export interface Access {
  assignments(): Assignment[] | Promise<Assignment[]>;
  roles(): Role[] | Promise<Role[]>;
  /** The teams the actor is in. */
  teams?(personId: string): string[] | Promise<string[]>;
}

/** The one-person Studio: the person is its Owner. The Studio on this computer, before there is a server, runs on this. */
export function ownerAccess(personId: string, studioId: string): Access {
  const roles = [defaultRole('owner')];
  const assignments: Assignment[] = [{ id: 'owner', subject: { kind: 'person', id: personId }, roleId: roles[0]!.id, scope: { kind: 'studio', id: studioId } }];
  return { assignments: () => assignments, roles: () => roles };
}

/** Reads who holds what from the Studio's own records, on every call, so a change takes effect at once. This is what the app and the Worker use. */
export function dbAccess(db: Db, studioId: string): Access {
  return {
    assignments: async () => (await loadAccess(db, { studioId })).assignments,
    roles: async () => (await loadAccess(db, { studioId })).roles,
    teams: async (personId) => (await loadAccess(db, { studioId })).teamsOf(personId)
  };
}

export interface ServiceOptions {
  db: Db;
  studioId: string;
  access: Access;
  /** The clock; injected so decisions and stamps are reproducible. */
  now?: () => Date;
}

export class StudioService {
  constructor(private readonly o: ServiceOptions) {}

  /** The service as one person: every call below is checked for and stamped with them. */
  as(personId: string): StudioAs {
    return new StudioAs(this.o, personId);
  }
}

export class StudioAs {
  constructor(private readonly o: ServiceOptions, readonly personId: string) {}

  private async context(): Promise<PermissionContext> {
    const actor: Actor = { personId: this.personId, teamIds: (await this.o.access.teams?.(this.personId)) ?? [] };
    return { actor, assignments: await this.o.access.assignments(), roles: new Map((await this.o.access.roles()).map((r) => [r.id, r])), now: this.stamp() };
  }
  private stamp(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private resource(): Resource {
    return { path: [{ kind: 'studio', id: this.o.studioId }] };
  }
  private async need(capability: string): Promise<void> {
    const d = explain(await this.context(), capability, this.resource());
    if (!d.allowed) throw new PermissionDenied(capability, d.reason);
  }
  private ctx() {
    return { studioId: this.o.studioId, actor: this.personId, now: this.stamp() };
  }
  /** A guardrail's refusal, as the same error a missing capability gives. */
  private allow(capability: string, check: { ok: true } | { ok: false; reason: string }): void {
    if (!check.ok) throw new PermissionDenied(capability, check.reason);
  }
  private studioPath(): ScopeRef[] {
    return [{ kind: 'studio', id: this.o.studioId }];
  }
  private scopePath(scope: { kind: ScopeKind; id: string }): ScopeRef[] {
    return scope.kind === 'studio' ? this.studioPath() : [...this.studioPath(), { kind: scope.kind, id: scope.id }];
  }

  /** Whether this person may do something, and why: the interface greys things out from this and "Explain access" shows the reason. */
  async explain(capability: string): Promise<Decision> {
    return explain(await this.context(), capability, this.resource());
  }
  async can(capability: string): Promise<boolean> {
    return can(await this.context(), capability, this.resource());
  }

  readonly catalogue = {
    ips: async (o?: { archived?: boolean }): Promise<Ip[]> => (await this.need('catalogue.read'), listIps(this.o.db, this.ctx(), o)),
    series: async (o?: { ipId?: string; archived?: boolean }): Promise<Series[]> => (await this.need('catalogue.read'), listSeries(this.o.db, this.ctx(), o)),
    books: async (o?: { seriesId?: string | null; archived?: boolean }): Promise<BookWithEditions[]> => (await this.need('catalogue.read'), listBooks(this.o.db, this.ctx(), o)),
    book: async (id: string): Promise<BookWithEditions | null> => (await this.need('catalogue.read'), getBook(this.o.db, this.ctx(), id)),
    /** The book an ASIN belongs to: how a Market or Finance row finds its record. */
    byAsin: async (asin: string): Promise<{ book: Book; edition: Edition } | null> => (await this.need('catalogue.read'), bookByAsin(this.o.db, this.ctx(), asin)),

    createIp: async (i: Parameters<typeof createIp>[2]): Promise<Ip> => (await this.need('catalogue.create'), createIp(this.o.db, this.ctx(), i)),
    createSeries: async (i: Parameters<typeof createSeries>[2]): Promise<Series> => (await this.need('catalogue.create'), createSeries(this.o.db, this.ctx(), i)),
    createBook: async (i: Parameters<typeof createBook>[2]): Promise<BookWithEditions> => (await this.need('catalogue.create'), createBook(this.o.db, this.ctx(), i)),

    updateBook: async (id: string, patch: Parameters<typeof updateBook>[3]): Promise<BookWithEditions> => (await this.need('catalogue.edit'), updateBook(this.o.db, this.ctx(), id, patch)),
    moveBook: async (id: string, seriesId: string | null, position?: number | null): Promise<BookWithEditions> => (await this.need('catalogue.edit'), moveBook(this.o.db, this.ctx(), id, seriesId, position)),
    addEdition: async (bookId: string, i: Parameters<typeof addEdition>[3]): Promise<Edition> => (await this.need('catalogue.edit'), addEdition(this.o.db, this.ctx(), bookId, i)),
    updateEdition: async (id: string, patch: Parameters<typeof updateEdition>[3]): Promise<Edition> => (await this.need('catalogue.edit'), updateEdition(this.o.db, this.ctx(), id, patch)),

    /**
     * Where this book can go from its stage, and for each move whether it is open to this person now and what is in the way. Reading a book's
     * stage needs catalogue.read; the roles a gate names are checked against the roles this person holds on the book's scope (the studio).
     */
    stageOptions: async (bookId: string): Promise<{ workflow: WorkflowRecord | null; current: Stage | null; options: StageOption[] }> => {
      await this.need('catalogue.read');
      return stageOptions(this.o.db, this.ctx(), bookId, await this.holdsRole());
    },
    /** Moves a book to another stage. Needs catalogue.edit, and the workflow must have the move, its conditions hold and the gate's roles include one of yours. */
    setStage: async (bookId: string, toKey: string): Promise<{ from: string; to: string; workflowId: string }> => {
      await this.need('catalogue.edit');
      return setBookStage(this.o.db, this.ctx(), bookId, toKey, await this.holdsRole());
    },

    archive: async (kind: 'ip' | 'series' | 'book' | 'edition', id: string, archived = true): Promise<void> => (await this.need('catalogue.archive'), setCatalogueArchived(this.o.db, this.ctx(), kind, id, archived))
  };

  /**
   * People, teams, roles and assignments. Reading needs people.read; the rest need the capability for what it changes, and role changes also
   * pass the governance guardrails: you cannot hand out a governance power you do not hold, nobody gives themselves a role, only an Owner
   * touches the Owner role, and the last Owner cannot be removed, expired or deactivated.
   */
  readonly people = {
    list: async (o?: { deactivated?: boolean }): Promise<Person[]> => (await this.need('people.read'), listPeople(this.o.db, this.ctx(), o)),
    get: async (id: string): Promise<{ person: Person; teams: Team[]; penNames: PenName[]; assignments: AssignmentRecord[] } | null> => {
      await this.need('people.read');
      const person = await getPerson(this.o.db, this.ctx(), id);
      if (!person) return null;
      return {
        person,
        teams: (await listTeams(this.o.db, this.ctx())).filter((t) => t.memberIds.includes(id)),
        penNames: (await listPenNames(this.o.db, this.ctx())).filter((n) => n.personIds.includes(id)),
        assignments: await listAssignments(this.o.db, this.ctx(), { subjectId: id })
      };
    },
    teams: async (): Promise<Team[]> => (await this.need('people.read'), listTeams(this.o.db, this.ctx())),
    penNames: async (): Promise<PenName[]> => (await this.need('people.read'), listPenNames(this.o.db, this.ctx())),
    roles: async (): Promise<RoleRecord[]> => (await this.need('people.read'), listRoles(this.o.db, this.ctx())),
    assignments: async (o?: { subjectId?: string; roleId?: string }): Promise<AssignmentRecord[]> => (await this.need('people.read'), listAssignments(this.o.db, this.ctx(), o)),

    create: async (i: Parameters<typeof createPerson>[2]): Promise<Person> => (await this.need('people.manage'), createPerson(this.o.db, this.ctx(), i)),
    update: async (id: string, patch: Parameters<typeof updatePerson>[3]): Promise<Person> => (await this.need('people.manage'), updatePerson(this.o.db, this.ctx(), id, patch)),
    setActive: async (id: string, active: boolean): Promise<Person> => {
      await this.need('people.manage');
      if (!active) {
        const { assignments, roles } = await loadAccess(this.o.db, this.ctx());
        this.allow('people.manage', keepsAnOwner(assignments.filter((a) => !(a.subject.kind === 'person' && a.subject.id === id)), new Map(roles.map((r) => [r.id, r])), '', this.stamp()));
      }
      return setPersonActive(this.o.db, this.ctx(), id, active);
    },
    createPenName: async (i: Parameters<typeof createPenName>[2]): Promise<PenName> => (await this.need('people.manage'), createPenName(this.o.db, this.ctx(), i)),
    setPenNamePeople: async (id: string, personIds: string[]): Promise<PenName> => (await this.need('people.manage'), setPenNamePeople(this.o.db, this.ctx(), id, personIds)),

    createTeam: async (name: string): Promise<Team> => (await this.need('teams.manage'), createTeam(this.o.db, this.ctx(), { name })),
    renameTeam: async (id: string, name: string): Promise<Team> => (await this.need('teams.manage'), renameTeam(this.o.db, this.ctx(), id, name)),
    setTeamMember: async (teamId: string, personId: string, member: boolean): Promise<Team> => (await this.need('teams.manage'), setTeamMember(this.o.db, this.ctx(), teamId, personId, member)),
    deleteTeam: async (id: string): Promise<void> => (await this.need('teams.manage'), deleteTeam(this.o.db, this.ctx(), id)),

    createRole: async (i: { name: string; description?: string; capabilities?: string[]; copyFrom?: string }): Promise<RoleRecord> => {
      await this.need('roles.manage');
      // a new role is checked as an edit of an empty one: you cannot start a role with a governance power you do not hold
      const src = i.copyFrom ? await getRole(this.o.db, this.ctx(), i.copyFrom) : null;
      const caps = i.capabilities ?? src?.capabilities ?? [];
      this.allow('roles.manage', canEditRole(await this.context(), { id: '', name: '', description: '', templateKey: null, capabilities: [] }, caps, this.studioPath()));
      return createRole(this.o.db, this.ctx(), i);
    },
    updateRole: async (id: string, patch: { name?: string; description?: string; capabilities?: string[] }): Promise<RoleRecord> => {
      await this.need('roles.manage');
      const before = await getRole(this.o.db, this.ctx(), id);
      if (before) this.allow('roles.manage', canEditRole(await this.context(), before, patch.capabilities ?? before.capabilities, this.studioPath()));
      return updateRole(this.o.db, this.ctx(), id, patch);
    },
    resetRole: async (id: string): Promise<RoleRecord> => {
      await this.need('roles.manage');
      const before = await getRole(this.o.db, this.ctx(), id);
      const shipped = before?.templateKey ? defaultRoles().find((r) => r.templateKey === before.templateKey) : undefined;
      if (before && shipped) this.allow('roles.manage', canEditRole(await this.context(), before, shipped.capabilities, this.studioPath()));
      return resetRole(this.o.db, this.ctx(), id);
    },
    /** A role that is still assigned needs a replacement, and moving people onto it is a grant, so it passes the grant guardrails for each of them. */
    deleteRole: async (id: string, replacementId?: string): Promise<void> => {
      await this.need('roles.manage');
      const role = await getRole(this.o.db, this.ctx(), id);
      if (role && replacementId) {
        const rep = await getRole(this.o.db, this.ctx(), replacementId);
        if (rep) {
          const pc = await this.context();
          for (const a of await listAssignments(this.o.db, this.ctx(), { roleId: id })) this.allow('roles.manage', canGrantRole(pc, rep, this.scopePath(a.scope), a.subject.kind === 'person' ? a.subject.id : undefined));
        }
      }
      return deleteRole(this.o.db, this.ctx(), id, replacementId);
    },
    capabilityReview: async (): Promise<string[]> => (await this.need('roles.manage'), capabilityReview(this.o.db, this.ctx())),
    acknowledgeCapabilities: async (caps: string[]): Promise<void> => (await this.need('roles.manage'), acknowledgeCapabilities(this.o.db, this.ctx(), caps)),

    grant: async (i: Parameters<typeof grantRole>[2]): Promise<AssignmentRecord> => {
      await this.need('roles.manage');
      const role = await getRole(this.o.db, this.ctx(), i.roleId);
      if (role) this.allow('roles.manage', canGrantRole(await this.context(), role, this.scopePath(i.scope), i.subject.kind === 'person' ? i.subject.id : undefined));
      return grantRole(this.o.db, this.ctx(), i);
    },
    revoke: async (id: string): Promise<void> => {
      await this.need('roles.manage');
      const a = (await listAssignments(this.o.db, this.ctx())).find((x) => x.id === id);
      if (a) await this.mayChange(a, null);
      return revokeAssignment(this.o.db, this.ctx(), id);
    },
    setExpiry: async (id: string, expiresAt: string | null): Promise<AssignmentRecord> => {
      await this.need('roles.manage');
      const a = (await listAssignments(this.o.db, this.ctx())).find((x) => x.id === id);
      if (a && expiresAt !== null) await this.mayChange(a, expiresAt);
      return setAssignmentExpiry(this.o.db, this.ctx(), id, expiresAt);
    },

    /**
     * Explain access: why this person can or cannot do something on a book, project or file. Needs roles.manage, since it shows who holds what.
     * `path` is the resource from the studio down to it.
     */
    explainAccess: async (personId: string, capability: string, path?: ScopeRef[]): Promise<Decision> => {
      await this.need('roles.manage');
      const { assignments, roles, teamsOf } = await loadAccess(this.o.db, this.ctx());
      const ctx: PermissionContext = { actor: { personId, teamIds: teamsOf(personId) }, assignments, roles: new Map(roles.map((r) => [r.id, r])), now: this.stamp() };
      return explain(ctx, capability, { path: path?.length ? path : this.studioPath() });
    },
    /** Every capability the person holds at the studio (or `*`), for the "who can do what" view. */
    effectiveCapabilities: async (personId: string, path?: ScopeRef[]): Promise<string[]> => {
      await this.need('roles.manage');
      const { assignments, roles, teamsOf } = await loadAccess(this.o.db, this.ctx());
      const ctx: PermissionContext = { actor: { personId, teamIds: teamsOf(personId) }, assignments, roles: new Map(roles.map((r) => [r.id, r])), now: this.stamp() };
      return [...effectiveCapabilities(ctx, path?.length ? path : this.studioPath())].sort();
    }
  };

  /** Removing, expiring or changing an Owner needs an Owner, and must leave at least one. Any other assignment needs only roles.manage. */
  private async mayChange(a: AssignmentRecord, _newExpiry: string | null): Promise<void> {
    const { assignments, roles } = await loadAccess(this.o.db, this.ctx());
    const map = new Map(roles.map((r) => [r.id, r]));
    const role = map.get(a.roleId);
    if (role?.all) {
      this.allow('roles.manage', canGrantRole(await this.context(), role, this.scopePath(a.scope)));
      this.allow('roles.manage', keepsAnOwner(assignments, map, a.id, this.stamp()));
    }
  }

  /**
   * Whether this person holds any of the given roles at the studio. An Owner holds every role (the Owner role is "all", and an Owner may do
   * what any gate asks). Used for the roles a workflow gate names.
   */
  private async holdsRole(): Promise<(roleIds: string[]) => boolean> {
    const pc = await this.context();
    const held = new Set<string>();
    let owner = false;
    const active = pc.assignments.filter((a) => (!a.expiresAt || a.expiresAt > pc.now) && a.scope.kind === 'studio' && ((a.subject.kind === 'person' && a.subject.id === this.personId) || (a.subject.kind === 'team' && pc.actor.teamIds.includes(a.subject.id))));
    for (const a of active) {
      held.add(a.roleId);
      if (pc.roles.get(a.roleId)?.all) owner = true;
    }
    return (roleIds) => owner || roleIds.some((r) => held.has(r));
  }

  /** The workflow builder's operations. Reading needs catalogue.read (people need to see where a book can go); building needs workflow.design. */
  readonly workflows = {
    list: async (): Promise<WorkflowRecord[]> => (await this.need('catalogue.read'), listWorkflows(this.o.db, this.ctx())),
    create: async (i: Parameters<typeof createWorkflow>[2]): Promise<WorkflowRecord> => (await this.need('workflow.design'), createWorkflow(this.o.db, this.ctx(), i)),
    save: async (id: string, draft: WorkflowDraft): Promise<WorkflowRecord> => (await this.need('workflow.design'), saveWorkflow(this.o.db, this.ctx(), id, draft)),
    setDefault: async (id: string): Promise<WorkflowRecord> => (await this.need('workflow.design'), setDefaultWorkflow(this.o.db, this.ctx(), id)),
    delete: async (id: string): Promise<void> => (await this.need('workflow.design'), deleteWorkflow(this.o.db, this.ctx(), id))
  };
}
