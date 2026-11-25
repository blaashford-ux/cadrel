// A Studio with a series of two books, a vault stand-in with pictures in it, and the pages' main-process classes over it. Shared by the Art and Preflight tests.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import type { FileVersion } from '@cadrel/kernel';
import type { PreflightFiles } from '../src/main/preflight';
import { ProjectManager, type WriteFolders } from '../src/main/manage';
import { PeopleHost } from '../src/main/people';
import { ProjectStages } from '../src/main/stages';
import { StudioService } from '../src/main/studio';

export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A JPEG header of the given size: all the readers look at. */
export const jpeg = (w: number, h: number, tag = 0) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xfe, 0, 3, tag, 0xff, 0xd9]);
/** A small RGB PSD with a gradient composite (raw), or one flat colour. */
export function psd(w = 8, h = 4, flat = false): Uint8Array {
  const planes = [0, 1, 2].map((c) => Array.from({ length: h }, () => Array.from({ length: w }, (_v, x) => (flat ? 120 : c === 0 ? Math.round((x / Math.max(1, w - 1)) * 255) : c === 1 ? 40 : 200))));
  return Uint8Array.from([...text('8BPS'), ...be16(1), 0, 0, 0, 0, 0, 0, ...be16(3), ...be32(h), ...be32(w), ...be16(8), ...be16(3), ...be32(0), ...be32(0), ...be32(0), ...be16(0), ...planes.flat(2)]);
}

export interface VFile {
  fileId: string;
  path: string;
  projectId: string | null;
  /** The bytes of each version, version 1 first. */
  versions: Uint8Array[];
}
/** A vault stand-in: files with versions and bytes, answering what the pages ask of the vault host. */
export class FakeVault implements PreflightFiles {
  constructor(readonly list: VFile[]) {}
  async files() {
    return this.list.map((f) => ({ fileId: f.fileId, path: f.path, version: f.versions.length, projectId: f.projectId, size: f.versions[f.versions.length - 1]!.length }));
  }
  async bytesOf(fileId: string, version: number) {
    const b = this.list.find((f) => f.fileId === fileId)?.versions[version - 1];
    if (!b) throw new Error('no such version');
    return b;
  }
  async versionsOf(fileId: string): Promise<FileVersion[]> {
    const f = this.list.find((x) => x.fileId === fileId)!;
    return f.versions.map((b, i) => ({ n: i + 1, hash: sha(b), size: b.length, author: 'x', comment: '', createdAt: '2026-11-01T00:00:00.000Z' })).reverse();
  }
  async textOf(fileId: string, version: number) {
    return new TextDecoder().decode(await this.bytesOf(fileId, version));
  }
}

const write: WriteFolders = {
  projectsRoot: () => '/w', templates: () => [{ id: 'novel', name: 'Novel', description: '' }], listFolders: async () => ({ projects: [], others: [] }),
  createProject: async (n) => ({ path: `/w/${n}` }), renameProject: async (p) => p, duplicateProject: async (_p, n) => ({ path: `/w/${n}` }), deleteProject: async () => undefined,
  readProject: async () => null, updateProject: async () => undefined, convertFolder: async () => undefined, addMissingTemplateParts: async () => [], openProject: () => undefined
};

export interface Fixture {
  dir: string;
  host: PeopleHost;
  studio: StudioService;
  series: string;
  book1: string;
  book4: string;
  me: () => ReturnType<NonNullable<PeopleHost['service']>['as']>;
  db: () => { run(sql: string, p?: unknown[]): Promise<unknown> };
  /** Registers the vault's files in the records, as a check-in would (each version with its real hash, a data card with the project). */
  register(vault: FakeVault): Promise<void>;
  close(): Promise<void>;
}
export async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-art-'));
  const host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  const studio = new StudioService({ file: path.join(dir, 'studio.json'), author: () => 'Ana', writeRoot: async () => null, fs: new MemoryFs() });
  host.setProjects(async () => studio.tree());
  const mgr = new ProjectManager(studio, write, new ProjectStages(studio, () => host.workflows, () => host.work));
  const series = (await mgr.create({ name: 'Dragon Rider', kind: 'Series', template: null })).id;
  const book1 = (await mgr.create({ name: 'Book One', parentId: series, kind: 'Book', template: null })).id;
  const book4 = (await mgr.create({ name: 'Book Four', parentId: series, kind: 'Book', template: null })).id;
  const db = () => (host as unknown as { db: { run(sql: string, p?: unknown[]): Promise<unknown> } }).db;
  return {
    dir, host, studio, series, book1, book4,
    me: () => host.service!.as(host.me),
    db,
    async register(vault) {
      for (const f of vault.list) {
        await db().run('INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, ?, ?, ?)', [f.fileId, 'local', f.path, f.versions.length]);
        for (const [i, b] of f.versions.entries()) await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, ?, ?, ?, 'x', '2026-11-01T00:00:00.000Z')", [f.fileId, i + 1, sha(b), b.length]);
        if (f.projectId) await db().run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES (?, ?, '{}', 'x', 'x')", [f.fileId, f.projectId]);
      }
    },
    async close() {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}
