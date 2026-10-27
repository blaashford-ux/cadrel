/**
 * People, teams, roles and assignments (docs/PERMISSIONS.md). Records and rules over the kernel's async `Db`, in the same shape as the
 * catalogue: every change is one batch with its audit row, uniqueness lives in the database, and nothing here decides who may do what.
 * The service runs `can` and the guardrails (`canGrantRole`, `canEditRole`, `keepsAnOwner`, `canDeleteRole`) before it calls in.
 *
 * Roles only grant. A person has no role until one is assigned. The Owner role holds every capability, including ones added later.
 */
import { allCapabilities, CAPABILITY_INFO } from './capabilities';
import { newRecordId } from './ids';
import { defaultRole, defaultRoles, ROLE_KEYS, type Role } from './roles';
import type { Assignment, ScopeKind } from './permissions';
import type { Ctx } from './catalogue';
import type { Db } from './vault';

export type PeopleCode = 'invalid' | 'exists' | 'not-found' | 'conflict' | 'refused';
export class PeopleError extends Error {
  constructor(readonly code: PeopleCode, message: string) {
    super(message);
  }
}
const fail = (code: PeopleCode, m: string): never => {
  throw new PeopleError(code, m);
};

export const PERSON_KINDS = ['employee', 'contractor', 'guest'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export interface Person {
  id: string;
  studioId: string;
  name: string;
  email: string | null;
  kind: PersonKind;
  deactivatedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
export interface PenName { id: string; studioId: string; displayName: string; personIds: string[] }
export interface Team { id: string; studioId: string; name: string; memberIds: string[] }
export interface RoleRecord extends Role {
  studioId: string;
  /** How many live assignments (people and teams) give this role. */
  holders: number;
}
export interface AssignmentRecord extends Assignment {
  studioId: string;
  grantedBy: string;
  grantedAt: string;
}

const audit = (c: Ctx, action: string, target: string, detail: unknown) => ({
  sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
  params: [c.now, c.actor, action, target, JSON.stringify(detail)]
});

async function write(db: Db, stmts: { sql: string; params?: unknown[] }[], onUnique: string): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(m)) fail('exists', onUnique);
    if (/FOREIGN KEY/i.test(m)) fail('not-found', 'That record is not there any more.');
    throw e;
  }
}

function cleanName(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) return fail('invalid', `${what} needs a name.`);
  return s.length > 120 ? fail('invalid', `${what} is too long (120 characters at most).`) : s;
}
function cleanEmail(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200 ? s : fail('invalid', 'That is not an email address.');
}
const cleanKind = (v: unknown): PersonKind => ((PERSON_KINDS as readonly string[]).includes(v as string) ? (v as PersonKind) : fail('invalid', `A person is one of: ${PERSON_KINDS.join(', ')}.`));

// ---- people ---------------------------------------------------------------------------------------------------------------

const PERSON_COLS = 'id, studio_id AS studioId, name, email, kind, deactivated_at AS deactivatedAt, created_at AS createdAt, created_by AS createdBy, updated_at AS updatedAt, updated_by AS updatedBy';

export async function getPerson(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Person | null> {
  return db.first<Person>(`SELECT ${PERSON_COLS} FROM person WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
}
export async function listPeople(db: Db, c: Pick<Ctx, 'studioId'>, o: { deactivated?: boolean } = {}): Promise<Person[]> {
  return db.all<Person>(`SELECT ${PERSON_COLS} FROM person WHERE studio_id = ? AND ${o.deactivated ? 'deactivated_at IS NOT NULL' : 'deactivated_at IS NULL'} ORDER BY lower(name)`, [c.studioId]);
}

/** `id` lets the app make the person for someone it already knows (the one on this computer); otherwise a new id is made. */
export async function createPerson(db: Db, c: Ctx, input: { name: string; email?: string | null; kind?: string; id?: string }): Promise<Person> {
  const name = cleanName(input?.name, 'A person');
  const email = cleanEmail(input?.email);
  const kind = input?.kind === undefined ? 'employee' : cleanKind(input.kind);
  const id = input?.id ?? newRecordId();
  await write(db, [
    { sql: 'INSERT INTO person (id, studio_id, name, email, kind, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, name, email, kind, c.now, c.actor, c.now, c.actor] },
    audit(c, 'people.person.create', id, { name, email, kind })
  ], email ? `Someone with the address ${email} is already here.` : 'That person already exists.');
  return (await getPerson(db, c, id))!;
}

export async function updatePerson(db: Db, c: Ctx, id: string, patch: { name?: string; email?: string | null; kind?: string }): Promise<Person> {
  const cur = await getPerson(db, c, id);
  if (!cur) return fail('not-found', 'That person is not there.');
  if (cur.deactivatedAt) fail('conflict', 'That person is deactivated. Reactivate them first.');
  const name = patch.name !== undefined ? cleanName(patch.name, 'A person') : cur.name;
  const email = 'email' in patch ? cleanEmail(patch.email) : cur.email;
  const kind = patch.kind !== undefined ? cleanKind(patch.kind) : cur.kind;
  await write(db, [
    { sql: 'UPDATE person SET name = ?, email = ?, kind = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [name, email, kind, c.now, c.actor, id, c.studioId] },
    audit(c, 'people.person.update', id, { from: { name: cur.name, email: cur.email, kind: cur.kind }, to: { name, email, kind } })
  ], `Someone with the address ${email} is already here.`);
  return (await getPerson(db, c, id))!;
}

/** A deactivated person keeps their history and their name on records, but their assignments stop applying and they cannot be given new ones. */
export async function setPersonActive(db: Db, c: Ctx, id: string, active: boolean): Promise<Person> {
  const cur = await getPerson(db, c, id);
  if (!cur) return fail('not-found', 'That person is not there.');
  await write(db, [
    { sql: 'UPDATE person SET deactivated_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [active ? null : c.now, c.now, c.actor, id, c.studioId] },
    audit(c, active ? 'people.person.reactivate' : 'people.person.deactivate', id, {})
  ], 'Reactivating them would clash with someone using the same email address.');
  return (await getPerson(db, c, id))!;
}

// ---- pen names --------------------------------------------------------------------------------------------------------------

export async function listPenNames(db: Db, c: Pick<Ctx, 'studioId'>): Promise<PenName[]> {
  const names = await db.all<{ id: string; studioId: string; displayName: string }>('SELECT id, studio_id AS studioId, display_name AS displayName FROM pen_name WHERE studio_id = ? ORDER BY lower(display_name)', [c.studioId]);
  const links = await db.all<{ penNameId: string; personId: string }>('SELECT pen_name_id AS penNameId, person_id AS personId FROM pen_name_person');
  return names.map((n) => ({ ...n, personIds: links.filter((l) => l.penNameId === n.id).map((l) => l.personId) }));
}

export async function createPenName(db: Db, c: Ctx, input: { displayName: string; personIds?: string[] }): Promise<PenName> {
  const displayName = cleanName(input?.displayName, 'A pen name');
  const personIds = [...new Set(input?.personIds ?? [])];
  for (const p of personIds) if (!(await getPerson(db, c, p))) fail('not-found', 'One of those people is not there.');
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO pen_name (id, studio_id, display_name, created_at, created_by) VALUES (?,?,?,?,?)', params: [id, c.studioId, displayName, c.now, c.actor] },
    ...personIds.map((p) => ({ sql: 'INSERT INTO pen_name_person (pen_name_id, person_id) VALUES (?, ?)', params: [id, p] })),
    audit(c, 'people.penname.create', id, { displayName, personIds })
  ], `There is already a pen name “${displayName}”.`);
  return (await listPenNames(db, c)).find((n) => n.id === id)!;
}

export async function setPenNamePeople(db: Db, c: Ctx, id: string, personIds: string[]): Promise<PenName> {
  const cur = (await listPenNames(db, c)).find((n) => n.id === id);
  if (!cur) return fail('not-found', 'That pen name is not there.');
  const next = [...new Set(personIds)];
  for (const p of next) if (!(await getPerson(db, c, p))) fail('not-found', 'One of those people is not there.');
  await write(db, [
    { sql: 'DELETE FROM pen_name_person WHERE pen_name_id = ?', params: [id] },
    ...next.map((p) => ({ sql: 'INSERT INTO pen_name_person (pen_name_id, person_id) VALUES (?, ?)', params: [id, p] })),
    audit(c, 'people.penname.people', id, { from: cur.personIds, to: next })
  ], 'That pen name already has that person.');
  return (await listPenNames(db, c)).find((n) => n.id === id)!;
}

// ---- teams -------------------------------------------------------------------------------------------------------------------

export async function listTeams(db: Db, c: Pick<Ctx, 'studioId'>): Promise<Team[]> {
  const teams = await db.all<{ id: string; studioId: string; name: string }>('SELECT id, studio_id AS studioId, name FROM team WHERE studio_id = ? ORDER BY lower(name)', [c.studioId]);
  const members = await db.all<{ teamId: string; personId: string }>('SELECT team_id AS teamId, person_id AS personId FROM team_member');
  return teams.map((t) => ({ ...t, memberIds: members.filter((m) => m.teamId === t.id).map((m) => m.personId) }));
}
async function team(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<Team> {
  return (await listTeams(db, c)).find((t) => t.id === id) ?? fail('not-found', 'That team is not there.');
}

export async function createTeam(db: Db, c: Ctx, input: { name: string }): Promise<Team> {
  const name = cleanName(input?.name, 'A team');
  const id = newRecordId();
  await write(db, [{ sql: 'INSERT INTO team (id, studio_id, name, created_at, created_by) VALUES (?,?,?,?,?)', params: [id, c.studioId, name, c.now, c.actor] }, audit(c, 'people.team.create', id, { name })], `There is already a team called “${name}”.`);
  return team(db, c, id);
}
export async function renameTeam(db: Db, c: Ctx, id: string, name: string): Promise<Team> {
  const cur = await team(db, c, id);
  const next = cleanName(name, 'A team');
  await write(db, [{ sql: 'UPDATE team SET name = ? WHERE id = ? AND studio_id = ?', params: [next, id, c.studioId] }, audit(c, 'people.team.rename', id, { from: cur.name, to: next })], `There is already a team called “${next}”.`);
  return team(db, c, id);
}
export async function setTeamMember(db: Db, c: Ctx, teamId: string, personId: string, member: boolean): Promise<Team> {
  const t = await team(db, c, teamId);
  const p = await getPerson(db, c, personId);
  if (!p) fail('not-found', 'That person is not there.');
  if (member && p!.deactivatedAt) fail('conflict', 'That person is deactivated.');
  const has = t.memberIds.includes(personId);
  if (member === has) return t;
  await write(db, [
    member ? { sql: 'INSERT INTO team_member (team_id, person_id) VALUES (?, ?)', params: [teamId, personId] } : { sql: 'DELETE FROM team_member WHERE team_id = ? AND person_id = ?', params: [teamId, personId] },
    audit(c, member ? 'people.team.add' : 'people.team.remove', teamId, { personId })
  ], 'They are already in that team.');
  return team(db, c, teamId);
}
/** A team that still has a role assigned cannot be deleted: its members would lose access without anyone choosing that. */
export async function deleteTeam(db: Db, c: Ctx, id: string): Promise<void> {
  const t = await team(db, c, id);
  const n = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM assignment WHERE subject_kind = 'team' AND subject_id = ?", [id]))!.n;
  if (n) fail('conflict', 'That team still has roles assigned. Remove those first.');
  await write(db, [{ sql: 'DELETE FROM team_member WHERE team_id = ?', params: [id] }, { sql: 'DELETE FROM team WHERE id = ? AND studio_id = ?', params: [id, c.studioId] }, audit(c, 'people.team.delete', id, { name: t.name })], '');
}

// ---- roles -------------------------------------------------------------------------------------------------------------------

const KNOWN = new Set(allCapabilities());

export function cleanCapabilities(caps: unknown): string[] {
  if (!Array.isArray(caps)) return fail('invalid', 'A role’s capabilities are a list.');
  const out = [...new Set(caps.map(String))];
  const bad = out.find((x) => !KNOWN.has(x));
  if (bad) fail('invalid', `${bad} is not a known capability.`);
  return out.sort();
}

async function rolesOf(db: Db, c: Pick<Ctx, 'studioId'>): Promise<RoleRecord[]> {
  const rows = await db.all<{ id: string; studioId: string; name: string; description: string; templateKey: string | null; allCaps: number }>(
    'SELECT id, studio_id AS studioId, name, description, template_key AS templateKey, all_caps AS allCaps FROM role WHERE studio_id = ? ORDER BY lower(name)', [c.studioId]);
  const caps = await db.all<{ roleId: string; capability: string }>('SELECT role_id AS roleId, capability FROM role_capability ORDER BY capability');
  const holders = await db.all<{ roleId: string; n: number }>('SELECT role_id AS roleId, COUNT(*) AS n FROM assignment WHERE studio_id = ? GROUP BY role_id', [c.studioId]);
  return rows.map((r) => ({
    id: r.id, studioId: r.studioId, name: r.name, description: r.description, templateKey: r.templateKey,
    ...(r.allCaps ? { all: true } : {}), capabilities: caps.filter((x) => x.roleId === r.id).map((x) => x.capability),
    holders: holders.find((h) => h.roleId === r.id)?.n ?? 0
  }));
}
export const listRoles = rolesOf;
export async function getRole(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<RoleRecord | null> {
  return (await rolesOf(db, c)).find((r) => r.id === id) ?? null;
}

const roleInsert = (c: Ctx, r: { id: string; name: string; description: string; templateKey: string | null; all: boolean; capabilities: string[] }) => [
  { sql: 'INSERT INTO role (id, studio_id, name, description, template_key, all_caps, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)', params: [r.id, c.studioId, r.name, r.description, r.templateKey, r.all ? 1 : 0, c.now, c.actor, c.now, c.actor] },
  ...r.capabilities.map((cap) => ({ sql: 'INSERT INTO role_capability (role_id, capability) VALUES (?, ?)', params: [r.id, cap] }))
];

/** Creates the twelve default roles that are missing (ids `role_<key>`, so this is safe to run again). Returns how many it made. */
export async function ensureDefaultRoles(db: Db, c: Ctx): Promise<number> {
  const have = new Set((await rolesOf(db, c)).map((r) => r.templateKey).filter(Boolean));
  const stmts: { sql: string; params?: unknown[] }[] = [];
  let made = 0;
  for (const r of defaultRoles()) {
    if (have.has(r.templateKey)) continue;
    stmts.push(...roleInsert(c, { id: r.id, name: r.name, description: r.description, templateKey: r.templateKey, all: !!r.all, capabilities: r.all ? [] : r.capabilities }));
    made++;
  }
  if (made) await write(db, [...stmts, ...markSeen(c, [...KNOWN]), audit(c, 'people.role.defaults', c.studioId, { made })], 'A role with that name already exists.');
  return made;
}

export async function createRole(db: Db, c: Ctx, input: { name: string; description?: string; capabilities?: string[]; copyFrom?: string }): Promise<RoleRecord> {
  const name = cleanName(input?.name, 'A role');
  let caps = input?.capabilities !== undefined ? cleanCapabilities(input.capabilities) : [];
  let description = typeof input?.description === 'string' ? input.description.trim().slice(0, 500) : '';
  if (input?.copyFrom) {
    const src = await getRole(db, c, input.copyFrom);
    if (!src) return fail('not-found', 'The role to copy is not there.');
    if (src.all) fail('refused', 'The Owner role cannot be copied: it holds every capability, now and later.');
    if (input.capabilities === undefined) caps = [...src.capabilities];
    if (!description) description = src.description;
  }
  const id = newRecordId();
  await write(db, [...roleInsert(c, { id, name, description, templateKey: null, all: false, capabilities: caps }), ...markSeen(c, caps), audit(c, 'people.role.create', id, { name, capabilities: caps, copyFrom: input?.copyFrom ?? null })], `There is already a role called “${name}”.`);
  return (await getRole(db, c, id))!;
}

export async function updateRole(db: Db, c: Ctx, id: string, patch: { name?: string; description?: string; capabilities?: string[] }): Promise<RoleRecord> {
  const cur = await getRole(db, c, id);
  if (!cur) return fail('not-found', 'That role is not there.');
  if (cur.all) fail('refused', 'The Owner role cannot be changed.');
  const name = patch.name !== undefined ? cleanName(patch.name, 'A role') : cur.name;
  const description = patch.description !== undefined ? patch.description.trim().slice(0, 500) : cur.description;
  const caps = patch.capabilities !== undefined ? cleanCapabilities(patch.capabilities) : cur.capabilities;
  const stmts = [{ sql: 'UPDATE role SET name = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ? AND studio_id = ?', params: [name, description, c.now, c.actor, id, c.studioId] }];
  if (patch.capabilities !== undefined) stmts.push({ sql: 'DELETE FROM role_capability WHERE role_id = ?', params: [id] }, ...caps.map((cap) => ({ sql: 'INSERT INTO role_capability (role_id, capability) VALUES (?, ?)', params: [id, cap] })));
  const added = caps.filter((x) => !cur.capabilities.includes(x));
  const removed = cur.capabilities.filter((x) => !caps.includes(x));
  await write(db, [...stmts, ...markSeen(c, added), audit(c, 'people.role.update', id, { name: [cur.name, name], added, removed })], `There is already a role called “${name}”.`);
  return (await getRole(db, c, id))!;
}

/** Puts a default role back to what the shipped matrix says (its name, description and capabilities). A role the studio made has nothing to go back to. */
export async function resetRole(db: Db, c: Ctx, id: string): Promise<RoleRecord> {
  const cur = await getRole(db, c, id);
  if (!cur) return fail('not-found', 'That role is not there.');
  if (!cur.templateKey || !(ROLE_KEYS as readonly string[]).includes(cur.templateKey)) fail('refused', 'Only a default role can be reset to its default.');
  const d = defaultRole(cur.templateKey as (typeof ROLE_KEYS)[number]);
  if (d.all) fail('refused', 'The Owner role cannot be changed.');
  return updateRole(db, c, id, { name: d.name, description: d.description, capabilities: d.capabilities });
}

/**
 * Deletes a role. One still assigned needs a `replacement`: its assignments move to it in the same batch (a person who already holds the
 * replacement at that scope just loses the duplicate). Not the Owner role.
 */
export async function deleteRole(db: Db, c: Ctx, id: string, replacementId?: string): Promise<void> {
  const cur = await getRole(db, c, id);
  if (!cur) return fail('not-found', 'That role is not there.');
  if (cur.all) fail('refused', 'The Owner role cannot be deleted.');
  const stmts: { sql: string; params?: unknown[] }[] = [];
  if (cur.holders > 0) {
    if (!replacementId) fail('conflict', 'The role is still assigned; choose a role to move those people to.');
    if (replacementId === id) fail('invalid', 'Choose a different role to move them to.');
    const rep = await getRole(db, c, replacementId!);
    if (!rep) fail('not-found', 'The replacement role is not there.');
    // duplicates first, so the move cannot collide with an assignment they already have
    stmts.push(
      { sql: `DELETE FROM assignment WHERE role_id = ? AND EXISTS (SELECT 1 FROM assignment b WHERE b.role_id = ? AND b.studio_id = assignment.studio_id AND b.subject_kind = assignment.subject_kind AND b.subject_id = assignment.subject_id AND b.scope_kind = assignment.scope_kind AND b.scope_id = assignment.scope_id)`, params: [id, replacementId] },
      { sql: 'UPDATE assignment SET role_id = ? WHERE role_id = ?', params: [replacementId, id] }
    );
  }
  await write(db, [...stmts, { sql: 'DELETE FROM role_capability WHERE role_id = ?', params: [id] }, { sql: 'DELETE FROM role WHERE id = ? AND studio_id = ?', params: [id, c.studioId] }, audit(c, 'people.role.delete', id, { name: cur.name, movedTo: replacementId ?? null })], '');
}

/**
 * Capabilities a module or version has added since an administrator last looked: in the catalogue, but not yet placed in any role or
 * acknowledged. Until then only the Owner has them (a new capability is Owner-only until an administrator places it).
 */
export async function capabilityReview(db: Db, _c: Pick<Ctx, 'studioId'>): Promise<string[]> {
  const seen = new Set((await db.all<{ capability: string }>('SELECT capability FROM capability_seen')).map((r) => r.capability));
  return [...KNOWN].filter((x) => !seen.has(x)).sort();
}

/** Marks capabilities as reviewed ("Owner-only is fine for now"). A capability placed in a role is marked by that edit. */
export async function acknowledgeCapabilities(db: Db, c: Ctx, caps: string[]): Promise<void> {
  const list = cleanCapabilities(caps);
  if (!list.length) return;
  await write(db, [...list.map((x) => ({ sql: 'INSERT OR IGNORE INTO capability_seen (capability, seen_at) VALUES (?, ?)', params: [x, c.now] })), audit(c, 'people.capability.review', c.studioId, { capabilities: list })], '');
}

const markSeen = (c: Ctx, caps: string[]) => caps.map((x) => ({ sql: 'INSERT OR IGNORE INTO capability_seen (capability, seen_at) VALUES (?, ?)', params: [x, c.now] }));

export const capabilityInfo = (cap: string): string => CAPABILITY_INFO[cap] ?? cap;

// ---- assignments -------------------------------------------------------------------------------------------------------------

const ASSIGN_COLS = 'id, studio_id AS studioId, subject_kind, subject_id, role_id AS roleId, scope_kind, scope_id, expires_at AS expiresAt, granted_by AS grantedBy, granted_at AS grantedAt';
interface AssignRow { id: string; studioId: string; subject_kind: 'person' | 'team'; subject_id: string; roleId: string; scope_kind: ScopeKind; scope_id: string; expiresAt: string | null; grantedBy: string; grantedAt: string }
const toAssignment = (r: AssignRow): AssignmentRecord => ({ id: r.id, studioId: r.studioId, subject: { kind: r.subject_kind, id: r.subject_id }, roleId: r.roleId, scope: { kind: r.scope_kind, id: r.scope_id }, expiresAt: r.expiresAt, grantedBy: r.grantedBy, grantedAt: r.grantedAt });

export async function listAssignments(db: Db, c: Pick<Ctx, 'studioId'>, o: { subjectId?: string; roleId?: string } = {}): Promise<AssignmentRecord[]> {
  const where = ['studio_id = ?'];
  const params: unknown[] = [c.studioId];
  if (o.subjectId) (where.push('subject_id = ?'), params.push(o.subjectId));
  if (o.roleId) (where.push('role_id = ?'), params.push(o.roleId));
  return (await db.all<AssignRow>(`SELECT ${ASSIGN_COLS} FROM assignment WHERE ${where.join(' AND ')} ORDER BY granted_at, id`, params)).map(toAssignment);
}
export async function getAssignment(db: Db, c: Pick<Ctx, 'studioId'>, id: string): Promise<AssignmentRecord | null> {
  const r = await db.first<AssignRow>(`SELECT ${ASSIGN_COLS} FROM assignment WHERE id = ? AND studio_id = ?`, [id, c.studioId]);
  return r ? toAssignment(r) : null;
}

export async function grantRole(db: Db, c: Ctx, input: { subject: { kind: 'person' | 'team'; id: string }; roleId: string; scope: { kind: ScopeKind; id: string }; expiresAt?: string | null }): Promise<AssignmentRecord> {
  const { subject, roleId, scope } = input ?? ({} as typeof input);
  if (subject?.kind === 'person') {
    const p = await getPerson(db, c, subject.id);
    if (!p) fail('not-found', 'That person is not there.');
    if (p!.deactivatedAt) fail('conflict', 'That person is deactivated.');
  } else if (subject?.kind === 'team') await team(db, c, subject.id);
  else fail('invalid', 'Give the role to a person or a team.');
  if (!(await getRole(db, c, roleId))) fail('not-found', 'That role is not there.');
  if (!scope || !['studio', 'project', 'file'].includes(scope.kind) || typeof scope.id !== 'string' || !scope.id) fail('invalid', 'Say where the role applies: the studio, a project or a file.');
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) fail('invalid', 'That expiry is not a date.');
  if (expiresAt !== null && expiresAt <= c.now) fail('invalid', 'An expiry must be in the future.');
  const id = newRecordId();
  await write(db, [
    { sql: 'INSERT INTO assignment (id, studio_id, subject_kind, subject_id, role_id, scope_kind, scope_id, expires_at, granted_by, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)', params: [id, c.studioId, subject.kind, subject.id, roleId, scope.kind, scope.id, expiresAt, c.actor, c.now] },
    audit(c, 'people.assignment.grant', id, { subject, roleId, scope, expiresAt })
  ], 'They already hold that role there.');
  return (await getAssignment(db, c, id))!;
}

export async function revokeAssignment(db: Db, c: Ctx, id: string): Promise<void> {
  const a = await getAssignment(db, c, id);
  if (!a) return fail('not-found', 'That assignment is not there.');
  await write(db, [{ sql: 'DELETE FROM assignment WHERE id = ? AND studio_id = ?', params: [id, c.studioId] }, audit(c, 'people.assignment.revoke', id, { subject: a.subject, roleId: a.roleId, scope: a.scope })], '');
}

export async function setAssignmentExpiry(db: Db, c: Ctx, id: string, expiresAt: string | null): Promise<AssignmentRecord> {
  const a = await getAssignment(db, c, id);
  if (!a) return fail('not-found', 'That assignment is not there.');
  if (expiresAt !== null && (Number.isNaN(Date.parse(expiresAt)) || expiresAt <= c.now)) fail('invalid', 'An expiry must be a date in the future.');
  await write(db, [{ sql: 'UPDATE assignment SET expires_at = ? WHERE id = ? AND studio_id = ?', params: [expiresAt, id, c.studioId] }, audit(c, 'people.assignment.expiry', id, { from: a.expiresAt ?? null, to: expiresAt })], '');
  return (await getAssignment(db, c, id))!;
}

// ---- what the permission function reads ----------------------------------------------------------------------------------------

/**
 * The assignments, roles and team memberships `can` needs. Deactivated people hold nothing and are in no team, so deactivating someone
 * takes effect on their next request without touching their assignments (reactivating restores them).
 */
export async function loadAccess(db: Db, c: Pick<Ctx, 'studioId'>): Promise<{ assignments: Assignment[]; roles: Role[]; teamsOf(personId: string): string[] }> {
  const dead = new Set((await db.all<{ id: string }>('SELECT id FROM person WHERE studio_id = ? AND deactivated_at IS NOT NULL', [c.studioId])).map((p) => p.id));
  const assignments = (await listAssignments(db, c)).filter((a) => !(a.subject.kind === 'person' && dead.has(a.subject.id))).map((a): Assignment => ({ id: a.id, subject: a.subject, roleId: a.roleId, scope: a.scope, expiresAt: a.expiresAt }));
  const roles = (await rolesOf(db, c)).map((r): Role => ({ id: r.id, name: r.name, description: r.description, ...(r.all ? { all: true } : {}), templateKey: r.templateKey, capabilities: r.capabilities }));
  const teams = await listTeams(db, c);
  return { assignments, roles, teamsOf: (personId) => (dead.has(personId) ? [] : teams.filter((t) => t.memberIds.includes(personId)).map((t) => t.id)) };
}

/**
 * Starts a studio: its default roles, and `owner` as its first person and Owner. Does nothing if the studio already has people, so it is
 * safe to call on every start. The Owner can never be removed afterwards (see `keepsAnOwner`).
 */
export async function bootstrapStudio(db: Db, c: Ctx, owner: { id: string; name: string; email?: string | null }): Promise<{ created: boolean }> {
  if ((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM person WHERE studio_id = ?', [c.studioId]))!.n > 0) {
    await ensureDefaultRoles(db, c);
    return { created: false };
  }
  await ensureDefaultRoles(db, c);
  await createPerson(db, c, { id: owner.id, name: owner.name, email: owner.email ?? null, kind: 'employee' });
  await grantRole(db, c, { subject: { kind: 'person', id: owner.id }, roleId: 'role_owner', scope: { kind: 'studio', id: c.studioId } });
  return { created: true };
}
