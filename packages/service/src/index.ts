/**
 * The studio's service: the one place records are read and changed on behalf of a person. Every call names an actor, is checked with the
 * kernel's `can` (the same function the Worker runs), and only then reaches the record code, so no screen, tool or transport can skip the
 * check. In M1 the transport is in-process (the app calls it directly); in M2 the Worker runs the same class behind HTTP.
 *
 * Catalogue records are studio-wide for now, so the permission resource is the studio. Scoped assignments (a role on one project) take part
 * once a book is linked to a project; until then they do not reach catalogue calls, which is the safe way round.
 */
import {
  addContribution, addCredit, addRights, addShare, listContributions, listCredits, listRights, listShares, setBusinessArchived, updateContribution, updateCredit, updateRights, updateShare, AUDITED_READS,
  acknowledgeCapabilities, bookProjectLinks, linkBookProject, addDependency, addEdition, approvalsWaitingFor, approvedLabels, createTask, getApproval, getDecision, getTask, listApprovals, listDecisions, listTasks, openTaskCount, recordDecision, removeDependency, requestApproval, respondToApproval, setTaskState, updateTask, withdrawApproval, checkMove, createWorkflow, defaultWorkflow, deleteWorkflow, listWorkflows, saveWorkflow, setDefaultWorkflow, stageOptions, bookByAsin, can, canEditRole, canGrantRole, capabilityReview, createBook, createIp, createPenName, createPerson, createRole, createSeries, createTeam, defaultRole,
  deleteRole, deleteTeam, effectiveCapabilities, explain, getBook, getPerson, getRole, grantRole, keepsAnOwner, listAssignments, listBooks, listIps, listPenNames, listPeople, listRoles, listSeries, listTeams,
  loadAccess, moveBook, renameTeam, resetRole, revokeAssignment, setAssignmentExpiry, setCatalogueArchived, deleteBook, setPenNamePeople, setPersonActive, setTeamMember, updateBook, updateEdition,
  updatePerson, updateRole, defaultRoles, projectVisibility, ancestorsOf, subtreeIds, getProject,
  addFeedback, addUse, approveVersion, approvedAssets, approvalsOf, assetOfFile, assetWhereUsed, chooseConcept, conceptsOf, createAsset, decideConcept, decideReplacement, feedbackOf, getAsset, getConcept, getReplacement,
  listAssets, proposeReplacement, replacementsOf, resolveFeedback, retireAsset, revokeApproval, setUseState, submitConcept, submitForReview, updateAsset, usesOf, withdrawReplacement, approvedVersions,
  getRun, latestRun, listRuns, recordRun, waiveResult,
  type ApprovedAsset, type Asset, type AssetApproval, type AssetFilter, type AssetKind, type AssetReplacement, type AssetUse, type AssetWhereUsed, type Concept, type Feedback, type LicenceInput, type NewAsset, type NewRun, type PreflightResult, type PreflightRun, type Region, type RunFilter, type UseKind,
  canonStamp, checkChange, decideProposal, entryVersions, getEntry, getFact, getProposal, listEntries, listFacts, listProposals, proposeChange, withdrawProposal,
  type CanonChange, type CanonEntry, type CanonEntryVersion, type CanonFact, type CanonProposal, type EntryFilter, type FactFilter, type ProposalFilter,
  closeCheck, decideFinding, deliverCheck, findingCounts, getCheck, getFinding, listChecks, listFindings, raiseFindings, startCheck, verifyFindings,
  type CheckFilter, type ContinuityCheck, type ContinuityFinding, type FindingCounts, type FindingDecision, type FindingFilter, type NewFinding,
  type Assignment, type AssignmentRecord, type Actor, type Book, type BookWithEditions, type Db, type Decision, type Edition, type Ip, type PenName, type PermissionContext, type Person, type Resource, type Role,
  type Contribution, type Credit, type Rights, type RevenueShare, type Subject,
  editorialFacts, type EditorialFacts, continuityFacts, type ContinuityFacts,
  listVerification, verifyPass, type VerificationRecord,
  decideQuery, listEditDecisions, type EditDecisionFilter, type EditDecisionRecord, type NewEditDecision,
  answerQuery, getQuery, listQueries, queriesFromNotes, queryCounts, raiseQueries, resolveQuery, withdrawQuery, type NewQuery, type QueryCounts, type QueryFilter, type QueryRecord,
  assignEditor, createPass, getPass, listPasses, movePass, type NewPass, type PassFilter, type PassRecord, type PassState,
  getPolicy, setPolicy, type PolicyChange, type StudioPolicy,
  bookFinanceMonths, listBookFinance, ownedAsins, publishBookFinance, type BookFinanceSummary, type PublishedMonth,
  briefVersions, createBrief, getBrief, listBriefs, reviseBrief, type BriefFilter, type BriefKind, type BriefRecord, type BriefVersion, type NewBrief,
  type ApprovalRecord, type DecisionRecord, type NewApproval, type NewTask, type TaskFilter, type TaskPatch, type TaskRecord, type TaskState, type ApprovalState,
  type RoleRecord, type Series, type Team, type ScopeKind, type ScopeRef, type WorkflowDraft, type WorkflowRecord, type StageOption, type Stage, type ProjectFacts, type ProjectLevel, type WorkflowUsage, type ProjectTree, type ProjectVisibility
} from '@cadrel/kernel';

import { PermissionDenied } from './errors';
export { PermissionDenied };
export { VaultAs } from './vault';
export { BetaAs, BETA_METHODS, MAX_BETA_NOTES, type BetaFile, type BetaNotes, type BetaText } from './beta';

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

/** Who holds what, as the permission checks read it. */
export type AccessSnapshot = Awaited<ReturnType<typeof loadAccess>>;

/**
 * Reads who holds what from the Studio's own records, on every call, so a change takes effect at once. This is what the app uses, where the
 * records are a local file. A server, where every row read is billed, passes `load` to hand back what it already holds until the records change.
 */
export function dbAccess(db: Db, studioId: string, load: () => Promise<AccessSnapshot> = () => loadAccess(db, { studioId })): Access {
  return {
    assignments: async () => (await load()).assignments,
    roles: async () => (await load()).roles,
    teams: async (personId) => (await load()).teamsOf(personId)
  };
}

export interface ServiceOptions {
  db: Db;
  studioId: string;
  access: Access;
  /** The clock; injected so decisions and stamps are reproducible. */
  now?: () => Date;
  /**
   * The Studio's project tree, which the records (tasks, sign-offs, decisions) hang off. With it, they follow who is assigned to what: a person
   * sees and changes the records of the projects they are assigned to, and a task or sign-off can be given only to someone assigned to its
   * project. Without it (no tree to go by) nothing is limited.
   */
  projects?: () => Promise<ProjectTree | null>;
}

const BRIEF_READ: Record<BriefKind, string> = { manuscript: 'task.read', edit: 'edit.read', cover: 'asset.read', art: 'asset.read' };
const BRIEF_WRITE: Record<BriefKind, string> = { manuscript: 'task.edit', edit: 'edit.assign', cover: 'brief.write', art: 'brief.write' };

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

  /** The projects this person can see: those they are assigned to (see `projectVisibility`), or all of them for the Owner and Admin. */
  async visibleProjects(tree: ProjectTree): Promise<ProjectVisibility> {
    return projectVisibility(tree, await this.context(), this.o.studioId);
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

    /** Which project each book is made in. */
    projectLinks: async (): Promise<{ bookId: string; projectId: string }[]> => (await this.need('catalogue.read'), bookProjectLinks(this.o.db, this.ctx())),
    linkProject: async (bookId: string, projectId: string | null): Promise<void> => (await this.need('catalogue.edit'), linkBookProject(this.o.db, this.ctx(), bookId, projectId)),

    archive: async (kind: 'ip' | 'series' | 'book' | 'edition', id: string, archived = true): Promise<void> => (await this.need('catalogue.archive'), setCatalogueArchived(this.o.db, this.ctx(), kind, id, archived)),

    /** Deletes a book added by mistake, with its editions, links, business records and log rows. Needs the same power as archiving; returns the ASINs its editions had. */
    deleteBook: async (id: string): Promise<{ asins: string[] }> => (await this.need('catalogue.archive'), deleteBook(this.o.db, this.ctx(), id))
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
    /**
     * Who is in the Studio, by name only, for showing who a task, sign-off or lock belongs to. Anyone who holds a role anywhere may see it; the
     * rest of a person's record (email, kind, roles) needs people.read.
     */
    directory: async (): Promise<{ id: string; name: string }[]> => {
      const some = ['people.read', 'task.read', 'catalogue.read', 'manuscript.read', 'asset.read', 'market.read', 'royalties.read'];
      let ok = false;
      for (const c of some) if (await this.canAt(c, null) || await this.canOn(c, null)) { ok = true; break; }
      if (!ok) throw new PermissionDenied('task.read', 'no active role grants it here');
      return (await listPeople(this.o.db, this.ctx())).map((p) => ({ id: p.id, name: p.name }));
    },
    penNames: async (): Promise<PenName[]> => (await this.need('people.read'), listPenNames(this.o.db, this.ctx())),
    /**
     * Only the names of the pen names the Studio publishes under, for limiting what Market imports and shows. Anyone who works with books or
     * money needs these, whether or not they may see the people.
     */
    penNameNames: async (): Promise<string[]> => {
      if (!(await this.can('people.read')) && !(await this.can('catalogue.read')) && !(await this.can('royalties.read'))) throw new PermissionDenied('catalogue.read', 'no active role grants it here');
      return (await listPenNames(this.o.db, this.ctx())).map((n) => n.displayName);
    },
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

  /**
   * Contributions, credits, rights and revenue shares: four separate kinds of record about a book, series, IP or edition. Reading needs
   * business.read and **is logged** (who looked, at what), as for royalties; changing needs business.manage. Nothing is deleted: records are archived.
   */
  readonly business = {
    contributions: async (f?: { subject?: Subject; personId?: string; archived?: boolean }): Promise<Contribution[]> => (await this.seen('contributions', f?.subject), listContributions(this.o.db, this.ctx(), f)),
    credits: async (f?: { subject?: Subject; archived?: boolean }): Promise<Credit[]> => (await this.seen('credits', f?.subject), listCredits(this.o.db, this.ctx(), f)),
    rights: async (f?: { subject?: Subject; archived?: boolean }): Promise<Rights[]> => (await this.seen('rights', f?.subject), listRights(this.o.db, this.ctx(), f)),
    shares: async (f?: { subject?: Subject; personId?: string; archived?: boolean }): Promise<RevenueShare[]> => (await this.seen('shares', f?.subject), listShares(this.o.db, this.ctx(), f)),

    addContribution: async (i: Parameters<typeof addContribution>[2]): Promise<Contribution> => (await this.need('business.manage'), addContribution(this.o.db, this.ctx(), i)),
    updateContribution: async (id: string, p: Parameters<typeof updateContribution>[3]): Promise<Contribution> => (await this.need('business.manage'), updateContribution(this.o.db, this.ctx(), id, p)),
    addCredit: async (i: Parameters<typeof addCredit>[2]): Promise<Credit> => (await this.need('business.manage'), addCredit(this.o.db, this.ctx(), i)),
    updateCredit: async (id: string, p: Parameters<typeof updateCredit>[3]): Promise<Credit> => (await this.need('business.manage'), updateCredit(this.o.db, this.ctx(), id, p)),
    addRights: async (i: Parameters<typeof addRights>[2]): Promise<Rights> => (await this.need('business.manage'), addRights(this.o.db, this.ctx(), i)),
    updateRights: async (id: string, p: Parameters<typeof updateRights>[3]): Promise<Rights> => (await this.need('business.manage'), updateRights(this.o.db, this.ctx(), id, p)),
    addShare: async (i: Parameters<typeof addShare>[2]): Promise<RevenueShare> => (await this.need('business.manage'), addShare(this.o.db, this.ctx(), i)),
    updateShare: async (id: string, p: Parameters<typeof updateShare>[3]): Promise<RevenueShare> => (await this.need('business.manage'), updateShare(this.o.db, this.ctx(), id, p)),
    archive: async (kind: 'contribution' | 'credit' | 'rights' | 'share', id: string, archived = true): Promise<void> => (await this.need('business.manage'), setBusinessArchived(this.o.db, this.ctx(), kind, id, archived))
  };

  /**
   * The assistant (MCP) acting for this person. `note` leaves the audit row saying a change was made through it, written here, on the side that
   * holds the records, so a Studio whose records are on a server needs no database in the assistant's own process. Needs assistant.use, on any project or the Studio.
   */
  readonly assistant = {
    /** Whether the assistant may be used at all: the person's role holds assistant.use (on any project or the Studio) and the Studio has not turned it off. */
    check: async (): Promise<void> => {
      await this.needWork('assistant.use'); // held anywhere: a role given on one project counts, as it does for the tools themselves
      if (!(await getPolicy(this.o.db, this.o.studioId)).assistantEnabled) throw new PermissionDenied('assistant.use', 'the Studio’s administrators have turned the assistant off');
    },
    note: async (tool: string, agent: string, target: string): Promise<void> => {
      await this.assistant.check();
      await this.o.db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [this.stamp(), this.personId, 'assistant', String(target).slice(0, 200), JSON.stringify({ tool: String(tool).slice(0, 80), agent: String(agent).slice(0, 80) })]);
    }
  };

  /**
   * Canon, the series' agreed facts (docs/M4-PLAN.md). A series is the top project of a book's path (a book that has no parent is its own series), and
   * its canon is read by everyone who may read canon on the series or on any book in it. Proposing a change needs canon.propose the same way;
   * approving or rejecting one needs canon.approve on the series itself. Nothing becomes canon except through an approved proposal, and a person
   * with canon.approve who changes canon makes a proposal and approves it in one step (`apply`), so the record reads the same either way.
   */
  readonly canon = {
    /** The series a project belongs to, and its name. */
    seriesOf: async (projectId: string): Promise<{ seriesId: string; name: string }> => {
      const { id, name } = await this.seriesFor(projectId);
      return { seriesId: id, name };
    },
    listEntries: async (f: EntryFilter & { projectId: string }): Promise<CanonEntry[]> => {
      const series = await this.canonSeries(f?.projectId, 'canon.read');
      return listEntries(this.o.db, this.ctx(), { ...f, projectId: series });
    },
    getEntry: async (id: string): Promise<CanonEntry | null> => {
      const e = await getEntry(this.o.db, this.ctx(), id);
      if (!e) return null;
      await this.canonSeries(e.projectId, 'canon.read');
      return e;
    },
    entryVersions: async (id: string): Promise<CanonEntryVersion[]> => {
      const e = await getEntry(this.o.db, this.ctx(), id);
      if (!e) throw new Error('That entry is not there.');
      await this.canonSeries(e.projectId, 'canon.read');
      return entryVersions(this.o.db, this.ctx(), id);
    },
    listFacts: async (f: FactFilter & { projectId: string }): Promise<CanonFact[]> => {
      const series = await this.canonSeries(f?.projectId, 'canon.read');
      return listFacts(this.o.db, this.ctx(), { ...f, projectId: series });
    },
    getFact: async (id: string): Promise<CanonFact | null> => {
      const f = await getFact(this.o.db, this.ctx(), id);
      if (!f) return null;
      await this.canonSeries(f.projectId, 'canon.read');
      return f;
    },
    /** The time of the series' last canon change: what a check made now would be pinned to. */
    stamp: async (projectId: string): Promise<string> => canonStamp(this.o.db, this.ctx(), await this.canonSeries(projectId, 'canon.read')),
    listProposals: async (f: ProposalFilter & { projectId: string }): Promise<CanonProposal[]> => {
      const series = await this.canonSeries(f?.projectId, 'canon.read');
      return listProposals(this.o.db, this.ctx(), { ...f, projectId: series });
    },
    /** Every open proposal in the series this person may approve: what waits on them. */
    waitingForMe: async (): Promise<CanonProposal[]> => {
      const tree = await this.o.projects?.();
      if (!tree) return [];
      const open = await listProposals(this.o.db, this.ctx(), { state: 'open' });
      const out: CanonProposal[] = [];
      for (const p of open) if (await this.holds('canon.approve', p.projectId)) out.push(p);
      return out;
    },
    getProposal: async (id: string): Promise<CanonProposal | null> => {
      const p = await getProposal(this.o.db, this.ctx(), id);
      if (!p) return null;
      await this.canonSeries(p.projectId, 'canon.read');
      return p;
    },
    propose: async (projectId: string, change: unknown): Promise<CanonProposal> => {
      const series = await this.canonSeries(projectId, 'canon.propose');
      return proposeChange(this.o.db, this.ctx(), series, change);
    },
    /** Someone who may approve changes canon: proposed and approved in one step. */
    apply: async (projectId: string, change: unknown): Promise<CanonProposal> => {
      const series = await this.seriesFor(projectId);
      await this.needWork('canon.approve', series.id);
      const p = await proposeChange(this.o.db, this.ctx(), series.id, change);
      return decideProposal(this.o.db, this.ctx(), p.id, { approve: true });
    },
    approve: async (id: string): Promise<CanonProposal> => {
      const p = await this.proposalToDecide(id);
      return decideProposal(this.o.db, this.ctx(), p.id, { approve: true });
    },
    reject: async (id: string, reason: string): Promise<CanonProposal> => {
      const p = await this.proposalToDecide(id);
      return decideProposal(this.o.db, this.ctx(), p.id, { approve: false, reason });
    },
    /** The person who proposed it takes it back, or someone who may approve does. */
    withdraw: async (id: string): Promise<CanonProposal> => {
      const p = await getProposal(this.o.db, this.ctx(), id);
      if (!p) throw new Error('That proposal is not there.');
      await this.canonSeries(p.projectId, 'canon.propose');
      if (p.proposedBy !== this.personId) await this.needWork('canon.approve', p.projectId);
      return withdrawProposal(this.o.db, this.ctx(), id);
    }
  };
  /**
   * Continuity checks: one book's manuscript, at an exact version, read against the series' canon. Starting a check, raising findings and
   * delivering it need canon.propose on the book (and only the person who started it, or someone who may approve canon, raises or delivers).
   * Deciding a finding, closing a check and re-checking a later version need the right to change the manuscript (manuscript.write) on the book, or
   * canon.approve on the series. Every read needs canon.read on the book.
   */
  readonly continuity = {
    start: async (i: { projectId: string; fileId: string; fileVersion?: number }): Promise<ContinuityCheck> => {
      await this.mustReach(i?.projectId, 'canon.read');
      await this.needPropose(i?.projectId);
      const series = await this.seriesFor(i.projectId);
      await this.mustHoldFileIn(i.fileId, i.projectId);
      return startCheck(this.o.db, this.ctx(), { projectId: i.projectId, seriesId: series.id, fileId: i.fileId, ...(i.fileVersion ? { fileVersion: i.fileVersion } : {}) });
    },
    list: async (f: CheckFilter = {}): Promise<ContinuityCheck[]> => {
      await this.needWork('canon.read');
      const reach = await this.reach('canon.read');
      return (await listChecks(this.o.db, this.ctx(), f)).filter((k) => !reach || reach(k.projectId));
    },
    get: async (id: string): Promise<ContinuityCheck | null> => {
      await this.needWork('canon.read');
      const k = await getCheck(this.o.db, this.ctx(), id);
      const reach = await this.reach('canon.read');
      return k && (!reach || reach(k.projectId)) ? k : null;
    },
    findings: async (f: FindingFilter = {}): Promise<ContinuityFinding[]> => {
      await this.needWork('canon.read');
      const reach = await this.reach('canon.read');
      const all = await listFindings(this.o.db, this.ctx(), f);
      if (!reach) return all;
      const ok = new Set((await listChecks(this.o.db, this.ctx(), {})).filter((k) => reach(k.projectId)).map((k) => k.id));
      return all.filter((x) => ok.has(x.checkId));
    },
    counts: async (checkIds: string[]): Promise<Record<string, FindingCounts>> => {
      await this.needWork('canon.read');
      const reach = await this.reach('canon.read');
      const ok = reach ? (await listChecks(this.o.db, this.ctx(), {})).filter((k) => reach(k.projectId)).map((k) => k.id) : checkIds;
      return findingCounts(this.o.db, this.ctx(), checkIds.filter((id) => ok.includes(id)));
    },
    raise: async (checkId: string, items: NewFinding[]): Promise<{ raised: ContinuityFinding[]; skipped: { index: number; why: string }[] }> => {
      await this.finderOf(await this.checkToRead(checkId));
      return raiseFindings(this.o.db, this.ctx(), checkId, items);
    },
    deliver: async (checkId: string): Promise<ContinuityCheck> => {
      await this.finderOf(await this.checkToRead(checkId));
      return deliverCheck(this.o.db, this.ctx(), checkId);
    },
    decide: async (findingId: string, d: FindingDecision): Promise<{ finding: ContinuityFinding; proposal: CanonProposal | null }> => {
      const f = await getFinding(this.o.db, this.ctx(), findingId);
      if (!f) throw new Error('That finding is not there.');
      const k = await this.checkToRead(f.checkId);
      await this.deciderOf(k);
      if (d?.outcome === 'accept_as_canon') await this.needPropose(k.projectId);
      return decideFinding(this.o.db, this.ctx(), findingId, d);
    },
    close: async (checkId: string): Promise<ContinuityCheck> => {
      await this.deciderOf(await this.checkToRead(checkId));
      return closeCheck(this.o.db, this.ctx(), checkId);
    },
    /** A later version of the manuscript, with its text (the records hold none): findings whose passage is gone from it are fixed. */
    verify: async (checkId: string, v: { version: number; text: string }): Promise<{ fixed: ContinuityFinding[]; remaining: ContinuityFinding[] }> => {
      await this.deciderOf(await this.checkToRead(checkId));
      return verifyFindings(this.o.db, this.ctx(), checkId, v);
    }
  };


  /**
   * Assets: art, covers and other design files, governed. Reading needs asset.read on the project; uploading a version as an asset, adding uses,
   * submitting a concept and proposing a replacement need asset.write; commenting needs asset.comment; approving or revoking a version, deciding a
   * replacement and choosing a concept need asset.approve; licences and retiring need asset.manage. Nothing is approved except an exact version.
   */
  readonly assets = {
    list: async (f: AssetFilter = {}): Promise<Asset[]> => {
      await this.needWork('asset.read');
      const reach = await this.reach('asset.read');
      return (await listAssets(this.o.db, this.ctx(), f)).filter((a) => !reach || reach(a.projectId));
    },
    get: async (id: string): Promise<Asset | null> => {
      await this.needWork('asset.read');
      const a = await getAsset(this.o.db, this.ctx(), id);
      const reach = await this.reach('asset.read');
      return a && (!reach || reach(a.projectId)) ? a : null;
    },
    /** The asset a vault file is, if it is one. */
    ofFile: async (fileId: string): Promise<Asset | null> => {
      await this.needWork('asset.read');
      const a = await assetOfFile(this.o.db, this.ctx(), fileId);
      const reach = await this.reach('asset.read');
      return a && (!reach || reach(a.projectId)) ? a : null;
    },
    create: async (i: NewAsset): Promise<Asset> => {
      await this.mustReach(i?.projectId, 'asset.read');
      await this.needWork('asset.write', i?.projectId);
      if (i.licence) await this.needWork('asset.manage', i.projectId);
      await this.mustHoldFileIn(i.fileId, i.projectId);
      return createAsset(this.o.db, this.ctx(), i);
    },
    update: async (id: string, i: { name?: string; channel?: string; licence?: LicenceInput }): Promise<Asset> => {
      const a = await this.assetToRead(id);
      await this.needWork(i?.licence ? 'asset.manage' : 'asset.write', a.projectId);
      return updateAsset(this.o.db, this.ctx(), id, i);
    },
    submit: async (id: string): Promise<Asset> => {
      const a = await this.assetToRead(id);
      await this.needWork('asset.write', a.projectId);
      return submitForReview(this.o.db, this.ctx(), id);
    },
    retire: async (id: string, reason: string): Promise<Asset> => {
      const a = await this.assetToRead(id);
      await this.needWork('asset.manage', a.projectId);
      return retireAsset(this.o.db, this.ctx(), id, reason);
    },
    approvals: async (id: string): Promise<AssetApproval[]> => {
      const a = await this.assetToRead(id);
      return approvalsOf(this.o.db, this.ctx(), a.id);
    },
    /** The versions that stand approved now. */
    approved: async (id: string): Promise<AssetApproval[]> => {
      const a = await this.assetToRead(id);
      return approvedVersions(await approvalsOf(this.o.db, this.ctx(), a.id));
    },
    approve: async (id: string, version: number, note?: string): Promise<AssetApproval> => {
      const a = await this.assetToRead(id);
      await this.needWork('asset.approve', a.projectId);
      return approveVersion(this.o.db, this.ctx(), id, version, note);
    },
    revoke: async (id: string, version: number, reason: string): Promise<AssetApproval> => {
      const a = await this.assetToRead(id);
      await this.needWork('asset.approve', a.projectId);
      return revokeApproval(this.o.db, this.ctx(), id, version, reason);
    },
    uses: async (id: string): Promise<AssetUse[]> => usesOf(this.o.db, this.ctx(), (await this.assetToRead(id)).id),
    whereUsed: async (id: string): Promise<AssetWhereUsed> => assetWhereUsed(this.o.db, this.ctx(), (await this.assetToRead(id)).id),
    addUse: async (id: string, i: { kind: UseKind; label: string; ref?: string; version?: number | null; note?: string }): Promise<AssetUse> => {
      const a = await this.assetToRead(id);
      await this.needWork('asset.write', a.projectId);
      return addUse(this.o.db, this.ctx(), id, i);
    },
    setUseState: async (useId: string, state: 'current' | 'done'): Promise<AssetUse> => {
      const u = await this.o.db.first<{ assetId: string }>('SELECT asset_id AS assetId FROM asset_use WHERE id = ? AND studio_id = ?', [useId, this.o.studioId]);
      if (!u) throw new Error('That use is not there.');
      const a = await this.assetToRead(u.assetId);
      await this.needWork('asset.write', a.projectId);
      return setUseState(this.o.db, this.ctx(), useId, state);
    },
    replacements: async (id: string): Promise<AssetReplacement[]> => replacementsOf(this.o.db, this.ctx(), (await this.assetToRead(id)).id),
    proposeReplacement: async (id: string, i: { fromVersion: number; toVersion: number; reason: string }): Promise<AssetReplacement> => {
      const a = await this.assetToRead(id);
      await this.needWork('asset.write', a.projectId);
      return proposeReplacement(this.o.db, this.ctx(), id, i);
    },
    decideReplacement: async (id: string, d: { approve: boolean; reason?: string }): Promise<{ replacement: AssetReplacement; needUpdate: AssetUse[] }> => {
      const r = await getReplacement(this.o.db, this.ctx(), id);
      if (!r) throw new Error('That replacement is not there.');
      const a = await this.assetToRead(r.assetId);
      await this.needWork('asset.approve', a.projectId);
      return decideReplacement(this.o.db, this.ctx(), id, d);
    },
    withdrawReplacement: async (id: string): Promise<AssetReplacement> => {
      const r = await getReplacement(this.o.db, this.ctx(), id);
      if (!r) throw new Error('That replacement is not there.');
      const a = await this.assetToRead(r.assetId);
      if (r.proposedBy !== this.personId) await this.needWork('asset.approve', a.projectId);
      else await this.needWork('asset.write', a.projectId);
      return withdrawReplacement(this.o.db, this.ctx(), id);
    },
    concepts: async (briefId: string): Promise<Concept[]> => {
      const b = await this.briefToRead(briefId);
      await this.needWork('asset.read', b.projectId);
      return conceptsOf(this.o.db, this.ctx(), b.id);
    },
    submitConcept: async (i: { briefId: string; briefVersion?: number; fileId: string; fileVersion?: number; note?: string }): Promise<Concept> => {
      const b = await this.briefToRead(i?.briefId);
      await this.needWork('asset.write', b.projectId);
      await this.mustHoldFileIn(i.fileId, b.projectId);
      return submitConcept(this.o.db, this.ctx(), i);
    },
    decideConcept: async (id: string, state: 'shortlisted' | 'rejected', note?: string): Promise<Concept> => {
      const k = await this.conceptToRead(id);
      await this.needWork('asset.approve', k.projectId);
      return decideConcept(this.o.db, this.ctx(), id, state, note);
    },
    chooseConcept: async (id: string): Promise<{ concept: Concept; asset: Asset }> => {
      const k = await this.conceptToRead(id);
      await this.needWork('asset.approve', k.projectId);
      return chooseConcept(this.o.db, this.ctx(), id);
    },
    feedback: async (targetKind: 'asset' | 'concept', targetId: string): Promise<Feedback[]> => {
      if (targetKind === 'asset') await this.assetToRead(targetId);
      else await this.conceptToRead(targetId);
      return feedbackOf(this.o.db, this.ctx(), targetKind, targetId);
    },
    comment: async (i: { targetKind: 'asset' | 'concept'; targetId: string; fileVersion?: number; region?: Region | null; body: string }): Promise<Feedback> => {
      const project = i?.targetKind === 'asset' ? (await this.assetToRead(i.targetId)).projectId : (await this.conceptToRead(i?.targetId)).projectId;
      await this.needWork('asset.comment', project);
      return addFeedback(this.o.db, this.ctx(), i);
    },
    resolveFeedback: async (id: string): Promise<Feedback> => {
      const f = await this.o.db.first<{ projectId: string; by: string }>('SELECT project_id AS projectId, by FROM asset_feedback WHERE id = ? AND studio_id = ?', [id, this.o.studioId]);
      if (!f) throw new Error('That feedback is not there.');
      await this.mustReach(f.projectId, 'asset.read');
      await this.needWork('asset.read', f.projectId);
      if (f.by !== this.personId) await this.needWork('asset.write', f.projectId);
      return resolveFeedback(this.o.db, this.ctx(), id);
    },
    /**
     * What Launch reads: the approved assets of a kind in a project and everything in it (with each one's approved version), and the newest
     * Preflight run of the project's editions, if this person may read it. The two facts a release plan needs, from records.
     */
    readiness: async (projectId: string, kind: AssetKind = 'cover'): Promise<{ assets: ApprovedAsset[]; preflight: PreflightRun | null }> => {
      await this.mustReach(projectId, 'asset.read');
      await this.needWork('asset.read', projectId);
      const ids = await this.subtree(projectId);
      const assets = await approvedAssets(this.o.db, this.ctx(), ids, kind);
      let preflight: PreflightRun | null = null;
      try {
        await this.needWork('preflight.read', projectId);
        preflight = await latestRun(this.o.db, this.ctx(), { projectIds: ids });
      } catch {
        preflight = null;
      }
      return { assets, preflight };
    }
  };

  /**
   * Preflight: graded checks of an EPUB before it is uploaded. The checking happens on the computer that has the file; the service keeps the run
   * and its results. Reading needs preflight.read on the project; recording a run and waiving a result need preflight.run.
   */
  readonly preflight = {
    list: async (f: RunFilter = {}): Promise<PreflightRun[]> => {
      await this.needWork('preflight.read');
      const reach = await this.reach('preflight.read');
      return (await listRuns(this.o.db, this.ctx(), f)).filter((r) => !reach || reach(r.projectId));
    },
    get: async (id: string): Promise<{ run: PreflightRun; results: PreflightResult[] } | null> => {
      await this.needWork('preflight.read');
      const g = await getRun(this.o.db, this.ctx(), id);
      const reach = await this.reach('preflight.read');
      return g && (!reach || reach(g.run.projectId)) ? g : null;
    },
    latest: async (f: { editionId?: string; fileId?: string; projectId?: string }): Promise<PreflightRun | null> => {
      await this.needWork('preflight.read');
      const reach = await this.reach('preflight.read');
      const run = await latestRun(this.o.db, this.ctx(), { ...(f.editionId ? { editionId: f.editionId } : {}), ...(f.fileId ? { fileId: f.fileId } : {}), ...(f.projectId ? { projectIds: await this.subtree(f.projectId) } : {}) });
      return run && (!reach || reach(run.projectId)) ? run : null;
    },
    record: async (i: NewRun): Promise<{ run: PreflightRun; results: PreflightResult[] }> => {
      await this.mustReach(i?.projectId, 'preflight.read');
      await this.needWork('preflight.run', i?.projectId);
      await this.mustHoldFileIn(i.fileId, i.projectId);
      return recordRun(this.o.db, this.ctx(), i);
    },
    waive: async (runId: string, seq: number, reason: string): Promise<{ run: PreflightRun; results: PreflightResult[] }> => {
      const g = await getRun(this.o.db, this.ctx(), runId);
      if (!g) throw new Error('That run is not there.');
      await this.mustReach(g.run.projectId, 'preflight.read');
      await this.needWork('preflight.run', g.run.projectId);
      return waiveResult(this.o.db, this.ctx(), runId, seq, reason);
    }
  };

  /**
   * The Studio's security policy (docs/PERMISSIONS.md §5). Anyone in the Studio may read it (the app needs the stale check-out warning and the
   * assistant switch); changing it needs studio.settings, and every change leaves an audit row.
   */
  readonly policy = {
    get: async (): Promise<StudioPolicy> => getPolicy(this.o.db, this.o.studioId),
    set: async (change: PolicyChange): Promise<StudioPolicy> => {
      await this.need('studio.settings');
      return setPolicy(this.o.db, { studioId: this.o.studioId, actor: this.personId, now: this.stamp(), change });
    }
  };

  /**
   * What the books earned, for the people who wrote them. The publisher's Cadrel publishes each book's months (needs royalties.manage); reading
   * is by book. Everyone who may manage royalties, and the roles that read them and edit the catalogue (Admin, Director), read every book; anyone
   * else with royalties.read (an Author) reads the books they are credited on as author or co-author, and only those. Every read is logged.
   */
  readonly finance = {
    publish: async (input: { asin: string; title?: string; months: PublishedMonth[] }): Promise<{ asin: string; months: number }> => {
      await this.need('royalties.manage');
      return publishBookFinance(this.o.db, this.ctx(), input);
    },
    /** The books this person may see figures for, with the months published for each. */
    books: async (): Promise<BookFinanceSummary[]> => {
      const asins = await this.financeBooks();
      return listBookFinance(this.o.db, this.o.studioId, asins);
    },
    /** Every published month of one book (oldest first), if this person may see that book. */
    book: async (asin: string): Promise<PublishedMonth[]> => {
      const a = String(asin ?? '').trim().toUpperCase();
      const asins = await this.financeBooks();
      if (asins && !asins.includes(a)) throw new PermissionDenied('royalties.read', 'you may see the figures of the books you wrote');
      await this.o.db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [this.stamp(), this.personId, 'read.royalties', a, '{}']);
      return bookFinanceMonths(this.o.db, this.o.studioId, a);
    }
  };

  /** The books whose figures this person may see: null for every book, else the ASINs of the books they wrote. */
  private async financeBooks(): Promise<string[] | null> {
    if (await this.can('royalties.manage')) return null;
    await this.need('royalties.read');
    if (await this.can('catalogue.edit')) return null;
    return ownedAsins(this.o.db, this.o.studioId, this.personId);
  }

  /** A read of business data: needs business.read, and leaves a row in the audit log saying who looked at what. */
  private async seen(what: string, subject?: Subject): Promise<void> {
    await this.need('business.read');
    if (AUDITED_READS.has('business.read')) {
      await this.o.db.run('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [this.stamp(), this.personId, 'read.business', subject ? `${subject.kind}:${subject.id}` : '*', JSON.stringify({ what })]);
    }
  }

  /**
   * Tasks, deadlines, approvals and decisions. Reading needs task.read. A task can be made and changed by someone with task.edit for work that is
   * theirs (assigned to them, or not yet to anyone when they make it); handing work to someone else needs task.assign; task.manage reaches
   * everything. An approval is requested by anyone with task.edit and answered only by the people it names (no capability makes you one of
   * them); it is withdrawn by whoever asked, or by task.manage. Decisions are recorded with task.edit and can never be changed or removed.
   * Projects live in the project tree, so the caller checks a project exists and expands a project to its subprojects.
   */
  /** Whether this person holds a capability on a project (a role given there or above it counts), or, with no project, anywhere at all. */
  async canOn(capability: string, projectId?: string | null): Promise<boolean> {
    try {
      await this.needWork(capability, projectId);
      return true;
    } catch (e) {
      if (e instanceof PermissionDenied) return false;
      throw e;
    }
  }

  /** Whether this person holds a capability at the studio (no project) or on one project (a role given there or above it counts). Without a project tree it is the studio. */
  async canAt(capability: string, projectId?: string | null): Promise<boolean> {
    const tree = projectId ? await this.o.projects?.() : null;
    const path = tree && projectId ? this.projectPath(tree, projectId) : this.studioPath();
    return explain(await this.context(), capability, { path }).allowed;
  }

  /**
   * `canAt` for many files at once: the project tree and the permission context are loaded once, and each (capability, project) is decided once.
   * Calling `canAt` per file read the tree from the database and rebuilt the context every time, which made listing a vault of a few hundred
   * files exceed the Worker's CPU limit. The answer is as of the moment this is called.
   */
  async checkerAt(): Promise<(capability: string, projectId?: string | null) => boolean> {
    const tree = (await this.o.projects?.()) ?? null;
    const ctx = await this.context();
    const decided = new Map<string, boolean>();
    return (capability, projectId) => {
      const key = `${capability}\u0000${projectId ?? ''}`;
      let allowed = decided.get(key);
      if (allowed === undefined) {
        const path = tree && projectId ? this.projectPath(tree, projectId) : this.studioPath();
        allowed = explain(ctx, capability, { path }).allowed;
        decided.set(key, allowed);
      }
      return allowed;
    };
  }

  // ---- canon: which series, and who may ----------------------------------------------------------------------------------

  /** The series a project belongs to: the top project of its path, or the project itself if it has no parent. */
  private async seriesFor(projectId: string): Promise<{ id: string; name: string }> {
    const tree = await this.o.projects?.();
    if (!tree) throw new Error('Canon needs the Studio’s projects, and they are not available here.');
    const p = typeof projectId === 'string' ? getProject(tree, projectId) : null;
    if (!p) throw new Error('There is no such project.');
    const root = ancestorsOf(tree, p.id)[0] ?? p;
    return { id: root.id, name: root.name };
  }
  /** Whether this person holds a capability on the series, or (for what a book's people may do) on any project in it. */
  private async holds(capability: string, seriesId: string, viaBook = false): Promise<boolean> {
    const tree = await this.o.projects?.();
    if (!tree || (await this.visibleProjects(tree)).all) {
      try {
        await this.need(capability);
        return true;
      } catch {
        return false;
      }
    }
    const ctx = await this.context();
    const ids = viaBook ? subtreeIds(tree, seriesId) : [seriesId];
    return ids.some((id) => explain(ctx, capability, { path: this.projectPath(tree, id) }).allowed);
  }
  /** Resolves a project to its series and checks the person may read or propose canon there (on the series, or on any book in it). */
  private async canonSeries(projectId: string, capability: 'canon.read' | 'canon.propose'): Promise<string> {
    const series = await this.seriesFor(projectId);
    // whoever may approve canon may of course propose it
    if (!(await this.holds(capability, series.id, true)) && !(capability === 'canon.propose' && (await this.holds('canon.approve', series.id)))) {
      const d = explain(await this.context(), capability, { path: [{ kind: 'studio', id: this.o.studioId }] });
      throw new PermissionDenied(capability, d.reason);
    }
    return series.id;
  }
  /** canon.propose on a project, or canon.approve (whoever approves canon may also propose and run checks). */
  private async needPropose(projectId: string): Promise<void> {
    try {
      await this.needWork('canon.propose', projectId);
    } catch (e) {
      if (!(e instanceof PermissionDenied)) throw e;
      await this.needWork('canon.approve', projectId);
    }
  }
  private async proposalToDecide(id: string): Promise<CanonProposal> {
    const p = await getProposal(this.o.db, this.ctx(), id);
    if (!p) throw new Error('That proposal is not there.');
    await this.canonSeries(p.projectId, 'canon.read');
    await this.needWork('canon.approve', p.projectId);
    return p;
  }
  private async checkToRead(id: string): Promise<ContinuityCheck> {
    await this.needWork('canon.read');
    const k = await getCheck(this.o.db, this.ctx(), id);
    const reach = await this.reach('canon.read');
    if (!k || (reach && !reach(k.projectId))) throw new Error('That check is not there.');
    return k;
  }
  /** Whoever started a check raises its findings and delivers it; someone who may approve canon can do so for them. */
  private async finderOf(k: ContinuityCheck): Promise<void> {
    if (k.runBy === this.personId) return this.needPropose(k.projectId);
    await this.needWork('canon.approve', k.seriesId);
  }
  /** The people who may change the manuscript decide what is wrong with it; so may whoever approves canon. */
  private async deciderOf(k: ContinuityCheck): Promise<void> {
    try {
      await this.needWork('manuscript.write', k.projectId);
    } catch (e) {
      if (!(e instanceof PermissionDenied)) throw e;
      await this.needWork('canon.approve', k.seriesId);
    }
  }
  /** A manuscript file checked is one of the book's own (its data card names a project in the book), when the card names one at all. */
  private async mustHoldFileIn(fileId: string, projectId: string): Promise<void> {
    const tree = await this.o.projects?.();
    const card = await this.o.db.first<{ projectId: string | null }>('SELECT project_id AS projectId FROM file_card WHERE file_id = ?', [fileId]);
    if (tree && card?.projectId && !subtreeIds(tree, projectId).includes(card.projectId)) throw new Error('That file belongs to another book.');
  }

  /** The path to a project in the permission check: the studio, the projects above it, and it. */
  private projectPath(tree: ProjectTree, projectId: string): ScopeRef[] {
    return [...this.studioPath(), ...ancestorsOf(tree, projectId).map((p) => ({ kind: 'project' as const, id: p.id })), { kind: 'project', id: projectId }];
  }
  /**
   * The check for a task, sign-off or decision. A role given on a project holds there, not at the whole studio, so the capability is looked for on
   * the project the record is on; for a list (no project in particular) it is enough to hold it anywhere. Whoever sees every project is checked
   * at the studio, as before. Without a project tree to go by it is always the studio.
   */
  private async needWork(capability: string, projectId?: string | null): Promise<void> {
    const tree = await this.o.projects?.();
    if (!tree || (await this.visibleProjects(tree)).all) return this.need(capability);
    const ctx = await this.context();
    if (projectId) {
      const d = explain(ctx, capability, { path: this.projectPath(tree, projectId) });
      if (!d.allowed) throw new PermissionDenied(capability, d.reason);
      return;
    }
    const held = ctx.assignments.some((a) => {
      if (a.expiresAt && a.expiresAt <= ctx.now) return false;
      const mine = (a.subject.kind === 'person' && a.subject.id === this.personId) || (a.subject.kind === 'team' && ctx.actor.teamIds.includes(a.subject.id));
      const role = ctx.roles.get(a.roleId);
      return mine && !!role && (role.all === true || role.capabilities.includes(capability));
    });
    if (!held) throw new PermissionDenied(capability, `no active role grants ${capability} here`);
  }
  /**
   * Which projects' records this person may reach with `capability`: those they are assigned to and hold it on. Null when everything is theirs
   * (they see every project, or there is no tree to go by). A project shown to them only as the container of a Book they are on is not theirs.
   */
  private async reach(capability = 'task.read'): Promise<((projectId: string | null | undefined) => boolean) | null> {
    const tree = await this.o.projects?.();
    if (!tree) return null;
    const v = await this.visibleProjects(tree);
    if (v.all) return null;
    const ctx = await this.context();
    const ok = new Set([...v.assigned].filter((id) => explain(ctx, capability, { path: this.projectPath(tree, id) }).allowed));
    return (projectId) => !!projectId && ok.has(projectId);
  }
  private async mustReach(projectId: string | null | undefined, capability = 'task.read'): Promise<void> {
    const reach = await this.reach(capability);
    if (reach && !reach(projectId)) throw new Error('There is no such project.');
  }
  /** Whether `personId` is assigned to the project (so work may be given to them): by a role on it or above it, or by holding every project. */
  private async assignedTo(personId: string, projectId: string): Promise<boolean> {
    const tree = await this.o.projects?.();
    if (!tree) return true;
    const v = await new StudioAs(this.o, personId).visibleProjects(tree);
    return v.all || v.assigned.has(projectId);
  }
  private async mustBeAssigned(personIds: (string | null | undefined)[], projectId: string, what: string): Promise<void> {
    for (const id of personIds) {
      if (!id || (await this.assignedTo(id, projectId))) continue;
      const who = (await getPerson(this.o.db, this.ctx(), id).catch(() => null))?.name ?? 'That person';
      throw new Error(`${who} is not assigned to this project, so ${what} cannot go to them. Give them a role on the project first (on its page, under People).`);
    }
  }
  /** The active people work on this project may be given to: those assigned to it (and the Owner and Admin, who hold every project). */
  private async assignable(projectId: string): Promise<{ id: string; name: string }[]> {
    const people = await listPeople(this.o.db, this.ctx());
    const out: { id: string; name: string }[] = [];
    for (const p of people) if (await this.assignedTo(p.id, projectId)) out.push({ id: p.id, name: p.name });
    return out;
  }

  readonly work = {
    tasks: async (f?: TaskFilter): Promise<TaskRecord[]> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return (await listTasks(this.o.db, this.ctx(), f)).filter((t) => !reach || reach(t.projectId));
    },
    task: async (id: string): Promise<TaskRecord | null> => {
      await this.needWork('task.read');
      const t = await getTask(this.o.db, this.ctx(), id);
      const reach = await this.reach();
      return t && (!reach || reach(t.projectId)) ? t : null;
    },
    openTaskCount: async (projectIds: string[]): Promise<number> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return openTaskCount(this.o.db, this.ctx(), reach ? projectIds.filter((p) => reach(p)) : projectIds);
    },
    createTask: async (i: NewTask): Promise<TaskRecord> => {
      await this.mustReach(i?.projectId, 'task.read');
      await this.needWork(i?.assigneeId && i.assigneeId !== this.personId ? 'task.assign' : 'task.edit', i?.projectId);
      await this.mustBeAssigned([i?.assigneeId], i.projectId, 'a task');
      return createTask(this.o.db, this.ctx(), i);
    },
    updateTask: async (id: string, patch: TaskPatch): Promise<TaskRecord> => {
      const t = await this.mineToChange(id);
      if (patch?.assigneeId !== undefined && (patch.assigneeId || null) !== t.assigneeId) {
        if (patch.assigneeId !== this.personId) await this.needWork('task.assign', t.projectId);
        await this.mustBeAssigned([patch.assigneeId], t.projectId, 'a task');
      }
      return updateTask(this.o.db, this.ctx(), id, patch);
    },
    setState: async (id: string, state: TaskState): Promise<TaskRecord> => (await this.mineToChange(id), setTaskState(this.o.db, this.ctx(), id, state)),
    addDependency: async (id: string, dependsOnId: string): Promise<TaskRecord> => (await this.mineToChange(id), addDependency(this.o.db, this.ctx(), id, dependsOnId)),
    removeDependency: async (id: string, dependsOnId: string): Promise<TaskRecord> => (await this.mineToChange(id), removeDependency(this.o.db, this.ctx(), id, dependsOnId)),
    /** The people a task or sign-off on this project may be given to. */
    assignable: async (projectId: string): Promise<{ id: string; name: string }[]> => {
      await this.mustReach(projectId);
      await this.needWork('task.read', projectId);
      return this.assignable(projectId);
    },

    approvals: async (f?: { projectId?: string; projectIds?: string[]; approverId?: string; state?: ApprovalState | 'any' }): Promise<ApprovalRecord[]> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return (await listApprovals(this.o.db, this.ctx(), f)).filter((a) => !reach || reach(a.projectId));
    },
    /** The sign-offs waiting for this person's answer. */
    waitingForMe: async (): Promise<ApprovalRecord[]> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return (await approvalsWaitingFor(this.o.db, this.ctx(), this.personId)).filter((a) => !reach || reach(a.projectId));
    },
    /** What a workflow gate sees of editorial passes on these projects (a project and its subprojects). Needs task.read, like the other gate facts. */
    editorialFacts: async (projectIds: string[]): Promise<EditorialFacts> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return editorialFacts(this.o.db, this.ctx(), reach ? projectIds.filter((p) => reach(p)) : projectIds);
    },
    /** What a workflow gate sees of continuity checks on these projects (a project and its subprojects). Needs task.read, like the other gate facts. */
    continuityFacts: async (projectIds: string[]): Promise<ContinuityFacts> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return continuityFacts(this.o.db, this.ctx(), reach ? projectIds.filter((p) => reach(p)) : projectIds);
    },
    approvedLabels: async (projectId: string): Promise<string[]> => (await this.mustReach(projectId), await this.needWork('task.read', projectId), approvedLabels(this.o.db, this.ctx(), projectId)),
    requestApproval: async (i: NewApproval): Promise<ApprovalRecord> => {
      await this.mustReach(i?.projectId);
      await this.needWork('task.edit', i?.projectId);
      await this.mustBeAssigned(i?.approverIds ?? [], i.projectId, 'a sign-off');
      return requestApproval(this.o.db, this.ctx(), i);
    },
    respond: async (id: string, response: 'approved' | 'rejected', reason?: string): Promise<ApprovalRecord> => {
      const a = await getApproval(this.o.db, this.ctx(), id);
      if (a) await this.mustReach(a.projectId);
      await this.needWork('task.read', a?.projectId);
      return respondToApproval(this.o.db, this.ctx(), id, response, reason);
    },
    withdraw: async (id: string): Promise<ApprovalRecord> => {
      const a = await getApproval(this.o.db, this.ctx(), id);
      if (a) await this.mustReach(a.projectId);
      await this.needWork('task.read', a?.projectId);
      if (a && a.requestedBy !== this.personId) await this.needWork('task.manage', a.projectId);
      return withdrawApproval(this.o.db, this.ctx(), id);
    },

    decisions: async (f?: { projectId?: string; projectIds?: string[]; current?: boolean }): Promise<DecisionRecord[]> => {
      await this.needWork('task.read');
      const reach = await this.reach();
      return (await listDecisions(this.o.db, this.ctx(), f)).filter((d) => !reach || !d.projectId || reach(d.projectId));
    },
    decision: async (id: string): Promise<DecisionRecord | null> => {
      await this.needWork('task.read');
      const d = await getDecision(this.o.db, this.ctx(), id);
      const reach = await this.reach();
      return d && (!reach || !d.projectId || reach(d.projectId)) ? d : null;
    },
    record: async (i: Parameters<typeof recordDecision>[2]): Promise<DecisionRecord> => {
      if (i?.projectId) await this.mustReach(i.projectId);
      await this.needWork('task.edit', i?.projectId);
      return recordDecision(this.o.db, this.ctx(), i);
    }
  };

  /**
   * Briefs for a manuscript and for an edit. A manuscript brief is read with task.read and written with task.edit (the author and the people
   * running the book); an edit brief is read with edit.read and written with edit.assign (whoever assigns the editors). Both only on projects
   * this person can reach. A brief is never overwritten: a revision is a new version, and the one before stays readable.
   */
  readonly briefs = {
    list: async (f: BriefFilter = {}): Promise<BriefRecord[]> => {
      const all = await listBriefs(this.o.db, this.ctx(), f);
      const out: BriefRecord[] = [];
      for (const b of all) if (await this.mayReadBrief(b)) out.push(b);
      return out;
    },
    get: async (id: string): Promise<BriefRecord | null> => {
      const b = await getBrief(this.o.db, this.ctx(), id);
      return b && (await this.mayReadBrief(b)) ? b : null;
    },
    versions: async (id: string): Promise<BriefVersion[]> => {
      const b = await this.briefToRead(id);
      return briefVersions(this.o.db, this.ctx(), b.id);
    },
    create: async (i: NewBrief): Promise<BriefRecord> => {
      const cap = BRIEF_WRITE[i?.kind as BriefKind] ?? 'task.edit';
      await this.mustReach(i?.projectId, BRIEF_READ[i?.kind as BriefKind] ?? 'task.read');
      await this.needWork(cap, i.projectId);
      return createBrief(this.o.db, this.ctx(), i);
    },
    revise: async (id: string, i: { body: string; note?: string; title?: string; basedOn: number }): Promise<BriefRecord> => {
      const b = await this.briefToRead(id);
      await this.needWork(BRIEF_WRITE[b.kind], b.projectId);
      return reviseBrief(this.o.db, this.ctx(), id, i);
    }
  };
  /**
   * Editorial passes. Reading needs edit.read; planning a pass and choosing or changing its editor needs edit.assign (the editor must be
   * assigned to the project); starting and delivering needs edit.run, and only the pass's own editor may unless the person also holds
   * edit.assign; the author's answer needs edit.respond; closing a pass needs edit.approve; calling one off needs edit.assign.
   */
  readonly passes = {
    list: async (f: PassFilter = {}): Promise<PassRecord[]> => {
      await this.needWork('edit.read');
      const reach = await this.reach('edit.read');
      return (await listPasses(this.o.db, this.ctx(), f)).filter((p) => !reach || reach(p.projectId));
    },
    get: async (id: string): Promise<PassRecord | null> => {
      await this.needWork('edit.read');
      const p = await getPass(this.o.db, this.ctx(), id);
      const reach = await this.reach('edit.read');
      return p && (!reach || reach(p.projectId)) ? p : null;
    },
    create: async (i: NewPass): Promise<PassRecord> => {
      await this.mustReach(i?.projectId, 'edit.read');
      await this.needWork('edit.assign', i.projectId);
      await this.mustBeAssigned([i.editorId], i.projectId, 'an editorial pass');
      return createPass(this.o.db, this.ctx(), i);
    },
    assign: async (id: string, editorId: string): Promise<PassRecord> => {
      const p = await this.passToRead(id);
      await this.needWork('edit.assign', p.projectId);
      await this.mustBeAssigned([editorId], p.projectId, 'an editorial pass');
      return assignEditor(this.o.db, this.ctx(), id, editorId);
    },
    start: async (id: string): Promise<PassRecord> => this.movePassAs(id, 'in_progress'),
    deliver: async (id: string): Promise<PassRecord> => this.movePassAs(id, 'delivered'),
    respond: async (id: string): Promise<PassRecord> => this.movePassAs(id, 'responded'),
    close: async (id: string): Promise<PassRecord> => this.movePassAs(id, 'closed'),
    cancel: async (id: string): Promise<PassRecord> => this.movePassAs(id, 'cancelled')
  };
  /**
   * Queries, comments and suggestions inside a pass. Reading needs edit.read. Raising, resolving and withdrawing are the pass's editor's (edit.run;
   * someone with edit.assign may do it for them); the author's answer needs edit.respond. Only items of passes on projects this person can reach.
   */
  readonly queries = {
    list: async (f: QueryFilter = {}): Promise<QueryRecord[]> => {
      await this.needWork('edit.read');
      const reach = await this.reach('edit.read');
      const all = await listQueries(this.o.db, this.ctx(), f);
      if (!reach) return all;
      const ok = new Set((await listPasses(this.o.db, this.ctx(), { state: 'any' })).filter((p) => reach(p.projectId)).map((p) => p.id));
      return all.filter((q) => ok.has(q.passId));
    },
    counts: async (passIds: string[]): Promise<Record<string, QueryCounts>> => {
      await this.needWork('edit.read');
      const reach = await this.reach('edit.read');
      const ok = reach ? (await listPasses(this.o.db, this.ctx(), { state: 'any' })).filter((p) => reach(p.projectId)).map((p) => p.id) : passIds;
      return queryCounts(this.o.db, this.ctx(), passIds.filter((id) => ok.includes(id)));
    },
    raise: async (passId: string, items: NewQuery[]): Promise<QueryRecord[]> => {
      await this.editorOf(await this.passToRead(passId));
      return raiseQueries(this.o.db, this.ctx(), passId, items);
    },
    /** Cadrel Write's notes as items in this pass. Notes without a usable anchor are counted, not raised. */
    importNotes: async (passId: string, notes: Parameters<typeof queriesFromNotes>[0]): Promise<{ raised: QueryRecord[]; skipped: number }> => {
      await this.editorOf(await this.passToRead(passId));
      const { items, skipped } = queriesFromNotes(notes);
      return { raised: items.length ? await raiseQueries(this.o.db, this.ctx(), passId, items) : [], skipped };
    },
    /** The author accepts, rejects or defers an item (edit.respond). A deferral makes a task for the revisit and everything is entered in the decision ledger. */
    decide: async (id: string, i: NewEditDecision): Promise<EditDecisionRecord> => {
      const q = await this.queryToRead(id);
      await this.needWork('edit.respond', (await this.passToRead(q.passId)).projectId);
      return decideQuery(this.o.db, this.ctx(), id, i);
    },
    /** The decisions on a pass's items: the ones standing now, or with `history` every change of mind. */
    decisions: async (f: EditDecisionFilter = {}): Promise<EditDecisionRecord[]> => {
      await this.needWork('edit.read');
      const reach = await this.reach('edit.read');
      const all = await listEditDecisions(this.o.db, this.ctx(), f);
      if (!reach) return all;
      const ok = new Set((await listPasses(this.o.db, this.ctx(), { state: 'any' })).filter((p) => reach(p.projectId)).map((p) => p.id));
      const qs = new Map((await listQueries(this.o.db, this.ctx())).map((q) => [q.id, q.passId]));
      return all.filter((d) => ok.has(qs.get(d.queryId) ?? ''));
    },
    /**
     * Checks the changes the author accepted against the text of a later version (the pass's editor, edit.run). The caller supplies that text;
     * the records hold none. Replaces any earlier check against the same version.
     */
    verify: async (passId: string, input: { revisedVersion: number; revisedText: string }): Promise<VerificationRecord[]> => {
      await this.editorOf(await this.passToRead(passId));
      return verifyPass(this.o.db, this.ctx(), passId, input);
    },
    /** The last check of a pass (or of one revised version). */
    verification: async (passId: string, revisedVersion?: number): Promise<VerificationRecord[]> => {
      await this.passToRead(passId);
      return listVerification(this.o.db, this.ctx(), { passId, revisedVersion });
    },
    answer: async (id: string, response: string): Promise<QueryRecord> => {
      const q = await this.queryToRead(id);
      await this.needWork('edit.respond', (await this.passToRead(q.passId)).projectId);
      return answerQuery(this.o.db, this.ctx(), id, response);
    },
    resolve: async (id: string): Promise<QueryRecord> => {
      const q = await this.queryToRead(id);
      await this.editorOf(await this.passToRead(q.passId));
      return resolveQuery(this.o.db, this.ctx(), id);
    },
    withdraw: async (id: string): Promise<QueryRecord> => {
      const q = await this.queryToRead(id);
      await this.editorOf(await this.passToRead(q.passId));
      return withdrawQuery(this.o.db, this.ctx(), id);
    }
  };
  /** The pass's own editor with edit.run, or anyone with edit.run and edit.assign. */
  private async editorOf(p: PassRecord): Promise<void> {
    await this.needWork('edit.run', p.projectId);
    if (p.editorId !== this.personId) await this.needWork('edit.assign', p.projectId);
  }
  private async queryToRead(id: string): Promise<QueryRecord> {
    await this.needWork('edit.read');
    const q = await getQuery(this.o.db, this.ctx(), id);
    if (!q) throw new Error('That item is not there.');
    await this.passToRead(q.passId); // throws if its pass is not there for this person
    return q;
  }
  private async passToRead(id: string): Promise<PassRecord> {
    await this.needWork('edit.read');
    const p = await getPass(this.o.db, this.ctx(), id);
    const reach = await this.reach('edit.read');
    if (!p || (reach && !reach(p.projectId))) throw new Error('That pass is not there.');
    return p;
  }
  private async movePassAs(id: string, to: PassState): Promise<PassRecord> {
    const p = await this.passToRead(id);
    if (to === 'in_progress' || to === 'delivered') {
      await this.editorOf(p);
    } else await this.needWork(to === 'responded' ? 'edit.respond' : to === 'closed' ? 'edit.approve' : 'edit.assign', p.projectId);
    return movePass(this.o.db, this.ctx(), id, to);
  }

  private async assetToRead(id: string): Promise<Asset> {
    const a = await getAsset(this.o.db, this.ctx(), id);
    if (a) {
      try {
        await this.mustReach(a.projectId, 'asset.read');
        await this.needWork('asset.read', a.projectId);
        return a;
      } catch {
        /* falls through: it is not there for this person */
      }
    }
    throw new Error('That asset is not there.');
  }
  private async conceptToRead(id: string): Promise<Concept> {
    const k = await getConcept(this.o.db, this.ctx(), id);
    if (k) {
      try {
        await this.mustReach(k.projectId, 'asset.read');
        await this.needWork('asset.read', k.projectId);
        return k;
      } catch {
        /* falls through */
      }
    }
    throw new Error('That concept is not there.');
  }
  private async subtree(projectId: string): Promise<string[]> {
    const tree = await this.o.projects?.();
    return tree ? subtreeIds(tree, projectId) : [projectId];
  }

  private async mayReadBrief(b: BriefRecord): Promise<boolean> {
    try {
      await this.mustReach(b.projectId, BRIEF_READ[b.kind]);
      await this.needWork(BRIEF_READ[b.kind], b.projectId);
      return true;
    } catch {
      return false;
    }
  }
  private async briefToRead(id: string): Promise<BriefRecord> {
    const b = await getBrief(this.o.db, this.ctx(), id);
    if (!b || !(await this.mayReadBrief(b))) throw new Error('That brief is not there.');
    return b;
  }

  /** A task this person may change: any task for task.manage, else one assigned to them with task.edit. */
  private async mineToChange(id: string): Promise<TaskRecord> {
    const t = await getTask(this.o.db, this.ctx(), id);
    if (!t) throw new Error('That task is not there.');
    const reach = await this.reach();
    if (reach && !reach(t.projectId)) throw new Error('That task is not there.');
    await this.needWork('task.edit', t.projectId);
    if (t.assigneeId !== this.personId) await this.needWork('task.manage', t.projectId);
    return t;
  }

  /**
   * The workflow builder and the stage moves. Reading workflows needs task.read (anyone who sees tasks sees where work can go); building
   * needs workflow.design; moving a project needs project.stage, a move its workflow has, every gate condition met, and (if the gate names
   * roles) one of those roles held at the studio. Projects live in the project tree, so what a gate sees of a project (`facts`) and how many
   * projects use a workflow (`usage`) are passed in by the caller that holds the tree.
   */
  readonly workflows = {
    list: async (): Promise<WorkflowRecord[]> => (await this.need('task.read'), listWorkflows(this.o.db, this.ctx())),
    /** The workflow a new project (or a new subproject) starts in. */
    defaultFor: async (level: ProjectLevel): Promise<WorkflowRecord | null> => (await this.need('task.read'), defaultWorkflow(this.o.db, this.ctx(), level)),
    create: async (i: Parameters<typeof createWorkflow>[2]): Promise<WorkflowRecord> => (await this.need('workflow.design'), createWorkflow(this.o.db, this.ctx(), i)),
    save: async (id: string, draft: WorkflowDraft, usage?: WorkflowUsage): Promise<WorkflowRecord> => (await this.need('workflow.design'), saveWorkflow(this.o.db, this.ctx(), id, draft, usage)),
    setDefault: async (id: string, levels?: ProjectLevel[]): Promise<WorkflowRecord> => (await this.need('workflow.design'), setDefaultWorkflow(this.o.db, this.ctx(), id, levels)),
    delete: async (id: string, usage?: WorkflowUsage): Promise<void> => (await this.need('workflow.design'), deleteWorkflow(this.o.db, this.ctx(), id, usage)),

    /** Where a project in `current` can go, and for each move whether it is open to this person now and what is in the way. */
    stageOptions: async (workflowId: string, current: string | null, facts: ProjectFacts): Promise<{ workflow: WorkflowRecord; current: Stage | null; options: StageOption[] }> => {
      await this.need('task.read');
      const workflow = (await listWorkflows(this.o.db, this.ctx())).find((w) => w.id === workflowId);
      if (!workflow) throw new Error('That workflow is not there.');
      return { workflow, ...stageOptions(workflow, current, facts, await this.holdsRole()) };
    },
    /** Checks that this person may move a project from one stage to another (throws with every reason if not). The caller then changes the tree. */
    allowMove: async (workflowId: string, from: string | null, to: string, facts: ProjectFacts): Promise<void> => {
      await this.need('project.stage');
      const workflow = (await listWorkflows(this.o.db, this.ctx())).find((w) => w.id === workflowId);
      if (!workflow) throw new Error('That workflow is not there.');
      checkMove(workflow, from, to, facts, await this.holdsRole());
    }
  };
}
export { decodeError, decodeValue, encodeError, encodeValue, type WireError } from './wire';
