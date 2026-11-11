// Not type-checked with the app (see harness.ts). Cadrel Reader as an invited Beta Reader, against the real Studio server code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, invitationLink } from '@cadrel/kernel';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { createStudioReader, type JoinedStudio } from '@cadrel/write/src/shared/review/studioReader';
import { joinStudio, StudioClient } from '@cadrel/studio-client';
import { makeAnchor, newReviewFile, parseReviewFile, serializeReviewFile } from '@cadrel/write/src/shared/review/comments';
import { studio, URL_ } from './harness';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const TEXT = '# One\n\nfirst chapter\n\n# Two\n\nsecret chapter\n\n# Three\n\nthird chapter\n';

async function setup() {
  const s = await studio();
  const fetchFn = (s.owner as unknown as { o: { fetchFn: typeof fetch } }).o.fetchFn;
  const fs = new MemoryFs();
  const reader = createStudioReader({ fs, root: '/Reader', stateFile: '/data/studios.json', fetchFn, seal: (t) => `x:${t}`, unseal: (t) => t.slice(2) });
  const link = async (role = 'beta_reader', extra: Record<string, unknown> = { projectId: 'pB1' }) => {
    const r = await s.owner.request<{ code: string }>('POST', '/v1/invites', { role, label: 'Bea', ...extra });
    return invitationLink({ url: URL_, code: r.code, fingerprint: await fingerprint(s.ownerKey.publicKey), studioName: 'Acme' }, 'cadrel-reader');
  };
  /** An invitation for a person with no role: they see nothing until the owner gives them a role on a project. */
  const rolelessLink = async (scheme: 'cadrel' | 'cadrel-reader' = 'cadrel-reader') => {
    const r = await s.owner.request<{ code: string; personId: string }>('POST', '/v1/invites', { person: { name: 'Bea', email: 'bea@example.com' } });
    return { personId: r.personId, link: invitationLink({ url: URL_, code: r.code, fingerprint: await fingerprint(s.ownerKey.publicKey), studioName: 'Acme' }, scheme) };
  };
  const giveBetaReader = (personId: string, projectId = 'pB1') =>
    s.owner.request('POST', '/v1/call', { path: ['people', 'grant'], args: [{ subject: { kind: 'person', id: personId }, roleId: 'role_beta_reader', scope: { kind: 'project', id: projectId } }] });
  const open = async (chapters: string[]) => {
    await s.desk.add('Book 1/ms.md', TEXT, 'pB1');
    const f = (await s.desk.list()).find((x) => x.path === 'Book 1/ms.md')!;
    await s.owner.vault('setBetaRead', { fileId: f.id, level: 1, chapters });
    return f;
  };
  return { s, fs, reader, link, open, rolelessLink, giveBetaReader, fetchFn };
}

describe('Cadrel Reader as a Beta Reader of a Studio', () => {
  it('joins from the invitation, gets only the chapters switched on as a project, and writes notes the author can read', async () => {
    const { s, fs, reader, link, open } = await setup();
    const f = await open(['One', 'Three']);
    const shared = await reader.joinReview(await link(), 'Bea');
    expect(shared).toMatchObject({ project: 'Book 1' });
    const text = await fs.readText(`${shared.dir}/ms.md`);
    expect(text).toContain('first chapter');
    expect(text).not.toContain('secret');
    expect((await reader.listShared()).map((p) => p.project)).toEqual(['Book 1']);

    // a note, then an exchange: it reaches the Studio, where the author reads it
    const mine = newReviewFile('Book 1', { id: shared.reviewerId, name: 'Bea' });
    mine.items.push({ id: 'n1', kind: 'comment', file: 'ms.md', anchor: makeAnchor(text, 0, 5), body: 'Loved this', status: 'open', author: shared.reviewerId, createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z', replies: [] });
    await fs.mkdir(`${shared.dir}/.cadrel/review`, { recursive: true });
    await fs.writeText(`${shared.dir}/.cadrel/review/${shared.reviewerId}.json`, serializeReviewFile(mine));
    expect(await reader.exchangeReviews(shared.dir)).toMatchObject({ revoked: false, errors: [] });
    const all = await s.owner.beta<{ name: string; text: string }[]>('allNotes', f.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Bea');
    expect(parseReviewFile(all[0]!.text)!.items.map((i) => i.body)).toEqual(['Loved this']);
  });

  it('brings down a chapter the author switches on later, and the new version, and says when access is withdrawn', async () => {
    const { s, fs, reader, link, open } = await setup();
    const f = await open(['One']);
    const shared = await reader.joinReview(await link(), 'Bea');
    expect(await fs.readText(`${shared.dir}/ms.md`)).not.toContain('third chapter');
    await s.owner.vault('setBetaRead', { fileId: f.id, level: 1, chapters: ['One', 'Three'] });
    // the manuscript has not changed, only the chapters on: the reader still gets the new chapter
    expect(await reader.exchangeReviews(shared.dir)).toMatchObject({ changed: true, revoked: false });
    expect(await fs.readText(`${shared.dir}/ms.md`)).toContain('third chapter');
    // and a new version of the manuscript brings the new text, though a chapter added to it stays off
    await s.desk.save('Book 1/ms.md', TEXT.replace('first chapter', 'revised first chapter') + '\n# Four\n\nfourth\n');
    expect(await reader.exchangeReviews(shared.dir)).toMatchObject({ changed: true, revoked: false });
    const text = await fs.readText(`${shared.dir}/ms.md`);
    expect(text).toContain('revised first chapter');
    expect(text).not.toContain('fourth');
    await s.owner.vault('setBetaRead', { fileId: f.id, level: 1, chapters: [] });
    expect(await reader.exchangeReviews(shared.dir)).toMatchObject({ revoked: true });
  });

  it('refuses an invitation for another role, and a Studio link that is not for a Beta Reader', async () => {
    const { reader, link } = await setup();
    await expect(reader.joinReview(await link('author', {}), 'Ann')).rejects.toThrow(/can’t use/);
    await expect(reader.joinReview('https://example.com', 'Ann')).rejects.toThrow(/not a Cadrel invitation/);
  });

  it('joins with nothing shared yet, says so, and finds the manuscript once the author opens it', async () => {
    const { fs, reader, link, open } = await setup();
    await expect(reader.joinReview(await link(), 'Bea')).rejects.toThrow(/nothing has been shared/);
    expect(await reader.listShared()).toEqual([]);
    await open(['One']);
    const found = await reader.listShared();
    expect(found.map((p) => p.project)).toEqual(['Book 1']);
    expect(await fs.readText(`${found[0]!.dir}/ms.md`)).toContain('first chapter');
  });

  it('joins with an invitation that names no role, is told nothing is shared yet (and is not asked to join again), and gets the manuscript once the owner gives them the project', async () => {
    const { fs, reader, open, rolelessLink, giveBetaReader } = await setup();
    await open(['One']);
    const inv = await rolelessLink();
    await expect(reader.joinReview(inv.link, 'Bea')).rejects.toThrow(/nothing has been shared/);
    expect(await reader.listShared()).toEqual([]); // in, but nothing given yet
    expect((await giveBetaReader(inv.personId)) as unknown).toBeTruthy();
    const found = await reader.listShared();
    expect(found.map((p) => p.project)).toEqual(['Book 1']);
    expect(await fs.readText(`${found[0]!.dir}/ms.md`)).toContain('first chapter');
  });

  it('reads through a Studio the host has already joined (Cadrel’s Read tab): lists what is shared, keeps what it has when the host cannot say, and does not join Studios itself', async () => {
    const { s, fs, open, rolelessLink, giveBetaReader, fetchFn } = await setup();
    await open(['One']);
    const inv = await rolelessLink('cadrel');
    const j = await joinStudio({ link: inv.link, yourName: 'Bea', fetchFn });
    const me = await new StudioClient({ url: j.url, key: j.key, fetchFn }).me();
    expect(me.personId).toBe(inv.personId);
    const here: JoinedStudio = { studioId: 'local-id', url: j.url, fingerprint: j.fingerprint, name: 'Acme', me: 'Bea', personId: me.personId, publicKey: j.key.publicKey, sealedPrivateKey: `plain:${j.key.privateKey}` };
    let hostKnows = true;
    const reader = createStudioReader({ fs, root: '/Cadrel/Acme/Projects', fetchFn, joined: async () => (hostKnows ? [here] : Promise.reject(new Error('not asked yet'))), seal: (t) => `plain:${t}`, unseal: (t) => t.replace(/^plain:/, ''), appName: 'Cadrel' });
    expect(await reader.listShared()).toEqual([]); // joined, given nothing yet
    await giveBetaReader(inv.personId);
    const found = await reader.listShared();
    expect(found.map((p) => p.project)).toEqual(['Book 1']);
    expect(found[0]!.dir.startsWith('/Cadrel/Acme/Projects/Shared With Me/')).toBe(true);
    expect(await fs.readText(`${found[0]!.dir}/ms.md`)).toContain('first chapter');
    // the host cannot say who is joined (offline): what was downloaded is still listed
    hostKnows = false;
    expect((await reader.listShared()).map((p) => p.project)).toEqual(['Book 1']);
    hostKnows = true;
    // Studios are joined in Cadrel, never here
    await expect(reader.joinReview((await rolelessLink()).link, 'Bea')).rejects.toThrow(/Studio menu on Home/);
    expect(s).toBeTruthy();
  });
});
