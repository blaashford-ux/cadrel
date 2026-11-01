/**
 * What a Studio's server does for the people in it, beyond knowing who they are (studio.ts): it holds the records and answers the service's calls
 * as the person whose key signed the request, it holds the vault (the lock rules, the versions) with the files' contents in R2, and it holds
 * the project tree the owner publishes. Every check is the service's, made here, so a changed app cannot skip one.
 *
 *   POST /v1/call    { path: ['catalogue', 'books'], args: [...] }   the service's calls, as the signed-in person
 *   POST /v1/vault   { method: 'checkOut', args: [{...}] }           the vault's operations, as the signed-in person
 *   PUT  /v1/blobs/<sha256>  (the file's bytes)                       a version's contents, stored by their hash
 *   GET  /v1/blobs/<sha256>                                           ...and read back, only by someone who may read a file that has them
 *   GET  /v1/tree  /  PUT /v1/tree                                    the project tree: each person sees their own projects; the owner publishes it
 */
import { sanitizeTree, sha256, hex, visibleTree, VAULT_STORE_METHODS } from '@cadrel/kernel';
import { VaultAs, decodeValue, encodeError, encodeValue } from '@cadrel/service';
import { readTree, serviceFor, writeTree, type RecordsEnv } from './records';
import { captureRoutes, isCaptureRoute } from './captures';

export interface ServerEnv extends RecordsEnv {
  FILES?: R2Bucket;
}

/** What a caller may reach on the service by name. A list, so nothing inherited (`constructor`) or private is. */
const NAMESPACES = new Set(['catalogue', 'people', 'business', 'work', 'workflows']);
const METHODS = new Set(['can', 'canOn', 'canAt', 'explain', 'visibleProjects']);
/** The largest file the Worker takes in one request (its request body limit is 100 MB). */
export const MAX_BLOB = 95 * 1024 * 1024;

const respond = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const ok = (value: unknown) => respond(encodeValue({ result: value === undefined ? null : value }));
const fail = (status: number, error: string) => respond(JSON.stringify({ error }), status);
const failed = (e: unknown) => {
  const w = encodeError(e);
  return w ? respond(JSON.stringify(w), w.kind === 'PermissionDenied' ? 403 : 422) : fail(500, 'The Studio could not do that.');
};

export const isServerRoute = (path: string): boolean => isCaptureRoute(path) || path === '/v1/call' || path === '/v1/vault' || path === '/v1/tree' || /^\/v1\/blobs\/[0-9a-f]{64}$/.test(path);

const blobKey = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash}`;

export async function serverRoutes(request: Request, env: ServerEnv, who: { kind: 'owner' | 'member' }, personId: string, body: string | Uint8Array, now: number): Promise<Response> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const { service, db } = serviceFor(env, now);
  const as = service.as(personId);

  if (isCaptureRoute(path)) return captureRoutes(request, env.FILES, as, body);

  if (path === '/v1/tree') {
    if (method === 'GET') {
      const tree = await readTree(db);
      return ok(visibleTree(tree, await as.visibleProjects(tree)));
    }
    if (method === 'PUT') {
      if (who.kind !== 'owner') return fail(403, 'Only the Studio’s owner can publish its projects.');
      let raw: unknown;
      try {
        raw = JSON.parse(String(body));
      } catch {
        return fail(400, 'The request was not understood.');
      }
      await writeTree(db, sanitizeTree(raw));
      return ok(true);
    }
    return fail(405, 'That is not something the Studio does.');
  }

  if (path === '/v1/call' && method === 'POST') {
    let req: { path?: unknown; args?: unknown };
    try {
      req = decodeValue(String(body)) as typeof req;
    } catch {
      return fail(400, 'The request was not understood.');
    }
    const names = Array.isArray(req.path) && req.path.every((x) => typeof x === 'string') ? (req.path as string[]) : null;
    const args = Array.isArray(req.args) ? req.args : [];
    if (!names || names.length < 1 || names.length > 2) return fail(400, 'That is not something the Studio does.');
    let target: unknown = as;
    let parent: unknown = as;
    if (names.length === 1) {
      if (!METHODS.has(names[0]!)) return fail(400, 'That is not something the Studio does.');
      target = (as as unknown as Record<string, unknown>)[names[0]!];
    } else {
      if (!NAMESPACES.has(names[0]!) || !Object.hasOwn(as, names[0]!)) return fail(400, 'That is not something the Studio does.');
      parent = (as as unknown as Record<string, unknown>)[names[0]!];
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, names[1]!)) return fail(400, 'That is not something the Studio does.');
      target = (parent as Record<string, unknown>)[names[1]!];
    }
    if (typeof target !== 'function') return fail(400, 'That is not something the Studio does.');
    try {
      return ok(await (target as (...a: unknown[]) => unknown).apply(parent, args));
    } catch (e) {
      return failed(e);
    }
  }

  if (path === '/v1/vault' && method === 'POST') {
    let req: { method?: unknown; args?: unknown };
    try {
      req = decodeValue(String(body)) as typeof req;
    } catch {
      return fail(400, 'The request was not understood.');
    }
    const name = typeof req.method === 'string' ? req.method : '';
    if (!(VAULT_STORE_METHODS as readonly string[]).includes(name)) return fail(400, 'That is not something the vault does.');
    const arg = Array.isArray(req.args) ? req.args[0] : undefined;
    const vault = new VaultAs({ db, studioId: env.STUDIO_ID, personId, as, now: () => new Date(now), hasBlob: async (hash) => !!env.FILES && !!(await env.FILES.head(blobKey(hash))) });
    try {
      return ok(await (vault as unknown as Record<string, (a: unknown) => Promise<unknown>>)[name]!(arg));
    } catch (e) {
      return failed(e);
    }
  }

  const blob = /^\/v1\/blobs\/([0-9a-f]{64})$/.exec(path);
  if (blob) {
    const hash = blob[1]!;
    if (!env.FILES) return fail(503, 'This Studio has no file store.');
    if (method === 'PUT') {
      // anyone who may write a manuscript or an asset somewhere may store contents; they are reachable only through a file record
      if (!((await as.canOn('manuscript.write', null)) || (await as.canOn('asset.write', null)))) return fail(403, 'You are not allowed to add files to this Studio.');
      const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
      if (bytes.length > MAX_BLOB) return fail(413, 'That file is too large for the Studio server (the limit is 95 MB).');
      if (hex(await sha256(bytes)) !== hash) return fail(400, 'The contents do not match their hash.');
      if (!(await env.FILES.head(blobKey(hash)))) await env.FILES.put(blobKey(hash), bytes);
      return ok(true);
    }
    if (method === 'GET') {
      // only contents of a version of a file this person may read
      const holders = await db.all<{ id: string }>('SELECT DISTINCT file_id AS id FROM file_version WHERE hash = ?', [hash]);
      const readable = new Set((await new VaultAs({ db, studioId: env.STUDIO_ID, personId, as }).list()).map((f) => f.id));
      if (!holders.some((h) => readable.has(h.id))) return fail(404, 'There is no such file.');
      const obj = await env.FILES.get(blobKey(hash));
      if (!obj) return fail(404, 'There is no such file.');
      return new Response(await obj.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
  }
  return fail(405, 'That is not something the Studio does.');
}
