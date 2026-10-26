import { beforeEach, describe, expect, it } from 'vitest';
import { errorCode, type FsPort } from './fsPort';

const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => errorCode(e) ?? String(e));

/**
 * The behaviour every `FsPort` must have, run against each implementation (in-memory, Node, and the phone's).
 * `make` returns a fresh port and an existing, empty folder to work in; `join` builds a path inside it.
 */
export function fsPortSuite(name: string, make: () => Promise<{ fs: FsPort; root: string; join: (...parts: string[]) => string }>): void {
  describe(`FsPort: ${name}`, () => {
    let fs: FsPort;
    let at: (...parts: string[]) => string;
    beforeEach(async () => {
      const m = await make();
      fs = m.fs;
      at = (...parts) => m.join(m.root, ...parts);
    });

    it('writes, reads and overwrites text (UTF-8, line endings untouched)', async () => {
      await fs.writeText(at('a.md'), 'héllo\r\nwörld\n');
      expect(await fs.readText(at('a.md'))).toBe('héllo\r\nwörld\n');
      await fs.writeText(at('a.md'), 'x');
      expect(await fs.readText(at('a.md'))).toBe('x');
    });

    it('reports missing files with ENOENT', async () => {
      expect(await codeOf(fs.readText(at('nope.md')))).toBe('ENOENT');
      expect(await codeOf(fs.readdir(at('nope')))).toBe('ENOENT');
      expect(await codeOf(fs.rename(at('nope'), at('x')))).toBe('ENOENT');
      expect(await fs.stat(at('nope'))).toBeNull();
    });

    it('exclusive writes refuse to overwrite', async () => {
      await fs.writeText(at('a.md'), '1', { exclusive: true });
      expect(await codeOf(fs.writeText(at('a.md'), '2', { exclusive: true }))).toBe('EEXIST');
      expect(await fs.readText(at('a.md'))).toBe('1');
    });

    it('stat tells files from folders and gives size and a modification time', async () => {
      await fs.writeText(at('a.md'), 'abc');
      await fs.mkdir(at('d'));
      const f = await fs.stat(at('a.md'));
      expect(f).toMatchObject({ isFile: true, isDirectory: false, size: 3 });
      expect(f!.mtimeMs).toBeGreaterThan(0);
      expect(await fs.stat(at('d'))).toMatchObject({ isFile: false, isDirectory: true });
    });

    it('lists a folder’s direct children only', async () => {
      await fs.mkdir(at('d'));
      await fs.writeText(at('a.md'), '');
      await fs.writeText(at('d', 'inner.md'), '');
      const names = (await fs.readdir(at())).map((e) => [e.name, e.isDirectory]).sort();
      expect(names).toEqual([['a.md', false], ['d', true]]);
    });

    it('mkdir: plain fails if it exists, recursive makes parents and tolerates existing', async () => {
      await fs.mkdir(at('d'));
      expect(await codeOf(fs.mkdir(at('d')))).toBe('EEXIST');
      await fs.mkdir(at('p', 'q', 'r'), { recursive: true });
      await fs.mkdir(at('p', 'q', 'r'), { recursive: true });
      expect((await fs.stat(at('p', 'q', 'r')))?.isDirectory).toBe(true);
    });

    it('renames files and folders (with their contents) and lets a file replace a file', async () => {
      await fs.writeText(at('a.md'), 'A');
      await fs.writeText(at('b.md'), 'B');
      await fs.rename(at('a.md'), at('b.md'));
      expect(await fs.readText(at('b.md'))).toBe('A');
      expect(await fs.stat(at('a.md'))).toBeNull();
      await fs.mkdir(at('d'));
      await fs.writeText(at('d', 'x.md'), 'X');
      await fs.rename(at('d'), at('e'));
      expect(await fs.readText(at('e', 'x.md'))).toBe('X');
      expect(await fs.stat(at('d'))).toBeNull();
    });

    it('removes files, and folders only when recursive; force ignores missing', async () => {
      await fs.mkdir(at('d'));
      await fs.writeText(at('d', 'x.md'), 'X');
      expect(await codeOf(fs.rm(at('d')))).not.toBe('ok');
      await fs.rm(at('d'), { recursive: true });
      expect(await fs.stat(at('d'))).toBeNull();
      expect(await codeOf(fs.rm(at('gone')))).toBe('ENOENT');
      expect(await codeOf(fs.rm(at('gone'), { force: true }))).toBe('ok');
    });

    it('copies a file (overwriting) and a whole folder (refusing an existing target)', async () => {
      await fs.writeText(at('a.md'), 'A');
      await fs.writeText(at('b.md'), 'old');
      await fs.copy(at('a.md'), at('b.md'));
      expect(await fs.readText(at('b.md'))).toBe('A');
      await fs.mkdir(at('d', 'sub'), { recursive: true });
      await fs.writeText(at('d', 'sub', 'x.md'), 'X');
      await fs.copy(at('d'), at('d2'));
      expect(await fs.readText(at('d2', 'sub', 'x.md'))).toBe('X');
      expect(await fs.readText(at('d', 'sub', 'x.md'))).toBe('X');
      expect(await codeOf(fs.copy(at('d'), at('d2')))).toBe('EEXIST');
    });
  });
}
