import { describe, expect, it } from 'vitest';
import { bootstrapStudio, imageInfo, type Ctx, type ProjectTree } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
let clock = Date.parse('2026-11-20T10:00:00.000Z');
const NOW = () => new Date((clock += 1000));
const T = '2026-01-01T00:00:00.000Z';
const proj = (id: string, name: string, parentId: string | null, kind: string) => ({ id, name, parentId, kind, status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: T, updatedAt: T });
const TREE = { projects: [proj('series', 'Dragon Rider', null, 'Series'), proj('b4', 'Book Four', 'series', 'Book'), proj('other', 'Other Book', null, 'Book')], links: [] } as unknown as ProjectTree;
const kind = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof PermissionDenied ? 'denied' : (e as Error).message || 'error'));
const ASIN = 'B0ABCDEF12';
const png = (w: number, h: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255, (h >> 24) & 255, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

async function studio() {
  const db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => TREE });
  const ana = svc.as('ana');
  const person = async (name: string, roleId: string, projectId?: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId, scope: projectId ? { kind: 'project', id: projectId } : { kind: 'studio', id: S } });
    return { id: p.id, as: svc.as(p.id) };
  };
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('banner', ?, 'Book Four/Art/banner.png', 1)", [S]);
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('banner', 1, 'bh', 1, 'x', '2026-11-01T00:00:00Z')");
  await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES ('banner', 'b4', '{}', 'x', 'x')");
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('epub', ?, 'Book Four/book.epub', 1)", [S]);
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('epub', 1, 'eh', 1, 'x', '2026-11-01T00:00:00Z')");
  await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES ('epub', 'b4', '{}', 'x', 'x')");
  return { db, svc, ana, person };
}

describe('release plans: who may do what, and what is computed', () => {
  it('Marketing makes a plan from a shipped template; the Author reads it and its counts; a stranger and Finance see nothing', async () => {
    const { person } = await studio();
    const mia = await person('Mia Marketing', 'role_marketing', 'series');
    const ann = await person('Ann Author', 'role_author', 'b4');
    const art = await person('Ada Art', 'role_art_director', 'b4');
    const fin = await person('Fin Finance', 'role_finance');
    const out = await person('Olly Other', 'role_author', 'other');
    const [tpl] = (await mia.as.launch.templates()).filter((t) => t.key === 'ebook_launch');
    expect(await kind(ann.as.launch.create({ projectId: 'b4', templateId: tpl!.id, releaseDate: '2027-03-31' }))).toBe('denied');
    const { plan } = await mia.as.launch.create({ projectId: 'b4', templateId: tpl!.id, releaseDate: '2027-03-31', assignees: { marketing: mia.id, art: art.id } });
    expect((await ann.as.launch.plans()).map((p) => p.id)).toEqual([plan.id]);
    const v = (await ann.as.launch.plan(plan.id))!;
    expect(v.outstanding.length).toBeGreaterThan(3);
    expect(v.items.find((i) => i.item.key === 'cover')).toMatchObject({ status: 'blocked' });
    expect(await out.as.launch.plans()).toEqual([]);
    expect(await out.as.launch.plan(plan.id)).toBeNull();
    expect(await kind(fin.as.launch.plans())).toBe('denied');
    // assignees must be on the book
    expect(await kind(mia.as.launch.create({ projectId: 'b4', templateId: tpl!.id, releaseDate: '2027-04-30', assignees: { marketing: out.id } }))).toMatch(/assigned/i);
  });

  it('an approved cover and a clear Preflight run tick their items with no one marking anything, for a manager', async () => {
    const { person, ana } = await studio();
    const mia = await person('Mia', 'role_marketing', 'series');
    const ada = await person('Ada', 'role_art_director', 'series');
    const tpl = (await mia.as.launch.templates()).find((t) => t.key === 'ebook_launch')!;
    const { plan } = await mia.as.launch.create({ projectId: 'b4', templateId: tpl.id, releaseDate: '2027-03-31' });
    const before = (await mia.as.launch.plan(plan.id))!;
    expect(before.items.find((i) => i.item.key === 'cover')!.status).toBe('blocked');
    const cover = await ada.as.assets.create({ projectId: 'b4', fileId: 'banner', kind: 'cover' });
    await ada.as.assets.approve(cover.id, 1);
    const after = (await mia.as.launch.plan(plan.id))!;
    expect(after.items.find((i) => i.item.key === 'cover')).toMatchObject({ status: 'done' });
    expect(after.items.find((i) => i.item.key === 'cover')!.task.state).toBe('done'); // ticked for her
    // a Preflight error holds the preflight item
    await ana.preflight.record({ projectId: 'b4', fileId: 'epub', fileVersion: 1, fileHash: 'eh', packId: 'kdp-ebook', packVersion: '1', findings: [{ ruleId: 'cover.size', grade: 'error', what: 'Too small.' }] });
    expect((await mia.as.launch.plan(plan.id))!.items.find((i) => i.item.key === 'preflight')!.reasons).toEqual(['1 Preflight error is still open.']);
    await ana.preflight.record({ projectId: 'b4', fileId: 'epub', fileVersion: 1, fileHash: 'eh', packId: 'kdp-ebook', packVersion: '1', findings: [] });
    expect((await mia.as.launch.plan(plan.id))!.items.find((i) => i.item.key === 'preflight')!.status).toBe('done');
  });

  it('approval is of an exact revision, by someone who may approve; the date moves by a proposal, and applying it to an approved plan sends it back for approval', async () => {
    const { person } = await studio();
    const mia = await person('Mia', 'role_marketing', 'series');
    const dan = await person('Dan Director', 'role_director', 'series');
    const ann = await person('Ann Author', 'role_author', 'b4');
    const tpl = (await mia.as.launch.templates()).find((t) => t.key === 'ebook_launch')!;
    const { plan } = await mia.as.launch.create({ projectId: 'b4', templateId: tpl.id, releaseDate: '2027-03-31' });
    const v = (await mia.as.launch.plan(plan.id))!;
    expect(await kind(ann.as.launch.approve(plan.id, v.revision))).toBe('denied'); // an Author reads the plan
    expect((await dan.as.launch.approve(plan.id, v.revision)).state).toBe('approved');
    expect(await kind(dan.as.launch.approve(plan.id, 'stale'))).toMatch(/changed since/);
    const p = await mia.as.launch.proposeDate(plan.id, '2027-04-14', 'The cover is late.');
    expect(await kind(ann.as.launch.applyDate(p.id))).toBe('denied');
    const done = await dan.as.launch.applyDate(p.id);
    expect(done.plan).toMatchObject({ releaseDate: '2027-04-14', state: 'draft' });
    expect((await mia.as.launch.plan(plan.id))!.changedSinceApproval).toBe(true);
    expect(await kind(mia.as.launch.goLive(plan.id))).toMatch(/not been approved/);
  });

  it('an item is ticked by a manager or by the person it is given to', async () => {
    const { person } = await studio();
    const mia = await person('Mia', 'role_marketing', 'series');
    const ann = await person('Ann Author', 'role_author', 'b4');
    const tpl = (await mia.as.launch.templates()).find((t) => t.key === 'series_launch')!;
    const { plan } = await mia.as.launch.create({ projectId: 'b4', templateId: tpl.id, releaseDate: '2027-06-30', assignees: { author: ann.id, marketing: mia.id } });
    await ann.as.launch.mark(plan.id, 'alsoby', true); // hers
    expect(await kind(ann.as.launch.mark(plan.id, 'series', true))).toBe('denied'); // not hers
    await mia.as.launch.mark(plan.id, 'alsoby', false);
    expect((await mia.as.launch.plan(plan.id))!.items.find((i) => i.item.key === 'alsoby')!.status).not.toBe('done');
  });
});

describe('campaign asset requests', () => {
  it('Marketing asks Art for a banner; the Artist’s wrong-sized file is refused with what was found; the right one is fulfilled once approved, and ticks the plan', async () => {
    const { person } = await studio();
    const mia = await person('Mia', 'role_marketing', 'series');
    const ada = await person('Ada', 'role_art_director', 'series');
    const arty = await person('Artie', 'role_artist', 'b4');
    const tpl = (await mia.as.launch.templates()).find((t) => t.key === 'ebook_launch')!;
    const { plan } = await mia.as.launch.create({ projectId: 'b4', templateId: tpl.id, releaseDate: '2027-03-31', assignees: { art: arty.id } });
    const q = await mia.as.launch.ask({ projectId: 'b4', planId: plan.id, kind: 'banner', title: 'Preorder banner', spec: { width: 1200, height: 628, formats: ['png'] }, assigneeId: arty.id });
    expect(await kind(arty.as.launch.ask({ projectId: 'b4', kind: 'ad', title: 'x' }))).toBe('denied');
    expect((await arty.as.launch.requests({ projectIds: ['b4'] })).map((r) => r.request.title)).toEqual(['Preorder banner']);
    const asset = await arty.as.assets.create({ projectId: 'b4', fileId: 'banner', kind: 'banner' });
    const refused = await arty.as.launch.deliver(q.id, { assetId: asset.id, version: 1, info: imageInfo(png(800, 600))! }).catch((e) => e as Error & { reasons?: string[] });
    expect((refused as Error).message).toMatch(/does not meet what was asked/);
    expect((refused as { reasons: string[] }).reasons[0]).toBe('Found 800 × 600 pixels; wanted 1200 pixels wide.');
    const d = await arty.as.launch.deliver(q.id, { assetId: asset.id, version: 1, info: imageInfo(png(1200, 628))! });
    expect(d.state).toBe('delivered');
    expect((await mia.as.launch.request(q.id))!.fulfilled).toBe(false); // not approved yet
    await ada.as.assets.approve(asset.id, 1);
    expect((await mia.as.launch.request(q.id))!.fulfilled).toBe(true);
    const item = (await mia.as.launch.plan(plan.id))!.items.find((i) => i.item.key === 'art')!;
    expect(item.item.requirement).toMatchObject({ kind: 'asset_request', requestId: q.id }); // the plan's "campaign art" item was linked to it
    expect(item.status).not.toBe('blocked'); // the request is met; it may still wait on the brief
    expect(await kind(mia.as.launch.cancelRequest(q.id, 'x'))).toBe('ok');
  });
});

describe('ARC readers, the review and market figures', () => {
  it('the Author sees counts and no names; Marketing sees the people and the read is logged; erasing keeps the count', async () => {
    const { person, db } = await studio();
    const mia = await person('Mia', 'role_marketing', 'series');
    const ann = await person('Ann Author', 'role_author', 'b4');
    const tpl = (await mia.as.launch.templates()).find((t) => t.key === 'ebook_launch')!;
    const { plan } = await mia.as.launch.create({ projectId: 'b4', templateId: tpl.id, releaseDate: '2027-03-31' });
    const k = await mia.as.launch.createCampaign({ planId: plan.id, name: 'Round one', targetReaders: 10, reviewTarget: 4, fileId: 'epub', fileVersion: 1 });
    const r = await mia.as.launch.addReader(k.id, { name: 'Rae Reader', email: 'rae@example.com' });
    await mia.as.launch.setReader(r.id, 'sent');
    const seen = await ann.as.launch.campaigns(plan.id);
    expect(seen[0]!.counts).toMatchObject({ total: 1, withFile: 1 });
    expect(JSON.stringify(seen)).not.toMatch(/Rae|rae@/);
    expect(await kind(ann.as.launch.readers(k.id))).toBe('denied');
    expect(await kind(ann.as.launch.addReader(k.id, { name: 'x' }))).toBe('denied');
    expect((await mia.as.launch.readers(k.id))[0]).toMatchObject({ name: 'Rae Reader', email: 'rae@example.com' });
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = 'arc.readers_read'"))!.n).toBe(1);
    await mia.as.launch.eraseReader(r.id);
    expect((await ann.as.launch.campaigns(plan.id))[0]!.counts.withFile).toBe(1);
    expect((await mia.as.launch.readers(k.id))[0]).toMatchObject({ name: null, email: null });
    // the plan's ARC item counts readers who have the file
    expect((await mia.as.launch.plan(plan.id))!.items.find((i) => i.item.key === 'arc')!.reasons.some((x) => /1 of 10 ARC readers/.test(x))).toBe(true);
  });

  it('figures are published by whoever may capture and read by whoever may read Market; a marketing brief pins the comps it saw', async () => {
    const { person } = await studio();
    const mia = await person('Mia', 'role_marketing', 'series');
    const ann = await person('Ann Author', 'role_author', 'b4');
    const fin = await person('Fin', 'role_finance');
    expect(await mia.as.marketing.publish([{ asin: ASIN, capturedAt: '2026-11-10T08:00:00Z', rank: 1200, price: 4.99, ratings: 40 }])).toEqual({ added: 1, skipped: 0 });
    expect(await kind(ann.as.marketing.publish([{ asin: ASIN, capturedAt: '2026-11-11T08:00:00Z' }]))).toBe('denied');
    expect((await ann.as.marketing.figures({ asin: ASIN })).map((f) => f.rank)).toEqual([1200]);
    expect(await kind(fin.as.marketing.figures({ asin: ASIN }))).toBe('denied');
    const brief = await mia.as.briefs.create({ projectId: 'b4', kind: 'launch', title: 'Launch brief', body: 'Against the comps.' });
    expect(await kind(ann.as.briefs.create({ projectId: 'b4', kind: 'launch', title: 'x', body: 'y' }))).toBe('denied');
    await mia.as.marketing.pinComps(brief.id, 1, [{ asin: ASIN, role: 'comp' }]);
    await mia.as.marketing.publish([{ asin: ASIN, capturedAt: '2026-11-19T08:00:00Z', rank: 300 }]);
    expect((await ann.as.marketing.briefComps(brief.id, 1))[0]).toMatchObject({ asin: ASIN, ageDays: 10, figure: { rank: 1200 } });
    expect(await kind(ann.as.marketing.pinComps(brief.id, 1, []))).toBe('denied');
    const d = await mia.as.marketing.decide({ editionId: 'ed1', asin: ASIN, kind: 'cover', reason: 'A new cover.', decidedAt: '2026-11-15T09:00:00Z' });
    expect((await ann.as.marketing.window(d.id, 30)).before.points).toHaveLength(1);
    expect(await kind(ann.as.marketing.decide({ editionId: 'ed1', kind: 'price', reason: 'x' }))).toBe('denied');
  });
});
