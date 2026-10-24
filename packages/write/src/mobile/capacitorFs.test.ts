import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../shared/memoryFs';
import { fsPortSuite } from '../shared/fsPortSuite';
import { createCapacitorFs, type FilesystemLike } from './capacitorFs';

/**
 * A stand-in for Capacitor's Filesystem plugin that is deliberately strict and unhelpful, like the real one:
 * it throws plain errors with no codes, refuses to overwrite on rename, to recreate folders, and to write without a
 * parent folder. The adapter must still honour the FsPort contract on top of it.
 */
export function fakePlugin(mem: MemoryFs): FilesystemLike {
  const p = (path: string) => '/' + path.replace(/^\/+/, '');
  const plain = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      throw new Error('Operation failed');
    }
  };
  return {
    readFile: ({ path }) => plain(async () => ({ data: await mem.readText(p(path)) })),
    writeFile: ({ path, data, recursive }) => plain(async () => {
      if (recursive) await mem.mkdir(p(path).replace(/\/[^/]*$/, ''), { recursive: true });
      await mem.writeText(p(path), data);
    }),
    deleteFile: ({ path }) => plain(() => mem.rm(p(path))),
    mkdir: ({ path, recursive }) => plain(() => mem.mkdir(p(path), { recursive })),
    rmdir: ({ path, recursive }) => plain(() => mem.rm(p(path), { recursive })),
    readdir: ({ path }) => plain(async () => ({ files: (await mem.readdir(p(path))).map((e) => ({ name: e.name, type: e.isDirectory ? 'directory' : 'file', size: e.size ?? 0, mtime: e.mtimeMs ?? 0 })) })),
    stat: ({ path }) => plain(async () => {
      const st = await mem.stat(p(path));
      if (!st) throw new Error('missing');
      return { type: st.isDirectory ? 'directory' : 'file', size: st.size, mtime: st.mtimeMs };
    }),
    rename: ({ from, to }) => plain(async () => {
      if (await mem.stat(p(to))) throw new Error('destination exists'); // the real plugin does not overwrite
      await mem.rename(p(from), p(to));
    }),
    copy: ({ from, to }) => plain(async () => {
      if (await mem.stat(p(to))) throw new Error('destination exists');
      await mem.copy(p(from), p(to));
    }),
  };
}

fsPortSuite('Capacitor adapter (fake plugin)', async () => {
  const mem = new MemoryFs();
  const fs = createCapacitorFs(fakePlugin(mem));
  await fs.mkdir('/data', { recursive: true });
  return { fs, root: '/data', join: (...parts) => parts.join('/') };
});


describe('bridge calls (each one crosses into native code, so they are the phone’s main cost)', () => {
  /** Counts how many plugin calls an operation makes. */
  async function calls(run: (fs: ReturnType<typeof createCapacitorFs>) => Promise<unknown>, seed?: (mem: MemoryFs) => void) {
    const mem = new MemoryFs();
    await mem.mkdir('/data', { recursive: true });
    seed?.(mem);
    const plugin = fakePlugin(mem);
    let n = 0;
    const counted = new Proxy(plugin, { get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof v === 'function' ? (...a: unknown[]) => (n++, (v as (...x: unknown[]) => unknown)(...a)) : v; } });
    await run(createCapacitorFs(counted));
    return n;
  }

  it('reads a file with one call, writes one with one call, lists a folder with one call', async () => {
    expect(await calls((fs) => fs.readText('/data/a.md'), (m) => m.seed('/data/a.md', 'x'))).toBe(1);
    expect(await calls((fs) => fs.writeText('/data/a.md', 'x'))).toBe(1);
    expect(await calls((fs) => fs.readdir('/data'))).toBe(1);
    expect(await calls((fs) => fs.mkdir('/data/new'))).toBe(1);
  });

  it('still reports why something failed, at the cost of an extra call only when it does', async () => {
    const mem = new MemoryFs();
    const fs = createCapacitorFs(fakePlugin(mem));
    await expect(fs.readText('/nope.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readdir('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.writeText('/missing/dir/a.md', 'x')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hands over size and modification time with the listing, so scans need no stat per file', async () => {
    const mem = new MemoryFs();
    await mem.mkdir('/data', { recursive: true });
    mem.seed('/data/a.md', 'abc');
    const [entry] = await createCapacitorFs(fakePlugin(mem)).readdir('/data');
    expect(entry).toMatchObject({ name: 'a.md', size: 3 });
    expect(entry.mtimeMs).toBeGreaterThan(0);
  });
});
