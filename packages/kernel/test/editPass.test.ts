import { beforeEach, describe, expect, it } from 'vitest';
import { WorkError, assignEditor, createBrief, createPass, createPerson, getPass, listPasses, movePass, reviseBrief, type Ctx } from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db, ana: string, bo: string, fileA: string, fileB: string, brief: string;
const at = (actor = 'ana', now = '2026-11-03T10:00:00.000Z'): Ctx => ({ studioId: 's1', actor, now });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));

async function addFile(id: string, versions: number) {
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, 's1', ?, ?)", [id, `${id}.md`, versions]);
  for (let n = 1; n <= versions; n++) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, ?, ?, 1, 'ana', '2026-11-01T00:00:00.000Z')", [id, n, `h${id}${n}`]);
}
beforeEach(async () => {
  db = memoryDb();
  const c = { studioId: 's1', actor: 'system', now: '2026-11-03T09:00:00.000Z' };
  ana = (await createPerson(db, c, { name: 'Ana' })).id;
  bo = (await createPerson(db, c, { name: 'Bo' })).id;
  await addFile('f1', 3);
  await addFile('f2', 1);
  fileA = 'f1';
  fileB = 'f2';
  brief = (await createBrief(db, at(), { projectId: 'p1', kind: 'edit', title: 'Line edit brief', body: 'Cut filter words.' })).id;
});

describe('editorial passes', () => {
  it('plans a pass over the file’s current version and the brief’s current version, with a default title', async () => {
    await reviseBrief(db, at(), brief, { body: 'Cut filter words and adverbs.', basedOn: 1 });
    const p = await createPass(db, at(), { projectId: 'p1', kind: 'line', fileId: fileA, briefId: brief, editorId: bo });
    expect(p).toMatchObject({ state: 'planned', title: 'Line edit', fileVersion: 3, briefId: brief, briefVersion: 2, editorId: bo, createdBy: 'ana' });
  });

  it('pins the version it was given, so later versions of the manuscript do not move it', async () => {
    const p = await createPass(db, at(), { projectId: 'p1', kind: 'developmental', fileId: fileA, fileVersion: 2, editorId: bo, title: 'Big picture' });
    expect([p.title, p.fileVersion]).toEqual(['Big picture', 2]);
    await db.run("UPDATE vault_file SET current_version = 4 WHERE id = 'f1'");
    await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 4, 'h4', 1, 'ana', '2026-11-05T00:00:00.000Z')");
    expect((await getPass(db, at(), p.id))!.fileVersion).toBe(2);
  });

  it('checks what it is given', async () => {
    const ok = { projectId: 'p1', kind: 'copy' as const, fileId: fileA, editorId: bo };
    expect(await code(createPass(db, at(), { ...ok, projectId: '' }))).toBe('invalid');
    expect(await code(createPass(db, at(), { ...ok, kind: 'cover' as never }))).toBe('invalid');
    expect(await code(createPass(db, at(), { ...ok, editorId: '' }))).toBe('invalid');
    expect(await code(createPass(db, at(), { ...ok, title: 'x'.repeat(201) }))).toBe('invalid');
    expect(await code(createPass(db, at(), { ...ok, fileId: 'nope' }))).toBe('not-found');
    expect(await code(createPass(db, at(), { ...ok, fileVersion: 9 }))).toBe('not-found');
    expect(await code(createPass(db, at(), { ...ok, fileVersion: 0 }))).toBe('not-found');
    expect(await code(createPass(db, at(), { ...ok, editorId: 'nobody' }))).toBe('not-found');
    expect(await code(createPass(db, at(), { ...ok, briefId: 'nope' }))).toBe('not-found');
    expect(await code(createPass(db, at(), { ...ok, briefId: brief, briefVersion: 5 }))).toBe('not-found');
    expect(await code(createPass(db, at(), { ...ok, projectId: 'p2', briefId: brief }))).toBe('invalid'); // another project's brief
    const m = await createBrief(db, at(), { projectId: 'p1', kind: 'manuscript', title: 'M', body: 'm' });
    expect(await code(createPass(db, at(), { ...ok, briefId: m.id }))).toBe('invalid'); // a manuscript brief is not an edit brief
  });

  it('will not plan a second live pass of a kind on a file, but will once the first is closed or cancelled', async () => {
    const ok = { projectId: 'p1', kind: 'line' as const, fileId: fileA, editorId: bo };
    const first = await createPass(db, at(), ok);
    expect(await code(createPass(db, at(), ok))).toBe('exists');
    expect(await code(createPass(db, at(), { ...ok, kind: 'copy' }))).toBe('ok'); // another kind is fine
    expect(await code(createPass(db, at(), { ...ok, fileId: fileB }))).toBe('ok'); // another file is fine
    await movePass(db, at(), first.id, 'cancelled');
    expect(await code(createPass(db, at(), ok))).toBe('ok');
  });

  it('runs planned, in progress, delivered, responded, closed, stamping each step', async () => {
    const p = await createPass(db, at(), { projectId: 'p1', kind: 'line', fileId: fileA, editorId: bo });
    const step = async (to: Parameters<typeof movePass>[3], who: string, when: string) => movePass(db, at(who, `2026-11-0${when}T10:00:00.000Z`), p.id, to);
    expect((await step('in_progress', bo, '4')).startedAt).toBe('2026-11-04T10:00:00.000Z');
    expect((await step('delivered', bo, '5')).deliveredAt).toBe('2026-11-05T10:00:00.000Z');
    expect((await step('responded', ana, '6')).respondedAt).toBe('2026-11-06T10:00:00.000Z');
    const closed = await step('closed', ana, '7');
    expect(closed).toMatchObject({ state: 'closed', closedAt: '2026-11-07T10:00:00.000Z', closedBy: ana });
    const log = await db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'pass.%' ORDER BY rowid");
    expect(log.map((l) => l.action)).toEqual(['pass.create', 'pass.in_progress', 'pass.delivered', 'pass.responded', 'pass.closed']);
  });

  it('refuses a move the path does not have, and names where the pass can go', async () => {
    const p = await createPass(db, at(), { projectId: 'p1', kind: 'line', fileId: fileA, editorId: bo });
    const err = (await movePass(db, at(), p.id, 'closed').catch((e) => e)) as WorkError;
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err.message).toContain('in progress, cancelled');
    expect(await code(movePass(db, at(), p.id, 'delivered'))).toBe('conflict');
    expect(await code(movePass(db, at(), p.id, 'bogus' as never))).toBe('invalid');
    expect(await code(movePass(db, at(), 'nope', 'in_progress'))).toBe('not-found');
    await movePass(db, at(), p.id, 'cancelled');
    expect(await code(movePass(db, at(), p.id, 'in_progress'))).toBe('conflict'); // final
  });

  it('lists live passes by default and filters by project, editor, file, kind and state', async () => {
    const a = await createPass(db, at(), { projectId: 'p1', kind: 'line', fileId: fileA, editorId: bo });
    const b = await createPass(db, at(), { projectId: 'p2', kind: 'copy', fileId: fileB, editorId: ana });
    const c = await createPass(db, at(), { projectId: 'p1', kind: 'copy', fileId: fileA, editorId: bo });
    await movePass(db, at(), c.id, 'cancelled');
    expect((await listPasses(db, at())).map((p) => p.id)).toEqual([a.id, b.id]);
    expect((await listPasses(db, at(), { state: 'any' })).length).toBe(3);
    expect((await listPasses(db, at(), { state: 'cancelled' })).map((p) => p.id)).toEqual([c.id]);
    expect((await listPasses(db, at(), { projectId: 'p2' })).map((p) => p.id)).toEqual([b.id]);
    expect((await listPasses(db, at(), { editorId: bo })).map((p) => p.id)).toEqual([a.id]);
    expect((await listPasses(db, at(), { fileId: fileB })).map((p) => p.id)).toEqual([b.id]);
    expect((await listPasses(db, at(), { kind: 'line' })).map((p) => p.id)).toEqual([a.id]);
    expect(await listPasses(db, at(), { projectIds: [] })).toEqual([]);
    expect(await listPasses(db, { studioId: 's2' }, { state: 'any' })).toEqual([]);
  });

  it('changes editor only before delivery', async () => {
    const p = await createPass(db, at(), { projectId: 'p1', kind: 'line', fileId: fileA, editorId: bo });
    expect((await assignEditor(db, at(), p.id, ana)).editorId).toBe(ana);
    expect(await code(assignEditor(db, at(), p.id, 'nobody'))).toBe('not-found');
    expect(await code(assignEditor(db, at(), p.id, ''))).toBe('invalid');
    await movePass(db, at(), p.id, 'in_progress');
    expect((await assignEditor(db, at(), p.id, bo)).editorId).toBe(bo);
    await movePass(db, at(), p.id, 'delivered');
    expect(await code(assignEditor(db, at(), p.id, ana))).toBe('conflict');
  });
});
