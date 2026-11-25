// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
//
// M6's exit test (docs/M6-PLAN.md): "a release is planned, executed and reviewed from one record", as an automated run against the real Worker code,
// with six people (Marketing, a Director, an Art Director, an Artist, an Author and Finance) and Marketing's assistant played by the real MCP tools
// through the app's local door.
//
// A plan from a template gives each item a task due exactly that many days from the release date. What is outstanding is computed from the records:
// an approved cover and a clear Preflight run clear their items with no one marking anything. Moving the date proposes and changes nothing until it is
// applied. The campaign asks Art for a banner; a wrong-sized file is refused with what was found; the right one is fulfilled once approved. A marketing
// brief pins its comps' figures as of their capture dates. The ARC round gives the Author counts and no names. After the date, the review is filled from
// published figures with their capture dates, and a change of cover is shown with the figures before and after, and the price change in the same
// window. The manual walk-through that covers what this cannot (the screens, on Windows) is docs/M6-EXIT-TEST.md.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { addDays, generateKeyPair, type ProjectFacts } from '@cadrel/kernel';
import { LocalVault, DirBlobs } from '@cadrel/store';
import { DoorClient } from '@cadrel/studio-client';
import { createCadrelServer } from '../../mcp/src/server';
import { launchModule } from '../../mcp/src/modules/launch';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';
import { AssistantDoor } from '../src/main/assistantDoor';
import { Launch } from '../src/main/launch';
import type { ArtFiles } from '../src/main/art';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-m6-'));
  dirs.push(d);
  return d;
};

const T = '2026-01-01T00:00:00.000Z';
const proj = (id: string, name: string, parentId: string | null, kind: string, order: number) => ({ id, name, parentId, kind, status: 'active' as const, order, workflowId: null, stage: null, createdAt: T, updatedAt: T });
const TREE = { projects: [proj('series', 'Dragon Rider', null, 'Series', 0), proj('b4', 'Book Four', 'series', 'Book', 1), proj('b1', 'Book One', 'series', 'Book', 2)], links: [] } as never;
const ASIN = 'B0ABCDEF12';
const COMP1 = 'B0COMPETE1';
const COMP2 = 'B0COMPETE2';
const today = new Date().toISOString().slice(0, 10);
const png = (w: number, h: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255, (h >> 24) & 255, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const jpeg = (w: number, h: number, tag = 0) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xfe, 0, 3, tag, 0xff, 0xd9]);

async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  const fetchFn = cf.fetchFn as typeof fetch;
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn, now });
  const person = async (role: string, name: string, scope: 'b4' | 'series' | null = null) => {
    const { link } = await owner.invite(role, name, 'Acme', scope ? { projectId: scope, days: 60 } : {});
    const j = await joinStudio({ link, yourName: name, fetchFn });
    return new StudioClient({ url: built.url, key: j.key, fetchFn, now });
  };
  return { owner, person, advance: () => (clock.t += 10_000) };
}
async function computer(client: StudioClient, machine: string) {
  const root = await tmp();
  const me = await client.me();
  const store = new OfflineAwareStore(new RemoteVaultStore(client), path.join(root, 'cache.json'));
  const vault = new LocalVault({ store, blobs: new RemoteBlobs(client, new DirBlobs(path.join(root, 'blobs'))), dir: path.join(root, 'work'), personId: me.personId, machine });
  await mkdir(path.join(root, 'work'), { recursive: true });
  return { vault, write: async (rel: string, data: string | Uint8Array) => (await mkdir(path.dirname(path.join(root, 'work', rel)), { recursive: true }), writeFile(path.join(root, 'work', rel), data)) };
}
type Pc = Awaited<ReturnType<typeof computer>>;
function filesOf(pc: Pc): ArtFiles {
  const entries = async () => (await pc.vault.list()).filter((e) => e.fileId !== null && (e.version ?? 0) > 0);
  const pathOf = async (id: string) => (await entries()).find((e) => e.fileId === id)!.path;
  return {
    files: async () => (await entries()).map((e) => ({ fileId: e.fileId!, path: e.path, version: e.version!, projectId: e.projectId ?? null, size: e.size })),
    bytesOf: async (id, v) => pc.vault.read(await pathOf(id), v),
    versionsOf: async (id) => pc.vault.history(await pathOf(id))
  };
}
const who = (client: StudioClient, id: string, name: string) => ({ service: remoteService(client), me: id, peopleList: async () => [{ id, name }], mayOn: async () => true }) as never;
async function assistantFor(door: AssistantDoor, personId: string) {
  const client = new DoorClient({ url: door.url!, token: door.token, fetchFn: fetch });
  const server = createCadrelServer({ modules: [launchModule({ service: remoteService(client), personId, studio: { read: async () => ({ tree: TREE }) } as never })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content[0]!.text, json: () => { if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`); return JSON.parse(r.content[0]!.text); } };
  };
  return { call, tools: async () => (await mcp.listTools()).tools.map((t) => t.name) };
}

describe('M6 exit test: a release is planned, executed and reviewed from one record', () => {
  it('a plan worked backwards, what is outstanding computed from the records, a date that moves by proposal, art asked of Art, comps pinned as of their dates, an ARC round with counts for the Author, a review from published figures, a change with its window, and a gate', async () => {
    const s = await studio();
    await s.owner.publishTree(TREE);
    const owner = remoteService(s.owner).as('x');

    // ---- the people: Marketing and the Art Director hold the series; the Artist and the Author Book Four only; the Director the series; Finance nothing of launches
    const miaClient = await s.person('marketing', 'Mia Marketing'); // holds the Studio (the catalogue is read Studio-wide) and is assigned to the series below
    const danClient = await s.person('director', 'Dan Director', 'series');
    const adaClient = await s.person('art_director', 'Ada Art', 'series');
    const artClient = await s.person('artist', 'Artie Artist', 'b4');
    const annClient = await s.person('author', 'Ann Author', 'b4');
    const finClient = await s.person('finance', 'Fin Finance');
    const [mia, dan, ada, art, ann, fin] = [miaClient, danClient, adaClient, artClient, annClient, finClient].map((c) => remoteService(c).as('x'));
    const [miaId, , adaId, artId] = await Promise.all([miaClient, danClient, adaClient, artClient].map(async (c) => (await c.me()).personId));

    await owner.people.grant({ subject: { kind: 'person', id: miaId }, roleId: 'role_marketing', scope: { kind: 'project', id: 'series' } });

    // ---- the catalogue and Market's figures, published from a library on Marketing's computer
    const series = await owner.catalogue.createSeries({ name: 'Dragon Rider' } as never);
    const book = await owner.catalogue.createBook({ title: 'Dragon Rider', subtitle: 'Book Four', penName: 'Ash Wilder', seriesId: series.id, position: 4 });
    const edition = await owner.catalogue.addEdition(book.id, { format: 'ebook', asin: ASIN, price: 4.99 });
    await owner.catalogue.linkProject(book.id, 'b4');
    const RELEASE = addDays(today, 100);
    const PAST = addDays(today, -45); // a book that has already launched, for the review
    const library = {
      history: (asin: string) =>
        asin === ASIN
          ? [{ capturedAt: `${addDays(PAST, -20)}T08:00:00Z`, ratingValue: 4.2, ratingCount: 3, kindlePrice: 4.99, overallRank: 90_000 }, { capturedAt: `${addDays(PAST, -5)}T08:00:00Z`, ratingValue: 4.2, ratingCount: 3, kindlePrice: 4.99, overallRank: 88_000 }, { capturedAt: `${addDays(PAST, 7)}T08:00:00Z`, ratingValue: 4.4, ratingCount: 12, kindlePrice: 4.99, overallRank: 40_000 }, { capturedAt: `${addDays(PAST, 8)}T08:00:00Z`, ratingValue: 4.4, ratingCount: 13, kindlePrice: 4.99, overallRank: 39_000 }, { capturedAt: `${addDays(PAST, 30)}T08:00:00Z`, ratingValue: 4.5, ratingCount: 31, kindlePrice: 4.99, overallRank: 12_000 }, { capturedAt: `${addDays(PAST, 31)}T08:00:00Z`, ratingValue: 4.5, ratingCount: 31, kindlePrice: 4.99, overallRank: 11_500 }]
          : []
    };
    const artPc = await computer(artClient, 'art-pc');
    const ownerPc = await computer(s.owner, 'owner-pc');
    const miaPage = new Launch({ tree: async () => TREE } as never, who(miaClient, miaId, 'Mia'), filesOf(ownerPc), library);
    expect(await miaPage.publishFigures('b4')).toMatchObject({ added: 6, skipped: 0, books: 1 });
    expect(await miaPage.publishFigures('b4')).toMatchObject({ added: 0, skipped: 6 }); // idempotent
    await mia.marketing.publish([{ asin: COMP1, capturedAt: `${addDays(today, -1)}T06:00:00Z`, title: 'Dragon Bound', rank: 1200, price: 4.99, ratings: 300 }, { asin: COMP2, capturedAt: `${addDays(today, -3)}T06:00:00Z`, title: 'Flame Sworn', rank: 800, price: 5.99, ratings: 900 }]);
    await expect(ann.marketing.publish([{ asin: COMP1, capturedAt: `${today}T07:00:00Z` }])).rejects.toThrow(/not allowed/);

    // ---- 1. a plan from a template: each item a task due exactly that many days from the date
    s.advance();
    const tpl = (await mia.launch.templates()).find((t) => t.key === 'ebook_launch')!;
    await expect(ann.launch.create({ projectId: 'b4', templateId: tpl.id, releaseDate: RELEASE })).rejects.toThrow(/not allowed/);
    const { plan } = await mia.launch.create({ projectId: 'b4', editionId: edition.id, templateId: tpl.id, releaseDate: RELEASE, assignees: { marketing: miaId, art: adaId }, targets: { rank: 20_000, reviews: 25, readers: 10 } });
    const view0 = (await mia.launch.plan(plan.id))!;
    const due = (key: string) => view0.items.find((i) => i.item.key === key)!.task.due;
    for (const it of tpl.items) expect(due(it.key)).toBe(addDays(RELEASE, it.offsetDays));
    expect(view0.items.find((i) => i.item.key === 'upload')!.task.dependsOn).toEqual([view0.items.find((i) => i.item.key === 'preflight')!.task.id]);
    expect((await owner.work.tasks({ projectId: 'b4' })).filter((t) => t.notes.includes(plan.name)).length).toBe(tpl.items.length); // they are in the Planner

    // ---- 2. what is outstanding comes from the records
    const item = async (key: string) => (await mia.launch.plan(plan.id))!.items.find((i) => i.item.key === key)!;
    expect(await item('cover')).toMatchObject({ status: 'blocked', reasons: ['The cover is not approved yet.'] });
    await ownerPc.write('Book Four/Art/cover.jpg', jpeg(1600, 2560, 1));
    await ownerPc.vault.add('Book Four/Art/cover.jpg', 'Cover', 'b4');
    const coverFile = (await ownerPc.vault.status('Book Four/Art/cover.jpg')).fileId!;
    const cover = await ada.assets.create({ projectId: 'b4', fileId: coverFile, kind: 'cover' });
    expect((await item('cover')).status).toBe('blocked'); // an asset in draft is not an approved cover
    await ada.assets.approve(cover.id, 1);
    s.advance();
    const cleared = await item('cover');
    expect(cleared.status).toBe('done');
    expect(cleared.task.state).toBe('done'); // ticked on the task for her; no one marked it
    // a Preflight error holds the preflight item, and the upload that waits for it
    await ownerPc.write('Book Four/book.epub', 'not really an epub');
    await ownerPc.vault.add('Book Four/book.epub', 'Export', 'b4');
    const epubFile = (await ownerPc.vault.status('Book Four/book.epub')).fileId!;
    await owner.preflight.record({ projectId: 'b4', fileId: epubFile, fileVersion: 1, fileHash: 'h', packId: 'kdp-ebook', packVersion: '1', findings: [{ ruleId: 'cover.size', grade: 'error', what: 'Too small.' }] });
    expect((await item('preflight')).reasons).toEqual(['1 Preflight error is still open.']);
    expect((await item('upload')).status).toBe('blocked');
    await owner.preflight.record({ projectId: 'b4', fileId: epubFile, fileVersion: 1, fileHash: 'h', packId: 'kdp-ebook', packVersion: '1', findings: [] });
    expect((await item('preflight')).status).toBe('done');

    // ---- 3. approval of an exact revision; the date moves by proposal and changes nothing until applied
    const v1 = (await mia.launch.plan(plan.id))!;
    await expect(ann.launch.approve(plan.id, v1.revision)).rejects.toThrow(/not allowed/);
    expect((await dan.launch.approve(plan.id, v1.revision)).state).toBe('approved');
    const proposal = await mia.launch.proposeDate(plan.id, addDays(RELEASE, 14), 'The brief slipped.');
    expect((await mia.launch.plan(plan.id))!.plan.releaseDate).toBe(RELEASE); // nothing changed
    expect(proposal.changes.find((c) => c.key === 'launch')).toMatchObject({ from: RELEASE, to: addDays(RELEASE, 14) });
    expect(proposal.changes.find((c) => c.key === 'cover')).toBeUndefined(); // done: keeps its date
    const applied = await dan.launch.applyDate(proposal.id);
    expect(applied.plan).toMatchObject({ releaseDate: addDays(RELEASE, 14), state: 'draft' });
    expect((await mia.launch.plan(plan.id))!.changedSinceApproval).toBe(true);
    await expect(mia.launch.goLive(plan.id)).rejects.toThrow(/not been approved/);

    // ---- 4. campaign art asked of Art: a wrong-sized file is refused with what was found, the right one is fulfilled once approved
    s.advance();
    const req = await mia.launch.ask({ projectId: 'b4', planId: plan.id, kind: 'banner', title: 'Preorder banner', spec: { width: 1200, height: 628, formats: ['png'] }, assigneeId: artId });
    await artPc.write('Book Four/Art/banner.png', png(800, 600));
    await artPc.vault.add('Book Four/Art/banner.png', 'Banner', 'b4');
    const bannerFile = (await artPc.vault.status('Book Four/Art/banner.png')).fileId!;
    const banner = await art.assets.create({ projectId: 'b4', fileId: bannerFile, kind: 'banner' });
    const artPage = new Launch({ tree: async () => TREE } as never, who(artClient, artId, 'Artie'), filesOf(artPc), null);
    await expect(artPage.deliver(req.id, banner.id, 1)).rejects.toThrow(/Found 800 × 600 pixels; wanted 1200 pixels wide/);
    await artPc.vault.checkOut('Book Four/Art/banner.png');
    await artPc.write('Book Four/Art/banner.png', png(1200, 628));
    await artPc.vault.checkIn('Book Four/Art/banner.png', 'Right size');
    s.advance();
    await artPage.deliver(req.id, banner.id, 2);
    expect((await mia.launch.request(req.id))!.fulfilled).toBe(false); // delivered, not approved
    await ada.assets.approve(banner.id, 2);
    expect((await mia.launch.request(req.id))!.fulfilled).toBe(true);
    expect((await item('art')).item.requirement).toMatchObject({ kind: 'asset_request', requestId: req.id });

    // ---- 5. a marketing brief pins its comps' figures as of their capture dates; newer ones do not change it
    const brief = await mia.briefs.create({ projectId: 'b4', kind: 'launch', title: 'Launch brief', body: 'Dragon riders, slow burn, against the two comps.' });
    await expect(ann.briefs.create({ projectId: 'b4', kind: 'launch', title: 'x', body: 'y' })).rejects.toThrow(/not allowed/);
    await mia.marketing.pinComps(brief.id, 1, [{ asin: COMP1 }, { asin: COMP2, role: 'competitor' }]);
    await mia.marketing.publish([{ asin: COMP1, capturedAt: `${addDays(today, 5)}T06:00:00Z`, rank: 50 }]); // a later capture
    const comps = await ann.marketing.briefComps(brief.id, 1);
    expect(comps.map((c) => [c.asin, c.figure?.rank])).toEqual([[COMP1, 1200], [COMP2, 800]]); // as they were
    expect((await ann.marketing.latest(COMP1))!.rank).toBe(50);
    expect((await item('brief')).status).toBe('done');

    // ---- 6. the ARC round: counts for the Author, people for Marketing only
    const round = await mia.launch.createCampaign({ planId: plan.id, name: 'Round one', targetReaders: 3, reviewTarget: 2, fileId: epubFile, fileVersion: 1 });
    for (const [n, e] of [['Rae Reader', 'rae@example.com'], ['Sam Reader', 'sam@example.com'], ['Tia Reader', 'tia@example.com']] as const) {
      const r = await mia.launch.addReader(round.id, { name: n, email: e });
      await mia.launch.setReader(r.id, 'sent');
    }
    const seen = await ann.launch.campaigns(plan.id);
    expect(seen[0]!.counts).toMatchObject({ total: 3, withFile: 3 });
    expect(JSON.stringify(seen)).not.toMatch(/Rae|Sam|Tia|@example/);
    await expect(ann.launch.readers(round.id)).rejects.toThrow(/not allowed/);
    const people = await mia.launch.readers(round.id);
    expect(people.map((r) => r.name)).toEqual(['Rae Reader', 'Sam Reader', 'Tia Reader']);
    expect(Object.keys(people[0]!)).not.toContain('rating');
    expect((await item('arc')).reasons).toContain('3 of 10 ARC readers have the file.'); // the template asks for ten; three have it
    await mia.launch.setReader(people[0]!.id, 'reviewed', { reviewUrl: 'https://example.com/review/1' });
    await mia.launch.reportReviews(round.id, 1);
    await mia.launch.eraseReader(people[1]!.id);
    expect((await mia.launch.readers(round.id))[1]).toMatchObject({ name: null, email: null });
    const x = await mia.launch.crossCheck(round.id);
    expect(x).toMatchObject({ reported: 1, readersReviewed: 1 });
    expect((await ann.launch.campaigns(plan.id))[0]!.counts.withFile).toBe(3); // erasing keeps the count

    // ---- 7. the review of a book that has launched: filled from published figures with their capture dates, planned kept apart
    const { plan: old } = await mia.launch.create({ projectId: 'b4', editionId: edition.id, templateId: tpl.id, releaseDate: PAST, targets: { rank: 20_000, reviews: 25 } });
    const oldView = (await mia.launch.plan(old.id))!;
    expect(oldView.items.filter((i) => i.item.required && i.status === 'late').length).toBeGreaterThan(0); // what was late is listed
    expect(await owner.launch.approve(old.id, oldView.revision).then((p) => p.state)).toBe('approved');
    expect((await mia.launch.goLive(old.id)).state).toBe('live');
    const review = await mia.launch.openReview(old.id);
    expect(review.planned).toMatchObject({ rank: 20_000, reviews: 25, releaseDate: PAST });
    expect(review.measured.map((p) => [p.day, p.figure?.capturedAt.slice(0, 10) ?? null, p.figure?.rank ?? null])).toEqual([[7, addDays(PAST, 7), 40_000], [30, addDays(PAST, 30), 12_000], [90, null, null]]);
    expect(review.measured[2]!.missing).toMatch(/not reached yet/);
    await mia.launch.writeReview(old.id, { worked: 'The ARC round gave twelve reviews by day 7.', didNot: 'The banner came late.', next: 'Ask Art at day -50.' });
    expect((await mia.launch.finishReview(old.id)).state).toBe('done');
    expect((await mia.launch.plan(old.id))!.plan.state).toBe('reviewed');

    // ---- 8. a change of cover, with the figures before and after, and the price change that fell in the same window
    const change = await mia.marketing.decide({ editionId: edition.id, asin: ASIN, kind: 'cover', from: 'First cover', to: 'New cover', reason: 'The old one did not read as a thumbnail.', projectId: 'b4', decidedAt: `${addDays(PAST, 1)}T09:00:00Z`, assetId: cover.id });
    await mia.marketing.decide({ editionId: edition.id, asin: ASIN, kind: 'price', from: '4.99', to: '2.99', reason: 'Launch sale.', projectId: 'b4', decidedAt: `${addDays(PAST, 2)}T09:00:00Z` });
    const w = await ann.marketing.window(change.id, 30);
    expect([w.before.points.length, w.after.points.length]).toEqual([2, 4]);
    expect(w.before.median.rank).toBe(89_000);
    expect(w.alsoChanged.map((o) => o.kind)).toEqual(['price']);
    expect(w.caveats.join(' ')).toMatch(/1 other change to this book \(price\) fell in the same window/);
    expect(w.caveats.join(' ')).not.toMatch(/caused/);

    // ---- a person with no launch role sees nothing
    await expect(fin.launch.plans()).rejects.toThrow(/not allowed/);
    await expect(fin.marketing.figures({ asin: ASIN })).rejects.toThrow(/not allowed/);
    await expect(fin.launch.requests()).rejects.toThrow(/not allowed/);

    // ---- Marketing's assistant: reads what is outstanding, counts only, figures with dates; no way to decide
    let target: StudioClient | null = miaClient;
    const door = new AssistantDoor(() => target);
    await door.start();
    try {
      s.advance();
      const bot = await assistantFor(door, miaId);
      const names = await bot.tools();
      for (const forbidden of ['approve', 'apply', 'publish', 'erase', 'reader', 'go_live', 'cancel']) expect(names.filter((n) => n.includes(forbidden)), forbidden).toEqual([]);
      const out = (await bot.call('launch_outstanding', { plan: plan.id })).json();
      expect(out.items.map((i: { key: string }) => i.key)).not.toContain('cover'); // approved: not outstanding
      expect(out.items.find((i: { key: string }) => i.key === 'signoff')).toMatchObject({ required: true });
      const arc = await bot.call('arc_status', { plan: plan.id });
      expect(arc.json()[0]).toMatchObject({ haveTheFile: 3, wanted: 3, reportedByTheStudio: 1 });
      expect(arc.text).not.toMatch(/Rae|Sam|Tia|@example/);
      const figs = (await bot.call('market_figures', { asin: COMP1 })).json();
      expect(figs.map((f: { capturedAt: string }) => f.capturedAt.slice(0, 10))).toEqual([addDays(today, -1), addDays(today, 5)]);
      expect((await bot.call('market_comps', { brief: 'Launch brief' })).json().comps[0]).toMatchObject({ asin: COMP1, seen: { rank: 1200 }, newerFigure: { rank: 50 } });
      expect((await bot.call('launch_brief_draft', { project: 'Book Four', brief: brief.id, body: 'A sharper version.', note: 'Hook.', comps: [COMP1] })).json()).toMatchObject({ version: 2 });
    } finally {
      await door.stop();
    }

    // ---- the optional gate: a stage move holds while a required item is late or blocked
    const base = (await owner.workflows.list())[0]!;
    const wf = await owner.workflows.create({ name: 'Launch ready before publishing' });
    await owner.workflows.save(wf.id, {
      name: wf.name, description: '',
      stages: base.stages.map((st) => ({ key: st.key, name: st.name, category: st.category, color: st.color })),
      transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'launch_ready' }] }]
    } as never);
    const gate = async (project: string) => {
      s.advance();
      const facts: ProjectFacts = { hasManuscript: true, openNotes: 0, subprojects: [], openTasks: 0, approved: [], launch: await owner.work.launchFacts([project]) };
      return (await owner.workflows.stageOptions(wf.id, 'editing', facts)).options.find((o) => o.key === 'published')!;
    };
    expect(await gate('b4')).toMatchObject({ allowed: false, reasons: [expect.stringMatching(/required items? of the release plan (is|are) late or blocked/)] });
    expect(await gate('b1')).toMatchObject({ allowed: false, reasons: ['Needs a release plan'] });
    void [adaId];
  }, 180_000);
});
