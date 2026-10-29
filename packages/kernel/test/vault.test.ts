import { beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeOrphans, addVaultFile, checkIn, checkOut, cleanVaultPath, fileKind, fileVersions, forceRelease, getLock, listVaultFiles, pendingOrphans, undoCheckOut, type Db } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
const T = (n: number) => `2026-10-24T00:00:${String(n).padStart(2, '0')}Z`;

beforeEach(async () => {
  db = memoryDb();
  await db.run("INSERT INTO vault_file (id, studio_id, path) VALUES ('f1', 's1', 'Series/Book1/Manuscript/ch1.md')");
});

describe('check-out', () => {
  it('locks the file for one person and records the version it was taken from', async () => {
    const r = await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    expect(r).toEqual({ ok: true, baseVersion: 0 });
    expect(await getLock(db, 'f1')).toMatchObject({ personId: 'alice', machine: 'pc-a' });
  });

  it('refuses a second person and says who holds it', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    const r = await checkOut(db, { fileId: 'f1', personId: 'bob', machine: 'pc-b', now: T(2) });
    expect(r).toMatchObject({ ok: false, reason: 'locked', heldBy: { personId: 'alice', since: T(1) } });
  });

  it('refuses even the same person on another machine', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    const r = await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'laptop', now: T(2) });
    expect(r).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('with many simultaneous requests exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => checkOut(db, { fileId: 'f1', personId: `p${i}`, machine: 'm', now: T(i) })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a file that does not exist cannot be locked', async () => {
    expect(await checkOut(db, { fileId: 'nope', personId: 'alice', machine: 'm', now: T(1) })).toEqual({ ok: false, reason: 'no-such-file' });
  });
});

describe('check-in and undo', () => {
  it('check-in stores a new version, releases the lock, and bumps the current version', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    const r = await checkIn(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', hash: 'h1', size: 10, comment: 'first draft', now: T(2) });
    expect(r).toEqual({ ok: true, version: 1 });
    expect(await getLock(db, 'f1')).toBeNull();
    const again = await checkOut(db, { fileId: 'f1', personId: 'bob', machine: 'pc-b', now: T(3) });
    expect(again).toEqual({ ok: true, baseVersion: 1 });
  });

  it('only the holder can check in', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    expect(await checkIn(db, { fileId: 'f1', personId: 'bob', machine: 'pc-b', hash: 'x', size: 1, comment: '', now: T(2) })).toEqual({ ok: false, reason: 'not-holder' });
    expect(await getLock(db, 'f1')).toMatchObject({ personId: 'alice' });
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM file_version'))?.n).toBe(0);
  });

  it('check-in without a lock writes nothing', async () => {
    expect(await checkIn(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', hash: 'x', size: 1, comment: '', now: T(1) })).toEqual({ ok: false, reason: 'not-holder' });
  });

  it('undo check-out releases the lock without a new version', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    expect(await undoCheckOut(db, { fileId: 'f1', personId: 'bob', machine: 'pc-b', now: T(2) })).toBe(false);
    expect(await undoCheckOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(3) })).toBe(true);
    expect(await getLock(db, 'f1')).toBeNull();
    expect((await db.first<{ current_version: number }>("SELECT current_version FROM vault_file WHERE id = 'f1'"))?.current_version).toBe(0);
  });

  it('versions count up across holders', async () => {
    for (const [i, who] of ['alice', 'bob', 'alice'].entries()) {
      await checkOut(db, { fileId: 'f1', personId: who, machine: who, now: T(i * 2) });
      const r = await checkIn(db, { fileId: 'f1', personId: who, machine: who, hash: `h${i}`, size: i, comment: '', now: T(i * 2 + 1) });
      expect(r).toEqual({ ok: true, version: i + 1 });
    }
  });
});

describe('force release', () => {
  it('needs a typed reason', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    expect(await forceRelease(db, { fileId: 'f1', adminId: 'root', reason: '  ', now: T(2) })).toEqual({ ok: false, reason: 'reason-required' });
    expect(await getLock(db, 'f1')).not.toBeNull();
  });

  it('breaks the lock, records an orphan for the holder, and audits it', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    const r = await forceRelease(db, { fileId: 'f1', adminId: 'root', reason: 'Alice is on leave; deadline Friday', now: T(2) });
    expect(r).toMatchObject({ ok: true, released: { personId: 'alice' } });
    expect(await getLock(db, 'f1')).toBeNull();
    expect(await pendingOrphans(db, 'alice')).toEqual([{ fileId: 'f1', machine: 'pc-a', baseVersion: 0, removedBy: 'root', removedAt: T(2), reason: 'Alice is on leave; deadline Friday' }]);
    const audit = await db.first<{ actor: string; detail: string }>("SELECT actor, detail FROM audit WHERE action = 'file.force-release'");
    expect(audit?.actor).toBe('root');
    expect(JSON.parse(audit!.detail)).toMatchObject({ holder: 'alice', reason: 'Alice is on leave; deadline Friday' });
  });

  it("the old holder's later check-in is refused, so their work is never silently merged", async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    await forceRelease(db, { fileId: 'f1', adminId: 'root', reason: 'leave', now: T(2) });
    await checkOut(db, { fileId: 'f1', personId: 'bob', machine: 'pc-b', now: T(3) });
    expect(await checkIn(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', hash: 'late', size: 1, comment: 'mine', now: T(4) })).toEqual({ ok: false, reason: 'not-holder' });
    expect(await getLock(db, 'f1')).toMatchObject({ personId: 'bob' });
  });

  it('nothing to release when the file is not locked', async () => {
    expect(await forceRelease(db, { fileId: 'f1', adminId: 'root', reason: 'x', now: T(1) })).toEqual({ ok: false, reason: 'not-locked' });
  });
});

describe('paths and kinds', () => {
  it('cleans a path and refuses what Windows or the vault would not keep', () => {
    expect(cleanVaultPath('.\\Series\\Book 1//ch1.md')).toEqual({ ok: true, path: 'Series/Book 1/ch1.md' });
    for (const bad of ['', '../x', 'a/../b', 'a/./b', 'a/b?.md', 'CON.md', 'a/NUL', 'dir./f', 'f ', '.cadrel-vault/state.json', 5 as never]) expect(cleanVaultPath(bad).ok, String(bad)).toBe(false);
  });
  it('tells manuscripts from assets', () => {
    expect(['ch1.md', 'plan.DOCX', 'Notes', 'a/b.txt'].map(fileKind)).toEqual(['manuscript', 'manuscript', 'manuscript', 'manuscript']);
    expect(['cover.psd', 'art/c.PNG', 'font.otf', 'thing.xyz'].map(fileKind)).toEqual(['asset', 'asset', 'asset', 'asset']);
  });
});

describe('adding, listing, history', () => {
  it('adds a file once per path, ignoring case, and lists it with its lock and current version', async () => {
    expect(await addVaultFile(db, { studioId: 's1', path: 'Books/a.md', personId: 'alice', now: T(1), id: 'f2' })).toEqual({ ok: true, id: 'f2' });
    expect(await addVaultFile(db, { studioId: 's1', path: 'books/A.md', personId: 'alice', now: T(1), id: 'f3' })).toEqual({ ok: false, reason: 'exists' });
    await checkOut(db, { fileId: 'f2', personId: 'alice', machine: 'pc-a', now: T(2) });
    await checkIn(db, { fileId: 'f2', personId: 'alice', machine: 'pc-a', hash: 'h1', size: 5, comment: 'one', now: T(3) });
    await checkOut(db, { fileId: 'f2', personId: 'bob', machine: 'pc-b', now: T(4) });
    const f = (await listVaultFiles(db, 's1')).find((x) => x.id === 'f2')!;
    expect(f).toMatchObject({ path: 'Books/a.md', currentVersion: 1, hash: 'h1', size: 5, lock: { personId: 'bob', machine: 'pc-b' } });
    expect((await fileVersions(db, 'f2')).map((v) => [v.n, v.comment, v.author])).toEqual([[1, 'one', 'alice']]);
    expect(await listVaultFiles(db, 's2')).toEqual([]);
  });
  it('marks an orphan as seen', async () => {
    await checkOut(db, { fileId: 'f1', personId: 'alice', machine: 'pc-a', now: T(1) });
    await forceRelease(db, { fileId: 'f1', adminId: 'root', reason: 'leave', now: T(2) });
    await acknowledgeOrphans(db, { personId: 'alice', machine: 'pc-b', fileId: 'f1', now: T(3) }); // another machine: not this one's
    expect(await pendingOrphans(db, 'alice')).toHaveLength(1);
    await acknowledgeOrphans(db, { personId: 'alice', machine: 'pc-a', fileId: 'f1', now: T(3) });
    expect(await pendingOrphans(db, 'alice')).toEqual([]);
  });
});
