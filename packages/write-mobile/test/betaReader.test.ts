// Not type-checked with the app (see harness.ts). Cadrel Reader as an invited Beta Reader, against the real Studio server code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, invitationLink } from '@cadrel/kernel';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { createStudioReader } from '@cadrel/write/src/shared/review/studioReader';
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
  const open = async (chapters: string[]) => {
    await s.desk.add('Book 1/ms.md', TEXT, 'pB1');
    const f = (await s.desk.list()).find((x) => x.path === 'Book 1/ms.md')!;
    await s.owner.vault('setBetaRead', { fileId: f.id, level: 1, chapters });
    return f;
  };
  return { s, fs, reader, link, open };
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
});
