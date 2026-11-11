/**
 * The Studio's own API: who is in it. Everything is signed with Ed25519 keys (see the kernel's studioProtocol); there are no passwords and
 * the Worker holds no one's secret, only public keys. The owner's key is set when the Studio is built; members join with an invitation the
 * owner made. Nothing here reads or writes the Studio's files: that comes with the vault.
 */
import { b64u, fingerprint, hex, inviteEmailText, invitationLink, ROLE_KEYS, sha256, STUDIO_API_VERSION, STUDIO_WORKER_REVISION, verifyRequest } from '@cadrel/kernel';
import { ensureSchema } from './schema';
import { admitMember, personForInvite, personIdFor, readTree, ROLELESS } from './records';
import { d1Db, readVersions } from './d1';
import { exportRecords, importRecords, ownerOf, type ImportRequest } from './import';
import { isServerRoute, serverRoutes } from './server';

/** Cloudflare Email Service's send binding, as far as this server uses it. */
export interface Mailer {
  send(message: { to: { email: string; name?: string }; from: { email: string; name?: string }; subject: string; text: string }): Promise<unknown>;
}

export interface StudioEnv {
  DB: D1Database;
  /** Set only when the owner turned invitation email on (Admin → Studio Manager): the send binding and the address it sends from, on a domain they onboarded in Cloudflare Email Service. */
  EMAIL?: Mailer;
  INVITE_FROM?: string;
  /** The Studio's file store, for the vault's contents. */
  FILES?: R2Bucket;
  /** Set when the Studio is built. */
  STUDIO_ID: string;
  /** The owner's public key (base64url). Only the holder of its private half can administer the Studio. */
  OWNER_KEY: string;
}

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_KEEP_MS = 10 * 60 * 1000;
/** Old signatures are swept at most this often by a running Worker: the table has no index on its time, so a sweep reads all of it. */
const NONCE_SWEEP_EVERY_MS = 60 * 1000;
let lastSweep = 0;
/** An invitation of this role adds one of the owner's own devices instead of a person. The `invite` table is shared so the Studio's schema does not change. */
const DEVICE_ROLE = '_device';
const DEVICE_LINK_LIFETIME_MS = 60 * 60 * 1000;
const deviceKey = (publicKey: string) => `device:${publicKey}`;
const MEMBER_ROLES = ROLE_KEYS.filter((k) => k !== 'owner') as string[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => json({ error }, status);
const iso = (ms: number) => new Date(ms).toISOString();
const randomId = (prefix: string, bytes = 8) => `${prefix}${hex(crypto.getRandomValues(new Uint8Array(bytes)))}`;

type Who = { kind: 'owner'; name: string; role: 'owner' } | { kind: 'member'; id: string; name: string; role: string; personId: string | null };

/** Verifies the signature, refuses a repeat of a request already seen, and says who the key belongs to (null: nobody here). */
async function authenticate(request: Request, body: string | Uint8Array, env: StudioEnv, now: number): Promise<{ key: string; who: Who | null } | Response> {
  const path = new URL(request.url).pathname;
  const v = await verifyRequest({ method: request.method, path, body, headers: (n) => request.headers.get(n), now });
  if (!v.ok) return fail(401, v.reason === 'stale' ? 'The request is too old or your computer’s clock is wrong.' : 'The request was not signed correctly.');
  const nonce = hex(await sha256(v.signature));
  // An old signature is refused as stale before it is looked up, so one that outlives its ten minutes here does no harm.
  if (now - lastSweep >= NONCE_SWEEP_EVERY_MS || now < lastSweep) {
    lastSweep = now;
    await env.DB.prepare('DELETE FROM request_nonce WHERE at < ?').bind(now - NONCE_KEEP_MS).run();
  }
  try {
    await env.DB.prepare('INSERT INTO request_nonce (id, at) VALUES (?, ?)').bind(nonce, now).run();
  } catch {
    return fail(401, 'That request was already received.');
  }
  if (v.publicKey === env.OWNER_KEY) return { key: v.publicKey, who: { kind: 'owner', name: 'Owner', role: 'owner' } };
  // A device the owner linked (their phone): it is the owner, signed with its own key, so the owner's key never leaves the owner's computer.
  if (await env.DB.prepare('SELECT 1 AS x FROM studio_meta WHERE key = ?').bind(deviceKey(v.publicKey)).first()) return { key: v.publicKey, who: { kind: 'owner', name: 'Owner', role: 'owner' } };
  const m = await env.DB.prepare('SELECT id, name, role, person_id AS personId FROM member WHERE public_key = ? AND revoked_at IS NULL').bind(v.publicKey).first<{ id: string; name: string; role: string; personId: string | null }>();
  return { key: v.publicKey, who: m ? { kind: 'member', id: m.id, name: m.name, role: m.role, personId: m.personId } : null };
}

/** The Studio's routes, or null for a path that is not one of them. */
export async function studioRoutes(request: Request, env: StudioEnv, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const isRoute = isServerRoute(path) || path === '/v1/records/import' || path === '/v1/records/export' || path === '/v1/info' || path === '/v1/invites' || path === '/v1/join' || path === '/v1/members' || path === '/v1/devices' || path === '/v1/me' || path === '/v1/version' || /^\/v1\/(members|invites|devices)\/[\w-]+$/.test(path);
  if (!isRoute) return null;

  let schemaVersion: number;
  try {
    schemaVersion = await ensureSchema(env.DB);
  } catch (e) {
    // Say what failed instead of a bare 500, so an upgrade that stops here tells the person why.
    return fail(503, `The Studio's database could not be brought up to date: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
  }

  // Public: what a person joining needs to check they are at the Studio they were told about.
  if (method === 'GET' && path === '/v1/info') {
    return json({ studioId: env.STUDIO_ID, ownerFingerprint: await fingerprint(env.OWNER_KEY), apiVersion: STUDIO_API_VERSION, schemaVersion, workerRevision: STUDIO_WORKER_REVISION, mail: !!(env.EMAIL && env.INVITE_FROM) });
  }

  const binary = method === 'PUT' && /^\/v1\/(blobs|captures)\//.test(path);
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
    if (!code) return fail(400, 'An invitation code is needed.');
    const link = await env.DB.prepare('SELECT id, role, label, expires_at, used_at FROM invite WHERE code_hash = ?').bind(hex(await sha256(code))).first<{ id: string; role: string; label: string; expires_at: string; used_at: string | null }>();
    // Linking one of the owner's own devices: the same person, so no name is asked, and nothing is added to the people.
    if (link?.role === DEVICE_ROLE) {
      if (auth.who?.kind === 'owner') return json({ memberId: 'owner', role: 'owner', studioId: env.STUDIO_ID });
      if (link.used_at) return fail(410, 'That link has already been used or does not exist.');
      if (link.expires_at < iso(now)) return fail(410, 'That link has expired. Make a new one on the computer that owns the Studio.');
      const took = await env.DB.prepare('UPDATE invite SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(iso(now), link.id).run();
      if ((took.meta.changes ?? 0) === 0) return fail(410, 'That link has already been used or does not exist.');
      if (await env.DB.prepare('SELECT 1 AS x FROM member WHERE public_key = ?').bind(auth.key).first()) return fail(403, 'This device was removed from the Studio and cannot be linked.');
      await env.DB.prepare('INSERT INTO studio_meta (key, value) VALUES (?, ?)').bind(deviceKey(auth.key), JSON.stringify({ label: link.label, linkedAt: iso(now) })).run();
      return json({ memberId: 'owner', role: 'owner', studioId: env.STUDIO_ID });
    }
    if (!name) return fail(400, 'An invitation code and a name are needed.');
    if (auth.who?.kind === 'owner') return fail(400, 'The owner does not join their own Studio.');
    if (auth.who?.kind === 'member') return json({ memberId: auth.who.id, role: auth.who.role, studioId: env.STUDIO_ID });
    const invite = await env.DB.prepare('SELECT id, role, expires_at, used_at, scope_kind, scope_id, grant_expires_at, person_id AS personId FROM invite WHERE code_hash = ?').bind(hex(await sha256(code))).first<{ id: string; role: string; expires_at: string; used_at: string | null; scope_kind: string; scope_id: string | null; grant_expires_at: string | null; personId: string | null }>();
    if (!invite || invite.used_at) return fail(410, 'That invitation has already been used or does not exist.');
    if (invite.expires_at < iso(now)) return fail(410, 'That invitation has expired. Ask for a new one.');
    const taken = await env.DB.prepare('UPDATE invite SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(iso(now), invite.id).run();
    if ((taken.meta.changes ?? 0) === 0) return fail(410, 'That invitation has already been used or does not exist.');
    const id = randomId('m');
    try {
      await env.DB.prepare('INSERT INTO member (id, public_key, name, role, joined_at, person_id) VALUES (?, ?, ?, ?, ?, ?)').bind(id, auth.key, name, invite.role, iso(now), invite.personId).run();
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

  if (path === '/v1/records/export') {
    if (auth.who.kind !== 'owner') return fail(403, 'Only the Studio’s owner can do that.');
    if (method !== 'POST') return fail(405, 'That is not something the Studio does.');
    if (data.table === '_owner') return json({ owner: await ownerOf(env), schemaVersion });
    const r = await exportRecords(env, { table: String(data.table ?? ''), offset: Number(data.offset ?? 0) });
    return r.ok ? json(r) : fail(400, r.error);
  }

  if (path === '/v1/records/import') {
    if (auth.who.kind !== 'owner') return fail(403, 'Only the Studio’s owner can do that.');
    if (method !== 'POST') return fail(405, 'That is not something the Studio does.');
    const r = await importRecords(env, data as unknown as ImportRequest);
    return r.ok ? json(r) : fail(400, r.error);
  }

  if (isServerRoute(path)) return serverRoutes(request, env, auth.who, await personIdFor(env, auth.who, now), body, now);

  // What the app asks, instead of fetching everything again on a timer: has anything changed since the counters it holds? (two rows read)
  if (method === 'GET' && path === '/v1/version') return json(await readVersions(env.DB));

  if (method === 'GET' && path === '/v1/me') return json({ kind: auth.who.kind, role: auth.who.role, name: auth.who.name, studioId: env.STUDIO_ID, personId: await personIdFor(env, auth.who, now) });

  // Everything below is the owner's.
  if (auth.who.kind !== 'owner') return fail(403, 'Only the Studio’s owner can do that.');

  // Emails an invitation the owner has just made, to the address on that person's record and to no one else, so this cannot be used to send
  // anything else to anyone. The code is the proof there is such an invitation: only its hash is kept, so it has to come with the request.
  if (method === 'POST' && path === '/v1/invites/mail') {
    if (!env.EMAIL || !env.INVITE_FROM) return fail(409, 'This Studio does not send email yet. Turn it on in Admin → Studio Manager.');
    const code = typeof data.code === 'string' ? data.code : '';
    if (!code) return fail(400, 'An invitation code is needed.');
    const row = await env.DB.prepare('SELECT i.expires_at AS expiresAt, i.used_at AS usedAt, p.name AS name, p.email AS email FROM invite i LEFT JOIN person p ON p.id = i.person_id WHERE i.code_hash = ?').bind(hex(await sha256(code))).first<{ expiresAt: string; usedAt: string | null; name: string | null; email: string | null }>();
    if (!row || row.usedAt) return fail(404, 'There is no such waiting invitation.');
    if (row.expiresAt < iso(now)) return fail(410, 'That invitation has expired. Make a new one.');
    if (!row.email) return fail(400, 'That person has no email address. Add one to their record, or send the link yourself.');
    const studioName = typeof data.studioName === 'string' ? data.studioName.trim().slice(0, 80) : '';
    const link = invitationLink({ url: url.origin, code, fingerprint: await fingerprint(env.OWNER_KEY), ...(studioName ? { studioName } : {}) }, data.opens === 'reader' ? 'cadrel-reader' : 'cadrel');
    const text = inviteEmailText({ studio: studioName, link, sender: typeof data.senderName === 'string' ? data.senderName : '' });
    try {
      await env.EMAIL.send({ to: { email: row.email, ...(row.name ? { name: row.name } : {}) }, from: { email: env.INVITE_FROM, ...(studioName ? { name: studioName } : {}) }, subject: text.subject, text: text.body });
    } catch (e) {
      return fail(502, `The email could not be sent: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
    return json({ ok: true, to: row.email });
  }
  if (method === 'POST' && path === '/v1/invites' && data.person && typeof data.person === 'object') {
    // An invitation for a person, with no role: they see nothing until the owner gives them one, per project, in Cadrel.
    const p = data.person as { id?: unknown; name?: unknown; email?: unknown };
    const made = await personForInvite(env, { ...(typeof p.id === 'string' && p.id ? { personId: p.id } : {}), ...(typeof p.name === 'string' ? { name: p.name } : {}), ...(typeof p.email === 'string' ? { email: p.email } : {}) }, now);
    if (!made.ok) return fail(400, made.error);
    const named = await env.DB.prepare('SELECT name FROM person WHERE id = ?').bind(made.id).first<{ name: string }>();
    const label = (typeof data.label === 'string' && data.label.trim() ? data.label.trim() : named?.name ?? '').slice(0, 80);
    const code = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const id = randomId('i');
    const expires = iso(now + INVITE_LIFETIME_MS);
    await env.DB.prepare("INSERT INTO invite (id, code_hash, role, label, created_at, expires_at, scope_kind, scope_id, grant_expires_at, person_id) VALUES (?, ?, ?, ?, ?, ?, 'studio', NULL, NULL, ?)").bind(id, hex(await sha256(code)), ROLELESS, label, iso(now), expires, made.id).run();
    return json({ id, code, role: ROLELESS, label, expiresAt: expires, studioId: env.STUDIO_ID, personId: made.id }, 201);
  }
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
    const rows = await env.DB.prepare('SELECT id, role, label, person_id AS personId, created_at AS createdAt, expires_at AS expiresAt FROM invite WHERE used_at IS NULL AND expires_at > ? AND role != ? ORDER BY created_at DESC').bind(iso(now), DEVICE_ROLE).all();
    return json({ invites: rows.results });
  }
  // The owner's own devices: a one-hour, one-use link that adds a phone as the owner, the phones already linked, and taking one away.
  if (method === 'POST' && path === '/v1/devices') {
    const label = typeof data.label === 'string' ? data.label.trim().slice(0, 80) : '';
    const code = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const expires = iso(now + DEVICE_LINK_LIFETIME_MS);
    await env.DB.prepare("INSERT INTO invite (id, code_hash, role, label, created_at, expires_at, scope_kind, scope_id, grant_expires_at) VALUES (?, ?, ?, ?, ?, ?, 'studio', NULL, NULL)").bind(randomId('i'), hex(await sha256(code)), DEVICE_ROLE, label, iso(now), expires).run();
    return json({ code, label, expiresAt: expires, studioId: env.STUDIO_ID }, 201);
  }
  if (method === 'GET' && path === '/v1/devices') {
    const rows = await env.DB.prepare("SELECT key, value FROM studio_meta WHERE key LIKE 'device:%'").all<{ key: string; value: string }>();
    const devices = rows.results.map((r) => {
      let v: { label?: string; linkedAt?: string } = {};
      try {
        v = JSON.parse(r.value);
      } catch {
        /* keep the key only */
      }
      return { id: r.key.slice('device:'.length), label: v.label ?? '', linkedAt: v.linkedAt ?? '' };
    });
    return json({ devices });
  }
  const delDevice = /^\/v1\/devices\/([\w-]+)$/.exec(path)?.[1];
  if (method === 'DELETE' && delDevice) {
    const r = await env.DB.prepare('DELETE FROM studio_meta WHERE key = ?').bind(deviceKey(delDevice)).run();
    if (!(r.meta.changes ?? 0)) return fail(404, 'There is no such linked device.');
    // A removed phone must not be linkable again with a link that was already spent, and cannot rejoin as a member under the same key.
    await env.DB.prepare("INSERT OR IGNORE INTO member (id, public_key, name, role, joined_at, revoked_at) VALUES (?, ?, 'Removed device', 'guest', ?, ?)").bind(randomId('m'), delDevice, iso(now), iso(now)).run();
    return json({ ok: true });
  }
  if (method === 'GET' && path === '/v1/members') {
    const rows = await env.DB.prepare('SELECT id, name, role, person_id AS personId, joined_at AS joinedAt, revoked_at AS revokedAt FROM member ORDER BY joined_at').all();
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
