import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirBlobs, LocalVault, VaultError, memoryStudioDb, sha256, type StudioDb } from '../src';

let root: string, db: StudioDb, blobs: DirBlobs;
let n = 0;
const clock = () => new Date(Date.UTC(2026, 10, 10, 10, 0, n++));
const seat = (person: string, machine: string, can?: (c: string) => Promise<boolean>) => {
  const dir = path.join(root, `${person}-${machine}`);
  return { dir, v: new LocalVault({ db, studioId: 's1', blobs, dir, personId: person, machine, now: clock, can }) };
};
const put = async (dir: string, rel: string, text: string) => {
  const f = path.join(dir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.chmod(f, 0o644).catch(() => undefined);
  await fsp.writeFile(f, text);
};
const text = (dir: string, rel: string) => fsp.readFile(path.join(dir, ...rel.split('/')), 'utf8');
const writable = async (dir: string, rel: string) => ((await fsp.stat(path.join(dir, ...rel.split('/')))).mode & 0o200) !== 0;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof VaultError ? e.code : `other:${(e as Error).message}`));

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cadrel-vault-'));
  db = memoryStudioDb();
  blobs = new DirBlobs(path.join(root, 'blobs'));
  n = 0;
});
afterEach(async () => {
  db.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('the local vault', () => {
  it('adds a file as version 1 and leaves it read-only; untracked files are listed as such', async () => {
    const a = seat('ana', 'pc');
    await put(a.dir, 'Series/ch1.md', 'one');
    await put(a.dir, 'notes.txt', 'loose');
    expect((await a.v.list()).map((e) => [e.path, e.status])).toEqual([['notes.txt', 'untracked'], ['Series/ch1.md', 'untracked']]);
    const e = await a.v.add('Series/ch1.md', 'first');
    expect(e).toMatchObject({ status: 'latest', version: 1, localVersion: 1, modified: false, kind: 'manuscript' });
    expect(await writable(a.dir, 'Series/ch1.md')).toBe(false);
    await put(a.dir, 'series/CH1.md', 'differs only by case');
    expect(await code(a.v.add('series/CH1.md'))).toBe('exists'); // Windows would call it the same file
    expect((await a.v.history('Series/ch1.md')).map((v) => [v.n, v.comment, v.author])).toEqual([[1, 'first', 'ana']]);
    expect(await code(a.v.add('missing.md'))).toBe('not-found');
    expect(await code(a.v.add('../escape.md'))).toBe('invalid');
  });

  it('check-out makes it writable, check-in saves a version and makes it read-only again', async () => {
    const a = seat('ana', 'pc');
    await put(a.dir, 'ch1.md', 'one');
    await a.v.add('ch1.md');
    expect(await a.v.checkOut('ch1.md')).toMatchObject({ status: 'checked-out-by-me', modified: false });
    expect(await writable(a.dir, 'ch1.md')).toBe(true);
    await put(a.dir, 'ch1.md', 'two');
    expect((await a.v.status('ch1.md')).modified).toBe(true);
    const r = await a.v.checkIn('ch1.md', 'second pass');
    expect(r).toMatchObject({ status: 'latest', version: 2, unchanged: false });
    expect(await writable(a.dir, 'ch1.md')).toBe(false);
    expect((await a.v.history('ch1.md')).map((v) => v.comment)).toEqual(['second pass', 'First version']);
    expect(new TextDecoder().decode(await a.v.read('ch1.md', 1))).toBe('one');
  });

  it('only one person holds a file; the other sees who, and cannot check it in', async () => {
    const a = seat('ana', 'pc-a');
    const b = seat('bo', 'pc-b');
    await put(a.dir, 'ch1.md', 'one');
    await a.v.add('ch1.md');
    await b.v.getLatest(undefined, { fetchMissing: true });
    expect(await text(b.dir, 'ch1.md')).toBe('one');
    await a.v.checkOut('ch1.md');
    expect(await code(b.v.checkOut('ch1.md'))).toBe('locked');
    expect(await b.v.status('ch1.md')).toMatchObject({ status: 'checked-out-by-other', lock: { personId: 'ana' } });
    expect(await code(b.v.checkIn('ch1.md'))).toBe('not-holder');
    expect(await code(seat('ana', 'laptop').v.checkOut('ch1.md'))).toBe('locked'); // same person, other machine
  });

  it('check-in with nothing changed releases the lock without a new version; undo restores the vault’s copy', async () => {
    const a = seat('ana', 'pc');
    await put(a.dir, 'ch1.md', 'one');
    await a.v.add('ch1.md');
    await a.v.checkOut('ch1.md');
    expect(await a.v.checkIn('ch1.md')).toMatchObject({ unchanged: true, version: 1, status: 'latest' });
    await a.v.checkOut('ch1.md');
    await put(a.dir, 'ch1.md', 'scribbles');
    expect(await a.v.undoCheckOut('ch1.md')).toMatchObject({ status: 'latest', modified: false });
    expect(await text(a.dir, 'ch1.md')).toBe('one');
    expect(await writable(a.dir, 'ch1.md')).toBe(false);
    expect(await code(a.v.undoCheckOut('ch1.md'))).toBe('not-holder');
  });

  it('get latest updates what nobody is editing, and never overwrites a checked-out file or an unprotected change', async () => {
    const a = seat('ana', 'pc-a');
    const b = seat('bo', 'pc-b');
    await put(a.dir, 'a.md', 'a1');
    await put(a.dir, 'b.md', 'b1');
    await a.v.add('a.md');
    await a.v.add('b.md');
    await b.v.getLatest(undefined, { fetchMissing: true });
    await a.v.checkOut('a.md');
    await put(a.dir, 'a.md', 'a2');
    await a.v.checkIn('a.md', 'edit a');
    await a.v.checkOut('b.md');
    await put(a.dir, 'b.md', 'b2');
    await a.v.checkIn('b.md', 'edit b');
    expect((await b.v.status('a.md')).status).toBe('out-of-date');
    await fsp.chmod(path.join(b.dir, 'b.md'), 0o644);
    await put(b.dir, 'b.md', 'bo changed it anyway');
    expect((await b.v.status('b.md')).status).toBe('modified-unprotected');
    const r = await b.v.getLatest();
    expect(r.updated).toEqual(['a.md']);
    expect(r.skipped).toEqual([{ path: 'b.md', why: expect.stringMatching(/without a check-out/) }]);
    expect(await text(b.dir, 'b.md')).toBe('bo changed it anyway'); // not overwritten
    expect(await code(b.v.checkOut('b.md'))).toBe('conflict');
    expect(await b.v.discardLocalChanges('b.md')).toMatchObject({ status: 'latest', localVersion: 2 });
    expect(await text(b.dir, 'b.md')).toBe('b2');
  });

  it('check-out of a file that is not downloaded or is out of date starts from the newest version', async () => {
    const a = seat('ana', 'pc-a');
    const b = seat('bo', 'pc-b');
    await put(a.dir, 'ch.md', 'v1');
    await a.v.add('ch.md');
    await a.v.checkOut('ch.md');
    await put(a.dir, 'ch.md', 'v2');
    await a.v.checkIn('ch.md');
    expect((await b.v.status('ch.md')).status).toBe('not-local');
    await b.v.checkOut('ch.md');
    expect(await text(b.dir, 'ch.md')).toBe('v2');
    expect(await writable(b.dir, 'ch.md')).toBe(true);
  });

  it('an administrator’s force-release keeps the holder’s unsaved work aside, flagged, never deleted, and refuses their late check-in', async () => {
    const a = seat('ana', 'pc-a');
    const root1 = seat('root', 'pc-r');
    await put(a.dir, 'ch1.md', 'one');
    await a.v.add('ch1.md');
    await a.v.checkOut('ch1.md');
    await put(a.dir, 'ch1.md', 'ana unsaved work');
    expect(await code(root1.v.forceRelease('ch1.md', ''))).toBe('invalid');
    await root1.v.forceRelease('ch1.md', 'Ana is on leave');
    expect(await code(a.v.checkIn('ch1.md'))).toBe('not-holder');
    expect(await text(a.dir, 'ch1.md')).toBe('ana unsaved work'); // her copy is untouched by the failed check-in
    const kept = await a.v.keepOrphansAside();
    expect(kept).toEqual([{ path: 'ch1.md', savedAs: 'ch1 (lock removed 2026-11-10).md', removedBy: 'root', reason: 'Ana is on leave' }]);
    expect(await text(a.dir, 'ch1 (lock removed 2026-11-10).md')).toBe('ana unsaved work');
    expect(await text(a.dir, 'ch1.md')).toBe('one');
    expect((await a.v.orphans())[0]).toMatchObject({ path: 'ch1.md', removedBy: 'root' });
    expect(await a.v.keepOrphansAside()).toEqual([]); // seen once
    expect((await a.v.status('ch1.md')).status).toBe('latest');
  });

  it('a removed lock with nothing unsaved leaves nothing aside', async () => {
    const a = seat('ana', 'pc-a');
    const r = seat('root', 'pc-r');
    await put(a.dir, 'ch1.md', 'one');
    await a.v.add('ch1.md');
    await a.v.checkOut('ch1.md');
    await r.v.forceRelease('ch1.md', 'x');
    expect(await a.v.keepOrphansAside()).toEqual([{ path: 'ch1.md', savedAs: null, removedBy: 'root', reason: 'x' }]);
    expect((await fsp.readdir(a.dir)).filter((f) => f.includes('lock removed'))).toEqual([]);
  });

  it('keeps old versions, can put one beside the file, and never over it', async () => {
    const a = seat('ana', 'pc');
    await put(a.dir, 'ch.md', 'v1');
    await a.v.add('ch.md');
    await a.v.checkOut('ch.md');
    await put(a.dir, 'ch.md', 'v2');
    await a.v.checkIn('ch.md');
    expect(await a.v.saveVersionAs('ch.md', 1, 'ch-v1.md')).toBe('ch-v1.md');
    expect(await text(a.dir, 'ch-v1.md')).toBe('v1');
    expect(await code(a.v.saveVersionAs('ch.md', 1, 'CH.md'))).toBe('conflict');
    expect(await code(a.v.saveVersionAs('ch.md', 1, 'ch-v1.md'))).toBe('exists');
    expect(await code(a.v.saveVersionAs('ch.md', 9, 'x.md'))).toBe('not-found');
  });

  it('follows the capability for the kind of file: manuscripts and assets are separate', async () => {
    const caps = new Set(['manuscript.read', 'manuscript.write', 'asset.read']);
    const a = seat('ana', 'pc', async (c) => caps.has(c));
    await put(a.dir, 'ch.md', 'text');
    await put(a.dir, 'cover.psd', 'pixels');
    await a.v.add('ch.md');
    expect(await code(a.v.add('cover.psd'))).toBe('denied');
    const admin = seat('root', 'pc-r');
    await put(admin.dir, 'cover.psd', 'pixels');
    await admin.v.add('cover.psd');
    expect((await a.v.list()).map((e) => e.path)).toEqual(['ch.md', 'cover.psd']); // may read it
    expect(await code(a.v.checkOut('cover.psd'))).toBe('denied');
    expect(await code(a.v.forceRelease('ch.md', 'x'))).toBe('denied');
    const blind = seat('eve', 'pc', async () => false);
    expect(await blind.v.list()).toEqual([]);
  });

  it('stores each version once by content, and treats a damaged blob as missing', async () => {
    const h = await blobs.put(new TextEncoder().encode('same'));
    expect(await blobs.put(new TextEncoder().encode('same'))).toBe(h);
    expect(h).toBe(sha256(new TextEncoder().encode('same')));
    expect(await blobs.has(h)).toBe(true);
    await fsp.writeFile(path.join(root, 'blobs', h.slice(0, 2), h.slice(2)), 'damaged');
    expect(await blobs.get(h)).toBeNull();
    await expect(blobs.get('../../etc/passwd')).rejects.toThrow(VaultError);
  });

  it('survives a restart: the local state is on disk', async () => {
    const a = seat('ana', 'pc');
    await put(a.dir, 'ch.md', 'v1');
    await a.v.add('ch.md');
    const again = new LocalVault({ db, studioId: 's1', blobs, dir: a.dir, personId: 'ana', machine: 'pc', now: clock });
    expect(await again.status('ch.md')).toMatchObject({ status: 'latest', localVersion: 1 });
  });
});
