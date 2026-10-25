import { ArcticShift } from '../src/index.js';

/** A stand-in for Arctic Shift: serves from fixed arrays, honouring after/before/sort/limit like the real thing. */
export function fakeArctic(data: { posts: any[]; comments: any[] }, log: string[] = []) {
  const f = (async (url: string) => {
    const u = new URL(url);
    log.push(u.pathname + '?' + u.searchParams.toString());
    const q = u.searchParams;
    const page = (rows: any[]) => rows.filter((r) => r.created_utc > Number(q.get('after') ?? 0) && r.created_utc < Number(q.get('before') ?? 1e12)).sort((a, b) => a.created_utc - b.created_utc).slice(0, 100);
    const body =
      u.pathname === '/api/posts/search' ? page(data.posts)
      : u.pathname === '/api/comments/search' ? page(data.comments)
      : data.posts.filter((p) => (q.get('ids') ?? '').split(',').includes(p.id));
    return new Response(JSON.stringify({ data: body }), { status: 200 });
  }) as unknown as typeof fetch;
  return new ArcticShift({ fetch: f, delayMs: 0, sleep: async () => {} });
}
