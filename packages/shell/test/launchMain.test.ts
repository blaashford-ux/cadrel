// The Launch page's main-process side on a Studio's own records: what it assembles, the calls it carries, the figures it publishes and the files it measures.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Launch, LaunchError, launchLens, type FigureSource } from '../src/main/launch';
import { FakeVault, fixture, type Fixture } from './artFixture';

let f: Fixture, vault: FakeVault, page: Launch, edition: string, tplId: string;
const png = (w: number, h: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255, (h >> 24) & 255, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const go = (name: string, ...args: unknown[]) => page.call(name, args);
const ASIN = 'B0ABCDEF12';
const library: FigureSource = {
  history: (asin) => (asin === ASIN ? [{ capturedAt: '2026-11-10 08:00:00', ratingValue: 4.4, ratingCount: 40, kindlePrice: 4.99, overallRank: 1200 }, { capturedAt: '2026-11-18T08:00:00Z', ratingValue: 4.5, ratingCount: 44, kindlePrice: 4.99, overallRank: 900 }] : [])
};
const ready = async (project = f.book4) => {
  const s = await page.state(project);
  if (!s.available) throw new Error(`launch unavailable: ${s.reason}`);
  return s;
};

beforeEach(async () => {
  f = await fixture();
  vault = new FakeVault([
    { fileId: 'ban', path: 'Book Four/Art/banner.png', projectId: f.book4, versions: [png(800, 600), png(1200, 628)] },
    { fileId: 'jpg', path: 'Book Four/Art/note.txt', projectId: f.book4, versions: [new TextEncoder().encode('not a picture')] }
  ]);
  await f.register(vault);
  const as = f.me();
  const series = await as.catalogue.createSeries({ name: 'Dragon Rider' } as never);
  const book = await as.catalogue.createBook({ title: 'Dragon Rider', subtitle: 'Book Four', penName: 'Ash Wilder', seriesId: series.id, position: 4 });
  edition = (await as.catalogue.addEdition(book.id, { format: 'ebook', asin: ASIN, price: 4.99 })).id;
  await as.catalogue.linkProject(book.id, f.book4);
  tplId = (await as.launch.templates()).find((t) => t.key === 'ebook_launch')!.id;
  page = new Launch(f.studio, f.host, vault, library);
});
afterEach(() => f.close());

describe('the Launch page: what it assembles', () => {
  it('offers the shipped templates and the book’s edition, and none of the series’ other books', async () => {
    const s = await ready();
    expect(s.templates.map((t) => t.name)).toEqual(['Ebook launch', 'Series launch']);
    expect(s.editions.map((e) => e.label)).toEqual([`Dragon Rider, ebook (${ASIN})`]);
    expect(s.may).toEqual({ read: true, manage: true, approve: true, capture: true });
    expect(s.plans).toEqual([]);
    expect(await page.state('nope')).toMatchObject({ available: false });
    const all = await page.state();
    expect(all.available && all.project.name).toBe('Dragon Rider');
  });

  it('a plan made from a template appears with what is outstanding, late and blocked, worked out from the records', async () => {
    const made = (await go('createPlan', { projectId: f.book4, templateId: tplId, releaseDate: '2027-06-30', editionId: edition })) as { plan: { id: string } };
    const s = await ready();
    expect(s.plans).toHaveLength(1);
    expect(s.plans[0]).toMatchObject({ projectName: 'Book Four', editionLabel: expect.stringContaining('Dragon Rider'), late: 0 });
    expect(s.plans[0]!.outstanding).toBeGreaterThan(5);
    expect(s.plans[0]!.blocked).toBeGreaterThan(0);
    const v = await page.plan(made.plan.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.items.find((i) => i.view.item.key === 'cover')!.view.reasons).toEqual(['The cover is not approved yet.']);
    expect(v.asin).toBe(ASIN);
    expect(v.may.manage).toBe(true);
    expect(await page.plan('nope')).toMatchObject({ available: false });
    const late = await go('createPlan', { projectId: f.book4, templateId: tplId, releaseDate: '2026-12-01' });
    expect(late).toBeTruthy();
    const s2 = await ready();
    expect(s2.plans.find((p) => p.plan.releaseDate === '2026-12-01')!.late).toBeGreaterThan(0);
  });

  it('only the page’s own calls are reachable', async () => {
    await expect(page.call('constructor', [])).rejects.toBeInstanceOf(LaunchError);
    await expect(page.call('delete', [])).rejects.toBeInstanceOf(LaunchError);
    await expect(go('createBrief', { projectId: f.book4, kind: 'edit', title: 'x', body: 'y' })).rejects.toThrow(/marketing and campaign briefs/);
  });
});

describe('the Launch page: figures, briefs and decisions', () => {
  it('publishes this computer’s captured figures for the book in view, once; a repeat adds nothing', async () => {
    expect(await page.publishFigures(f.book4)).toEqual({ added: 2, skipped: 0, books: 1 });
    expect(await page.publishFigures(f.book4)).toEqual({ added: 0, skipped: 2, books: 1 });
    const m = await page.market(f.book4);
    if (!m.available) throw new Error(m.reason);
    expect(m.editions[0]).toMatchObject({ asin: ASIN, figures: 2, latest: { rank: 900, ratings: 44 } });
    expect(await new Launch(f.studio, f.host, vault, null).publishFigures(f.book4)).toMatchObject({ available: false });
  });

  it('a marketing brief pins its comps, shows how old they are, and says when newer figures exist', async () => {
    await page.publishFigures(f.book4);
    const b = (await go('createBrief', { projectId: f.book4, kind: 'launch', title: 'Launch brief', body: 'Against the comps.' })) as { id: string };
    await go('pinComps', b.id, 1, [{ asin: ASIN }]);
    let v = await page.brief(b.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.comps[0]).toMatchObject({ asin: ASIN, figure: { rank: 900 } });
    expect(v.newer).toEqual([]);
    const s = await ready();
    expect(s.briefs[0]).toMatchObject({ title: 'Launch brief', kind: 'launch', comps: 1 });
    await f.me().marketing.publish([{ asin: ASIN, capturedAt: '2099-01-01T00:00:00Z', rank: 5 }]);
    v = await page.brief(b.id);
    expect(v.available && v.newer).toEqual([ASIN]);
    expect(await page.brief('nope')).toMatchObject({ available: false });
  });

  it('records a change and shows what the figures did around it, with its caveats', async () => {
    await page.publishFigures(f.book4);
    await go('decide', { editionId: edition, asin: ASIN, kind: 'cover', from: 'Old', to: 'New', reason: 'Better thumbnail.', projectId: f.book4, decidedAt: '2026-11-15T09:00:00Z' });
    const m = await page.market(f.book4);
    if (!m.available) throw new Error(m.reason);
    expect(m.decisions[0]).toMatchObject({ kind: 'cover', byName: 'you', editionLabel: expect.stringContaining('Dragon Rider') });
    const w = await page.decisionWindow(m.decisions[0]!.id, 30);
    expect('before' in w && [w.before.points.length, w.after.points.length]).toEqual([1, 1]);
    expect('caveats' in w && w.caveats.join(' ')).toMatch(/Only 1 figure on the thinner side/);
    await expect(page.decisionWindow('nope', 30)).rejects.toThrow(/not there/);
  });
});

describe('the Launch page: requests, ARC and the lens', () => {
  it('measures the file offered for a request and refuses one that is the wrong size, saying what was found', async () => {
    const asset = (await f.me().assets.create({ projectId: f.book4, fileId: 'ban', kind: 'banner' }));
    const q = (await go('ask', { projectId: f.book4, kind: 'banner', title: 'Preorder banner', spec: { width: 1200, height: 628, formats: ['png'] } })) as { id: string };
    await expect(page.deliver(q.id, asset.id, 1)).rejects.toThrow(/Found 800 × 600 pixels; wanted 1200 pixels wide/);
    const ok = (await page.deliver(q.id, asset.id, 2)) as { state: string; measured: { width: number } };
    expect(ok).toMatchObject({ state: 'delivered', measured: { width: 1200, height: 628 } });
    const s = await ready();
    expect(s.requests[0]).toMatchObject({ fulfilled: false, projectName: 'Book Four' });
    await f.me().assets.approve(asset.id, 2);
    expect((await ready()).requests[0]!.fulfilled).toBe(true);
    const txt = await f.me().assets.create({ projectId: f.book4, fileId: 'jpg', kind: 'other' });
    await expect(page.deliver(q.id, txt.id, 1)).rejects.toThrow(/not a picture/);
    await expect(page.deliver(q.id, 'nope', 1)).rejects.toThrow(/not there/);
  });

  it('ARC: counts on the plan; names and emails only through readers(), which is logged; erasing keeps the count', async () => {
    const made = (await go('createPlan', { projectId: f.book4, templateId: tplId, releaseDate: '2027-06-30', editionId: edition })) as { plan: { id: string } };
    const k = (await go('createCampaign', { planId: made.plan.id, name: 'Round one', targetReaders: 10, reviewTarget: 4 })) as { id: string };
    const r = (await go('addReader', k.id, { name: 'Rae Reader', email: 'rae@example.com' })) as { id: string };
    await go('setReader', r.id, 'sent');
    await go('reportReviews', k.id, 3);
    const v = await page.plan(made.plan.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.campaigns[0]).toMatchObject({ counts: { withFile: 1, total: 1 }, reportedReviews: 3, cross: { reported: 3, measured: null } });
    expect(JSON.stringify(v)).not.toMatch(/Rae|rae@example/);
    const people = await page.readers(k.id);
    expect('readers' in people && people.readers![0]).toMatchObject({ name: 'Rae Reader', email: 'rae@example.com' });
    await go('eraseReader', r.id);
    const after = await page.plan(made.plan.id);
    expect(after.available && after.campaigns[0]!.counts.withFile).toBe(1);
  });

  it('the home panel’s source lists the live plans with what is late, the requests waiting, and the reviews that are due', async () => {
    const made = (await go('createPlan', { projectId: f.book4, templateId: tplId, releaseDate: '2026-12-01', editionId: edition })) as { plan: { id: string } };
    await go('ask', { projectId: f.book4, kind: 'ad', title: 'Ad', spec: {} });
    const l = await launchLens(f.studio, f.host);
    expect(l.plans).toEqual([expect.objectContaining({ id: made.plan.id, projectName: 'Book Four', late: expect.any(Number) })]);
    expect(l.plans[0]!.late).toBeGreaterThan(0);
    expect(l.requests.map((r) => r.title)).toEqual(['Ad']);
    expect(l.reviewsDue).toEqual([]);
  });

  it('a Studio managed by its owner has no launches here', async () => {
    const away = new Launch(f.studio, { service: null, me: 'x', peopleList: async () => [], mayOn: async () => false } as never, null);
    expect(await away.state()).toMatchObject({ available: false });
    expect(await away.plan('x')).toMatchObject({ available: false });
    await expect(away.call('createPlan', [])).rejects.toBeInstanceOf(LaunchError);
  });
});
