import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, addFeedback, addUse, approveVersion, approvedAssets, approvedVersion, assetWhereUsed, chooseConcept, conceptsOf, createAsset, createBrief, decideConcept, decideReplacement,
  feedbackOf, getAsset, licenceDaysLeft, licenceExpired, listAssets, proposeReplacement, replacementsOf, resolveFeedback, retireAsset, revokeApproval, setUseState, submitConcept,
  submitForReview, updateAsset, usesOf, type Ctx, type Db
} from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
const ctx = (actor: string): Ctx => ({ studioId: 's1', actor, now: `2026-11-19T10:00:${String(clock++).padStart(2, '0')}Z` });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
const BOOK = 'book1';

async function file(id: string, path: string, versions = 2) {
  await db.run('INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, ?, ?, ?)', [id, 's1', path, versions]);
  for (let n = 1; n <= versions; n++) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, ?, ?, 1, 'art', '2026-11-01T00:00:00.000Z')", [id, n, `${id}-h${n}`]);
}
beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  await file('cov', 'Art/cover.psd', 3);
  await file('c2', 'Art/cover-b.jpg', 1);
  await file('epub', 'Exports/book.epub', 1);
});
const cover = () => createAsset(db, ctx('art'), { projectId: BOOK, fileId: 'cov', kind: 'cover', name: 'Cover' });

describe('assets: a vault file with governance', () => {
  it('makes a vault file an asset in draft, once; the name defaults to the file name', async () => {
    const a = await createAsset(db, ctx('art'), { projectId: BOOK, fileId: 'cov', kind: 'cover' });
    expect(a).toMatchObject({ projectId: BOOK, fileId: 'cov', kind: 'cover', name: 'cover.psd', state: 'draft' });
    expect(await code(createAsset(db, ctx('art'), { projectId: BOOK, fileId: 'cov', kind: 'cover' }))).toBe('exists');
    expect(await code(createAsset(db, ctx('art'), { projectId: BOOK, fileId: 'nope', kind: 'cover' }))).toBe('not-found');
    expect(await code(createAsset(db, ctx('art'), { projectId: BOOK, fileId: 'c2', kind: 'poster' as never }))).toBe('invalid');
    expect((await listAssets(db, ctx('x'), { projectId: BOOK })).map((x) => x.id)).toEqual([a.id]);
  });

  it('approval is of an exact version and hash; another version is not approved until someone approves it', async () => {
    const a = await cover();
    const ap = await approveVersion(db, ctx('dir'), a.id, 2, 'Good.');
    expect(ap).toMatchObject({ version: 2, hash: 'cov-h2', state: 'approved', decidedBy: 'dir', note: 'Good.' });
    expect(await getAsset(db, ctx('x'), a.id)).toMatchObject({ state: 'approved' });
    expect(await approvedVersion(db, ctx('x'), a.id)).toMatchObject({ version: 2 });
    expect(await code(approveVersion(db, ctx('dir'), a.id, 2))).toBe('conflict');
    expect(await code(approveVersion(db, ctx('dir'), a.id, 9))).toBe('not-found');
    // version 3 exists in the vault but is not approved; the approved one is still 2
    expect(await approvedVersion(db, ctx('x'), a.id)).toMatchObject({ version: 2, hash: 'cov-h2' });
    expect((await approvedAssets(db, ctx('x'), [BOOK], 'cover'))[0]).toMatchObject({ version: 2, licenceExpired: false });
  });

  it('revoking takes an approval back with a reason, later; the asset returns to review when none is left', async () => {
    const a = await cover();
    await approveVersion(db, ctx('dir'), a.id, 1);
    expect(await code(revokeApproval(db, ctx('dir'), a.id, 1, ''))).toBe('invalid');
    expect(await code(revokeApproval(db, ctx('dir'), a.id, 3, 'x'))).toBe('conflict');
    await revokeApproval(db, ctx('dir'), a.id, 1, 'Wrong trim.');
    expect(await approvedVersion(db, ctx('x'), a.id)).toBeNull();
    expect(await getAsset(db, ctx('x'), a.id)).toMatchObject({ state: 'in_review' });
    await approveVersion(db, ctx('dir'), a.id, 1); // it can be approved again: a new row, the history stays
    expect((await db.all('SELECT 1 FROM asset_approval WHERE asset_id = ?', [a.id])).length).toBe(3);
  });

  it('an expired licence blocks a new approval and nothing else; the day it runs to still counts', async () => {
    const a = await createAsset(db, ctx('art'), { projectId: BOOK, fileId: 'cov', kind: 'cover', licence: { kind: 'stock', licensor: 'Pixel Co', expires: '2026-11-18' } });
    expect(licenceExpired(a.licence, '2026-11-19T00:00:00Z')).toBe(true);
    expect(licenceExpired(a.licence, '2026-11-18T23:59:59Z')).toBe(false);
    expect(licenceDaysLeft(a.licence, '2026-11-16T00:00:00Z')).toBe(2);
    expect(await code(approveVersion(db, ctx('dir'), a.id, 1))).toBe('blocked');
    await updateAsset(db, ctx('man'), a.id, { licence: { expires: '2027-11-18' } });
    expect(await code(approveVersion(db, ctx('dir'), a.id, 1))).toBe('ok');
    await updateAsset(db, ctx('man'), a.id, { licence: { expires: '2026-01-01' } }); // lapses later: the approved version stays, flagged
    expect((await approvedAssets(db, ctx('x'), [BOOK]))[0]).toMatchObject({ version: 1, licenceExpired: true });
    expect(await code(updateAsset(db, ctx('man'), a.id, { licence: { expires: '18 November' } }))).toBe('invalid');
  });

  it('a retired asset cannot be approved, changed or given uses', async () => {
    const a = await cover();
    await retireAsset(db, ctx('man'), a.id, 'Dropped.');
    expect(await code(approveVersion(db, ctx('dir'), a.id, 1))).toBe('conflict');
    expect(await code(updateAsset(db, ctx('man'), a.id, { name: 'x' }))).toBe('conflict');
    expect(await code(addUse(db, ctx('man'), a.id, { kind: 'listing', label: 'x' }))).toBe('conflict');
    expect(await listAssets(db, ctx('x'), { projectId: BOOK })).toEqual([]);
    expect((await listAssets(db, ctx('x'), { projectId: BOOK, state: 'any' })).length).toBe(1);
  });

  it('draft goes to review once', async () => {
    const a = await cover();
    expect((await submitForReview(db, ctx('art'), a.id)).state).toBe('in_review');
    expect(await code(submitForReview(db, ctx('art'), a.id))).toBe('conflict');
  });
});

describe('assets: where used, and replacements that move nothing', () => {
  it('lists the declared uses and the vault files that reference the asset', async () => {
    const a = await cover();
    await addUse(db, ctx('mkt'), a.id, { kind: 'listing', label: 'Amazon US listing', ref: 'B0123' });
    await addUse(db, ctx('mkt'), a.id, { kind: 'ad', label: 'Spring ad', version: 1 });
    expect(await code(addUse(db, ctx('mkt'), a.id, { kind: 'ad', label: 'Bad', version: 7 }))).toBe('not-found');
    await db.run("INSERT INTO file_reference (file_id, refers_to_id, version, note, created_at, created_by) VALUES ('epub', 'cov', 2, 'embedded', '2026-11-01T00:00:00Z', 'x')");
    const w = await assetWhereUsed(db, ctx('x'), a.id);
    expect(w.declared.map((u) => u.label)).toEqual(['Amazon US listing', 'Spring ad']);
    expect(w.files).toEqual([{ fileId: 'epub', path: 'Exports/book.epub', version: 2, note: 'embedded' }]);
  });

  it('proposing needs both versions approved; approving moves nothing and marks each current use "needs update"', async () => {
    const a = await cover();
    await approveVersion(db, ctx('dir'), a.id, 1);
    expect(await code(proposeReplacement(db, ctx('art'), a.id, { fromVersion: 1, toVersion: 2, reason: 'Recoloured.' }))).toBe('conflict'); // 2 is not approved
    await approveVersion(db, ctx('dir'), a.id, 2);
    expect(await code(proposeReplacement(db, ctx('art'), a.id, { fromVersion: 1, toVersion: 1, reason: 'x' }))).toBe('invalid');
    expect(await code(proposeReplacement(db, ctx('art'), a.id, { fromVersion: 1, toVersion: 2, reason: '' }))).toBe('invalid');
    const follows = await addUse(db, ctx('mkt'), a.id, { kind: 'listing', label: 'Listing' });
    const pinned = await addUse(db, ctx('mkt'), a.id, { kind: 'ad', label: 'Ad on v1', version: 1 });
    const other = await addUse(db, ctx('mkt'), a.id, { kind: 'banner', label: 'Banner on v2', version: 2 });
    const r = await proposeReplacement(db, ctx('art'), a.id, { fromVersion: 1, toVersion: 2, reason: 'Recoloured.' });
    expect(await code(proposeReplacement(db, ctx('art'), a.id, { fromVersion: 1, toVersion: 2, reason: 'again' }))).toBe('exists');
    expect((await usesOf(db, ctx('x'), a.id)).every((u) => u.state === 'current')).toBe(true); // a proposal changes nothing
    const done = await decideReplacement(db, ctx('dir'), r.id, { approve: true });
    expect(done.replacement).toMatchObject({ state: 'approved', decidedBy: 'dir' });
    expect(done.needUpdate.map((u) => u.id).sort()).toEqual([follows.id, pinned.id].sort());
    expect((await usesOf(db, ctx('x'), a.id)).find((u) => u.id === other.id)!.state).toBe('current');
    expect(await approvedVersion(db, ctx('x'), a.id)).toMatchObject({ version: 2 });
    expect((await db.all('SELECT 1 FROM asset_approval WHERE asset_id = ? AND version = 1 AND state = \'revoked\'', [a.id])).length).toBe(0); // the old one stays approved
    await setUseState(db, ctx('mkt'), follows.id, 'done');
    expect((await usesOf(db, ctx('x'), a.id)).find((u) => u.id === follows.id)!.state).toBe('done');
    expect(await code(decideReplacement(db, ctx('dir'), r.id, { approve: true }))).toBe('conflict');
  });

  it('a rejection needs a reason and marks nothing', async () => {
    const a = await cover();
    await approveVersion(db, ctx('dir'), a.id, 1);
    await approveVersion(db, ctx('dir'), a.id, 2);
    await addUse(db, ctx('mkt'), a.id, { kind: 'listing', label: 'Listing' });
    const r = await proposeReplacement(db, ctx('art'), a.id, { fromVersion: 1, toVersion: 2, reason: 'x' });
    expect(await code(decideReplacement(db, ctx('dir'), r.id, { approve: false }))).toBe('invalid');
    await decideReplacement(db, ctx('dir'), r.id, { approve: false, reason: 'Not yet.' });
    expect((await replacementsOf(db, ctx('x'), a.id))[0]).toMatchObject({ state: 'rejected', decisionReason: 'Not yet.' });
    expect((await usesOf(db, ctx('x'), a.id))[0]!.state).toBe('current');
  });
});

describe('concepts and pinned feedback', () => {
  const brief = (kind: 'cover' | 'edit' = 'cover') => createBrief(db, ctx('dir'), { projectId: BOOK, kind, title: 'Cover for Book Four', body: 'A dragon at dusk.' });

  it('offers a file version against a brief version; only cover and art briefs take concepts', async () => {
    const b = await brief();
    const k = await submitConcept(db, ctx('art'), { briefId: b.id, fileId: 'cov', fileVersion: 2, note: 'Warm.' });
    expect(k).toMatchObject({ briefVersion: 1, fileId: 'cov', fileVersion: 2, state: 'submitted', submittedBy: 'art', projectId: BOOK });
    expect(await code(submitConcept(db, ctx('art'), { briefId: b.id, briefVersion: 5, fileId: 'cov' }))).toBe('not-found');
    expect(await code(submitConcept(db, ctx('art'), { briefId: b.id, fileId: 'cov', fileVersion: 9 }))).toBe('not-found');
    expect(await code(submitConcept(db, ctx('art'), { briefId: (await brief('edit')).id, fileId: 'cov' }))).toBe('invalid');
    expect((await conceptsOf(db, ctx('x'), b.id)).length).toBe(1);
  });

  it('shortlisting and rejecting (with a reason); choosing makes the file an asset in review, and is not approval', async () => {
    const b = await brief();
    const one = await submitConcept(db, ctx('art'), { briefId: b.id, fileId: 'cov' });
    const two = await submitConcept(db, ctx('art'), { briefId: b.id, fileId: 'c2' });
    await decideConcept(db, ctx('dir'), one.id, 'shortlisted');
    expect(await code(decideConcept(db, ctx('dir'), two.id, 'rejected'))).toBe('invalid');
    await decideConcept(db, ctx('dir'), two.id, 'rejected', 'Too dark.');
    expect(await code(chooseConcept(db, ctx('dir'), two.id))).toBe('conflict');
    const { concept, asset } = await chooseConcept(db, ctx('dir'), one.id);
    expect(concept).toMatchObject({ state: 'chosen', assetId: asset.id, decidedBy: 'dir' });
    expect(asset).toMatchObject({ fileId: 'cov', kind: 'cover', state: 'in_review' });
    expect(await approvedVersion(db, ctx('x'), asset.id)).toBeNull();
    expect(await code(chooseConcept(db, ctx('dir'), one.id))).toBe('conflict');
  });

  it('feedback pins to a region at an exact version; a region outside the image is refused', async () => {
    const b = await brief();
    const k = await submitConcept(db, ctx('art'), { briefId: b.id, fileId: 'cov', fileVersion: 2 });
    const f = await addFeedback(db, ctx('dir'), { targetKind: 'concept', targetId: k.id, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, body: 'Title too small.' });
    expect(f).toMatchObject({ fileVersion: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, state: 'open', by: 'dir' });
    expect(await code(addFeedback(db, ctx('dir'), { targetKind: 'concept', targetId: k.id, region: { x: 0.9, y: 0, w: 0.3, h: 0.1 }, body: 'x' }))).toBe('invalid');
    expect(await code(addFeedback(db, ctx('dir'), { targetKind: 'concept', targetId: k.id, body: '' }))).toBe('invalid');
    expect(await code(addFeedback(db, ctx('dir'), { targetKind: 'concept', targetId: k.id, fileVersion: 3, body: 'x' }))).toBe('ok'); // a version of the file that exists
    const a = await cover();
    await addFeedback(db, ctx('dir'), { targetKind: 'asset', targetId: a.id, body: 'Whole thing is dim.' }); // no region: about the whole image, on the latest version
    expect((await feedbackOf(db, ctx('x'), 'asset', a.id))[0]).toMatchObject({ region: null, fileVersion: 3 });
    const done = await resolveFeedback(db, ctx('art'), f.id);
    expect(done).toMatchObject({ state: 'resolved', resolvedBy: 'art' });
    expect((await feedbackOf(db, ctx('x'), 'concept', k.id)).map((x) => x.state)).toEqual(['resolved', 'open']);
  });

  it('cover and art briefs are versioned like any brief', async () => {
    const b = await brief();
    expect(b).toMatchObject({ kind: 'cover', current: { n: 1 } });
  });
});
