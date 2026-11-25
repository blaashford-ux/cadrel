import { beforeEach, describe, expect, it } from 'vitest';
import { CONDITION_KINDS, approveVersion, artFacts, cleanConditions, createAsset, recordRun, revokeApproval, unmetConditions, waiveResult, type Ctx, type Db, type ProjectFacts } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
const at = (actor = 'ana'): Ctx => ({ studioId: 's1', actor, now: `2026-11-19T10:00:${String(clock++).padStart(2, '0')}Z` });
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ hasManuscript: false, openNotes: 0, subprojects: [], openTasks: 0, approved: [], ...over });
const run = (file: string, errors: number, project = 'book') => recordRun(db, at(), { projectId: project, fileId: file, fileVersion: 1, fileHash: 'h', packId: 'kdp', packVersion: '1', findings: Array.from({ length: errors }, (_v, i) => ({ ruleId: `r${i}`, grade: 'error' as const, what: 'Wrong.', location: `l${i}` })) });

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  for (const id of ['cov', 'banner', 'e1', 'e2']) {
    await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, 's1', ?, 1)", [id, `${id}.x`]);
    await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, 1, ?, 1, 'x', '2026-11-01T00:00:00Z')", [id, `h-${id}`]);
  }
});

describe('the cover and Preflight gate conditions', () => {
  it('are conditions an administrator can add, with no label to give', () => {
    expect(CONDITION_KINDS.cover_approved).toMatch(/approved cover/);
    expect(CONDITION_KINDS.preflight_clear).toMatch(/no open errors/);
    expect(cleanConditions([{ kind: 'cover_approved' }, { kind: 'cover_approved' }, { kind: 'preflight_clear' }])).toEqual([{ kind: 'cover_approved' }, { kind: 'preflight_clear' }]);
  });

  it('a cover is needed first; a Preflight check is needed, then no open error', () => {
    expect(unmetConditions(facts(), [{ kind: 'cover_approved' }])).toEqual(['Needs an approved cover']);
    expect(unmetConditions(facts({ art: { approvedCovers: 0, checked: 0, openErrors: 0 } }), [{ kind: 'cover_approved' }])).toEqual(['Needs an approved cover']);
    expect(unmetConditions(facts({ art: { approvedCovers: 1, checked: 0, openErrors: 0 } }), [{ kind: 'cover_approved' }])).toEqual([]);
    const pf = [{ kind: 'preflight_clear' as const }];
    expect(unmetConditions(facts(), pf)).toEqual(['Needs a Preflight check']);
    expect(unmetConditions(facts({ art: { approvedCovers: 1, checked: 0, openErrors: 0 } }), pf)).toEqual(['Needs a Preflight check']);
    expect(unmetConditions(facts({ art: { approvedCovers: 0, checked: 1, openErrors: 1 } }), pf)).toEqual(['1 Preflight error is still open']);
    expect(unmetConditions(facts({ art: { approvedCovers: 0, checked: 2, openErrors: 4 } }), pf)).toEqual(['4 Preflight errors are still open']);
    expect(unmetConditions(facts({ art: { approvedCovers: 0, checked: 1, openErrors: 0 } }), pf)).toEqual([]);
  });
});

describe('what a gate sees of a project’s art', () => {
  it('is nothing before any cover or run', async () => {
    expect(await artFacts(db, { studioId: 's1' }, ['book'])).toEqual({ approvedCovers: 0, checked: 0, openErrors: 0 });
    expect(await artFacts(db, { studioId: 's1' }, [])).toEqual({ approvedCovers: 0, checked: 0, openErrors: 0 });
  });

  it('counts approved covers (not other art, not a cover whose approval was taken back, not another book’s)', async () => {
    const cover = await createAsset(db, at(), { projectId: 'book', fileId: 'cov', kind: 'cover' });
    const banner = await createAsset(db, at(), { projectId: 'book', fileId: 'banner', kind: 'banner' });
    expect((await artFacts(db, { studioId: 's1' }, ['book'])).approvedCovers).toBe(0); // a draft cover is not approved
    await approveVersion(db, at(), banner.id, 1);
    expect((await artFacts(db, { studioId: 's1' }, ['book'])).approvedCovers).toBe(0); // approved, but a banner
    await approveVersion(db, at(), cover.id, 1);
    expect((await artFacts(db, { studioId: 's1' }, ['book'])).approvedCovers).toBe(1);
    expect((await artFacts(db, { studioId: 's1' }, ['other'])).approvedCovers).toBe(0);
    await revokeApproval(db, at(), cover.id, 1, 'Wrong trim.');
    expect((await artFacts(db, { studioId: 's1' }, ['book'])).approvedCovers).toBe(0);
  });

  it('counts only the newest Preflight run of each EPUB, and a waived error is not open', async () => {
    await run('e1', 3);
    expect(await artFacts(db, { studioId: 's1' }, ['book'])).toEqual({ approvedCovers: 0, checked: 1, openErrors: 3 });
    await run('e1', 1); // newer: the three no longer count
    await run('e2', 2);
    expect(await artFacts(db, { studioId: 's1' }, ['book'])).toEqual({ approvedCovers: 0, checked: 2, openErrors: 3 });
    const newest = await run('e2', 2);
    await waiveResult(db, at(), newest.run.id, 1, 'Accepted.');
    expect(await artFacts(db, { studioId: 's1' }, ['book'])).toEqual({ approvedCovers: 0, checked: 2, openErrors: 2 });
    expect((await artFacts(db, { studioId: 's1' }, ['elsewhere'])).checked).toBe(0);
  });
});
