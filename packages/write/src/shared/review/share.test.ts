import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { FakeDrive } from '../sync/fakeDrive';
import { makeReviews } from '../backend/reviews';
import { makeAnchor, newReviewFile, parseReviewFile, serializeReviewFile, type ReviewItem } from './comments';
import { parseInviteLink } from './link';
import { ReviewJoin, ReviewShare } from './share';

const note = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id, kind: 'comment', file: 'Manuscript/Book.md', anchor: makeAnchor('Hello there', 0, 5), body: 'nice', status: 'open',
  author: 'Sam', createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z', replies: [], ...over,
});

function setup() {
  const drive = new FakeDrive();
  const ownerFs = new MemoryFs();
  ownerFs.seed('/root/Novel/Manuscript/Book.md', '# One\n\nHello there\n');
  ownerFs.seed('/root/Novel/Manuscript/Book.export.json', '{}');
  ownerFs.seed('/root/Novel/.mdedit/project.json', '{}');
  ownerFs.seed('/root/Novel/Exports/Book.epub', 'x');
  let n = 0;
  const share = new ReviewShare({ fs: ownerFs, drive: () => drive, stateFile: '/state/shares.json', newId: () => `rev${++n}abcdef` });
  const readerFs = new MemoryFs();
  const join = new ReviewJoin({ fs: readerFs, drive: () => drive, sharedRoot: '/root/Shared With Me' });
  return { drive, ownerFs, share, readerFs, join };
}

describe('sharing a project for review', () => {
  it('publishes only the prose, as a link-readable file beside (not inside) the sync folder', async () => {
    const { drive, share } = setup();
    const rec = await share.publish('/root/Novel', 'Novel');
    const pkg = JSON.parse(await drive.download(rec.packageId));
    expect(pkg.files.map((f: { path: string }) => f.path)).toEqual(['Manuscript/Book.md']);
    expect(drive.links.get(rec.packageId)).toBe('reader');
    const all = await drive.listAll();
    expect(all.find((f) => f.id === rec.packageId)?.parentId).toBe(all.find((f) => f.name === 'MDEdit Reviews')?.id);
  });

  it('does not upload again when nothing changed, and updates in place when it did', async () => {
    const { drive, ownerFs, share } = setup();
    const a = await share.publish('/root/Novel', 'Novel');
    const b = await share.publish('/root/Novel', 'Novel');
    expect(b.packageId).toBe(a.packageId);
    expect(drive.calls.filter((c) => c.startsWith('updateFile'))).toHaveLength(0);
    ownerFs.seed('/root/Novel/Manuscript/Book.md', '# One\n\nChanged\n');
    await share.publish('/root/Novel', 'Novel');
    expect(drive.calls.filter((c) => c.startsWith('updateFile'))).toHaveLength(1);
  });

  it('invites a reviewer with their own writable file and a link that parses', async () => {
    const { drive, share } = setup();
    const r = await share.invite('/root/Novel', 'Novel', 'Sam');
    expect(drive.links.get(r.commentsId)).toBe('writer');
    expect(parseInviteLink(r.link)).toMatchObject({ commentsId: r.commentsId, reviewerId: r.id, project: 'Novel' });
    expect((await share.status('Novel')).reviewers.map((x) => x.name)).toEqual(['Sam']);
  });

  it('carries notes both ways between reviewer and owner', async () => {
    const { drive, share, ownerFs, readerFs, join } = setup();
    const inv = await share.invite('/root/Novel', 'Novel', 'Sam');
    const invite = parseInviteLink(inv.link)!;

    drive.granted = new Set([invite.packageId, invite.commentsId]); // what the picker grants the reviewer
    const joined = await join.join(invite, 'Sam');
    expect(await readerFs.readText(`${joined.dir}/Manuscript/Book.md`)).toContain('Hello there');
    expect((await join.list())[0].project).toBe('Novel');

    // the reviewer comments, then syncs
    const reviews = makeReviews(readerFs);
    const mine = parseReviewFile((await reviews.list(joined.dir))[0].text)!;
    await reviews.save(joined.dir, joined.reviewerId, serializeReviewFile({ ...mine, items: [note('n1')] }));
    await join.sync(joined.dir);

    // the owner pulls it, replies, and the reviewer sees the reply
    drive.granted = null;
    const pulled = await share.pull('/root/Novel', 'Novel');
    expect(pulled.changed).toBe(true);
    const ownerCopy = parseReviewFile((await makeReviews(ownerFs).list('/root/Novel')).find((r) => r.id === inv.id)!.text)!;
    expect(ownerCopy.items.map((i) => i.id)).toEqual(['n1']);
    await makeReviews(ownerFs).save('/root/Novel', inv.id, serializeReviewFile({ ...ownerCopy, items: [{ ...ownerCopy.items[0], status: 'resolved', updatedAt: '2026-10-07T12:00:00Z' }] }));
    await share.pull('/root/Novel', 'Novel');

    drive.granted = new Set([invite.packageId, invite.commentsId]);
    const res = await join.sync(joined.dir);
    expect(res.changed).toBe(true);
    const back = parseReviewFile((await reviews.list(joined.dir))[0].text)!;
    expect(back.items[0].status).toBe('resolved');
  });

  it('gives the reviewer new text, but never the project’s other files', async () => {
    const { drive, share, ownerFs, readerFs, join } = setup();
    ownerFs.seed('/root/Novel/.mdedit/project.json', JSON.stringify({ version: 1, name: 'Novel', activeManuscript: 'Manuscript/Book.md' }));
    const inv = await share.invite('/root/Novel', 'Novel', 'Sam');
    const invite = parseInviteLink(inv.link)!;
    drive.granted = new Set([invite.packageId, invite.commentsId]);
    const joined = await join.join(invite, 'Sam');
    drive.granted = null;
    ownerFs.seed('/root/Novel/Manuscript/Book.md', '# One\n\nRewritten\n');
    ownerFs.seed('/root/Novel/Extra.md', 'more');
    await share.sync('/root/Novel', 'Novel');
    drive.granted = new Set([invite.packageId, invite.commentsId]);
    await join.sync(joined.dir);
    expect(await readerFs.readText(`${joined.dir}/Manuscript/Book.md`)).toContain('Rewritten');
    expect(await readerFs.stat(`${joined.dir}/Extra.md`)).toBeNull();
  });

  it('joins the same invitation into the same folder, and refuses when access was not granted', async () => {
    const { drive, share, join } = setup();
    const inv = await share.invite('/root/Novel', 'Novel', 'Sam');
    const invite = parseInviteLink(inv.link)!;
    drive.granted = new Set();
    await expect(join.join(invite, 'Sam')).rejects.toThrow(/can’t open/);
    drive.granted = new Set([invite.packageId, invite.commentsId]);
    const a = await join.join(invite, 'Sam');
    const b = await join.join(invite, 'Sam');
    expect(b.dir).toBe(a.dir);
  });

  it('revoking closes the reviewer’s file, keeps their notes, and unshares the package with the last one', async () => {
    const { drive, share, ownerFs } = setup();
    const a = await share.invite('/root/Novel', 'Novel', 'Sam');
    const pkgId = (await share.status('Novel')).reviewers.length && (await drive.listAll()).find((f) => f.name.endsWith('mdedit-review.json'))!.id;
    await share.revoke('/root/Novel', 'Novel', a.id);
    expect(drive.links.has(a.commentsId)).toBe(false);
    expect(drive.links.has(pkgId as string)).toBe(false);
    expect((await share.status('Novel')).reviewers).toEqual([]);
    expect((await makeReviews(ownerFs).list('/root/Novel')).some((r) => r.id === a.id)).toBe(true);
  });

  it('reports that access was withdrawn', async () => {
    const { drive, share, join } = setup();
    const inv = await share.invite('/root/Novel', 'Novel', 'Sam');
    const invite = parseInviteLink(inv.link)!;
    drive.granted = new Set([invite.packageId, invite.commentsId]);
    const joined = await join.join(invite, 'Sam');
    drive.granted = new Set();
    expect(await join.sync(joined.dir)).toEqual({ changed: false, revoked: true });
  });

  it('shares the package again when a new reviewer is invited after the last one was removed', async () => {
    const { drive, share } = setup();
    const a = await share.invite('/root/Novel', 'Novel', 'Sam');
    const packageId = parseInviteLink(a.link)!.packageId;
    await share.revoke('/root/Novel', 'Novel', a.id);
    expect(drive.links.has(packageId)).toBe(false); // the last reviewer is gone, so the package is closed
    const b = await share.invite('/root/Novel', 'Novel', 'Mihael');
    expect(parseInviteLink(b.link)!.packageId).toBe(packageId); // the same package is re-used...
    expect(drive.links.get(packageId)).toBe('reader'); // ...so it has to be opened again
  });

  it('repairs an invitation whose package was left private, when the owner next exchanges notes', async () => {
    const { drive, ownerFs, share } = setup();
    const a = await share.invite('/root/Novel', 'Novel', 'Sam');
    const packageId = parseInviteLink(a.link)!.packageId;
    await drive.unshare(packageId); // how existing invitations were left
    const later = new ReviewShare({ fs: ownerFs, drive: () => drive, stateFile: '/state/shares.json' }); // the next time the app runs
    const r = await later.pull('/root/Novel', 'Novel');
    expect(r.errors).toEqual([]);
    expect(drive.links.get(packageId)).toBe('reader');
    drive.calls.length = 0;
    await later.pull('/root/Novel', 'Novel');
    expect(drive.calls.filter((c) => c.startsWith('share:'))).toEqual([]); // checked once per session, not every minute
  });

  it('lists the shared projects and can remove every reviewer at once', async () => {
    const { share, drive } = setup();
    expect(await share.list()).toEqual([]);
    const a = await share.invite('/root/Novel', 'Novel', 'Sam');
    const b = await share.invite('/root/Novel', 'Novel', 'Alex');
    const listed = await share.list();
    expect(listed.map((x) => [x.project, x.reviewers.length])).toEqual([['Novel', 2]]);
    await share.revokeAll('/root/Novel', 'Novel');
    expect(await share.list()).toEqual([]);
    expect(drive.links.has(a.commentsId) || drive.links.has(b.commentsId)).toBe(false);
  });
});

describe('what reviewers can see', () => {
  const twoBooks = () => {
    const t = setup();
    t.ownerFs.seed('/root/Novel/Manuscript/Other Book.md', '# Secret\n\nNot for reviewers\n');
    t.ownerFs.seed('/root/Novel/Notes/Plot.md', '# Plot\n\nSpoilers\n');
    return t;
  };
  const withActive = (t: ReturnType<typeof setup>, active: string | null) =>
    t.ownerFs.seed('/root/Novel/.mdedit/project.json', JSON.stringify({ version: 1, name: 'Novel', activeManuscript: active }));

  it('only the active manuscript goes in the package', async () => {
    const t = twoBooks();
    withActive(t, 'Manuscript/Book.md');
    const rec = await t.share.publish('/root/Novel', 'Novel');
    const pkg = JSON.parse(await t.drive.download(rec.packageId));
    expect(pkg.files.map((f: { path: string }) => f.path)).toEqual(['Manuscript/Book.md']);
  });

  it('refuses to share a project with several files until one is chosen, and says what to do', async () => {
    const t = twoBooks();
    await expect(t.share.invite('/root/Novel', 'Novel', 'Sam')).rejects.toThrow(/Active Manuscript/);
    expect((await t.drive.listAll()).filter((f) => f.name.endsWith('.comments.json'))).toHaveLength(0);
  });

  it('says so when the chosen file is gone', async () => {
    const t = twoBooks();
    withActive(t, 'Manuscript/Missing.md');
    await expect(t.share.publish('/root/Novel', 'Novel')).rejects.toThrow(/isn’t in this project/);
  });

  it('a reviewer who joined earlier loses the other files when the owner narrows it down', async () => {
    const t = twoBooks();
    withActive(t, 'Manuscript/Other Book.md');
    const inv = await t.share.invite('/root/Novel', 'Novel', 'Sam');
    const invite = parseInviteLink(inv.link)!;
    t.drive.granted = new Set([invite.packageId, invite.commentsId]);
    const joined = await t.join.join(invite, 'Sam');
    expect(await t.readerFs.stat(`${joined.dir}/Manuscript/Other Book.md`)).not.toBeNull();
    expect(await t.readerFs.stat(`${joined.dir}/Notes/Plot.md`)).toBeNull();

    withActive(t, 'Manuscript/Book.md');
    t.drive.granted = null;
    await t.share.publish('/root/Novel', 'Novel');
    t.drive.granted = new Set([invite.packageId, invite.commentsId]);
    await t.join.sync(joined.dir);
    expect(await t.readerFs.stat(`${joined.dir}/Manuscript/Book.md`)).not.toBeNull();
    expect(await t.readerFs.stat(`${joined.dir}/Manuscript/Other Book.md`)).toBeNull();
  });
});

describe('the owner on two devices', () => {
  function devices() {
    const drive = new FakeDrive();
    const mk = (n: string) => {
      const fs = new MemoryFs();
      fs.seed('/root/Novel/Manuscript/Book.md', '# One\n\nHello there\n');
      fs.seed('/root/Novel/.mdedit/project.json', '{}');
      let clock = Date.parse('2026-10-12T10:00:00Z');
      let c = 0;
      const share = new ReviewShare({ fs, drive: () => drive, stateFile: `/state-${n}/shares.json`, newId: () => `${n}${++c}abcdefgh`, now: () => new Date((clock += 120_000)) });
      return { fs, share };
    };
    return { drive, pc: mk('pc'), phone: mk('ph') };
  }

  it('the phone shows what the PC shared, and the other way round', async () => {
    const { pc, phone } = devices();
    const sam = await pc.share.invite('/root/Novel', 'Novel', 'Sam');
    expect((await phone.share.status('Novel')).reviewers.map((r) => r.name)).toEqual(['Sam']);
    expect((await phone.share.list()).map((s) => s.project)).toEqual(['Novel']);
    const kim = await phone.share.invite('/root/Novel', 'Novel', 'Kim');
    expect((await pc.share.status('Novel')).reviewers.map((r) => r.name).sort()).toEqual(['Kim', 'Sam']);
    expect(kim.link).not.toBe(sam.link);
  });

  it('the phone can pull a reviewer’s notes on its own', async () => {
    const { drive, pc, phone } = devices();
    const inv = await pc.share.invite('/root/Novel', 'Novel', 'Sam');
    // the reviewer writes a note straight into their comments file
    const file = newReview('Novel', inv.id, 'Sam', [note('n1')]);
    await drive.updateFile(inv.commentsId, file);
    const r = await phone.share.sync('/root/Novel', 'Novel');
    expect(r.errors).toEqual([]);
    const saved = (await makeReviews(phone.fs).list('/root/Novel')).find((x) => x.id === inv.id)!;
    expect(parseReviewFile(saved.text)!.items.map((i) => i.id)).toEqual(['n1']);
  });

  it('finds the PC’s shares when Drive names My Drive itself as the top-level parent (as the real Drive does)', async () => {
    const { drive, pc, phone } = devices();
    // The real Drive lists a top-level folder with parents: [<id of My Drive>], an id the app never sees listed.
    const real = Object.create(drive) as FakeDrive;
    real.listAll = async () => (await drive.listAll()).map((f) => (f.parentId === null ? { ...f, parentId: 'MY-DRIVE-ROOT' } : f));
    const phoneShare = new ReviewShare({ fs: phone.fs, drive: () => real, stateFile: '/state-ph/shares.json', newId: () => 'phabcdefgh' });
    await pc.share.invite('/root/Novel', 'Novel', 'Sam');
    expect((await phoneShare.list()).map((x) => x.project)).toEqual(['Novel']);
    expect((await drive.listAll()).filter((f) => f.isFolder && f.name === 'MDEdit Reviews')).toHaveLength(1);
  });

  it('a reviewer removed on one device stays removed on the other', async () => {
    const { pc, phone } = devices();
    const sam = await pc.share.invite('/root/Novel', 'Novel', 'Sam');
    await phone.share.status('Novel');
    await phone.share.revoke('/root/Novel', 'Novel', sam.id);
    expect((await pc.share.status('Novel')).shared).toBe(false);
    // and a stale copy of the list can't bring them back
    const again = await pc.share.invite('/root/Novel', 'Novel', 'Kim');
    expect((await phone.share.status('Novel')).reviewers.map((r) => r.id)).toEqual([again.id]);
  });

  it('works offline: each device keeps its own record when Drive can’t be reached', async () => {
    const { drive, pc } = devices();
    const sam = await pc.share.invite('/root/Novel', 'Novel', 'Sam');
    const orig = drive.listAll.bind(drive);
    const origGet = drive.getFile.bind(drive);
    drive.listAll = async () => { throw new Error('offline'); };
    drive.getFile = async () => { throw new Error('offline'); };
    expect((await pc.share.status('Novel')).reviewers.map((r) => r.id)).toEqual([sam.id]);
    drive.listAll = orig;
    drive.getFile = origGet;
  });
});

function newReview(project: string, id: string, name: string, items: ReviewItem[]): string {
  return serializeReviewFile({ version: 1, reviewer: { id, name }, project, items });
}

describe('chapter-limited links', () => {
  const MS = '/root/Novel/Manuscript/Book.md';
  const book = '# One\n\nHello there\n\n# Two\n\nSecond\n\n# Three\n\nThird\n';

  it('lists chapters, ticked by default, and remembers the ticks per manuscript', async () => {
    const { ownerFs, share } = setup();
    ownerFs.seed(MS, book);
    const first = await share.chapters('/root/Novel', 'Novel', 1);
    expect(first.manuscript).toBe('Manuscript/Book.md');
    expect(first.chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
    expect(first.selected).toEqual(['One', 'Two', 'Three']);
    await share.invite('/root/Novel', 'Novel', 'Sam', { keys: ['One', 'Three'], level: 1 });
    expect((await share.chapters('/root/Novel', 'Novel', 1)).selected).toEqual(['One', 'Three']);
    ownerFs.seed(MS, book + '\n# Four\n\nFourth\n'); // a later chapter starts unticked
    expect((await share.chapters('/root/Novel', 'Novel', 1)).selected).toEqual(['One', 'Three']);
  });

  it('gives a limited reviewer their own package with only those chapters, and keeps it up to date', async () => {
    const { drive, ownerFs, readerFs, share, join } = setup();
    ownerFs.seed(MS, book);
    const full = await share.invite('/root/Novel', 'Novel', 'Ann');
    const sam = await share.invite('/root/Novel', 'Novel', 'Sam', { keys: ['Two'], level: 1 });
    const inviteSam = parseInviteLink(sam.link)!;
    expect(inviteSam.packageId).not.toBe(parseInviteLink(full.link)!.packageId);
    expect(drive.links.get(inviteSam.packageId)).toBe('reader');

    drive.granted = new Set([inviteSam.packageId, inviteSam.commentsId]);
    const joined = await join.join(inviteSam, 'Sam');
    const text = await readerFs.readText(`${joined.dir}/Manuscript/Book.md`);
    expect(text).toContain('Second');
    expect(text).not.toContain('Hello there');
    expect(text).not.toContain('Third');

    ownerFs.seed(MS, book.replace('Second', 'Second, edited').replace('Third', 'Secret'));
    drive.granted = null;
    await share.sync('/root/Novel', 'Novel');
    drive.granted = new Set([inviteSam.packageId, inviteSam.commentsId]);
    await join.sync(joined.dir);
    const after = await readerFs.readText(`${joined.dir}/Manuscript/Book.md`);
    expect(after).toContain('Second, edited');
    expect(after).not.toContain('Secret');
  });

  it('closes the reviewer’s own package when they are removed, and needs at least one chapter', async () => {
    const { drive, ownerFs, share } = setup();
    ownerFs.seed(MS, book);
    await expect(share.invite('/root/Novel', 'Novel', 'Sam', { keys: [], level: 1 })).rejects.toThrow(/at least one/);
    const sam = await share.invite('/root/Novel', 'Novel', 'Sam', { keys: ['Two'], level: 1 });
    await share.invite('/root/Novel', 'Novel', 'Ann');
    await share.revoke('/root/Novel', 'Novel', sam.id);
    expect(drive.links.get(sam.packageId!)).toBeUndefined();
  });

  it('ticking every chapter is the same as sharing the whole manuscript', async () => {
    const { ownerFs, share } = setup();
    ownerFs.seed(MS, book);
    const r = await share.invite('/root/Novel', 'Novel', 'Sam', { keys: ['One', 'Two', 'Three'], level: 1 });
    expect(r.chapters).toBeUndefined();
    expect(r.packageId).toBeUndefined();
  });
});

describe('collaboration: editable links', () => {
  const book = '# One\n\nAlpha\n\n# Two\n\nBeta\n\n# Three\n\nGamma\n';
  const path = '/root/Novel/Manuscript/Book.md';

  async function invited(chapters?: { keys: string[]; level: number }) {
    const s = setup();
    s.ownerFs.seed(path, book);
    const inv = await s.share.invite('/root/Novel', 'Novel', 'Sam', chapters ?? null, 'edit');
    const invite = parseInviteLink(inv.link)!;
    s.drive.granted = new Set([invite.packageId, invite.commentsId]);
    const joined = await s.join.join(invite, 'Sam');
    s.drive.granted = null;
    return { ...s, inv, invite, joined, copy: `${joined.dir}/Manuscript/Book.md` };
  }

  it('makes a link whose working copy is writable by anyone with it', async () => {
    const { drive, inv, invite, joined } = await invited();
    expect(inv.role).toBe('edit');
    expect(invite.role).toBe('edit');
    expect(invite.packageId).not.toBe((await drive.listAll()).find((f) => f.name === 'Novel.mdedit-review.json')?.id);
    expect(drive.links.get(invite.packageId)).toBe('writer');
    expect(joined.role).toBe('edit');
  });

  it('merges edits both ways without overwriting either author', async () => {
    const { share, join, ownerFs, readerFs, joined, copy } = await invited();
    await readerFs.writeText(copy, book.replace('Alpha', 'Alpha by Sam'));
    ownerFs.seed(path, book.replace('Gamma', 'Gamma by owner'));

    // Sam syncs (sends their chapter), then the owner takes it and publishes theirs
    await join.sync(joined.dir);
    const a = await share.sync('/root/Novel', 'Novel');
    expect(a.changed).toBe(true);
    expect(a.errors).toEqual([]);
    const merged = book.replace('Alpha', 'Alpha by Sam').replace('Gamma', 'Gamma by owner');
    expect(await ownerFs.readText(path)).toBe(merged);

    // then Sam again: keeps their copy and receives the owner's chapter
    const b = await join.sync(joined.dir);
    expect(b.changed).toBe(true);
    expect(await readerFs.readText(copy)).toBe(merged);

    // nothing left to exchange
    expect((await share.sync('/root/Novel', 'Novel')).changed).toBe(false);
    expect((await join.sync(joined.dir)).changed).toBe(false);
  });

  it('keeps the collaborator\'s edits when the owner has not changed anything', async () => {
    const { share, join, ownerFs, readerFs, joined, copy } = await invited();
    await readerFs.writeText(copy, book.replace('Beta', 'Beta, rewritten'));
    await join.sync(joined.dir);
    await share.sync('/root/Novel', 'Novel');
    expect(await ownerFs.readText(path)).toBe(book.replace('Beta', 'Beta, rewritten'));
  });

  it('keeps both versions when both edit the same lines, and says so', async () => {
    const { share, join, ownerFs, readerFs, joined, copy } = await invited();
    await readerFs.writeText(copy, book.replace('Alpha', 'Sam says'));
    ownerFs.seed(path, book.replace('Alpha', 'Owner says'));
    await join.sync(joined.dir);
    const r = await share.sync('/root/Novel', 'Novel');
    expect(r.errors[0]).toMatch(/Sam: 1 place/);
    const text = await ownerFs.readText(path);
    expect(text).toContain('Sam says');
    expect(text).toContain('Owner says');
  });

  it('gives a collaborator only the ticked chapters and merges only those', async () => {
    const { share, join, ownerFs, readerFs, joined, copy, inv } = await invited({ keys: ['Two'], level: 1 });
    expect(inv.chapters).toEqual(['Two']);
    expect(await readerFs.readText(copy)).toBe('# Two\n\nBeta\n\n');
    await readerFs.writeText(copy, '# Two\n\nBeta by Sam\n\n# Extra\n\nNew\n');
    ownerFs.seed(path, book.replace('Alpha', 'Alpha by owner'));
    await join.sync(joined.dir);
    await share.sync('/root/Novel', 'Novel');
    const text = await ownerFs.readText(path);
    expect(text).toContain('Alpha by owner');
    expect(text).toContain('Beta by Sam');
    expect(text).toContain('# Extra');
    await join.sync(joined.dir);
    expect(await readerFs.readText(copy)).not.toContain('Alpha');
  });

  it('does not let a reviewer\'s read-only package be made writable, and removing a collaborator keeps their work', async () => {
    const { share, join, ownerFs, readerFs, joined, copy, inv, drive } = await invited();
    await readerFs.writeText(copy, book.replace('Beta', 'Beta by Sam'));
    await join.sync(joined.dir);
    await share.revoke('/root/Novel', 'Novel', inv.id);
    expect(await ownerFs.readText(path)).toContain('Beta by Sam');
    expect(drive.links.has(parseInviteLink(inv.link)!.packageId)).toBe(false);
  });

  describe('every file of the project', () => {
    it('gives a collaborator all the Markdown files, but a reviewer only the active manuscript', async () => {
      const { share, join, ownerFs, readerFs, drive, joined, copy } = await invited();
      ownerFs.seed('/root/Novel/Notes/World.md', '# World\n\nMap notes\n');
      ownerFs.seed('/root/Novel/Exports/Draft.md', '# Exported\n');
      ownerFs.seed('/root/Novel/.mdedit/project.json', '{"activeManuscript":"Manuscript/Book.md"}');
      await share.sync('/root/Novel', 'Novel');
      await join.sync(joined.dir);
      expect(await readerFs.readText(`${joined.dir}/Notes/World.md`)).toContain('Map notes');
      expect(await readerFs.readText(copy)).toBe(book);
      expect(await readerFs.stat(`${joined.dir}/Exports/Draft.md`)).toBeNull();

      const rev = await share.invite('/root/Novel', 'Novel', 'Rae');
      const pkg = JSON.parse(await drive.download(parseInviteLink(rev.link)!.packageId));
      expect(pkg.files.map((f: { path: string }) => f.path)).toEqual(['Manuscript/Book.md']);
    });

    it('carries a file the collaborator creates to the owner, and the owner\'s new file to them', async () => {
      const { share, join, ownerFs, readerFs, joined } = await invited();
      await readerFs.mkdir(`${joined.dir}/Characters`, { recursive: true });
      await readerFs.writeText(`${joined.dir}/Characters/Sam.md`, '# Sam\n\nBrave\n');
      ownerFs.seed('/root/Novel/Outline.md', '# Outline\n\nAct one\n');
      await join.sync(joined.dir);
      await share.sync('/root/Novel', 'Novel');
      await join.sync(joined.dir);
      expect(await ownerFs.readText('/root/Novel/Characters/Sam.md')).toBe('# Sam\n\nBrave\n');
      expect(await readerFs.readText(`${joined.dir}/Outline.md`)).toBe('# Outline\n\nAct one\n');
      // and both then edit the same file without trouble
      await readerFs.writeText(`${joined.dir}/Outline.md`, '# Outline\n\nAct one, revised\n');
      await join.sync(joined.dir);
      await share.sync('/root/Novel', 'Novel');
      expect(await ownerFs.readText('/root/Novel/Outline.md')).toContain('revised');
    });

    it('does not take files from hidden folders or non-Markdown paths from the shared copy', async () => {
      const { share, drive, ownerFs, invite } = await invited();
      const pkg = JSON.parse(await drive.download(invite.packageId));
      pkg.files.push({ path: '.mdedit/project.json', text: '{"evil":1}' }, { path: 'Exports/x.md', text: 'no' }, { path: 'run.sh', text: 'no' });
      await drive.updateFile(invite.packageId, JSON.stringify(pkg));
      await share.sync('/root/Novel', 'Novel');
      expect(await ownerFs.readText('/root/Novel/.mdedit/project.json')).not.toContain('evil');
      expect(await ownerFs.stat('/root/Novel/Exports/x.md')).toBeNull();
      expect(await ownerFs.stat('/root/Novel/run.sh')).toBeNull();
    });

    it('invites a collaborator even when several files exist and none is the active manuscript', async () => {
      const s = setup();
      s.ownerFs.seed('/root/Novel/Other.md', '# Other\n');
      const r = await s.share.invite('/root/Novel', 'Novel', 'Sam', null, 'edit');
      expect(r.role).toBe('edit');
    });
  });

  describe('notes among the editing group', () => {
    const readNotes = async (fs: MemoryFs, dir: string) => {
      const m = new Map<string, string[]>();
      for (const r of await makeReviews(fs).list(dir)) m.set(r.id, (parseReviewFile(r.text)?.items ?? []).map((i) => i.id));
      return m;
    };
    const aiNote = note('ai1', { origin: 'ai', author: 'Claude' });

    it('carries the owner\'s notes and AI notes to the collaborator and theirs back', async () => {
      const { share, join, ownerFs, readerFs, joined } = await invited();
      const owner = (id: string, items: ReviewItem[]) => makeReviews(ownerFs).save('/root/Novel', id, serializeReviewFile({ ...newOwnerFile(id), items }));
      await owner('owner', [note('o1')]);
      await owner('ai-claude', [aiNote]);
      // the collaborator has an AI pass of their own and a note on the owner's note
      await makeReviews(readerFs).save(joined.dir, 'ai-gpt', serializeReviewFile({ ...newOwnerFile('ai-gpt'), items: [note('g1', { origin: 'ai', author: 'GPT' })] }));

      await join.sync(joined.dir);
      await share.sync('/root/Novel', 'Novel');
      await join.sync(joined.dir);

      const mine = await readNotes(readerFs, joined.dir);
      expect(mine.get('owner')).toEqual(['o1']);
      expect(mine.get('ai-claude')).toEqual(['ai1']);
      expect((await readNotes(ownerFs, '/root/Novel')).get('ai-gpt')).toEqual(['g1']);

      // a resolution on the owner's note made by the collaborator reaches the owner
      const o1 = parseReviewFile((await makeReviews(readerFs).list(joined.dir)).find((r) => r.id === 'owner')!.text)!;
      await makeReviews(readerFs).save(joined.dir, 'owner', serializeReviewFile({ ...o1, items: [{ ...o1.items[0], status: 'resolved', updatedAt: '2026-10-08T10:00:00Z' }] }));
      await join.sync(joined.dir);
      await share.sync('/root/Novel', 'Novel');
      const back = parseReviewFile((await makeReviews(ownerFs).list('/root/Novel')).find((r) => r.id === 'owner')!.text)!;
      expect(back.items[0].status).toBe('resolved');
    });

    it('passes one collaborator\'s notes to another but never a reviewer\'s', async () => {
      const a = await invited();
      const { share, drive, ownerFs } = a;
      // a second collaborator and a read-only reviewer
      const b = await share.invite('/root/Novel', 'Novel', 'Kim', null, 'edit');
      const r = await share.invite('/root/Novel', 'Novel', 'Rae');
      const bInvite = parseInviteLink(b.link)!;
      drive.granted = new Set([bInvite.packageId, bInvite.commentsId]);
      const bFs = new MemoryFs();
      const bJoin = new ReviewJoin({ fs: bFs, drive: () => drive, sharedRoot: '/root/Shared With Me' });
      const bJoined = await bJoin.join(bInvite, 'Kim');
      drive.granted = null;

      await makeReviews(a.readerFs).save(a.joined.dir, a.inv.id, serializeReviewFile({ ...newOwnerFile(a.inv.id), reviewer: { id: a.inv.id, name: 'Sam' }, items: [note('s1')] }));
      await makeReviews(ownerFs).save('/root/Novel', r.id, serializeReviewFile({ ...newOwnerFile(r.id), items: [note('r1')] }));

      await a.join.sync(a.joined.dir);
      await share.sync('/root/Novel', 'Novel');
      await bJoin.sync(bJoined.dir);

      const kim = await readNotes(bFs, bJoined.dir);
      expect(kim.get(a.inv.id)).toEqual(['s1']);
      expect(kim.has(r.id)).toBe(false);
    });

    it('leaves notes on chapters a collaborator wasn\'t given out of what they receive', async () => {
      const { share, join, ownerFs, readerFs, joined } = await invited({ keys: ['Two'], level: 1 });
      await makeReviews(ownerFs).save('/root/Novel', 'owner', serializeReviewFile({
        ...newOwnerFile('owner'),
        items: [note('inOne', { anchor: makeAnchor('Alpha', 0, 5) }), note('inTwo', { anchor: makeAnchor('Beta', 0, 4) })]
      }));
      await join.sync(joined.dir);
      await share.sync('/root/Novel', 'Novel');
      await join.sync(joined.dir);
      expect((await readNotes(readerFs, joined.dir)).get('owner')).toEqual(['inTwo']);
    });
  });
});

const newOwnerFile = (id: string) => newReviewFile('Novel', { id, name: id === 'owner' ? 'Me' : id });
