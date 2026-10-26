import { md5Hex } from '../md5';
import type { DriveApi, DriveFile } from './drive';

/** An in-memory Drive for tests: ids, trash that cascades, duplicate names allowed (like the real one), MD5s. */
export class FakeDrive implements DriveApi {
  private nodes = new Map<string, DriveFile & { content: string | null; trashed: boolean }>();
  private n = 0;
  clock = 1_000;
  /** Test hook: every call is recorded here. */
  calls: string[] = [];

  private tick = () => (this.clock += 10);
  private plain = (f: DriveFile & { content: string | null; trashed: boolean }): DriveFile => ({ id: f.id, name: f.name, parentId: f.parentId, isFolder: f.isFolder, md5: f.md5, modifiedMs: f.modifiedMs });

  async listAll(): Promise<DriveFile[]> {
    this.calls.push('list');
    return [...this.nodes.values()].filter((f) => !f.trashed).map(this.plain);
  }

  async createFolder(name: string, parentId: string | null): Promise<DriveFile> {
    this.calls.push(`createFolder:${name}`);
    const f = { id: `d${++this.n}`, name, parentId, isFolder: true, md5: null, modifiedMs: this.tick(), content: null, trashed: false };
    this.nodes.set(f.id, f);
    return this.plain(f);
  }

  async createFile(name: string, parentId: string, content: string): Promise<DriveFile> {
    this.calls.push(`createFile:${name}`);
    const f = { id: `d${++this.n}`, name, parentId, isFolder: false, md5: md5Hex(content), modifiedMs: this.tick(), content, trashed: false };
    this.nodes.set(f.id, f);
    return this.plain(f);
  }

  async updateFile(id: string, content: string): Promise<DriveFile> {
    this.calls.push(`updateFile:${id}`);
    const f = this.live(id);
    f.content = content;
    f.md5 = md5Hex(content);
    f.modifiedMs = this.tick();
    return this.plain(f);
  }

  async download(id: string): Promise<string> {
    this.calls.push(`download:${id}`);
    return this.live(id).content ?? '';
  }

  async rename(id: string, name: string, move?: { from: string | null; to: string }): Promise<DriveFile> {
    this.calls.push(`rename:${id}:${name}`);
    const f = this.live(id);
    f.name = name;
    if (move) f.parentId = move.to;
    f.modifiedMs = this.tick();
    return this.plain(f);
  }

  /** Link sharing per file id, for tests. */
  links = new Map<string, 'reader' | 'writer'>();
  /** Test hook: ids this fake "app" has been given access to (when set, other files look missing to getFile/download). */
  granted: Set<string> | null = null;

  async getFile(id: string): Promise<DriveFile | null> {
    this.calls.push(`getFile:${id}`);
    const f = this.nodes.get(id);
    if (!f || f.trashed || (this.granted && !this.granted.has(id))) return null;
    return this.plain(f);
  }

  async shareByLink(id: string, role: 'reader' | 'writer'): Promise<void> {
    this.calls.push(`share:${id}:${role}`);
    this.live(id);
    this.links.set(id, role);
  }

  async unshare(id: string): Promise<void> {
    this.calls.push(`unshare:${id}`);
    this.links.delete(id);
  }

  async trash(id: string): Promise<void> {
    this.calls.push(`trash:${id}`);
    const kill = (x: string) => {
      const f = this.nodes.get(x);
      if (!f) return;
      f.trashed = true;
      for (const c of this.nodes.values()) if (c.parentId === x) kill(c.id);
    };
    this.live(id);
    kill(id);
  }

  private live(id: string) {
    const f = this.nodes.get(id);
    if (!f || f.trashed || (this.granted && !this.granted.has(id))) throw Object.assign(new Error(`Drive: file ${id} not found`), { status: 404 });
    return f;
  }

  /** Test helper: a file made behind the app's back (for example in the Drive web UI). */
  seed(path: string, content: string, rootId: string): DriveFile {
    const parts = path.split('/');
    let parent = rootId;
    for (const seg of parts.slice(0, -1)) {
      const existing = [...this.nodes.values()].find((f) => !f.trashed && f.isFolder && f.parentId === parent && f.name === seg);
      if (existing) parent = existing.id;
      else {
        const f = { id: `d${++this.n}`, name: seg, parentId: parent, isFolder: true, md5: null, modifiedMs: this.tick(), content: null, trashed: false };
        this.nodes.set(f.id, f);
        parent = f.id;
      }
    }
    const f = { id: `d${++this.n}`, name: parts[parts.length - 1], parentId: parent, isFolder: false, md5: md5Hex(content), modifiedMs: this.tick(), content, trashed: false };
    this.nodes.set(f.id, f);
    return this.plain(f);
  }

  /** Test helper: current content of the live file at a path under the root, or undefined. */
  read(path: string): string | undefined {
    const root = [...this.nodes.values()].find((f) => !f.trashed && f.isFolder && f.parentId === null);
    if (!root) return undefined;
    let cur: string = root.id;
    const parts = path.split('/');
    for (const seg of parts.slice(0, -1)) {
      const next = [...this.nodes.values()].find((f) => !f.trashed && f.isFolder && f.parentId === cur && f.name === seg);
      if (!next) return undefined;
      cur = next.id;
    }
    return [...this.nodes.values()].find((f) => !f.trashed && !f.isFolder && f.parentId === cur && f.name === parts[parts.length - 1])?.content ?? undefined;
  }
}
