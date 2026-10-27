import { beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgeCapabilities, CAPABILITY_INFO, PeopleError, ROLE_KEYS, allCapabilities, bootstrapStudio, capabilityReview, createPenName, createPerson, createRole, createTeam, defaultRole, deleteRole, deleteTeam, ensureDefaultRoles,
  getRole, grantRole, listAssignments, listPeople, listPenNames, listRoles, listTeams, loadAccess, renameTeam, resetRole, revokeAssignment, setAssignmentExpiry, setPenNamePeople, setPersonActive,
  setTeamMember, updatePerson, updateRole, can, type Ctx
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ studioId: 's1', actor: 'owner1', now: '2026-10-27T10:00:00.000Z', ...over });
beforeEach(() => {
  db = memoryDb();
});
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof PeopleError ? e.code : `other:${e}`));
const STUDIO = { kind: 'studio' as const, id: 's1' };

describe('capability descriptions', () => {
  it('has a plain-language description for every capability, and none for a capability that does not exist', () => {
    const all = allCapabilities();
    expect(all.filter((c) => !CAPABILITY_INFO[c])).toEqual([]);
    expect(Object.keys(CAPABILITY_INFO).filter((c) => !all.includes(c))).toEqual([]);
  });
});

describe('starting a studio', () => {
  it('makes the twelve default roles and the first person as Owner, once', async () => {
    expect(await bootstrapStudio(db, ctx(), { id: 'owner1', name: 'Ana Reyes', email: 'ana@example.com' })).toEqual({ created: true });
    const roles = await listRoles(db, ctx());
    expect(roles).toHaveLength(ROLE_KEYS.length);
    expect(roles.find((r) => r.id === 'role_owner')).toMatchObject({ all: true, capabilities: [], holders: 1 });
    expect(roles.find((r) => r.id === 'role_author')!.capabilities).toEqual(defaultRole('author').capabilities);
    expect((await listPeople(db, ctx())).map((p) => p.name)).toEqual(['Ana Reyes']);
    expect(await bootstrapStudio(db, ctx(), { id: 'someone', name: 'Impostor' })).toEqual({ created: false });
    expect((await listPeople(db, ctx())).map((p) => p.name)).toEqual(['Ana Reyes']);
    expect(await ensureDefaultRoles(db, ctx())).toBe(0);
  });

  it('gives the Owner every capability through the permission function, including a future one', async () => {
    await bootstrapStudio(db, ctx(), { id: 'owner1', name: 'Ana' });
    const access = await loadAccess(db, ctx());
    const pc = { actor: { personId: 'owner1', teamIds: [] }, assignments: access.assignments, roles: new Map(access.roles.map((r) => [r.id, r])), now: ctx().now };
    expect(can(pc, 'catalogue.create', { path: [STUDIO] })).toBe(true);
    expect(can(pc, 'something.added.later', { path: [STUDIO] })).toBe(true);
    expect(can({ ...pc, actor: { personId: 'nobody', teamIds: [] } }, 'catalogue.read', { path: [STUDIO] })).toBe(false);
  });
});

describe('people and pen names', () => {
  beforeEach(async () => void (await bootstrapStudio(db, ctx(), { id: 'owner1', name: 'Ana' })));

  it('adds people with a kind and an optional unique email, and validates them', async () => {
    const bo = await createPerson(db, ctx(), { name: '  Bo   Lin ', email: 'bo@example.com', kind: 'contractor' });
    expect(bo).toMatchObject({ name: 'Bo Lin', email: 'bo@example.com', kind: 'contractor', createdBy: 'owner1', deactivatedAt: null });
    expect(await code(createPerson(db, ctx(), { name: 'Other', email: 'BO@example.com' }))).toBe('exists');
    expect(await code(createPerson(db, ctx(), { name: 'Same Email None' }))).toBe('ok');
    expect(await code(createPerson(db, ctx(), { name: 'Twin' }))).toBe('ok'); // names may repeat: people are told apart by id
    expect(await code(createPerson(db, ctx(), { name: '' }))).toBe('invalid');
    expect(await code(createPerson(db, ctx(), { name: 'X', email: 'nope' }))).toBe('invalid');
    expect(await code(createPerson(db, ctx(), { name: 'X', kind: 'wizard' }))).toBe('invalid');
    const u = await updatePerson(db, ctx({ actor: 'bo' }), bo.id, { kind: 'employee', email: null });
    expect(u).toMatchObject({ kind: 'employee', email: null, updatedBy: 'bo' });
    expect(await code(updatePerson(db, ctx(), 'nope', { name: 'X' }))).toBe('not-found');
  });

  it('deactivating keeps the person and their history, stops their access and team membership, and reactivating restores it', async () => {
    const bo = await createPerson(db, ctx(), { name: 'Bo' });
    const t = await createTeam(db, ctx(), { name: 'Editors' });
    await setTeamMember(db, ctx(), t.id, bo.id, true);
    await grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'role_editor', scope: STUDIO });
    expect((await loadAccess(db, ctx())).teamsOf(bo.id)).toEqual([t.id]);
    await setPersonActive(db, ctx(), bo.id, false);
    const off = await loadAccess(db, ctx());
    expect(off.assignments.some((a) => a.subject.id === bo.id)).toBe(false);
    expect(off.teamsOf(bo.id)).toEqual([]);
    expect((await listPeople(db, ctx())).map((p) => p.name)).toEqual(['Ana']);
    expect((await listPeople(db, ctx(), { deactivated: true })).map((p) => p.name)).toEqual(['Bo']);
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'role_author', scope: STUDIO }))).toBe('conflict');
    expect(await code(setTeamMember(db, ctx(), t.id, bo.id, true))).toBe('conflict'); // a deactivated person cannot be added
    await setPersonActive(db, ctx(), bo.id, true);
    expect((await loadAccess(db, ctx())).assignments.some((a) => a.subject.id === bo.id)).toBe(true);
  });

  it('keeps pen names apart from people: shared, several per person, and re-pointed later', async () => {
    const bo = await createPerson(db, ctx(), { name: 'Bo' });
    const cy = await createPerson(db, ctx(), { name: 'Cy' });
    const pn = await createPenName(db, ctx(), { displayName: 'A. J. Marsh', personIds: [bo.id, cy.id] });
    expect(pn.personIds.sort()).toEqual([bo.id, cy.id].sort());
    expect(await code(createPenName(db, ctx(), { displayName: 'a. j. marsh' }))).toBe('exists');
    await createPenName(db, ctx(), { displayName: 'Bo Lin', personIds: [bo.id] });
    expect((await setPenNamePeople(db, ctx(), pn.id, [cy.id])).personIds).toEqual([cy.id]);
    expect((await listPenNames(db, ctx())).map((p) => p.displayName)).toEqual(['A. J. Marsh', 'Bo Lin']);
    expect(await code(createPenName(db, ctx(), { displayName: 'X', personIds: ['nope'] }))).toBe('not-found');
  });
});

describe('teams', () => {
  beforeEach(async () => void (await bootstrapStudio(db, ctx(), { id: 'owner1', name: 'Ana' })));
  it('creates, renames and fills teams, and refuses a duplicate name', async () => {
    const bo = await createPerson(db, ctx(), { name: 'Bo' });
    const t = await createTeam(db, ctx(), { name: 'Art' });
    expect(await code(createTeam(db, ctx(), { name: 'art' }))).toBe('exists');
    expect((await setTeamMember(db, ctx(), t.id, bo.id, true)).memberIds).toEqual([bo.id]);
    expect((await setTeamMember(db, ctx(), t.id, bo.id, false)).memberIds).toEqual([]);
    expect((await renameTeam(db, ctx(), t.id, 'Art & Covers')).name).toBe('Art & Covers');
    expect((await listTeams(db, ctx())).map((x) => x.name)).toEqual(['Art & Covers']);
  });
  it('will not delete a team that still has a role, and deletes an unused one with its memberships', async () => {
    const bo = await createPerson(db, ctx(), { name: 'Bo' });
    const t = await createTeam(db, ctx(), { name: 'Editors' });
    await setTeamMember(db, ctx(), t.id, bo.id, true);
    const a = await grantRole(db, ctx(), { subject: { kind: 'team', id: t.id }, roleId: 'role_editor', scope: STUDIO });
    expect(await code(deleteTeam(db, ctx(), t.id))).toBe('conflict');
    await revokeAssignment(db, ctx(), a.id);
    await deleteTeam(db, ctx(), t.id);
    expect(await listTeams(db, ctx())).toEqual([]);
    expect(await db.all('SELECT 1 FROM team_member')).toEqual([]);
  });
});

describe('roles', () => {
  beforeEach(async () => void (await bootstrapStudio(db, ctx(), { id: 'owner1', name: 'Ana' })));

  it('creates a role, copies one, edits its capabilities with the change in the log, and refuses unknown capabilities', async () => {
    const r = await createRole(db, ctx(), { name: 'Proofreader', description: 'Reads and flags', capabilities: ['manuscript.read', 'edit.respond'] });
    expect(r).toMatchObject({ name: 'Proofreader', templateKey: null, capabilities: ['edit.respond', 'manuscript.read'], holders: 0 });
    const copy = await createRole(db, ctx(), { name: 'Senior Editor', copyFrom: 'role_editor' });
    expect(copy.capabilities).toEqual(defaultRole('editor').capabilities);
    expect(copy.description).toBe(defaultRole('editor').description);
    const u = await updateRole(db, ctx(), r.id, { capabilities: ['manuscript.read', 'canon.read'] });
    expect(u.capabilities).toEqual(['canon.read', 'manuscript.read']);
    const log = await db.all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'people.role.update'");
    expect(JSON.parse(log[0]!.detail)).toMatchObject({ added: ['canon.read'], removed: ['edit.respond'] });
    expect(await code(createRole(db, ctx(), { name: 'X', capabilities: ['nope.nothing'] }))).toBe('invalid');
    expect(await code(createRole(db, ctx(), { name: 'proofreader' }))).toBe('exists');
    expect(await code(createRole(db, ctx(), { name: 'Owner copy', copyFrom: 'role_owner' }))).toBe('refused');
    expect(await code(updateRole(db, ctx(), 'role_owner', { name: 'Boss' }))).toBe('refused');
    expect(await code(updateRole(db, ctx(), 'nope', { name: 'X' }))).toBe('not-found');
  });

  it('resets a default role to the shipped matrix, and refuses to reset one the studio made', async () => {
    await updateRole(db, ctx(), 'role_author', { name: 'Writer', capabilities: ['catalogue.read'] });
    expect((await getRole(db, ctx(), 'role_author'))!.capabilities).toEqual(['catalogue.read']);
    const back = await resetRole(db, ctx(), 'role_author');
    expect(back).toMatchObject({ name: 'Author', capabilities: defaultRole('author').capabilities });
    const mine = await createRole(db, ctx(), { name: 'Mine' });
    expect(await code(resetRole(db, ctx(), mine.id))).toBe('refused');
    expect(await code(resetRole(db, ctx(), 'role_owner'))).toBe('refused');
  });

  it('shows who holds a role and moves them to a replacement when it is deleted; an unassigned role just goes', async () => {
    const bo = await createPerson(db, ctx(), { name: 'Bo' });
    const cy = await createPerson(db, ctx(), { name: 'Cy' });
    const r = await createRole(db, ctx(), { name: 'Temp', capabilities: ['catalogue.read'] });
    await grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: r.id, scope: STUDIO });
    await grantRole(db, ctx(), { subject: { kind: 'person', id: cy.id }, roleId: r.id, scope: STUDIO });
    await grantRole(db, ctx(), { subject: { kind: 'person', id: cy.id }, roleId: 'role_author', scope: STUDIO }); // already has the replacement
    expect((await getRole(db, ctx(), r.id))!.holders).toBe(2);
    expect(await code(deleteRole(db, ctx(), r.id))).toBe('conflict');
    expect(await code(deleteRole(db, ctx(), r.id, r.id))).toBe('invalid');
    expect(await code(deleteRole(db, ctx(), r.id, 'nope'))).toBe('not-found');
    await deleteRole(db, ctx(), r.id, 'role_author');
    expect(await getRole(db, ctx(), r.id)).toBeNull();
    const mine = await listAssignments(db, ctx(), { roleId: 'role_author' });
    expect(mine.map((a) => a.subject.id).sort()).toEqual([bo.id, cy.id].sort()); // Cy keeps one, not two
    const free = await createRole(db, ctx(), { name: 'Unused' });
    await deleteRole(db, ctx(), free.id);
    expect(await code(deleteRole(db, ctx(), 'role_owner'))).toBe('refused');
    expect(await db.all("SELECT 1 FROM role_capability WHERE role_id = ?", [r.id])).toEqual([]);
  });

  it('puts a capability a newer version adds in front of an administrator until it is placed or acknowledged', async () => {
    expect(await capabilityReview(db, ctx())).toEqual([]); // a fresh studio has seen everything the catalogue has
    await db.run("DELETE FROM capability_seen WHERE capability IN ('canon.manage', 'asset.manage', 'launch.manage')"); // as if a later version had added these
    expect(await capabilityReview(db, ctx())).toEqual(['asset.manage', 'canon.manage', 'launch.manage']);
    await createRole(db, ctx(), { name: 'Art lead', capabilities: ['asset.manage'] });
    expect(await capabilityReview(db, ctx())).toEqual(['canon.manage', 'launch.manage']);
    const r = await createRole(db, ctx(), { name: 'Empty' });
    await updateRole(db, ctx(), r.id, { capabilities: ['canon.manage'] });
    await acknowledgeCapabilities(db, ctx(), ['launch.manage']);
    expect(await capabilityReview(db, ctx())).toEqual([]);
    expect(await ensureDefaultRoles(db, ctx())).toBe(0); // starting again does not mark anything seen
    await db.run("DELETE FROM capability_seen WHERE capability = 'canon.manage'");
    await bootstrapStudio(db, ctx(), { id: 'x', name: 'x' });
    expect(await capabilityReview(db, ctx())).toEqual(['canon.manage']);
  });
});

describe('assignments', () => {
  beforeEach(async () => void (await bootstrapStudio(db, ctx(), { id: 'owner1', name: 'Ana' })));

  it('grants a role to a person or team at a scope, once, with an optional future expiry, and revokes it', async () => {
    const bo = await createPerson(db, ctx(), { name: 'Bo' });
    const a = await grantRole(db, ctx({ actor: 'owner1' }), { subject: { kind: 'person', id: bo.id }, roleId: 'role_author', scope: { kind: 'project', id: 'p-book-1' }, expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(a).toMatchObject({ roleId: 'role_author', scope: { kind: 'project', id: 'p-book-1' }, expiresAt: '2027-01-01T00:00:00.000Z', grantedBy: 'owner1', grantedAt: ctx().now });
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'role_author', scope: { kind: 'project', id: 'p-book-1' } }))).toBe('exists');
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'role_author', scope: { kind: 'project', id: 'p-book-2' } }))).toBe('ok');
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: 'nope' }, roleId: 'role_author', scope: STUDIO }))).toBe('not-found');
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'nope', scope: STUDIO }))).toBe('not-found');
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'role_editor', scope: STUDIO, expiresAt: '2020-01-01T00:00:00.000Z' }))).toBe('invalid');
    expect(await code(grantRole(db, ctx(), { subject: { kind: 'person', id: bo.id }, roleId: 'role_editor', scope: { kind: 'galaxy' as 'studio', id: 'x' } }))).toBe('invalid');
    const extended = await setAssignmentExpiry(db, ctx(), a.id, null);
    expect(extended.expiresAt).toBeNull();
    await revokeAssignment(db, ctx(), a.id);
    expect((await listAssignments(db, ctx(), { subjectId: bo.id })).map((x) => x.scope.id)).toEqual(['p-book-2']);
    expect(await code(revokeAssignment(db, ctx(), a.id))).toBe('not-found');
  });

  it('keeps one studio’s people, roles and assignments from another’s', async () => {
    const other = ctx({ studioId: 's2' });
    expect(await listPeople(db, other)).toEqual([]);
    expect(await listRoles(db, other)).toEqual([]);
    expect(await getRole(db, other, 'role_author')).toBeNull();
    // another studio cannot give a role to this studio's person, nor use this studio's role
    expect(await code(grantRole(db, other, { subject: { kind: 'person', id: 'owner1' }, roleId: 'role_owner', scope: { kind: 'studio', id: 's2' } }))).toBe('not-found');
    expect(await code(updateRole(db, other, 'role_author', { name: 'Hijacked' }))).toBe('not-found');
  });
});
