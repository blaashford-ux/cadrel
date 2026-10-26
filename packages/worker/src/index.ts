import { d1Db } from './d1';
import { ensureSchema } from './schema';
import { studioRoutes, type StudioEnv } from './studio';

export interface Env extends Partial<StudioEnv> {
  DB: D1Database;
  FILES: R2Bucket;
  ENVIRONMENT: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Health: proves the Worker can reach its database (and that migrations have created the vault tables) and its
 * file bucket. It reveals nothing about studio data. Sign-in and the vault endpoints arrive with M2; until a caller
 * can be authenticated there is deliberately nothing else here.
 */
export async function health(env: Env): Promise<Response> {
  const checks: Record<string, string> = {};
  try {
    await ensureSchema(env.DB);
    await d1Db(env.DB).first('SELECT COUNT(*) AS n FROM vault_file');
    checks.database = 'ok';
  } catch {
    checks.database = 'unavailable';
  }
  try {
    await env.FILES.head('health-check');
    checks.files = 'ok';
  } catch {
    checks.files = 'unavailable';
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  return json({ ok, environment: env.ENVIRONMENT, ...checks }, ok ? 200 : 503);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/health') return health(env);
    // A Studio built by the app has an owner key; the Worker deployed by hand for development does not, and serves health only.
    if (env.OWNER_KEY && env.STUDIO_ID) {
      const r = await studioRoutes(request, env as StudioEnv);
      if (r) return r;
    }
    return json({ error: 'not found' }, 404);
  }
} satisfies ExportedHandler<Env>;
