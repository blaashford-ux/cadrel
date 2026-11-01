/**
 * Shared captures. The pages Market saves (a book's page, a category's list, a search) and the covers are public page source, so the people
 * in a Studio share them through its file store: each computer sends the ones the others lack and fetches the ones it lacks, then reads
 * them with its own parsers into its own index. Nothing is ever changed or removed here: a capture is named by when it was made, and
 * sending one the store has already is a no-op. The personal-data scrub happens on the computer that captured, before anything is saved.
 *
 *   GET /v1/captures?cursor=…       the names (and sizes) held so far, a page at a time
 *   PUT /v1/captures/<path>         a capture's file, from someone who may capture
 *   GET /v1/captures/<path>         ...and read back, by someone who may see market research
 */
import type { StudioAs } from '@cadrel/service';

const SEG = '[A-Za-z0-9._-]+';
const STAMP = '\\d{8}T\\d{6}Z';
/** The files a capture is made of, by their place in the library: the same shapes Market's own data packs accept. */
export const CAPTURE_PATH = new RegExp(
  `^(?:books/[A-Z0-9]{10}/snapshots/${STAMP}/(?:capture\\.json|page\\.html\\.gz)|books/[A-Z0-9]{10}/covers/[0-9a-f]{16}\\.[a-z0-9]{2,5}|lists/${SEG}/${SEG}/${SEG}/${STAMP}/(?:capture\\.json|page\\.html\\.gz)|searches/${SEG}/${SEG}/${STAMP}/(?:capture\\.json|page\\.html\\.gz))$`
);
const MAX = 64 * 1024 * 1024;
const PAGE = 1000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => json({ error }, status);

export const isCaptureRoute = (path: string): boolean => path === '/v1/captures' || path.startsWith('/v1/captures/');

export async function captureRoutes(request: Request, files: R2Bucket | undefined, as: StudioAs, body: string | Uint8Array): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!files) return fail(503, 'This Studio has no file store.');

  if (path === '/v1/captures' && method === 'GET') {
    if (!(await as.canOn('market.read', null))) return fail(403, 'You are not allowed to see this Studio’s market research.');
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const r = await files.list({ prefix: 'captures/', limit: PAGE, ...(cursor ? { cursor } : {}) });
    return json({ files: r.objects.map((o) => ({ path: o.key.slice('captures/'.length), size: o.size })), next: r.truncated ? r.cursor : null });
  }

  const rel = decodeURIComponent(path.slice('/v1/captures/'.length));
  if (!CAPTURE_PATH.test(rel)) return fail(400, 'That is not a capture file.');
  const key = `captures/${rel}`;

  if (method === 'PUT') {
    if (!(await as.canOn('market.capture', null))) return fail(403, 'You are not allowed to add captures to this Studio.');
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
    if (bytes.length > MAX) return fail(413, 'That file is too large.');
    if (!(await files.head(key))) await files.put(key, bytes); // append-only: what is there is never replaced
    return json({ ok: true });
  }
  if (method === 'GET') {
    if (!(await as.canOn('market.read', null))) return fail(403, 'You are not allowed to see this Studio’s market research.');
    const obj = await files.get(key);
    if (!obj) return fail(404, 'There is no such capture.');
    return new Response(await obj.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }
  return fail(405, 'That is not something the Studio does.');
}
