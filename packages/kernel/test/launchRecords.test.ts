import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, addReader, approveVersion, arcSent, briefComps, cancelRequest, checkSpec, cleanSpec, closeCampaign, countsOf, createAsset, createBrief, createCampaign, createCompSet, createPerson, createRequest,
  decisionWindow, deliverRequest, eraseReader, finishReview, getReview, goLive, latestFigure, listCompSets, listFigures, listMarketDecisions, listReports, openReview, pinBriefComps, publishFigures,
  readersOf, recordMarketDecision, refreshReview, reportReviews, requestFacts, requestView, reviewCrossCheck, saveReport, setReaderState, syncRequest, writeReview, getReport, createPlan,
  ensureDefaultTemplates, listTemplates, approvePlan, itemsOf, getTask, planRevision, listRequests, getRequest, type Ctx, type Db, type ImageInfo
} from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
let ana: string;
const at = (actor = 'ana', day = '2026-11-20'): Ctx => ({ studioId: 's1', actor, now: `${day}T10:00:${String(clock++ % 60).padStart(2, '0')}Z` });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
const info = (o: Partial<ImageInfo> = {}): ImageInfo => ({ format: 'png', width: 1200, height: 628, colour: 'rgb', dpi: null, bytes: 90_000, ...o });
const ASIN = 'B0ABCDEF12';
const fig = (day: string, o: object = {}) => ({ asin: ASIN, capturedAt: `${day}T08:00:00Z`, price: 4.99, rank: 50_000, ratings: 10, ratingAvg: 4.4, ...o });

async function file(id: string, versions = 2) {
  await db.run('INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, ?, ?, ?)', [id, 's1', `${id}.png`, versions]);
  for (let n = 1; n <= versions; n++) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, ?, ?, 1, 'x', '2026-11-01T00:00:00Z')", [id, n, `${id}-h${n}`]);
}
beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  ana = (await createPerson(db, { studioId: 's1', actor: 'system', now: '2026-11-01T00:00:00Z' }, { name: 'Ana' })).id;
});

describe('campaign asset requests: fulfilled by an asset that meets the spec as measured and is approved', () => {
  it('is also a task for whoever it is given to, with what is wanted in its notes', async () => {
    const q = await createRequest(db, at(), { projectId: 'book', kind: 'banner', title: 'Preorder banner', spec: { width: 1200, height: 628, formats: ['png', 'jpeg'] }, due: '2026-12-01', assigneeId: ana });
    expect(q).toMatchObject({ state: 'open', due: '2026-12-01', assigneeId: ana });
    const task = (await getTask(db, at(), q.taskId!))!;
    expect(task).toMatchObject({ title: 'Campaign art: Preorder banner', due: '2026-12-01', assigneeId: ana });
    expect(task.notes).toContain('1200 × 628 pixels, PNG or JPEG');
    expect((await requestView(db, at(), q)).reasons[0]).toMatch(/Nothing has been delivered yet/);
  });

  it('a file of the wrong size is refused with what was found and what was wanted; the right one is delivered, then fulfilled only when approved', async () => {
    await file('banner');
    const asset = await createAsset(db, at(), { projectId: 'book', fileId: 'banner', kind: 'banner' });
    const q = await createRequest(db, at(), { projectId: 'book', kind: 'banner', title: 'Preorder banner', spec: { width: 1200, height: 628, formats: ['png'], maxBytes: 100_000 } });
    const refused = await deliverRequest(db, at(), q.id, { assetId: asset.id, version: 1, info: info({ width: 800, height: 600, format: 'jpeg', bytes: 300_000 }) }).catch((e) => e as WorkError);
    expect(refused).toBeInstanceOf(WorkError);
    expect((refused as WorkError).reasons).toEqual(['Found 800 × 600 pixels; wanted 1200 pixels wide.', 'Found 800 × 600 pixels; wanted 628 pixels tall.', 'Found JPEG; wanted PNG.', 'Found 293 KB; wanted at most 98 KB.']);
    expect((await getRequest(db, at(), q.id))!.state).toBe('open');
    const d = await deliverRequest(db, at(), q.id, { assetId: asset.id, version: 1, info: info() });
    expect(d).toMatchObject({ state: 'delivered', assetId: asset.id, deliveredVersion: 1, measured: { width: 1200, height: 628 } });
    expect((await requestView(db, at(), d)).reasons).toEqual(['Version 1 was delivered and is waiting to be approved.']);
    expect(await syncRequest(db, at(), q.id)).toBe(false);
    await approveVersion(db, at(), asset.id, 1);
    expect((await requestView(db, at(), d)).fulfilled).toBe(true);
    expect(await requestFacts(db, at(), [q.id, 'nope'])).toEqual({ [q.id]: { fulfilled: true, title: 'Preorder banner' } });
    expect(await syncRequest(db, at(), q.id)).toBe(true);
    expect((await getTask(db, at(), q.taskId!))!.state).toBe('done');
  });

  it('a version other than the one delivered being approved does not fulfil it; an asset of another book is refused; a cancel needs a reason', async () => {
    await file('a');
    await file('b');
    const asset = await createAsset(db, at(), { projectId: 'book', fileId: 'a', kind: 'banner' });
    const other = await createAsset(db, at(), { projectId: 'other', fileId: 'b', kind: 'banner' });
    const q = await createRequest(db, at(), { projectId: 'book', kind: 'ad', title: 'Ad', spec: {} });
    expect(await code(deliverRequest(db, at(), q.id, { assetId: other.id, version: 1, info: info() }))).toBe('invalid');
    expect(await code(deliverRequest(db, at(), q.id, { assetId: asset.id, version: 9, info: info() }))).toBe('not-found');
    await deliverRequest(db, at(), q.id, { assetId: asset.id, version: 1, info: info() });
    await approveVersion(db, at(), asset.id, 2);
    expect((await requestView(db, at(), (await getRequest(db, at(), q.id))!)).fulfilled).toBe(false);
    expect(await code(cancelRequest(db, at(), q.id, ' '))).toBe('invalid');
    await cancelRequest(db, at(), q.id, 'Dropped the ad.');
    expect((await getTask(db, at(), q.taskId!))!.state).toBe('cancelled');
    expect(await listRequests(db, at(), { projectIds: ['book'] })).toEqual([]);
    expect(await code(deliverRequest(db, at(), q.id, { assetId: asset.id, version: 1, info: info() }))).toBe('conflict');
  });

  it('checks what it is given, and measures against each part of a spec', () => {
    expect(() => cleanSpec({ width: -1 })).toThrow(/whole number of pixels/);
    expect(() => cleanSpec({ formats: ['bmp' as never] })).toThrow(/formats are among/);
    expect(cleanSpec({ width: 1200, formats: ['png', 'png'], channel: ' Facebook ' })).toEqual({ width: 1200, formats: ['png'], channel: 'Facebook' });
    expect(checkSpec({ minWidth: 1000, minHeight: 500 }, info())).toEqual([]);
    expect(checkSpec({ minWidth: 2000 }, info())).toEqual(['Found 1200 pixels wide; wanted at least 2000.']);
  });
});

describe('Market figures, comps and marketing briefs', () => {
  it('publishing is idempotent by ASIN and capture time, and a repeat changes nothing', async () => {
    expect(await publishFigures(db, at(), [fig('2026-10-01'), fig('2026-10-08', { rank: 40_000 })])).toEqual({ added: 2, skipped: 0 });
    expect(await publishFigures(db, at(), [fig('2026-10-01', { rank: 1 }), fig('2026-10-15')])).toEqual({ added: 1, skipped: 1 });
    expect((await listFigures(db, at(), { asin: ASIN })).map((f) => [f.capturedAt.slice(0, 10), f.rank])).toEqual([['2026-10-01', 50_000], ['2026-10-08', 40_000], ['2026-10-15', 50_000]]); // the repeat did not overwrite
    expect((await latestFigure(db, at(), ASIN, '2026-10-10T00:00:00Z'))!.capturedAt.slice(0, 10)).toBe('2026-10-08');
    expect(await code(publishFigures(db, at(), [fig('2026-10-01', { asin: 'short' })]))).toBe('invalid');
    expect(await code(publishFigures(db, at(), [{ ...fig('2026-10-01'), capturedAt: 'yesterday' }]))).toBe('invalid');
    expect(await code(publishFigures(db, at(), [fig('2026-10-01', { rank: -4 })]))).toBe('invalid');
    expect(await publishFigures(db, at(), [])).toEqual({ added: 0, skipped: 0 });
  });

  it('a marketing brief pins the figures it saw; publishing newer ones later does not change it; its figures show how old they are', async () => {
    await publishFigures(db, at('ana', '2026-10-01'), [fig('2026-10-01', { rank: 1200 }), { ...fig('2026-10-01'), asin: 'B0COMPETE1', rank: 900 }]);
    const brief = await createBrief(db, at(), { projectId: 'book', kind: 'launch', title: 'Launch brief', body: 'Position against the comps.' });
    await pinBriefComps(db, at('ana', '2026-10-02'), brief.id, 1, [{ asin: ASIN, role: 'comp', note: 'Same trope' }, { asin: 'B0COMPETE1', role: 'competitor' }, { asin: 'B0NOFIGURE', role: 'comp' }, { asin: ASIN }]);
    await publishFigures(db, at('ana', '2026-11-15'), [fig('2026-11-15', { rank: 300 })]);
    const comps = await briefComps(db, at(), brief.id, 1, '2026-11-20');
    expect(comps.map((c) => [c.asin, c.role, c.figure?.rank ?? null, c.ageDays])).toEqual([[ASIN, 'comp', 1200, 50], ['B0COMPETE1', 'competitor', 900, 50], ['B0NOFIGURE', 'comp', null, null]]);
    expect(comps[0]!.note).toBe('Same trope');
    // setting them again for the version replaces them, and then pins the newer figure
    await pinBriefComps(db, at('ana', '2026-11-16'), brief.id, 1, [{ asin: ASIN }]);
    expect((await briefComps(db, at(), brief.id, 1, '2026-11-20'))[0]!.figure!.rank).toBe(300);
    expect(await code(pinBriefComps(db, at(), brief.id, 3, []))).toBe('not-found');
    const other = await createBrief(db, at(), { projectId: 'book', kind: 'edit', title: 'Edit', body: 'x' });
    expect(await code(pinBriefComps(db, at(), other.id, 1, []))).toBe('invalid');
  });

  it('comp sets and saved reports; a report is never edited and says what its figures are as of', async () => {
    const s = await createCompSet(db, at(), { projectId: 'series', name: 'Dragon comps', asins: [ASIN, ASIN.toLowerCase(), 'B0COMPETE1'] });
    expect(s.asins).toEqual([ASIN, 'B0COMPETE1']);
    expect((await listCompSets(db, at(), { projectIds: ['series'] })).map((x) => x.name)).toEqual(['Dragon comps']);
    expect(await listCompSets(db, at(), { projectIds: [] })).toEqual([]);
    expect(await code(createCompSet(db, at(), { projectId: 'series', name: 'x', asins: [] }))).toBe('invalid');
    const r = await saveReport(db, at(), { projectId: 'series', kind: 'category', title: 'Dragon Fantasy, November', asOf: '2026-11-15', payload: { top: [{ asin: ASIN, rank: 3 }] } });
    expect(r).toMatchObject({ kind: 'category', asOf: '2026-11-15', payload: { top: [{ asin: ASIN, rank: 3 }] } });
    expect((await listReports(db, at(), { projectIds: ['series'], kind: 'category' })).map((x) => x.title)).toEqual(['Dragon Fantasy, November']);
    expect((await getReport(db, at(), r.id))!.payload).toEqual({ top: [{ asin: ASIN, rank: 3 }] });
    expect(await code(saveReport(db, at(), { projectId: 'series', kind: 'poem' as never, title: 'x', asOf: '2026-11-15', payload: 1 }))).toBe('invalid');
    expect(await code(saveReport(db, at(), { projectId: 'series', kind: 'keyword', title: 'x', asOf: 'later', payload: 1 }))).toBe('invalid');
  });
});

describe('decisions and what the figures did around them', () => {
  const ranks = (days: string[], rank: number) => days.map((d) => fig(d, { rank }));

  it('records a change with its reason, in the ledger too, and shows the figures before and after with the points on each side', async () => {
    await publishFigures(db, at(), [...ranks(['2026-09-25', '2026-10-02', '2026-10-09'], 80_000), ...ranks(['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10'], 30_000)]);
    const d = await recordMarketDecision(db, at('ana'), { editionId: 'ed1', asin: ASIN, kind: 'cover', from: 'Old cover', to: 'New cover', reason: 'The old one did not read as a thumbnail.', decidedAt: '2026-10-15T09:00:00Z', projectId: 'book' });
    expect(d.decisionId).toBeTruthy();
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM decision WHERE id = ?', [d.decisionId]))!.n).toBe(1);
    const w = await decisionWindow(db, at(), d.id, 30);
    expect(w.before.points).toHaveLength(3);
    expect(w.after.points).toHaveLength(4);
    expect(w.before.median.rank).toBe(80_000);
    expect(w.after.median.rank).toBe(30_000);
    expect(w.alsoChanged).toEqual([]);
    expect(w.caveats.join(' ')).not.toMatch(/caused/);
    expect(w.caveats.at(-1)).toMatch(/captures, not sales/);
  });

  it('lists the other changes in the same window and says the figures cannot be put down to one; too few points is said, not hidden', async () => {
    await publishFigures(db, at(), [fig('2026-10-10'), fig('2026-10-20')]);
    const cover = await recordMarketDecision(db, at(), { editionId: 'ed1', asin: ASIN, kind: 'cover', reason: 'New art.', decidedAt: '2026-10-15T09:00:00Z' });
    await recordMarketDecision(db, at(), { editionId: 'ed1', asin: ASIN, kind: 'price', from: '4.99', to: '0.99', reason: 'Launch sale.', decidedAt: '2026-10-16T09:00:00Z' });
    await recordMarketDecision(db, at(), { editionId: 'ed2', asin: 'B0OTHERBK1', kind: 'price', reason: 'Another book.', decidedAt: '2026-10-16T09:00:00Z' });
    const w = await decisionWindow(db, at(), cover.id, 30);
    expect(w.alsoChanged.map((x) => x.kind)).toEqual(['price']);
    expect(w.caveats[0]).toMatch(/Only 1 figure on the thinner side/);
    expect(w.caveats.join(' ')).toMatch(/1 other change to this book \(price\) fell in the same window/);
    expect((await listMarketDecisions(db, at(), { editionId: 'ed1' })).map((x) => x.kind)).toEqual(['price', 'cover']);
    expect(await code(decisionWindow(db, at(), cover.id, 0))).toBe('invalid');
    const none = await recordMarketDecision(db, at(), { editionId: 'ed3', kind: 'blurb', reason: 'Rewrote it.' });
    expect((await decisionWindow(db, at(), none.id)).caveats[0]).toMatch(/names no ASIN/);
    expect(await code(recordMarketDecision(db, at(), { editionId: 'ed1', kind: 'cover', reason: ' ' }))).toBe('invalid');
  });
});

describe('the post-launch review', () => {
  const live = async (date = '2026-10-01') => {
    await ensureDefaultTemplates(db, at());
    const t = (await listTemplates(db, at())).find((x) => x.key === 'ebook_launch')!;
    const { plan } = await createPlan(db, at(), { projectId: 'book', templateId: t.id, releaseDate: date, targets: { rank: 20_000, reviews: 25, readers: 10 } });
    const pairs = await Promise.all((await itemsOf(db, plan.id)).map(async (item) => ({ item, task: (await getTask(db, at(), item.taskId))! })));
    await approvePlan(db, at('dir'), plan.id, planRevision(plan, pairs), pairs);
    await goLive(db, at(), plan.id, pairs);
    return plan;
  };

  it('is filled from published figures at 7, 30 and 90 days, each with its capture time; planned and measured are kept apart; a day not reached says so', async () => {
    const plan = await live('2026-10-01');
    await publishFigures(db, at(), [fig('2026-10-08', { rank: 40_000 }), fig('2026-10-09'), fig('2026-10-31', { rank: 12_000, ratings: 31 })]);
    const r = await openReview(db, at(), plan.id, ASIN, '2026-11-20');
    expect(r.planned).toEqual({ rank: 20_000, reviews: 25, readers: 10, releaseDate: '2026-10-01' });
    expect(r.measured.map((p) => [p.day, p.due, p.figure?.capturedAt.slice(0, 10) ?? null, p.figure?.rank ?? null])).toEqual([[7, '2026-10-08', '2026-10-08', 40_000], [30, '2026-10-31', '2026-10-31', 12_000], [90, '2025-12-30'.replace('2025', '2026'), null, null]]);
    expect(r.measured[2]!.missing).toMatch(/not reached yet/);
    expect(await code(openReview(db, at(), plan.id, ASIN, '2026-11-20'))).toBe('exists');
    await publishFigures(db, at(), [fig('2026-12-31', { rank: 9000 })]);
    const later = await refreshReview(db, at(), plan.id, ASIN, '2027-01-05');
    expect(later.measured[2]!.figure!.rank).toBe(9000);
    expect(await code(finishReview(db, at(), plan.id))).toBe('invalid'); // nothing written yet
    await writeReview(db, at(), plan.id, { worked: 'The ARC round.', didNot: 'The banner came late.', next: 'Order art earlier.' });
    const done = await finishReview(db, at(), plan.id);
    expect(done).toMatchObject({ state: 'done', worked: 'The ARC round.' });
    expect((await (await import('../src')).getPlan(db, at(), plan.id))!.state).toBe('reviewed');
    expect(await code(refreshReview(db, at(), plan.id, ASIN, '2027-01-05'))).toBe('conflict');
    expect((await getReview(db, at(), plan.id))!.state).toBe('done');
  });

  it('says why a day has no figure: no capture near it, or no ASIN; and only a live plan is reviewed', async () => {
    const plan = await live('2026-10-01');
    const r = await openReview(db, at(), plan.id, null, '2026-11-20');
    expect(r.measured[0]!.missing).toMatch(/no ASIN/);
    await db.run("DELETE FROM launch_review");
    const r2 = await openReview(db, at(), plan.id, ASIN, '2026-11-20');
    expect(r2.measured[0]!.missing).toBe('No capture between 2026-10-08 and 2026-10-13.');
    const { plan: draft } = await createPlan(db, at(), { projectId: 'book2', templateId: (await listTemplates(db, at()))[0]!.id, releaseDate: '2027-03-01' });
    expect(await code(openReview(db, at(), draft.id, ASIN, '2026-11-20'))).toBe('conflict');
  });
});
