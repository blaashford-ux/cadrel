import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { fakeD1 } from './d1fake';

function env(over: Partial<{ db: 'ok' | 'fail'; files: 'ok' | 'fail' }> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    DB: over.db === 'fail' ? ({ prepare: () => { throw new Error('no such table'); } } as unknown as D1Database) : fakeD1(),
    FILES: { head: async () => { if (over.files === 'fail') throw new Error('down'); return null; } } as unknown as R2Bucket
  };
}
const get = (path: string, e: Env) => worker.fetch(new Request(`https://x.test${path}`), e);

describe('worker', () => {
  it('health is ok when the database and bucket answer', async () => {
    const r = await get('/v1/health', env());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, environment: 'test', database: 'ok', files: 'ok' });
  });

  it('health is 503 and names what failed, with no detail', async () => {
    const r = await get('/v1/health', env({ db: 'fail' }));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, database: 'unavailable', files: 'ok' });
  });

  it('everything else is 404', async () => {
    expect((await get('/v1/files', env())).status).toBe(404);
    expect((await worker.fetch(new Request('https://x.test/v1/health', { method: 'POST' }), env())).status).toBe(404);
  });
});
