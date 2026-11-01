/**
 * The Studio's records on its server. The same schema as the desktop's records file (the migrations are shared), the same kernel code and the
 * same service, so a person's rights are decided here by the same `can` the app runs. A member of the Studio is a person in these records
 * from the moment they join, with the role (and the project and end date) their invitation named.
 */
import { bootstrapStudio, grantRole, createPerson, hex, sanitizeTree, type Db, type ProjectTree, type Ctx } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { d1Db } from './d1';

export interface RecordsEnv {
  DB: D1Database;
  STUDIO_ID: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ctxAt = (env: RecordsEnv, now: number): Ctx => ({ studioId: env.STUDIO_ID, actor: 'system', now: iso(now) });

async function meta(db: Db, key: string): Promise<string | null> {
  return (await db.first<{ value: string }>('SELECT value FROM studio_meta WHERE key = ?', [key]))?.value ?? null;
}
async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.run('INSERT INTO studio_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

const ready = new WeakMap<object, Promise<string>>();

/**
 * Makes sure the Studio has its records (the twelve default roles, the default workflows and the owner as a person with the Owner role) and
 * says who the owner is. Safe to call on every request.
 */
export function ensureRecords(env: RecordsEnv, now = Date.now()): Promise<string> {
  const known = ready.get(env.DB);
  if (known) return known;
  const run = (async () => {
    const db = d1Db(env.DB);
    let owner = await meta(db, 'owner_person');
    if (!owner) {
      // records brought across from the owner's computer: their Owner is the one holding the Owner role at the whole Studio
      const held = await db.first<{ id: string }>("SELECT subject_id AS id FROM assignment WHERE studio_id = ? AND role_id = 'role_owner' AND scope_kind = 'studio' AND subject_kind = 'person' ORDER BY granted_at, id LIMIT 1", [env.STUDIO_ID]);
      owner = held?.id ?? `p${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
      await setMeta(db, 'owner_person', owner);
    }
    await bootstrapStudio(db, ctxAt(env, now), { id: owner, name: 'Owner' });
    return owner;
  })().catch((e) => {
    ready.delete(env.DB);
    throw e;
  });
  ready.set(env.DB, run);
  return run;
}

/** Someone who joined by invitation becomes a person here, holding the role the invitation named where it named. */
export async function admitMember(env: RecordsEnv, m: { id: string; name: string; role: string }, grant: { scopeKind: string; scopeId: string | null; expiresAt: string | null }, now = Date.now()): Promise<void> {
  await ensureRecords(env, now);
  const db = d1Db(env.DB);
  const c = ctxAt(env, now);
  const there = await db.first<{ id: string }>('SELECT id FROM person WHERE id = ? AND studio_id = ?', [m.id, env.STUDIO_ID]);
  if (!there) await createPerson(db, c, { id: m.id, name: m.name, kind: m.role === 'guest' ? 'guest' : 'employee' });
  const roleId = `role_${m.role}`;
  const scope = grant.scopeKind === 'project' && grant.scopeId ? { kind: 'project' as const, id: grant.scopeId } : { kind: 'studio' as const, id: env.STUDIO_ID };
  const held = await db.first<{ id: string }>('SELECT id FROM assignment WHERE studio_id = ? AND subject_kind = ? AND subject_id = ? AND role_id = ? AND scope_kind = ? AND scope_id = ?', [env.STUDIO_ID, 'person', m.id, roleId, scope.kind, scope.id]);
  if (!held) await grantRole(db, c, { subject: { kind: 'person', id: m.id }, roleId, scope, expiresAt: grant.expiresAt });
}

/** The person a signed request is from: the owner's, or the member's own (made at joining; made now for a member from before the server held records). */
export async function personIdFor(env: RecordsEnv, who: { kind: 'owner' } | { kind: 'member'; id: string; name: string; role: string }, now = Date.now()): Promise<string> {
  const owner = await ensureRecords(env, now);
  if (who.kind === 'owner') return owner;
  const db = d1Db(env.DB);
  if (!(await db.first('SELECT 1 AS x FROM person WHERE id = ?', [who.id]))) await admitMember(env, who, { scopeKind: 'studio', scopeId: null, expiresAt: null }, now);
  return who.id;
}

export async function readTree(db: Db): Promise<ProjectTree> {
  const raw = await meta(db, 'tree');
  try {
    return sanitizeTree(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeTree(null);
  }
}
export async function writeTree(db: Db, tree: ProjectTree): Promise<void> {
  await setMeta(db, 'tree', JSON.stringify(tree));
}

/** The Studio's service on its server: the records in D1, access from the records themselves, and the project tree the owner published. */
export function serviceFor(env: RecordsEnv, now = Date.now()): { service: StudioService; db: Db } {
  const db = d1Db(env.DB);
  return { db, service: new StudioService({ db, studioId: env.STUDIO_ID, access: dbAccess(db, env.STUDIO_ID), now: () => new Date(now), projects: () => readTree(db) }) };
}

