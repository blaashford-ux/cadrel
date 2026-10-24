import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '../api';
import { MemoryFs } from '../memoryFs';
import { FakeDrive } from './fakeDrive';
import { SyncService } from './service';

const ROOT = '/MDEdit';
let fs: MemoryFs;
let drive: FakeDrive;
let authorizeCalls: number;
let authFails: Error | null;
let changed: number;

let signedOut: number;
const make = (root = ROOT) =>
  new SyncService({
    fs, root, signOut: async () => void signedOut++, stateFile: '/state/sync.json', device: 'Pixel', now: () => new Date('2026-10-05T12:00:00'),
    authorize: async () => {
      authorizeCalls++;
      if (authFails) throw authFails;
      return 'token';
    },
    makeDrive: () => drive,
    onLocalChanges: () => void changed++,
    trashLocal: async (p) => fs.rm(p),
  });

beforeEach(async () => {
  fs = new MemoryFs();
  drive = new FakeDrive();
  authorizeCalls = 0;
  authFails = null;
  changed = 0;
  signedOut = 0;
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir('/state', { recursive: true });
});
afterEach(() => vi.useRealTimers());

describe('SyncService', () => {
  it('starts off, and does nothing until connected', async () => {
    const s = make();
    await s.load();
    expect((await s.getSyncStatus()).state).toBe('off');
    await s.syncNow();
    expect(drive.calls).toEqual([]);
  });

  it('connects: asks Google, then runs the first sync and reports it', async () => {
    fs.seed(`${ROOT}/Novel/Ch 1.md`, 'hello');
    const s = make();
    await s.load();
    const seen: SyncStatus['state'][] = [];
    s.onSyncStatus((st) => seen.push(st.state));
    const st = await s.connectSync();
    expect(authorizeCalls).toBe(1);
    expect(st).toMatchObject({ connected: true, state: 'idle', summary: { uploaded: 1, downloaded: 0 } });
    expect(st.lastSyncAt).not.toBeNull();
    expect(seen).toContain('syncing');
    expect(drive.read('Novel/Ch 1.md')).toBe('hello');
  });

  it('stays disconnected when sign-in is cancelled', async () => {
    authFails = new Error('Google sign-in was cancelled.');
    const s = make();
    await s.load();
    const st = await s.connectSync();
    expect(st).toMatchObject({ connected: false, state: 'error', message: 'Google sign-in was cancelled.' });
    expect(drive.calls).toEqual([]);
  });

  it('remembers being connected across launches, and reuses its sync memory', async () => {
    fs.seed(`${ROOT}/a.md`, 'x');
    const first = make();
    await first.load();
    await first.connectSync();
    const second = make();
    await second.load();
    expect(await second.getSyncStatus()).toMatchObject({ connected: true, state: 'idle' });
    const before = drive.calls.length;
    await second.syncNow();
    expect(drive.calls.slice(before).filter((c) => c !== 'list')).toEqual([]); // nothing re-uploaded
    expect(authorizeCalls).toBe(1); // only the original connect asked; a later launch asks lazily, when Drive needs a token
  });

  it('runs one pass at a time and goes round again if asked meanwhile', async () => {
    const s = make();
    await s.load();
    await s.connectSync();
    fs.seed(`${ROOT}/one.md`, '1');
    const slow = drive.listAll.bind(drive);
    let listings = 0;
    drive.listAll = async () => {
      listings++;
      await new Promise((r) => setTimeout(r, 5));
      return slow();
    };
    const a = s.syncNow();
    const b = s.syncNow(); // arrives while a is running
    await Promise.all([a, b]);
    expect(listings).toBe(2); // not three, not interleaved
  });

  it('debounces syncSoon into a single pass', async () => {
    vi.useFakeTimers();
    const s = make();
    await s.load();
    await s.connectSync();
    const before = drive.calls.length;
    s.syncSoon(5000);
    s.syncSoon(5000);
    s.syncSoon(5000);
    await vi.advanceTimersByTimeAsync(5100);
    expect(drive.calls.slice(before).filter((c) => c === 'list')).toHaveLength(1);
  });

  it('holds back a mass delete until the user confirms', async () => {
    for (let i = 0; i < 6; i++) fs.seed(`${ROOT}/Novel/n${i}.md`, `${i}`);
    const s = make();
    await s.load();
    await s.connectSync();
    await fs.rm(`${ROOT}/Novel`, { recursive: true });
    const held = await s.syncNow();
    expect(held.state).toBe('confirm');
    expect(held.pendingDeletes.length).toBe(6);
    expect(drive.read('Novel/n0.md')).toBe('0');
    const done = await s.confirmDeletes();
    expect(done.state).toBe('idle');
    expect(drive.read('Novel/n0.md')).toBeUndefined();
  });

  it('tells the UI when a pass changed local files', async () => {
    const s = make();
    await s.load();
    await s.connectSync();
    drive.seed('Novel/from-elsewhere.md', 'remote', (await fs.readText('/state/sync.json').then((t) => JSON.parse(t).state.rootId)) as string);
    await s.syncNow();
    expect(changed).toBe(1);
    expect(await fs.readText(`${ROOT}/Novel/from-elsewhere.md`)).toBe('remote');
  });

  it('reports a failed pass without losing the connection, and recovers', async () => {
    const s = make();
    await s.load();
    await s.connectSync();
    const real = drive.listAll.bind(drive);
    drive.listAll = async () => {
      throw new Error('Failed to fetch');
    };
    const bad = await s.syncNow();
    expect(bad).toMatchObject({ connected: true, state: 'error' });
    expect(bad.message).toMatch(/Can’t reach Google Drive/);
    drive.listAll = real;
    expect((await s.syncNow()).state).toBe('idle');
  });

  it('disconnecting forgets the sync memory but leaves the files', async () => {
    fs.seed(`${ROOT}/a.md`, 'x');
    const s = make();
    await s.load();
    await s.connectSync();
    await s.disconnectSync();
    expect(await s.getSyncStatus()).toMatchObject({ connected: false, state: 'off' });
    expect(await fs.readText(`${ROOT}/a.md`)).toBe('x');
    expect(JSON.parse(await fs.readText('/state/sync.json'))).toMatchObject({ connected: false, state: { files: {} } });
  });

  it('says when it had to create a new MDEdit folder in Drive', async () => {
    fs.seed(`${ROOT}/a.md`, 'x');
    const s = make();
    await s.load();
    expect((await s.connectSync()).summary?.rootCreated).toBe(true);
    expect((await s.syncNow()).summary?.rootCreated).toBe(false);
  });

  it('counts passes that changed local files, so the UI knows to refresh', async () => {
    const s = make();
    await s.load();
    await s.connectSync();
    expect((await s.getSyncStatus()).localChanges).toBe(0);
    drive.seed('Novel/x.md', 'remote', JSON.parse(await fs.readText('/state/sync.json')).state.rootId);
    await s.syncNow();
    expect((await s.getSyncStatus()).localChanges).toBe(1);
    await s.syncNow();
    expect((await s.getSyncStatus()).localChanges).toBe(1);
  });

  it('forgets its memory when the Root Folder is somewhere else, instead of treating the new folder as "everything deleted"', async () => {
    fs.seed(`${ROOT}/Novel/a.md`, 'a');
    fs.seed(`${ROOT}/Novel/b.md`, 'b');
    fs.seed(`${ROOT}/Novel/c.md`, 'c');
    const first = make();
    await first.load();
    await first.connectSync();
    await fs.mkdir('/Elsewhere', { recursive: true });
    const moved = make('/Elsewhere');
    await moved.load();
    const st = await moved.syncNow();
    expect(st.state).toBe('idle'); // no "this would delete 3 files" prompt
    expect(drive.read('Novel/a.md')).toBe('a'); // Drive untouched
    expect(await fs.readText('/Elsewhere/Novel/a.md')).toBe('a'); // and the new folder is filled from it
  });

  it('signs out of Google on disconnect', async () => {
    const s = make();
    await s.load();
    await s.connectSync();
    await s.disconnectSync();
    expect(signedOut).toBe(1);
  });

  it('knows when edits are waiting for a pass', async () => {
    vi.useFakeTimers();
    const s = make();
    await s.load();
    await s.connectSync();
    expect(s.dirty).toBe(false);
    s.syncSoon(1000);
    expect(s.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.dirty).toBe(false);
  });

  it('shows progress during a long pass and refreshes the lists along the way, not only at the end', async () => {
    const s = make();
    await s.load();
    await s.connectSync();
    const rootId = JSON.parse(await fs.readText('/state/sync.json')).state.rootId as string;
    for (let i = 0; i < 20; i++) drive.seed(`Novel/Chapter ${i}.md`, `chapter ${i}`, rootId);
    const seen: { progress: { done: number; total: number } | null; localChanges: number }[] = [];
    s.onSyncStatus((st) => seen.push({ progress: st.progress, localChanges: st.localChanges }));
    await s.syncNow();
    const withProgress = seen.filter((x) => x.progress);
    expect(withProgress.length).toBeGreaterThan(1);
    expect(withProgress[withProgress.length - 1].progress).toEqual({ done: 20, total: 20 });
    expect(seen[seen.length - 1].progress).toBeNull(); // cleared when the pass ends
    expect(seen[seen.length - 1].localChanges).toBeGreaterThan(0);
  });
});
