/**
 * The Studio's own API: who is in it. Everything is signed with Ed25519 keys (see the kernel's studioProtocol); there are no passwords and
 * the Worker holds no one's secret, only public keys. The owner's key is set when the Studio is built; members join with an invitation the
 * owner made. Nothing here reads or writes the Studio's files: that comes with the vault.
 */
import { b64u, fingerprint, hex, ROLE_KEYS, sha256, STUDIO_API_VERSION, verifyRequest } from '@cadrel/kernel';
import { ensureSchema } from './schema';
import { admitMember, personIdFor, readTree } from './records';
import { d1Db } from './d1';
import { importRecords, type ImportRequest } from './import';
import { isServerRoute, serverRoutes } from './server';

export interface StudioEnv {
  DB: D1Database;
  /** The Studio's file store, for the vault's contents. */
  FILES?: R2Bucket;
  /** Set when the Studio is built. */
  STUDIO_ID: string;
  /** The owner's public key (base64url). Only the holder of its private half can administer the Studio. */
  OWNER_KEY: string;
}

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_KEEP_MS = 10 * 60 * 1000;
const MEMBER_ROLES = ROLE_KEYS.filter((k) => k !== 'owner') as string[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => json({ error }, status);
const iso = (ms: number) => new Date(ms).toISOString();
const randomId = (prefix: string, bytes = 8) => `${prefix}${hex(crypto.getRandomValues(new Uint8Array(bytes)))}`;

type Who = { kind: 'owner'; name: string; role: 'owner' } | { kind: 'member'; id: string; name: string; role: string };

/** Verifies the signature, refuses a repeat of a request already seen, and says who the key belongs to (null: nobody here). */
async function authenticate(request: Request, body: string | Uint8Array, env: StudioEnv, now: number): Promise<{ key: string; who: Who | null } | Response> {
  const path = new URL(request.url).pathname;
  const v = await verifyRequest({ method: request.method, path, body, headers: (n) => request.headers.get(n), now });
  if (!v.ok) return fail(401, v.reason === 'stale' ? 'The request is too old or your computer’s clock is wrong.' : 'The request was not signed correctly.');
  const nonce = hex(await sha256(v.signature));
  await env.DB.prepare('DELETE FROM request_nonce WHERE at < ?').bind(now - NONCE_KEEP_MS).run();
  try {
    await env.DB.prepare('INSERT INTO request_nonce (id, at) VALUES (?, ?)').bind(nonce, now).run();
  } catch {
    return fail(401, 'That request was already received.');
  }
  if (v.publicKey === env.OWNER_KEY) return { key: v.publicKey, who: { kind: 'owner', name: 'Owner', role: 'owner' } };
  const m = await env.DB.prepare('SELECT id, name, role FROM member WHERE public_key = ? AND revoked_at IS NULL').bind(v.publicKey).first<{ id: string; name: string; role: string }>();
  return { key: v.publicKey, who: m ? { kind: 'member', id: m.id, name: m.name, role: m.role } : null };
}

/** The Studio's routes, or null for a path that is not one of them. */
export async function studioRoutes(request: Request, env: StudioEnv, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const isRoute = isServerRoute(path) || path === '/v1/records/import' || path === '/v1/info' || path === '/v1/invites' || path === '/v1/join' || path === '/v1/members' || path === '/v1/me' || /^\/v1\/(members|invites)\/[\w-]+$/.test(path);
  if (!isRoute) return null;

  const schemaVersion = await ensureSchema(env.DB);

  // Public: what a person joining needs to check they are at the Studio they were told about.
  if (method === 'GET' && path === '/v1/info') {
    return json({ studioId: env.STUDIO_ID, ownerFingerprint: await fingerprint(env.OWNER_KEY), apiVersion: STUDIO_API_VERSION, schemaVersion });
  }

  const binary = method === 'PUT' && /^\/v1\/blobs\//.test(path);
  const body: string | Uint8Array = method === 'GET' || method === 'DELETE' ? '' : binary ? new Uint8Array(await request.arrayBuffer()) : await request.text();
  const auth = await authenticate(request, body, env, now);
  if (auth instanceof Response) return auth;
  let data: Record<string, unknown> = {};
  if (body && !binary && !isServerRoute(path)) {
    try {
      data = JSON.parse(body as string) as Record<string, unknown>;
    } catch {
      return fail(400, 'The request was not understood.');
    }
  }

  // Joining: the one request a stranger's key may make, and only with a code the owner made.
  if (method === 'POST' && path === '/v1/join') {
    const code = typeof data.code === 'string' ? data.code : '';
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 60) : '';
    if (!code || !name) return fail(400, 'An invitation code and a name are needed.');
    if (auth.who?.kind === 'owner') return fail(400, 'The owner does not join their own Studio.');
    if (auth.who?.kind === 'member') return json({ memberId: auth.who.id, role: auth.who.role, studioId: env.STUDIO_ID });
    const invite = await env.DB.prepare('SELECT id, role, expires_at, used_at, scope_kind, scope_id, grant_expires_at FROM invite WHERE code_hash = ?').bind(hex(await sha256(code))).first<{ id: string; role: string; expires_at: string; used_at: string | null; scope_kind: string; scope_id: string | null; grant_expires_at: string | null }>();
    if (!invite || invite.used_at) return fail(410, 'That invitation has already been used or does not exist.');
    if (invite.expires_at < iso(now)) return fail(410, 'That invitation has expired. Ask for a new one.');
    const taken = await env.DB.prepare('UPDATE invite SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(iso(now), invite.id).run();
    if ((taken.meta.changes ?? 0) === 0) return fail(410, 'That invitation has already been used or does not exist.');
    const id = randomId('m');
    try {
      await env.DB.prepare('INSERT INTO member (id, public_key, name, role, joined_at) VALUES (?, ?, ?, ?, ?)').bind(id, auth.key, name, invite.role, iso(now)).run();
    } catch {
      await env.DB.prepare('UPDATE invite SET used_at = NULL WHERE id = ?').bind(invite.id).run();
      return fail(403, 'This computer was removed from the Studio and cannot rejoin with it.');
    }
    try {
      await admitMember(env, { id, name, role: invite.role }, { scopeKind: invite.scope_kind, scopeId: invite.scope_id, expiresAt: invite.grant_expires_at }, now);
    } catch {
      await env.DB.prepare('DELETE FROM member WHERE id = ?').bind(id).run();
      await env.DB.prepare('UPDATE invite SET used_at = NULL WHERE id = ?').bind(invite.id).run();
      return fail(500, 'The Studio could not add you. Ask the owner for a new invitation.');
    }
    return json({ memberId: id, role: invite.role, studioId: env.STUDIO_ID });
  }

  if (!auth.who) return fail(403, 'This computer is not a member of the Studio.');

  if (path === '/v1/records/import') {
    if (auth.who.kind !== 'owner') return fail(403, 'Only the Studio’s owner can do that.');
    if (method !== 'POST') return fail(405, 'That is not something the Studio does.');
    const r = await importRecords(env, data as unknown as ImportRequest);
    return r.ok ? json(r) : fail(400, r.error);
  }

  if (isServerRoute(path)) return serverRoutes(request, env, auth.who, await personIdFor(env, auth.who, now), body, now);

  if (method === 'GET' && path === '/v1/me') return json({ kind: auth.who.kind, role: auth.who.role, name: auth.who.name, studioId: env.STUDIO_ID, personId: await personIdFor(env, auth.who, now) });

  // Everything below is the owner's.
  if (auth.who.kind !== 'owner') return fail(403, 'Only the Studio’s owner can do that.');

  if (method === 'POST' && path === '/v1/invites') {
    const role = typeof data.role === 'string' ? data.role : '';
    const label = typeof data.label === 'string' ? data.label.trim().slice(0, 80) : '';
    if (!MEMBER_ROLES.includes(role)) return fail(400, 'Choose a role for the invitation (not Owner).');
    // where the role applies (one project, for a guest) and for how long (days), if the invitation says
    const projectId = typeof data.projectId === 'string' && data.projectId ? data.projectId : null;
    const days = typeof data.days === 'number' && data.days > 0 && data.days <= 3650 ? Math.floor(data.days) : null;
    if (projectId && !(await readTree(d1Db(env.DB))).projects.some((p) => p.id === projectId)) return fail(400, 'That project is not in the Studio’s published projects.');
    const grantEnds = days ? iso(now + days * 24 * 60 * 60 * 1000) : null;
    const code = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const id = randomId('i');
    const expires = iso(now + INVITE_LIFETIME_MS);
    await env.DB.prepare('INSERT INTO invite (id, code_hash, role, label, created_at, expires_at, scope_kind, scope_id, grant_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, hex(await sha256(code)), role, label, iso(now), expires, projectId ? 'project' : 'studio', projectId, grantEnds).run();
    return json({ id, code, role, label, expiresAt: expires, studioId: env.STUDIO_ID, projectId, grantEndsAt: grantEnds }, 201);
  }
  if (method === 'GET' && path === '/v1/invites') {
    const rows = await env.DB.prepare('SELECT id, role, label, created_at AS createdAt, expires_at AS expiresAt FROM invite WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').bind(iso(now)).all();
    return json({ invites: rows.results });
  }
  if (method === 'GET' && path === '/v1/members') {
    const rows = await env.DB.prepare('SELECT id, name, role, joined_at AS joinedAt, revoked_at AS revokedAt FROM member ORDER BY joined_at').all();
    return json({ members: rows.results });
  }
  const del = /^\/v1\/(members|invites)\/([\w-]+)$/.exec(path);
  if (method === 'DELETE' && del) {
    if (del[1] === 'members') {
      const r = await env.DB.prepare('UPDATE member SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(iso(now), del[2]).run();
      return (r.meta.changes ?? 0) ? json({ ok: true }) : fail(404, 'There is no such member.');
    }
    const r = await env.DB.prepare('DELETE FROM invite WHERE id = ? AND used_at IS NULL').bind(del[2]).run();
    return (r.meta.changes ?? 0) ? json({ ok: true }) : fail(404, 'There is no such pending invitation.');
  }
  return fail(405, 'That is not something the Studio does.');
}
