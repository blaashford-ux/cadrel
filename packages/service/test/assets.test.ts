import { describe, expect, it } from 'vitest';
import { bootstrapStudio, type Ctx, type ProjectTree } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
let clock = Date.parse('2026-11-19T10:00:00.000Z');
const NOW = () => new Date((clock += 1000));
const T = '2026-01-01T00:00:00.000Z';
const proj = (id: string, name: string, parentId: string | null, kind: string) => ({ id, name, parentId, kind, status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: T, updatedAt: T });
const TREE = { projects: [proj('series', 'Dragon Rider', null, 'Series'), proj('b4', 'Book Four', 'series', 'Book'), proj('other', 'Other Book', null, 'Book')], links: [] } as unknown as ProjectTree;
const kind = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof PermissionDenied ? 'denied' : (e as Error).message || 'error'));

async function studio() {
  const db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => TREE });
  const ana = svc.as('ana');
  const person = async (name: string, roleId: string, projectId?: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId, scope: projectId ? { kind: 'project', id: projectId } : { kind: 'studio', id: S } });
    return svc.as(p.id);
  };
  for (const [id, path, project, n] of [['cov', 'Book Four/Art/cover.psd', 'b4', 3], ['c2', 'Book Four/Art/cover-b.jpg', 'b4', 1], ['epub', 'Book Four/book.epub', 'b4', 1], ['elsewhere', 'Other/art.png', 'other', 1]] as const) {
    await db.run('INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, ?, ?, ?)', [id, S, path, n]);
    for (let v = 1; v <= n; v++) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, ?, ?, 1, 'x', '2026-11-01T00:00:00Z')", [id, v, `${id}-h${v}`]);
    await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES (?, ?, '{}', 'x', 'x')", [id, project]);
  }
  return { db, svc, ana, person };
}

describe('assets: who may do what', () => {
  it('an Artist uploads, an Art Director approves; the Artist cannot approve their own, and the Author only comments', async () => {
    const { person } = await studio();
    const ada = await person('Ada Art', 'role_art_director', 'series');
    const art = await person('Artie', 'role_artist', 'b4');
    const ann = await person('Ann Author', 'role_author', 'b4');
    const a = await art.assets.create({ projectId: 'b4', fileId: 'cov', kind: 'cover' });
    expect(a).toMatchObject({ state: 'draft', projectId: 'b4' });
    expect(await kind(art.assets.approve(a.id, 2))).toBe('denied');
    expect(await kind(ann.assets.create({ projectId: 'b4', fileId: 'c2', kind: 'cover' }))).toBe('denied');
    expect(await kind(art.assets.create({ projectId: 'b4', fileId: 'c2', kind: 'cover', licence: { kind: 'stock' } }))).toBe('denied'); // a licence is asset.manage
    expect((await ada.assets.approve(a.id, 2, 'Good.')).hash).toBe('cov-h2');
    expect(await kind(ann.assets.comment({ targetKind: 'asset', targetId: a.id, region: { x: 0, y: 0, w: 0.5, h: 0.5 }, body: 'Lovely.' }))).toBe('ok');
    expect(await kind(art.assets.retire(a.id, 'x'))).toBe('denied');
    expect((await art.assets.approved(a.id)).map((r) => r.version)).toEqual([2]);
  });

  it('a file from another book cannot be made an asset here; a person with no part in the project sees none', async () => {
    const { person } = await studio();
    const art = await person('Artie', 'role_artist', 'b4');
    expect(await kind(art.assets.create({ projectId: 'b4', fileId: 'elsewhere', kind: 'cover' }))).toMatch(/another book/);
    const a = await art.assets.create({ projectId: 'b4', fileId: 'cov', kind: 'cover' });
    const stranger = await person('Sam', 'role_artist', 'other');
    expect(await stranger.assets.list()).toEqual([]);
    expect(await stranger.assets.get(a.id)).toBeNull();
    expect(await kind(stranger.assets.whereUsed(a.id))).toMatch(/not there/);
    expect(await kind(stranger.assets.approve(a.id, 1))).toMatch(/not there/);
  });

  it('a replacement is proposed by one who writes and decided by one who approves; the proposer may withdraw it', async () => {
    const { person } = await studio();
    const ada = await person('Ada', 'role_art_director', 'series');
    const art = await person('Artie', 'role_artist', 'b4');
    const a = await art.assets.create({ projectId: 'b4', fileId: 'cov', kind: 'cover' });
    await ada.assets.approve(a.id, 1);
    await ada.assets.approve(a.id, 2);
    await art.assets.addUse(a.id, { kind: 'listing', label: 'Amazon US' });
    const r = await art.assets.proposeReplacement(a.id, { fromVersion: 1, toVersion: 2, reason: 'Recoloured.' });
    expect(await kind(art.assets.decideReplacement(r.id, { approve: true }))).toBe('denied');
    const done = await ada.assets.decideReplacement(r.id, { approve: true });
    expect(done.needUpdate.map((u) => u.label)).toEqual(['Amazon US']);
    expect(await kind(art.assets.withdrawReplacement(r.id))).toMatch(/already been approved/);
  });

  it('concepts: a brief for a cover, concepts against it, the Art Director chooses; readiness gives Launch the approved cover and the latest run', async () => {
    const { person } = await studio();
    const ada = await person('Ada', 'role_art_director', 'series');
    const art = await person('Artie', 'role_artist', 'b4');
    const ed = await person('Eve', 'role_editor', 'b4');
    const b = await ada.briefs.create({ projectId: 'b4', kind: 'cover', title: 'Cover', body: 'A dragon at dusk.' });
    expect(await kind(art.briefs.create({ projectId: 'b4', kind: 'cover', title: 'Mine', body: 'x' }))).toBe('denied'); // brief.write
    expect((await art.briefs.list({ kind: 'cover' })).map((x) => x.id)).toEqual([b.id]);
    const k1 = await art.assets.submitConcept({ briefId: b.id, fileId: 'cov', fileVersion: 3 });
    const k2 = await art.assets.submitConcept({ briefId: b.id, fileId: 'c2' });
    expect(await kind(art.assets.chooseConcept(k1.id))).toBe('denied');
    await ada.assets.decideConcept(k2.id, 'rejected', 'Too dark.');
    const { asset } = await ada.assets.chooseConcept(k1.id);
    await ada.assets.approve(asset.id, 3);
    // an EPUB checked by the Editor, who may run Preflight
    expect(await kind(art.preflight.record({ projectId: 'b4', fileId: 'epub', fileVersion: 1, fileHash: 'epub-h1', packId: 'kdp', packVersion: '1', findings: [] }))).toBe('denied');
    const run = await ed.preflight.record({ projectId: 'b4', editionId: 'ed1', fileId: 'epub', fileVersion: 1, fileHash: 'epub-h1', coverAssetId: asset.id, coverVersion: 3, packId: 'kdp', packVersion: '1', findings: [{ ruleId: 'cover.size', grade: 'error', what: 'Cover is small.', measured: '800x600', expected: '1600x2560' }] });
    expect(run.run).toMatchObject({ errors: 1, ready: false });
    await ed.preflight.waive(run.run.id, 1, 'Accepted by the retailer.');
    expect(await kind(art.assets.readiness('series'))).toMatch(/no such project/); // a role on the book reaches the book, not the series above it
    const ready = await ada.assets.readiness('series');
    expect(ready.assets.map((x) => [x.asset.id, x.version])).toEqual([[asset.id, 3]]);
    expect(ready.preflight).toMatchObject({ id: run.run.id, errors: 0, ready: true });
    expect((await ed.preflight.get(run.run.id))!.results[0]).toMatchObject({ state: 'waived' });
    expect(await kind(art.preflight.waive(run.run.id, 1, 'x'))).toBe('denied');
  });
});
