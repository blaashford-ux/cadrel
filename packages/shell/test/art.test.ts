// The Art page's main-process side on a Studio's own records: what it assembles for the page, the calls it carries, and the pictures it shows.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Art, ArtError, previewOf } from '../src/main/art';
import { FakeVault, fixture, jpeg, psd, sha, type Fixture } from './artFixture';

let f: Fixture, vault: FakeVault, art: Art;
const go = (name: string, ...args: unknown[]) => art.call(name, args);
const ready = async (project = f.book4) => {
  const s = await art.state(project);
  if (!s.available) throw new Error(`art unavailable: ${s.reason}`);
  return s;
};

beforeEach(async () => {
  f = await fixture();
  vault = new FakeVault([
    { fileId: 'cov', path: 'Book Four/Art/cover.psd', projectId: f.book4, versions: [psd(8, 4), psd(8, 4), psd(16, 8)] },
    { fileId: 'jpg', path: 'Book Four/Art/cover-b.jpg', projectId: f.book4, versions: [jpeg(1600, 2560, 1)] },
    { fileId: 'old', path: 'Book One/Art/cover.jpg', projectId: f.book1, versions: [jpeg(1600, 2560, 2)] },
    { fileId: 'ms', path: 'Book Four/book.md', projectId: f.book4, versions: [new TextEncoder().encode('Chapter one.')] },
    { fileId: 'loose', path: 'Art/unfiled.png', projectId: null, versions: [jpeg(10, 10)] }
  ]);
  await f.register(vault);
  art = new Art(f.studio, f.host, vault);
});
afterEach(() => f.close());

describe('the Art page: what it shows for the project in view', () => {
  it('offers only the design files of the project in view that are not assets yet', async () => {
    const book4 = await ready();
    expect(book4.candidates.map((c) => c.path)).toEqual(['Book Four/Art/cover-b.jpg', 'Book Four/Art/cover.psd']); // not the manuscript, not Book One's art, not a file in no project
    const series = await ready(f.series);
    expect(series.candidates.map((c) => c.path)).toEqual(['Book Four/Art/cover-b.jpg', 'Book Four/Art/cover.psd', 'Book One/Art/cover.jpg']);
    expect(series.project).toMatchObject({ name: 'Dragon Rider' });
    expect(book4.may).toMatchObject({ read: true, write: true, approve: true, manage: true, brief: true });
  });

  it('says so for a project that is not there, and for none in view it takes the first series', async () => {
    expect(await art.state('nope')).toMatchObject({ available: false });
    const s = await art.state();
    expect(s.available && s.project.name).toBe('Dragon Rider');
  });

  it('an asset appears with its approval, its newer version, its licence and its uses', async () => {
    const a = (await go('create', { projectId: f.book4, fileId: 'cov', kind: 'cover', name: 'Cover', licence: { kind: 'stock', licensor: 'Pixel Co', expires: '2099-01-01' } })) as { id: string };
    await go('approve', a.id, 2, 'Good.');
    await go('addUse', a.id, { kind: 'listing', label: 'Amazon US' });
    const s = await ready();
    const row = s.assets[0]!;
    expect(row).toMatchObject({ name: 'Cover', path: 'Book Four/Art/cover.psd', latestVersion: 3, approvedNow: 2, newerThanApproved: true, state: 'approved', uses: 1, needUpdate: 0, licenceExpired: false, projectName: 'Book Four' });
    expect(row.approved).toEqual([{ version: 2, hash: sha(psd(8, 4)), at: expect.any(String), byName: 'you' }]);
    expect(s.candidates.map((c) => c.fileId)).toEqual(['jpg']); // cov is an asset now
    expect(s.licencesDue).toEqual([]);
  });

  it('a licence that has run out, or runs out soon, is listed, soonest first', async () => {
    const a = (await go('create', { projectId: f.book4, fileId: 'cov', kind: 'cover', licence: { expires: '2020-01-01' } })) as { id: string };
    const b = (await go('create', { projectId: f.book4, fileId: 'jpg', kind: 'banner', licence: { expires: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) } })) as { id: string };
    const s = await ready();
    expect(s.licencesDue.map((d) => d.assetId)).toEqual([a.id, b.id]);
    expect(s.licencesDue[0]!.days).toBeLessThan(0);
    expect(s.assets.find((r) => r.id === a.id)!.licenceExpired).toBe(true);
    await expect(go('approve', a.id, 1)).rejects.toThrow(/licence ran out/);
  });

  it('one asset: its versions with who and which are approved, where it is used, replacements and feedback', async () => {
    const a = (await go('create', { projectId: f.book4, fileId: 'cov', kind: 'cover' })) as { id: string };
    await go('approve', a.id, 1);
    await go('approve', a.id, 3);
    await go('addUse', a.id, { kind: 'listing', label: 'Amazon US' });
    await go('proposeReplacement', a.id, { fromVersion: 1, toVersion: 3, reason: 'Recoloured.' });
    await go('comment', { targetKind: 'asset', targetId: a.id, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, body: 'Title is low.' });
    const v = await art.asset(a.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.versions.map((x) => [x.n, x.approved])).toEqual([[3, true], [2, false], [1, true]]);
    expect(v.approvals.map((x) => [x.version, x.byName])).toEqual([[1, 'you'], [3, 'you']]);
    expect(v.uses.map((u) => u.label)).toEqual(['Amazon US']);
    expect(v.replacements[0]).toMatchObject({ state: 'open', proposerName: 'you', fromVersion: 1, toVersion: 3 });
    expect(v.feedback[0]).toMatchObject({ body: 'Title is low.', byName: 'you', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    expect(v.asset.openFeedback).toBe(1);
    expect(await art.asset('nope')).toMatchObject({ available: false });
  });
});

describe('the Art page: briefs and concepts', () => {
  it('writes a cover brief, takes concepts against it, and choosing one makes its file an asset in review', async () => {
    const b = (await go('createBrief', { projectId: f.book4, kind: 'cover', title: 'Cover for Book Four', body: 'A dragon at dusk.' })) as { id: string };
    await expect(go('createBrief', { projectId: f.book4, kind: 'edit', title: 'x', body: 'y' })).rejects.toThrow(ArtError);
    const k1 = (await go('submitConcept', { briefId: b.id, fileId: 'cov', fileVersion: 3, note: 'Warm.' })) as { id: string };
    await go('submitConcept', { briefId: b.id, fileId: 'jpg' });
    await go('comment', { targetKind: 'concept', targetId: k1.id, region: { x: 0, y: 0, w: 1, h: 0.2 }, body: 'Crop the top.' });
    let v = await art.brief(b.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.brief).toMatchObject({ title: 'Cover for Book Four', kind: 'cover', version: 1, body: 'A dragon at dusk.', writtenByName: 'you' });
    expect(v.concepts.map((c) => [c.path, c.fileVersion, c.state, c.feedback.length])).toEqual([['Book Four/Art/cover.psd', 3, 'submitted', 1], ['Book Four/Art/cover-b.jpg', 1, 'submitted', 0]]);
    expect(v.candidates).toEqual([]); // both versions in the project's design files are already offered
    await go('chooseConcept', k1.id);
    v = await art.brief(b.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.concepts[0]).toMatchObject({ state: 'chosen' });
    const s = await ready();
    expect(s.assets.find((r) => r.fileId === 'cov')).toMatchObject({ state: 'in_review', kind: 'cover' });
    expect(s.briefs[0]).toMatchObject({ title: 'Cover for Book Four', concepts: 2, chosen: true });
  });

  it('a revised brief keeps its earlier version, and the brief is not an edit brief', async () => {
    const b = (await go('createBrief', { projectId: f.book4, kind: 'art', title: 'Banner', body: 'v1' })) as { id: string };
    await go('reviseBrief', b.id, { body: 'v2', basedOn: 1, note: 'More red.' });
    const v = await art.brief(b.id);
    if (!v.available) throw new Error(v.reason);
    expect(v.versions.map((x) => [x.n, x.body])).toEqual([[2, 'v2'], [1, 'v1']]);
    expect(v.brief).toMatchObject({ version: 2, note: 'More red.' });
    expect(await art.brief('nope')).toMatchObject({ available: false });
  });

  it('only the page’s own calls are reachable', async () => {
    await expect(go('constructor', [])).rejects.toBeInstanceOf(ArtError);
    await expect(go('delete', [])).rejects.toBeInstanceOf(ArtError);
  });
});

describe('the Art page: pictures', () => {
  it('shows a picture as it is, the composite of a Photoshop file, and says why when there is none', async () => {
    const a = (await go('create', { projectId: f.book4, fileId: 'cov', kind: 'cover' })) as { id: string };
    void a;
    const j = await art.preview('jpg', 1);
    expect(j).toMatchObject({ kind: 'image', mime: 'image/jpeg', width: 1600, height: 2560, format: 'jpeg' });
    if (j.kind === 'image') expect(j.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(await art.preview('cov', 1)).toMatchObject({ kind: 'image', mime: 'image/png', format: 'psd', width: 8, height: 4, note: expect.stringContaining('Photoshop') });
    expect(await art.preview('cov', 9)).toMatchObject({ kind: 'none', reason: expect.stringContaining('not here') });
  });

  it('a picture the person cannot reach, or a file that is no picture, shows nothing', async () => {
    expect(await art.preview('loose', 1)).toMatchObject({ kind: 'none' }); // in no project
    expect(previewOf(new TextEncoder().encode('Chapter one.'))).toMatchObject({ kind: 'none' });
    expect(previewOf(psd(8, 4, true))).toMatchObject({ kind: 'none', reason: expect.stringContaining('Maximize Compatibility'), format: 'psd', width: 8, height: 4 });
  });

  it('a Studio managed by its owner has no art here', async () => {
    const away = new Art(f.studio, { service: null, me: 'x', peopleList: async () => [], mayOn: async () => false } as never, null);
    expect(await away.state()).toMatchObject({ available: false });
    expect(await away.asset('x')).toMatchObject({ available: false });
    await expect(away.call('create', [])).rejects.toBeInstanceOf(ArtError);
  });
});
