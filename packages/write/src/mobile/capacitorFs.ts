/**
 * `FsPort` over Capacitor's Filesystem plugin (the phone's storage). Everything lives under one plugin directory
 * (app-private "Data" storage); paths are "/"-style strings relative to it, e.g. "/MDEdit/The Lost King/Ch 1.md".
 *
 * The plugin's error messages differ between platforms and versions, so this adapter never relies on them: where the
 * `FsPort` contract promises ENOENT / EEXIST / ENOTEMPTY it checks with `stat` first and raises the error itself.
 */
import { fsError, type FsEntry, type FsPort, type FsStat } from '../shared/fsPort';

/** The slice of `@capacitor/filesystem`'s `Filesystem` this adapter uses (so tests can supply a fake). */
export interface FilesystemLike {
  readFile(o: { path: string; directory: string; encoding: string }): Promise<{ data: string | Blob }>;
  writeFile(o: { path: string; directory: string; data: string; encoding: string; recursive?: boolean }): Promise<unknown>;
  deleteFile(o: { path: string; directory: string }): Promise<void>;
  mkdir(o: { path: string; directory: string; recursive?: boolean }): Promise<void>;
  rmdir(o: { path: string; directory: string; recursive?: boolean }): Promise<void>;
  readdir(o: { path: string; directory: string }): Promise<{ files: { name: string; type: string; size: number; mtime?: number }[] }>;
  stat(o: { path: string; directory: string }): Promise<{ type: string; size: number; mtime?: number }>;
  rename(o: { from: string; to: string; directory: string; toDirectory?: string }): Promise<void>;
  copy(o: { from: string; to: string; directory: string; toDirectory?: string }): Promise<unknown>;
}

const rel = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
const parentOf = (p: string) => (rel(p).includes('/') ? rel(p).slice(0, rel(p).lastIndexOf('/')) : '');

export function createCapacitorFs(plugin: FilesystemLike, directory = 'DATA', encoding = 'utf8'): FsPort {
  const at = (p: string) => ({ path: rel(p), directory });

  async function stat(p: string): Promise<FsStat | null> {
    if (rel(p) === '') return { isDirectory: true, isFile: false, mtimeMs: 0, size: 0 };
    try {
      const st = await plugin.stat(at(p));
      return { isDirectory: st.type === 'directory', isFile: st.type !== 'directory', mtimeMs: st.mtime ?? 0, size: st.size ?? 0 };
    } catch {
      return null; // the plugin throws for anything it can't find
    }
  }

  const requireDir = async (p: string) => {
    const st = await stat(p);
    if (!st) throw fsError('ENOENT', p);
    if (!st.isDirectory) throw fsError('ENOTDIR', p);
  };

  /** The success path is one bridge call; only a failure pays for `stat` to say why. */
  async function readdir(p: string): Promise<FsEntry[]> {
    let files;
    try {
      ({ files } = await plugin.readdir(at(p)));
    } catch (e) {
      await requireDir(p); // missing → ENOENT, a file → ENOTDIR
      throw e;
    }
    return files.map((f) => ({
      name: f.name, isDirectory: f.type === 'directory', isFile: f.type !== 'directory', isSymbolicLink: false,
      ...(f.type !== 'directory' && typeof f.mtime === 'number' && typeof f.size === 'number' ? { size: f.size, mtimeMs: f.mtime } : {}),
    }));
  }

  async function copyTree(from: string, to: string): Promise<void> {
    const st = await stat(from);
    if (!st) throw fsError('ENOENT', from);
    if (!st.isDirectory) {
      if (!(await stat(parentOf(to)))?.isDirectory) throw fsError('ENOENT', to);
      if (await stat(to)) await plugin.deleteFile(at(to)); // a file copy overwrites
      await plugin.copy({ from: rel(from), to: rel(to), directory, toDirectory: directory });
      return;
    }
    if (await stat(to)) throw fsError('EEXIST', to);
    await plugin.mkdir({ ...at(to), recursive: true });
    for (const e of await readdir(from)) await copyTree(`${rel(from)}/${e.name}`, `${rel(to)}/${e.name}`);
  }

  return {
    async readText(p) {
      let data: string | Blob;
      try {
        ({ data } = await plugin.readFile({ ...at(p), encoding }));
      } catch (e) {
        const st = await stat(p); // why did it fail?
        if (!st) throw fsError('ENOENT', p);
        if (st.isDirectory) throw fsError('EISDIR', p);
        throw e;
      }
      return typeof data === 'string' ? data : await data.text();
    },

    async writeText(p, content, opts) {
      if (opts?.exclusive && (await stat(p))) throw fsError('EEXIST', p);
      try {
        await plugin.writeFile({ ...at(p), data: content, encoding, recursive: false });
      } catch (e) {
        if (!(await stat(parentOf(p)))) throw fsError('ENOENT', p); // the parent folder is missing
        if ((await stat(p))?.isDirectory) throw fsError('EISDIR', p);
        throw e;
      }
    },

    readdir,
    stat,

    async mkdir(p, opts) {
      if (opts?.recursive) {
        const st = await stat(p);
        if (st?.isFile) throw fsError('EEXIST', p);
        if (!st) await plugin.mkdir({ ...at(p), recursive: true });
        return;
      }
      try {
        await plugin.mkdir({ ...at(p), recursive: false });
      } catch (e) {
        if (await stat(p)) throw fsError('EEXIST', p);
        await requireDir(parentOf(p)).catch(() => {
          throw fsError('ENOENT', p);
        });
        throw e;
      }
    },

    async rename(from, to) {
      const src = await stat(from);
      if (!src) throw fsError('ENOENT', from);
      await requireDir(parentOf(to)).catch(() => {
        throw fsError('ENOENT', to);
      });
      if (rel(from) === rel(to)) return;
      const dest = await stat(to);
      if (dest) {
        // Like Node: a file replaces a file; anything else that is already there is an error.
        if (!(src.isFile && dest.isFile)) throw fsError('EEXIST', to);
        await plugin.deleteFile(at(to));
      }
      await plugin.rename({ from: rel(from), to: rel(to), directory, toDirectory: directory });
    },

    async rm(p, opts) {
      const st = await stat(p);
      if (!st) {
        if (opts?.force) return;
        throw fsError('ENOENT', p);
      }
      if (st.isFile) return plugin.deleteFile(at(p));
      if (!opts?.recursive && (await readdir(p)).length > 0) throw fsError('ENOTEMPTY', p);
      await plugin.rmdir({ ...at(p), recursive: true });
    },

    copy: copyTree,
  };
}
