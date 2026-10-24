import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { emptySyncState, syncOnce, type SyncState } from './engine';
import { FakeDrive } from './fakeDrive';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps an object so each method call takes `ms`, and records how many ran at the same time. */
function metered<T extends object>(o: T, ms: number, log: { calls: Record<string, number>; inFlight: Record<string, number>; maxInFlight: Record<string, number> }): T {
  return new Proxy(o, {
    get: (t, p, r) => {
      const v = Reflect.get(t, p, r);
      if (typeof v !== 'function') return v;
      const name = String(p);
      return async (...a: unknown[]) => {
        log.calls[name] = (log.calls[name] ?? 0) + 1;
        log.inFlight[name] = (log.inFlight[name] ?? 0) + 1;
        log.maxInFlight[name] = Math.max(log.maxInFlight[name] ?? 0, log.inFlight[name]);
        await sleep(ms);
        try {
          return await v.apply(t, a);
        } finally {
          log.inFlight[name]--;
        }
      };
    },
  });
}
const newLog = () => ({ calls: {} as Record<string, number>, inFlight: {} as Record<string, number>, maxInFlight: {} as Record<string, number> });

async function library(files: number) {
  const mem = new MemoryFs();
  await mem.mkdir('/MDEdit', { recursive: true });
  for (let i = 0; i < files; i++) mem.seed(`/MDEdit/Project ${i % 3}/Part ${i % 4}/Chapter ${i}.md`, `# Chapter ${i}\n${'word '.repeat(50)}`);
  return mem;
}

describe('sync performance', () => {
  it('transfers several files at once, never more than the limit, and makes each folder once', async () => {
    const mem = await library(40);
    const drive = new FakeDrive();
    const log = newLog();
    let state: SyncState = emptySyncState();
    const store = { load: async () => state, save: async (s: SyncState) => void (state = JSON.parse(JSON.stringify(s))) };
    const progress: number[] = [];
    await syncOnce({ fs: mem, root: '/MDEdit', drive: metered(drive, 4, log), store, device: 'Pixel', onProgress: (p) => p.phase === 'syncing' && progress.push(p.done) });

    expect(log.calls.createFile).toBe(40);
    expect(log.maxInFlight.createFile).toBeGreaterThan(1); // parallel…
    expect(log.maxInFlight.createFile).toBeLessThanOrEqual(4); // …but bounded
    expect(log.calls.createFolder).toBe(1 + 3 + 3 * 4); // MDEdit + 3 projects + 12 part folders: parallel uploads never duplicate a folder
    expect(progress[progress.length - 1]).toBe(40);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // counts only go up
  });

  it('an idle pass lists Drive and the folders, and touches no file', async () => {
    const mem = await library(40);
    const drive = new FakeDrive();
    let state: SyncState = emptySyncState();
    const store = { load: async () => state, save: async (s: SyncState) => void (state = JSON.parse(JSON.stringify(s))) };
    await syncOnce({ fs: mem, root: '/MDEdit', drive, store, device: 'Pixel' });

    const fsLog = newLog();
    const driveLog = newLog();
    const r = await syncOnce({ fs: metered(mem, 0, fsLog), root: '/MDEdit', drive: metered(drive, 0, driveLog), store, device: 'Pixel' });
    expect(r).toMatchObject({ uploaded: [], downloaded: [], errors: [] });
    expect(fsLog.calls.readText ?? 0).toBe(0); // nothing re-read
    expect(fsLog.calls.stat ?? 0).toBe(0); // and no per-file stat: sizes and times come with the listing
    expect(Object.keys(driveLog.calls)).toEqual(['listAll']);
  });

  it('a second device downloads in parallel too', async () => {
    const first = await library(24);
    const drive = new FakeDrive();
    const mk = () => {
      let state: SyncState = emptySyncState();
      return { load: async () => state, save: async (s: SyncState) => void (state = JSON.parse(JSON.stringify(s))) };
    };
    await syncOnce({ fs: first, root: '/MDEdit', drive, store: mk(), device: 'Laptop' });
    const second = new MemoryFs();
    await second.mkdir('/MDEdit', { recursive: true });
    const log = newLog();
    const r = await syncOnce({ fs: metered(second, 2, log), root: '/MDEdit', drive: metered(drive, 4, newLog()), store: mk(), device: 'Pixel' });
    expect(r.downloaded).toHaveLength(24);
    expect(log.maxInFlight.writeText).toBeGreaterThan(1);
  });

  it('reports its work in a stable order even though it runs in parallel', async () => {
    const mem = await library(12);
    const store = (() => {
      let state: SyncState = emptySyncState();
      return { load: async () => state, save: async (s: SyncState) => void (state = JSON.parse(JSON.stringify(s))) };
    })();
    const r = await syncOnce({ fs: mem, root: '/MDEdit', drive: metered(new FakeDrive(), 3, newLog()), store, device: 'Pixel' });
    expect(r.uploaded).toEqual([...r.uploaded].sort());
  });
});
