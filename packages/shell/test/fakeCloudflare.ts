// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
import http from 'node:http';
import worker, { type Env } from '../../worker/src/index';
import { fakeD1 } from '../../worker/test/d1fake';
import { fakeR2 } from '../../worker/test/r2fake';

export const ACCOUNT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const TOKEN = 'cf-token-0123456789abcdefghijklmnopqrstuv';
const json = (result: unknown, status = 200, success = true, errors: unknown[] = []) => new Response(JSON.stringify({ success, result, errors }), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stand-in for Cloudflare that does what the real API does for the calls the app makes: it keeps databases, buckets and Workers, and a
 * Worker it is given really runs (the same code the app ships), bound to its own database and the settings it was uploaded with.
 */
export function fakeCloudflare(opts: { subdomain?: string | null; allowedToken?: string } = {}) {
  const db = new Map<string, { uuid: string; name: string }>();
  const buckets = new Set<string>();
  const workers = new Map<string, { env: Env; source: string; bindings: unknown[] }>();
  const calls: string[] = [];
  const dbs = new Map<string, D1Database>();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'api.cloudflare.com') {
      calls.push(`${method} ${url.pathname.replace(ACCOUNT, 'A')}`);
      const auth = (init?.headers as Record<string, string>)?.authorization;
      if (auth !== `Bearer ${opts.allowedToken ?? TOKEN}`) return json(null, 401, false, [{ message: 'Invalid token' }]);
      const p = url.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '');
      if (p === '/workers/subdomain') return json({ subdomain: opts.subdomain === undefined ? 'me' : opts.subdomain });
      if (p === '/d1/database' && method === 'GET') return json([...db.values()].filter((d) => d.name === url.searchParams.get('name')));
      if (p === '/d1/database' && method === 'POST') {
        const name = JSON.parse(String(init!.body)).name as string;
        const d = { uuid: `uuid-${db.size + 1}`, name };
        db.set(d.uuid, d);
        dbs.set(d.uuid, fakeD1());
        return json(d);
      }
      const bucket = /^\/r2\/buckets\/?([\w-]*)$/.exec(p);
      if (bucket && method === 'GET') return buckets.has(bucket[1]!) ? json({ name: bucket[1] }) : json(null, 404, false, [{ message: 'no such bucket' }]);
      if (bucket && method === 'POST') return buckets.add(JSON.parse(String(init!.body)).name), json({});
      const script = /^\/workers\/scripts\/([\w-]+)$/.exec(p);
      if (script && method === 'PUT') {
        const form = init!.body as FormData;
        const meta = JSON.parse(await (form.get('metadata') as Blob).text()) as { bindings: { type: string; name: string; id?: string; text?: string }[] };
        const source = await (form.get('worker.mjs') as Blob).text();
        const env: Record<string, unknown> = { FILES: fakeR2() };
        for (const b of meta.bindings) {
          if (b.type === 'd1') env.DB = dbs.get(b.id!) ?? (() => { throw new Error('no such database'); })();
          if (b.type === 'plain_text') env[b.name] = b.text;
        }
        workers.set(script[1]!, { env: env as unknown as Env, source, bindings: meta.bindings });
        return json({});
      }
      if (/^\/workers\/scripts\/[\w-]+\/subdomain$/.test(p)) return json({ enabled: true });
      return json(null, 404, false, [{ message: `unexpected ${method} ${p}` }]);
    }
    // a Worker address
    const w = workers.get(url.hostname.split('.')[0]!);
    if (!w) return new Response('no worker', { status: 404 });
    return worker.fetch(new Request(url, init as RequestInit), w.env);
  }) as unknown as typeof fetch;
  return { fetchFn, db, buckets, workers, calls };
}


/**
 * Serves the stand-in over HTTP on this computer, for the app itself to talk to (CADREL_TEST_CF): Cloudflare's API under /client/v4 and each
 * uploaded Worker under /w/<name>. Several app instances can share it, which is how two people's computers are played in a test.
 */
export async function serveFakeCloudflare(opts: Parameters<typeof fakeCloudflare>[0] = {}) {
  const fc = fakeCloudflare(opts);
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://x');
      const w = /^\/w\/([\w-]+)(\/.*)?$/.exec(url.pathname);
      const target = url.pathname.startsWith('/client/v4/') ? `https://api.cloudflare.com${url.pathname}${url.search}` : w ? `https://${w[1]}.me.workers.dev${w[2] ?? '/'}${url.search}` : null;
      if (!target) return void res.writeHead(404).end();
      const type = String(req.headers['content-type'] ?? '');
      const init: RequestInit = { method: req.method, headers: req.headers as Record<string, string> };
      if (type.startsWith('multipart/form-data')) init.body = await new Request('http://x', { method: 'POST', headers: { 'content-type': type }, body }).formData();
      else if (body.length) init.body = body.toString();
      const r = await fc.fetchFn(target, init);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { ...fc, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
