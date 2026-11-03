import { beforeEach, describe, expect, it } from 'vitest';
import { WorkError, briefVersions, createBrief, getBrief, listBriefs, reviseBrief, type Ctx } from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db;
const at = (actor = 'ana', now = '2026-11-03T10:00:00.000Z'): Ctx => ({ studioId: 's1', actor, now });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
beforeEach(() => {
  db = memoryDb();
});

describe('briefs', () => {
  it('makes a brief with a first version and finds it by project and kind', async () => {
    const m = await createBrief(db, at(), { projectId: 'p1', kind: 'manuscript', title: ' Book one brief ', body: 'A slow-burn thriller.\r\nNo cliffhangers.' });
    await createBrief(db, at(), { projectId: 'p1', kind: 'edit', title: 'Developmental', body: 'Look at pacing in act two.' });
    await createBrief(db, at(), { projectId: 'p2', kind: 'edit', title: 'Elsewhere', body: 'x' });
    expect(m.title).toBe('Book one brief');
    expect(m.current).toMatchObject({ n: 1, body: 'A slow-burn thriller.\nNo cliffhangers.', writtenBy: 'ana' });
    expect((await listBriefs(db, at(), { projectId: 'p1' })).map((b) => b.title)).toEqual(['Book one brief', 'Developmental']);
    expect((await listBriefs(db, at(), { projectId: 'p1', kind: 'edit' })).map((b) => b.title)).toEqual(['Developmental']);
    expect((await listBriefs(db, at(), { projectIds: ['p1', 'p2'], kind: 'edit' })).map((b) => b.title)).toEqual(['Developmental', 'Elsewhere']);
    expect(await listBriefs(db, at(), { projectIds: [] })).toEqual([]);
  });

  it('keeps every revision: the new version is the current one and the old ones stay readable', async () => {
    const b = await createBrief(db, at(), { projectId: 'p1', kind: 'edit', title: 'Line edit', body: 'Tighten dialogue.' });
    const r = await reviseBrief(db, at('bo', '2026-11-04T10:00:00.000Z'), b.id, { body: 'Tighten dialogue and cut filter words.', note: 'added filter words', basedOn: 1 });
    expect(r.current).toMatchObject({ n: 2, writtenBy: 'bo', note: 'added filter words' });
    const all = await briefVersions(db, at(), b.id);
    expect(all.map((v) => [v.n, v.body])).toEqual([[1, 'Tighten dialogue.'], [2, 'Tighten dialogue and cut filter words.']]);
    expect((await getBrief(db, at(), b.id))!.current.n).toBe(2);
  });

  it('refuses a revision made from an older version, so two editors cannot overwrite each other', async () => {
    const b = await createBrief(db, at(), { projectId: 'p1', kind: 'edit', title: 'Copy edit', body: 'v1' });
    await reviseBrief(db, at(), b.id, { body: 'v2', basedOn: 1 });
    expect(await code(reviseBrief(db, at(), b.id, { body: 'v2 from the other editor', basedOn: 1 }))).toBe('conflict');
    expect((await briefVersions(db, at(), b.id)).length).toBe(2);
  });

  it('checks what it is given', async () => {
    const ok = { projectId: 'p1', kind: 'edit' as const, title: 'T', body: 'B' };
    expect(await code(createBrief(db, at(), { ...ok, projectId: '' }))).toBe('invalid');
    expect(await code(createBrief(db, at(), { ...ok, kind: 'cover' as never }))).toBe('invalid');
    expect(await code(createBrief(db, at(), { ...ok, title: '  ' }))).toBe('invalid');
    expect(await code(createBrief(db, at(), { ...ok, body: '' }))).toBe('invalid');
    expect(await code(createBrief(db, at(), { ...ok, body: 'x'.repeat(100_001) }))).toBe('invalid');
    const b = await createBrief(db, at(), ok);
    expect(await code(reviseBrief(db, at(), b.id, { body: 'B', basedOn: 1 }))).toBe('invalid'); // nothing changed
    expect(await code(reviseBrief(db, at(), b.id, { body: ' ', basedOn: 1 }))).toBe('invalid');
    expect(await code(reviseBrief(db, at(), 'nope', { body: 'x', basedOn: 1 }))).toBe('not-found');
    expect(await code(briefVersions(db, at(), 'nope'))).toBe('not-found');
  });

  it('a title change alone is a new version, and the audit log records the work', async () => {
    const b = await createBrief(db, at(), { projectId: 'p1', kind: 'manuscript', title: 'Old', body: 'Same' });
    const r = await reviseBrief(db, at(), b.id, { body: 'Same', title: 'New', basedOn: 1 });
    expect([r.title, r.current.n]).toEqual(['New', 2]);
    const log = await db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'brief.%' ORDER BY rowid");
    expect(log.map((l) => l.action)).toEqual(['brief.create', 'brief.revise']);
  });

  it('does not show another studio’s briefs', async () => {
    const b = await createBrief(db, at(), { projectId: 'p1', kind: 'edit', title: 'T', body: 'B' });
    expect(await getBrief(db, { studioId: 's2' }, b.id)).toBeNull();
    expect(await listBriefs(db, { studioId: 's2' })).toEqual([]);
  });
});
