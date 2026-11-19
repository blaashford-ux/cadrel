import { beforeEach, describe, expect, it } from 'vitest';
import { WorkError, getRun, latestRun, listRuns, recordRun, waiveResult, type Ctx, type Db, type Finding } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
const ctx = (actor: string): Ctx => ({ studioId: 's1', actor, now: `2026-11-19T10:00:${String(clock++).padStart(2, '0')}Z` });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
const f = (o: Partial<Finding> = {}): Finding => ({ ruleId: 'epub.manifest', grade: 'error', what: 'A manifest item is missing.', location: 'OEBPS/content.opf', measured: 'ch3.xhtml absent', expected: 'every item present', ...o });
const run = (findings: Finding[], o: { version?: number } = {}) =>
  recordRun(db, ctx('ed'), { projectId: 'book1', editionId: 'ed1', fileId: 'epub', fileVersion: o.version ?? 1, fileHash: 'h', packId: 'kdp', packVersion: '1', packVerified: '2026-11-19', notChecked: ['Print interiors'], findings });

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('epub', 's1', 'Exports/book.epub', 2)");
});

describe('preflight runs', () => {
  it('records a run with its results, worst first, each saying what was measured and what was expected', async () => {
    const { run: r, results } = await run([f({ grade: 'suggestion', ruleId: 'meta.keywords', what: 'Fewer than seven keywords.' }), f(), f({ grade: 'warning', ruleId: 'nav.order', what: 'Contents out of order.' })]);
    expect(r).toMatchObject({ errors: 1, warnings: 1, suggestions: 1, ready: false, packId: 'kdp', packVerified: '2026-11-19', notChecked: ['Print interiors'], runBy: 'ed' });
    expect(results.map((x) => x.grade)).toEqual(['error', 'warning', 'suggestion']);
    expect(results[0]).toMatchObject({ what: 'A manifest item is missing.', measured: 'ch3.xhtml absent', expected: 'every item present', state: 'open' });
  });

  it('a run with no error is ready; a result without a grade, a rule or words is refused', async () => {
    expect((await run([f({ grade: 'warning' })])).run.ready).toBe(true);
    expect(await code(run([f({ grade: 'fatal' as never })]))).toBe('invalid');
    expect(await code(run([f({ what: ' ' })]))).toBe('invalid');
    expect(await code(recordRun(db, ctx('ed'), { projectId: 'b', fileId: 'nope', fileVersion: 1, fileHash: 'h', packId: 'kdp', packVersion: '1', findings: [] }))).toBe('not-found');
  });

  it('a waiver needs a reason, lowers the count, and carries onto the next run of the same file, marked as carried', async () => {
    const first = await run([f(), f({ ruleId: 'cover.size', what: 'Cover is small.', location: 'cover.jpg' })]);
    expect(await code(waiveResult(db, ctx('ed'), first.run.id, 1, ' '))).toBe('invalid');
    const w = await waiveResult(db, ctx('ed'), first.run.id, 1, 'The retailer accepts this one.');
    expect(w.run).toMatchObject({ errors: 1 });
    expect(await code(waiveResult(db, ctx('ed'), first.run.id, 1, 'again'))).toBe('conflict');
    const second = await run([f(), f({ ruleId: 'cover.size', what: 'Cover is small.', location: 'cover.jpg' })], { version: 2 });
    expect(second.run.errors).toBe(1); // the waived rule at the same place is not counted
    const carried = second.results.find((x) => x.ruleId === 'epub.manifest')!;
    expect(carried).toMatchObject({ state: 'waived', waivedReason: 'The retailer accepts this one.', carried: true });
    // a different place is not waived
    const third = await run([f({ location: 'OEBPS/other.opf' })], { version: 2 });
    expect(third.results[0]!.state).toBe('open');
  });

  it('lists runs newest first and finds the latest for an edition', async () => {
    const a = await run([f()]);
    const b = await run([]);
    expect((await listRuns(db, ctx('x'), { projectId: 'book1' })).map((r) => r.id)).toEqual([b.run.id, a.run.id]);
    expect((await latestRun(db, ctx('x'), { editionId: 'ed1' }))!.id).toBe(b.run.id);
    expect(await latestRun(db, ctx('x'), { editionId: 'other' })).toBeNull();
    expect((await getRun(db, ctx('x'), a.run.id))!.results.length).toBe(1);
    expect(await getRun(db, { studioId: 'other' }, a.run.id)).toBeNull();
  });
});
