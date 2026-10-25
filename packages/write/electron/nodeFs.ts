import { promises as fs } from 'node:fs';
import { errorCode, fsError, type FsEntry, type FsPort, type FsStat } from '../src/shared/fsPort';

/** `FsPort` over Node's `fs`: what the Windows app uses. */
export const nodeFs: FsPort = {
  readText: (p) => fs.readFile(p, 'utf8'),

  writeText: (p, content, opts) => fs.writeFile(p, content, { encoding: 'utf8', flag: opts?.exclusive ? 'wx' : 'w' }),

  async readdir(p): Promise<FsEntry[]> {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymbolicLink: e.isSymbolicLink() }));
  },

  async stat(p): Promise<FsStat | null> {
    try {
      const st = await fs.stat(p);
      return { isDirectory: st.isDirectory(), isFile: st.isFile(), mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      if (errorCode(e) === 'ENOENT' || errorCode(e) === 'ENOTDIR') return null;
      throw e;
    }
  },

  async mkdir(p, opts) {
    await fs.mkdir(p, opts?.recursive ? { recursive: true } : undefined);
  },

  rename: (from, to) => fs.rename(from, to),

  rm: (p, opts) => fs.rm(p, { recursive: opts?.recursive ?? false, force: opts?.force ?? false }),

  async copy(from, to) {
    const st = await fs.stat(from);
    if (st.isDirectory()) {
      if (await fs.lstat(to).then(() => true, () => false)) throw fsError('EEXIST', to);
      await fs.cp(from, to, { recursive: true });
    } else await fs.copyFile(from, to);
  },
};
