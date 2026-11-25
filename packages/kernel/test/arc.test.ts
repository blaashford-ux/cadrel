import { beforeEach, describe, expect, it } from 'vitest';
import { WorkError, addReader, arcSent, closeCampaign, countsOf, createCampaign, createPlan, ensureDefaultTemplates, eraseReader, listCampaigns, listTemplates, publishFigures, readersOf, reportReviews, reviewCrossCheck, setReaderState, type Ctx, type Db } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
let plan: string;
let camp: string;
const at = (actor = 'mia'): Ctx => ({ studioId: 's1', actor, now: `2026-11-20T10:00:${String(clock++ % 60).padStart(2, '0')}Z` });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('epub', 's1', 'book.epub', 2)");
  for (const n of [1, 2]) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('epub', ?, ?, 1, 'x', '2026-11-01T00:00:00Z')", [n, `h${n}`]);
  await ensureDefaultTemplates(db, at());
  plan = (await createPlan(db, at(), { projectId: 'book', templateId: (await listTemplates(db, at()))[0]!.id, releaseDate: '2027-02-01' })).plan.id;
  camp = (await createCampaign(db, at(), { planId: plan, name: 'First round', targetReaders: 10, reviewTarget: 5, fileId: 'epub', fileVersion: 2, sendBy: '2026-12-15' })).id;
});

describe('an ARC round', () => {
  it('pins the file to an exact version, and refuses one that is not there or a plan that is not', async () => {
    expect((await listCampaigns(db, at(), { planId: plan }))[0]).toMatchObject({ name: 'First round', fileId: 'epub', fileVersion: 2, targetReaders: 10, state: 'open' });
    expect(await code(createCampaign(db, at(), { planId: plan, name: 'x', fileId: 'epub', fileVersion: 9 }))).toBe('not-found');
    expect(await code(createCampaign(db, at(), { planId: 'nope', name: 'x' }))).toBe('not-found');
    expect(await code(createCampaign(db, at(), { planId: plan, name: 'x', targetReaders: -1 }))).toBe('invalid');
  });

  it('tracks readers through invited, sent and reviewed, with the time each was reached; the same email twice is refused', async () => {
    const a = await addReader(db, at(), camp, { name: 'Rae Reader', email: 'Rae@Example.com', source: 'newsletter' });
    expect(a).toMatchObject({ state: 'invited', email: 'rae@example.com', sentAt: null });
    expect(await code(addReader(db, at(), camp, { name: 'Rae again', email: 'rae@example.com' }))).toBe('exists');
    expect(await code(addReader(db, at(), camp, { name: 'Bad', email: 'not an email' }))).toBe('invalid');
    expect(await code(addReader(db, at(), camp, { name: ' ' }))).toBe('invalid');
    const sent = await setReaderState(db, at(), a.id, 'sent');
    expect(sent.sentAt).not.toBeNull();
    const done = await setReaderState(db, at(), a.id, 'reviewed', { reviewUrl: 'https://example.com/review/1' });
    expect(done).toMatchObject({ state: 'reviewed', reviewUrl: 'https://example.com/review/1', sentAt: sent.sentAt });
    expect(done.reviewedAt).not.toBeNull();
    expect(await code(setReaderState(db, at(), a.id, 'five stars' as never))).toBe('invalid');
    expect(Object.keys(done)).not.toContain('rating'); // no star rating is kept, and nothing asks for one
  });

  it('counts are for everyone and have no people in them; the details are for managers and every read is logged', async () => {
    const [r1, r2, r3] = [await addReader(db, at(), camp, { name: 'One', email: 'one@x.com' }), await addReader(db, at(), camp, { name: 'Two' }), await addReader(db, at(), camp, { name: 'Three' })];
    await setReaderState(db, at(), r1.id, 'sent');
    await setReaderState(db, at(), r2.id, 'reviewed');
    await setReaderState(db, at(), r3.id, 'declined');
    const c = await countsOf(db, at(), camp);
    expect(c).toEqual({ total: 3, byState: { invited: 0, sent: 1, received: 0, reviewed: 1, declined: 1, bounced: 0 }, withFile: 2, reviewed: 1, targetReaders: 10, reviewTarget: 5 });
    expect(JSON.stringify(c)).not.toMatch(/One|one@x/);
    expect(await arcSent(db, at(), plan)).toBe(2);
    const before = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = 'arc.readers_read'"))!.n;
    const people = await readersOf(db, at('mia'), camp);
    expect(people.map((p) => p.name)).toEqual(['One', 'Two', 'Three']);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = 'arc.readers_read'"))!.n).toBe(before + 1);
    expect((await db.first<{ actor: string }>("SELECT actor FROM audit WHERE action = 'arc.readers_read' ORDER BY rowid DESC LIMIT 1"))!.actor).toBe('mia');
  });

  it('erasing a reader removes their details and keeps the count; the erasure is logged; an erased reader cannot be changed; the email can be used again', async () => {
    const r = await addReader(db, at(), camp, { name: 'Rae Reader', email: 'rae@example.com', note: 'Prefers EPUB' });
    await setReaderState(db, at(), r.id, 'reviewed', { reviewUrl: 'https://example.com/r' });
    await eraseReader(db, at(), r.id);
    const [e] = await readersOf(db, at(), camp);
    expect(e).toMatchObject({ name: null, email: null, reviewUrl: null, note: '', state: 'reviewed' });
    expect(e!.erasedAt).not.toBeNull();
    expect((await countsOf(db, at(), camp)).reviewed).toBe(1);
    expect(await code(setReaderState(db, at(), r.id, 'sent'))).toBe('conflict');
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = 'arc.reader_erase'"))!.n).toBe(1);
    expect(await code(addReader(db, at(), camp, { name: 'Rae back', email: 'rae@example.com' }))).toBe('ok');
    await eraseReader(db, at(), r.id); // again: nothing happens
    expect(await code(eraseReader(db, at(), 'nope'))).toBe('not-found');
  });

  it('reported reviews sit beside the measured ratings count, each labelled and dated', async () => {
    await reportReviews(db, at(), camp, 18);
    expect(await reviewCrossCheck(db, at(), camp, null)).toEqual({ reported: 18, readersReviewed: 0, measured: null });
    await publishFigures(db, at(), [{ asin: 'B0ABCDEF12', capturedAt: '2026-11-18T08:00:00Z', ratings: 14 }]);
    const x = await reviewCrossCheck(db, at(), camp, 'B0ABCDEF12');
    expect(x.reported).toBe(18);
    expect(x.measured).toEqual({ ratings: 14, capturedAt: '2026-11-18T08:00:00.000Z' });
    expect(await code(reportReviews(db, at(), camp, -3))).toBe('invalid');
    await closeCampaign(db, at(), camp);
    expect((await listCampaigns(db, at(), { planIds: [plan] }))[0]!.state).toBe('closed');
  });
});
