import { errorCode, fsError, type FsEntry, type FsPort, type FsStat } from './fsPort';

/**
 * An in-memory `FsPort` for tests (and the browser dev preview). Paths use "/" (a leading "C:" style prefix is just
 * part of the first segment). Modification times come from a counter, so they are deterministic.
 */
export class MemoryFs implements FsPort {
  private files = new Map<string, { text: string; mtimeMs: number }>();
  private dirs = new Set<string>(['']);
  clock = 1;

  private norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/g, '');
  private parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  private isDir = (p: string) => this.dirs.has(p);
  private tick = () => ++this.clock;

  /** Test helper: puts a file there, creating its folders. */
  seed(path: string, text: string): void {
    const p = this.norm(path);
    this.mkdirp(this.parent(p));
    this.files.set(p, { text, mtimeMs: this.tick() });
  }

  private mkdirp(p: string): void {
    if (p === '' || this.dirs.has(p)) return;
    this.mkdirp(this.parent(p));
    this.dirs.add(p);
  }

  async readText(path: string): Promise<string> {
    const f = this.files.get(this.norm(path));
    if (!f) throw fsError(this.isDir(this.norm(path)) ? 'EISDIR' : 'ENOENT', path);
    return f.text;
  }

  async writeText(path: string, content: string, opts: { exclusive?: boolean } = {}): Promise<void> {
    const p = this.norm(path);
    if (this.isDir(p)) throw fsError('EISDIR', path);
    if (!this.isDir(this.parent(p))) throw fsError('ENOENT', path);
    if (opts.exclusive && this.files.has(p)) throw fsError('EEXIST', path);
    this.files.set(p, { text: content, mtimeMs: this.tick() });
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const p = this.norm(path);
    if (!this.isDir(p)) throw fsError(this.files.has(p) ? 'ENOTDIR' : 'ENOENT', path);
    const out: FsEntry[] = [];
    for (const d of this.dirs) if (d !== '' && this.parent(d) === p) out.push({ name: d.slice(p === '' ? 0 : p.length + 1), isDirectory: true, isFile: false, isSymbolicLink: false });
    for (const [f, v] of this.files) if (this.parent(f) === p) out.push({ name: f.slice(p === '' ? 0 : p.length + 1), isDirectory: false, isFile: true, isSymbolicLink: false, size: new TextEncoder().encode(v.text).length, mtimeMs: v.mtimeMs });
    return out;
  }

  async stat(path: string): Promise<FsStat | null> {
    const p = this.norm(path);
    const f = this.files.get(p);
    if (f) return { isDirectory: false, isFile: true, mtimeMs: f.mtimeMs, size: new TextEncoder().encode(f.text).length };
    if (this.isDir(p)) return { isDirectory: true, isFile: false, mtimeMs: 0, size: 0 };
    return null;
  }

  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const p = this.norm(path);
    if (opts.recursive) {
      if (this.files.has(p)) throw fsError('EEXIST', path);
      this.mkdirp(p);
      return;
    }
    if (this.isDir(p) || this.files.has(p)) throw fsError('EEXIST', path);
    if (!this.isDir(this.parent(p))) throw fsError('ENOENT', path);
    this.dirs.add(p);
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.norm(from), b = this.norm(to);
    if (!this.files.has(a) && !this.isDir(a)) throw fsError('ENOENT', from);
    if (!this.isDir(this.parent(b))) throw fsError('ENOENT', to);
    if (a === b) return;
    const caseOnly = a.toLowerCase() === b.toLowerCase();
    const targetExists = this.files.has(b) || this.isDir(b);
    // Like Node: a file replaces a file; anything else that is already there is an error.
    if (targetExists && !caseOnly && !(this.files.has(a) && this.files.has(b))) throw fsError('EEXIST', to);
    this.moveTree(a, b);
  }

  private moveTree(a: string, b: string): void {
    const f = this.files.get(a);
    if (f) { this.files.delete(a); this.files.set(b, { ...f, mtimeMs: this.tick() }); return; }
    const remap = (p: string) => (p === a ? b : b + p.slice(a.length));
    const under = (p: string) => p === a || p.startsWith(a + '/');
    for (const d of [...this.dirs].filter(under)) { this.dirs.delete(d); this.dirs.add(remap(d)); }
    for (const [k, v] of [...this.files].filter(([k]) => under(k))) { this.files.delete(k); this.files.set(remap(k), v); }
  }

  async rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const p = this.norm(path);
    if (this.files.delete(p)) return;
    if (this.isDir(p)) {
      const hasChildren = [...this.dirs].some((d) => d.startsWith(p + '/')) || [...this.files.keys()].some((f) => f.startsWith(p + '/'));
      if (hasChildren && !opts.recursive) throw fsError('ENOTEMPTY', path);
      for (const d of [...this.dirs]) if (d === p || d.startsWith(p + '/')) this.dirs.delete(d);
      for (const f of [...this.files.keys()]) if (f.startsWith(p + '/')) this.files.delete(f);
      return;
    }
    if (!opts.force) throw fsError('ENOENT', path);
  }

  async copy(from: string, to: string): Promise<void> {
    const a = this.norm(from), b = this.norm(to);
    const f = this.files.get(a);
    if (f) {
      if (!this.isDir(this.parent(b))) throw fsError('ENOENT', to);
      this.files.set(b, { text: f.text, mtimeMs: this.tick() });
      return;
    }
    if (!this.isDir(a)) throw fsError('ENOENT', from);
    if (this.isDir(b)) throw fsError('EEXIST', to);
    this.mkdirp(b);
    for (const d of [...this.dirs]) if (d.startsWith(a + '/')) this.dirs.add(b + d.slice(a.length));
    for (const [k, v] of [...this.files]) if (k.startsWith(a + '/')) this.files.set(b + k.slice(a.length), { text: v.text, mtimeMs: this.tick() });
  }
}

export { errorCode };
