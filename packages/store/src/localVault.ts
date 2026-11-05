/**
 * The local vault: a working folder of real files, backed by the Studio's records (who holds which file, every version) and a content-addressed
 * store of the versions themselves. It applies the same rules the server will: one holder per file, only the holder checks in, a force-release
 * leaves the holder's work aside rather than losing it, and a file nobody is editing is read-only on disk. The rules are the kernel's
 * (`checkOut`, `checkIn`, `undoCheckOut`, `forceRelease`); this adds the disk: hashing, read-only, what the local copy is based on.
 *
 * A file is in one of these states for the person using this machine:
 *  - `untracked`: in the working folder, not in the vault yet
 *  - `not-local`: in the vault, not downloaded
 *  - `latest`: the local copy is the newest version, read-only
 *  - `out-of-date`: a newer version exists (Get latest)
 *  - `checked-out-by-me`: writable; `modified` says whether it differs from what was checked out
 *  - `checked-out-by-other`: read-only; the lock says who and since when
 *  - `modified-unprotected`: changed on disk without a check-out (something got round the read-only); never overwritten silently
 *  - `missing`: checked out by me but gone from disk
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  DbVaultStore, FileLinkError, type DataCard, type FileRef, cleanVaultPath, fileKind,
  type Db, type FileVersion, type VaultFileRow, type VaultStore
} from '@cadrel/kernel';

export class VaultError extends Error {
  constructor(readonly code: 'invalid' | 'denied' | 'exists' | 'not-found' | 'locked' | 'not-holder' | 'conflict', message: string) {
    super(message);
  }
}

/** Where file contents live. Content-addressed, so a version is stored once whatever it is called; a cloud store (R2) is the same shape. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Blobs as files under a folder: `ab/cdef…`. Written to a temporary name and renamed, so a half-written blob is never there. */
export class DirBlobs implements BlobStore {
  constructor(private readonly dir: string) {}
  private file(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new VaultError('invalid', 'That is not a content hash.');
    return path.join(this.dir, hash.slice(0, 2), hash.slice(2));
  }
  async put(bytes: Uint8Array): Promise<string> {
    const hash = sha256(bytes);
    const f = this.file(hash);
    if (await this.has(hash)) return hash;
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, f);
    return hash;
  }
  async get(hash: string): Promise<Uint8Array | null> {
    const b = await fsp.readFile(this.file(hash)).catch(() => null);
    return b && sha256(b) === hash ? b : null; // a damaged blob is as good as missing
  }
  async has(hash: string): Promise<boolean> {
    return fsp.access(this.file(hash)).then(() => true, () => false);
  }
}

export type FileStatus = 'untracked' | 'not-local' | 'latest' | 'out-of-date' | 'checked-out-by-me' | 'checked-out-by-other' | 'modified-unprotected' | 'missing';

export interface VaultEntry {
  path: string;
  kind: 'manuscript' | 'asset';
  fileId: string | null;
  status: FileStatus;
  /** The newest version in the vault (0 before the first check-in), null for an untracked file. */
  version: number | null;
  /** The version the local copy is based on. */
  localVersion: number | null;
  /** The local copy differs from the version it is based on. */
  modified: boolean;
  lock: { personId: string; machine: string; since: string } | null;
  size: number | null;
  /** The file's state in its own workflow (draft, approved…). */
  state: string | null;
}

export interface VaultOptions {
  /** Where the vault's records are: the Studio's records file (with `studioId`), or any other store (the Studio's server). */
  db?: Db;
  studioId?: string;
  store?: VaultStore;
  blobs: BlobStore;
  /** The working folder. */
  dir: string;
  personId: string;
  machine: string;
  now?: () => Date;
  /** Whether the person holds a capability (the service answers). Without one everything is allowed (tests, a Studio with one person). */
  can?: (capability: string) => Promise<boolean>;
}

interface LocalState {
  files: Record<string, { fileId: string; version: number; hash: string }>;
  /** Copies kept aside when someone else's force-release took the lock from under them. */
  orphans: { path: string; savedAs: string; removedBy: string; removedAt: string; reason: string; version: number }[];
}

const STATE_DIR = '.cadrel-vault';
const READONLY = 0o444;
const WRITABLE = 0o644;

export class LocalVault {
  private mem: LocalState | null = null;
  private readonly store: VaultStore;
  constructor(private readonly o: VaultOptions) {
    if (o.store) this.store = o.store;
    else if (o.db && o.studioId) this.store = new DbVaultStore({ db: o.db, studioId: o.studioId, personId: o.personId, now: o.now });
    else throw new Error('A vault needs a records file or a store.');
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private abs(rel: string): string {
    return path.join(this.o.dir, ...rel.split('/'));
  }
  private clean(p: string): string {
    const c = cleanVaultPath(p);
    if (!c.ok) throw new VaultError('invalid', c.reason);
    return c.path;
  }
  private async allow(rel: string, level: 'read' | 'write'): Promise<void> {
    const cap = `${fileKind(rel) === 'manuscript' ? 'manuscript' : 'asset'}.${level}`;
    if (this.o.can && !(await this.o.can(cap))) throw new VaultError('denied', `You are not allowed to do that (${cap}).`);
  }

  // ---- local state ---------------------------------------------------------------------------------------------------------

  private async state(): Promise<LocalState> {
    if (this.mem) return this.mem;
    const raw = await fsp.readFile(path.join(this.o.dir, STATE_DIR, 'state.json'), 'utf8').then((t) => JSON.parse(t) as Partial<LocalState>, () => ({}) as Partial<LocalState>);
    this.mem = { files: raw.files && typeof raw.files === 'object' ? raw.files : {}, orphans: Array.isArray(raw.orphans) ? raw.orphans : [] };
    return this.mem;
  }
  private async save(): Promise<void> {
    const dir = path.join(this.o.dir, STATE_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const f = path.join(dir, 'state.json');
    await fsp.writeFile(`${f}.tmp`, JSON.stringify(this.mem, null, 2));
    await fsp.rename(`${f}.tmp`, f);
  }

  private async readLocal(rel: string): Promise<Uint8Array | null> {
    return fsp.readFile(this.abs(rel)).catch(() => null);
  }
  private async writeLocal(rel: string, bytes: Uint8Array, writable: boolean): Promise<void> {
    const f = this.abs(rel);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.chmod(f, WRITABLE).catch(() => undefined); // an earlier read-only copy
    await fsp.writeFile(f, bytes);
    await fsp.chmod(f, writable ? WRITABLE : READONLY);
  }
  private async setWritable(rel: string, writable: boolean): Promise<void> {
    await fsp.chmod(this.abs(rel), writable ? WRITABLE : READONLY).catch(() => undefined);
  }
  private async blob(hash: string): Promise<Uint8Array> {
    return (await this.o.blobs.get(hash)) ?? Promise.reject(new VaultError('not-found', 'That version’s contents are not in the vault store.'));
  }

  // ---- reading -------------------------------------------------------------------------------------------------------------

  private async fileAt(rel: string): Promise<VaultFileRow | null> {
    return (await this.store.list()).find((f) => f.path.toLowerCase() === rel.toLowerCase()) ?? null;
  }

  private async entry(f: VaultFileRow, st: LocalState): Promise<VaultEntry> {
    const local = st.files[f.path];
    const disk = await this.readLocal(f.path);
    const diskHash = disk ? sha256(disk) : null;
    const mine = f.lock && f.lock.personId === this.o.personId && f.lock.machine === this.o.machine;
    const base: Omit<VaultEntry, 'status' | 'modified'> = { path: f.path, kind: fileKind(f.path), fileId: f.id, version: f.currentVersion, localVersion: local?.version ?? null, lock: f.lock && { personId: f.lock.personId, machine: f.lock.machine, since: f.lock.since }, size: disk ? disk.length : f.size, state: f.state };
    const changed = !!diskHash && !!local && diskHash !== local.hash;
    if (mine) return { ...base, status: disk ? 'checked-out-by-me' : 'missing', modified: changed };
    if (f.lock) return { ...base, status: 'checked-out-by-other', modified: changed };
    if (!disk) return { ...base, status: 'not-local', modified: false };
    if (!local) return { ...base, status: diskHash === f.hash ? 'latest' : 'modified-unprotected', modified: diskHash !== f.hash, localVersion: diskHash === f.hash ? f.currentVersion : null };
    if (changed) return { ...base, status: 'modified-unprotected', modified: true };
    return { ...base, status: local.version < f.currentVersion ? 'out-of-date' : 'latest', modified: false };
  }

  /** Every file in the vault, and every file in the working folder that is not (untracked), for the files this person may read. */
  async list(): Promise<VaultEntry[]> {
    const st = await this.state();
    const files = await this.store.list();
    const out: VaultEntry[] = [];
    for (const f of files) {
      if (this.o.can && !(await this.o.can(`${fileKind(f.path) === 'manuscript' ? 'manuscript' : 'asset'}.read`))) continue;
      out.push(await this.entry(f, st));
    }
    const known = new Set(files.map((f) => f.path.toLowerCase()));
    for (const rel of await this.walk()) {
      if (known.has(rel.toLowerCase())) continue;
      if (this.o.can && !(await this.o.can(`${fileKind(rel) === 'manuscript' ? 'manuscript' : 'asset'}.write`))) continue;
      const size = (await fsp.stat(this.abs(rel)).catch(() => null))?.size ?? null;
      out.push({ path: rel, kind: fileKind(rel), fileId: null, status: 'untracked', version: null, localVersion: null, modified: false, lock: null, size, state: null });
    }
    return out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  }

  private async walk(dir = ''): Promise<string[]> {
    const out: string[] = [];
    const entries = await fsp.readdir(path.join(this.o.dir, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === STATE_DIR || e.name.endsWith('.tmp')) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await this.walk(rel)));
      else if (e.isFile() && cleanVaultPath(rel).ok) out.push(rel);
    }
    return out;
  }

  async status(rel: string): Promise<VaultEntry> {
    const p = this.clean(rel);
    await this.allow(p, 'read');
    const f = await this.fileAt(p);
    if (!f) return (await this.list()).find((e) => e.path.toLowerCase() === p.toLowerCase()) ?? Promise.reject(new VaultError('not-found', 'There is no such file.'));
    return this.entry(f, await this.state());
  }

  async history(rel: string): Promise<FileVersion[]> {
    const p = this.clean(rel);
    await this.allow(p, 'read');
    const f = (await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.'));
    return this.store.versions((await f).id);
  }

  /** The contents of a version (the newest by default), without touching the working folder. */
  async read(rel: string, version?: number): Promise<Uint8Array> {
    const p = this.clean(rel);
    await this.allow(p, 'read');
    const f = (await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.'));
    const file = await f;
    const v = (await this.store.versions(file.id)).find((x) => x.n === (version ?? file.currentVersion));
    if (!v) throw new VaultError('not-found', 'There is no such version.');
    return this.blob(v.hash);
  }

  // ---- changing ------------------------------------------------------------------------------------------------------------

  /** Puts a file from the working folder into the vault as version 1, with this person as the author. It is left read-only, like any file nobody is editing. */
  async add(rel: string, comment = 'First version'): Promise<VaultEntry> {
    const p = this.clean(rel);
    await this.allow(p, 'write');
    const bytes = (await this.readLocal(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the working folder.'));
    const content = await bytes;
    if (await this.fileAt(p)) throw new VaultError('exists', 'A file with that name is already in the vault.');
    const hash = await this.o.blobs.put(content);
    const added = await this.store.addFile({ path: p, hash, size: content.length, comment, machine: this.o.machine });
    if (!added.ok) throw new VaultError(added.reason === 'exists' ? 'exists' : added.reason === 'locked' ? 'locked' : 'not-holder', added.reason === 'exists' ? 'A file with that name is already in the vault.' : added.reason === 'locked' ? 'That file is locked.' : 'The first version could not be saved.');
    const st = await this.state();
    st.files[p] = { fileId: added.id, version: added.version, hash };
    await this.save();
    await this.setWritable(p, false);
    return this.status(p);
  }

  /**
   * Takes the file for editing: refused while someone else holds it. If the local copy is old or missing the newest version is fetched first
   * (a check-out is always of the newest), and a local copy someone changed outside a check-out is refused rather than overwritten.
   */
  async checkOut(rel: string): Promise<VaultEntry> {
    const p = this.clean(rel);
    await this.allow(p, 'write');
    const f = (await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.'));
    const file = await f;
    const st = await this.state();
    const e = await this.entry(file, st);
    if (e.status === 'modified-unprotected') throw new VaultError('conflict', 'The copy on disk was changed without checking it out. Save it elsewhere or discard those changes first; it will not be overwritten.');
    const r = await this.store.checkOut({ fileId: file.id, machine: this.o.machine });
    if (!r.ok) {
      if (r.reason === 'locked') throw new VaultError('locked', `${r.heldBy.personId === this.o.personId ? 'You have' : 'Someone else has'} this file checked out${r.heldBy.personId === this.o.personId ? ' on another machine' : ''} (since ${r.heldBy.since.slice(0, 10)}).`);
      throw new VaultError('not-found', 'That file is not in the vault.');
    }
    // after taking the lock nobody else can change the file, so the newest version is the one to start from
    const cur = (await this.store.versions(file.id))[0];
    if (cur && (e.status === 'not-local' || e.status === 'out-of-date' || (await this.readLocal(p)) === null)) {
      await this.writeLocal(p, await this.blob(cur.hash), true);
      st.files[p] = { fileId: file.id, version: cur.n, hash: cur.hash };
      await this.save();
    } else {
      await this.setWritable(p, true);
    }
    return this.status(p);
  }

  /** Saves what is on disk as a new version and releases the lock. Nothing changed: the lock is released and no version is made. */
  async checkIn(rel: string, comment = ''): Promise<VaultEntry & { unchanged: boolean }> {
    const p = this.clean(rel);
    await this.allow(p, 'write');
    const file = await ((await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.')));
    if (!file.lock || file.lock.personId !== this.o.personId || file.lock.machine !== this.o.machine) throw new VaultError('not-holder', 'You do not have this file checked out here.');
    const bytes = (await this.readLocal(p)) ?? Promise.reject(new VaultError('not-found', 'The file is not in the working folder.'));
    const content = await bytes;
    const st = await this.state();
    const hash = sha256(content);
    if (st.files[p] && st.files[p]!.hash === hash) {
      await this.store.undoCheckOut({ fileId: file.id, machine: this.o.machine });
      await this.setWritable(p, false);
      return { ...(await this.status(p)), unchanged: true };
    }
    await this.o.blobs.put(content);
    const r = await this.store.checkIn({ fileId: file.id, machine: this.o.machine, hash, size: content.length, comment: comment.trim() });
    if (!r.ok) throw new VaultError('not-holder', 'Your lock on this file was removed, so this was not saved to the vault. Your copy is kept on your disk; use Get latest to see what is in the vault.');
    st.files[p] = { fileId: file.id, version: r.version, hash };
    await this.save();
    await this.setWritable(p, false);
    return { ...(await this.status(p)), unchanged: false };
  }

  /** Gives up the changes: releases the lock and puts the vault's version back on disk. */
  async undoCheckOut(rel: string): Promise<VaultEntry> {
    const p = this.clean(rel);
    await this.allow(p, 'write');
    const file = await ((await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.')));
    const ok = await this.store.undoCheckOut({ fileId: file.id, machine: this.o.machine });
    if (!ok) throw new VaultError('not-holder', 'You do not have this file checked out here.');
    await this.restoreCurrent(file);
    return this.status(p);
  }

  /** Throws away changes made to a read-only copy outside a check-out, putting the vault's newest version back. */
  async discardLocalChanges(rel: string): Promise<VaultEntry> {
    const p = this.clean(rel);
    await this.allow(p, 'read');
    const file = await ((await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.')));
    if (file.lock && file.lock.personId === this.o.personId && file.lock.machine === this.o.machine) throw new VaultError('conflict', 'This file is checked out by you: undo the check-out instead.');
    await this.restoreCurrent(file);
    return this.status(p);
  }

  private async restoreCurrent(file: VaultFileRow): Promise<void> {
    const cur = (await this.store.versions(file.id))[0];
    if (!cur) return;
    await this.writeLocal(file.path, await this.blob(cur.hash), false);
    const st = await this.state();
    st.files[file.path] = { fileId: file.id, version: cur.n, hash: cur.hash };
    await this.save();
  }

  /**
   * Brings local copies up to the newest versions. Never overwrites a file you have checked out, and never a copy that was changed outside a
   * check-out: those are reported as skipped. A file nobody has downloaded is downloaded only when `fetchMissing` is set.
   */
  async getLatest(rels?: string[], o: { fetchMissing?: boolean } = {}): Promise<{ updated: string[]; skipped: { path: string; why: string }[] }> {
    const wanted = rels ? new Set(rels.map((r) => this.clean(r).toLowerCase())) : null;
    const st = await this.state();
    const updated: string[] = [];
    const skipped: { path: string; why: string }[] = [];
    for (const f of await this.store.list()) {
      if (wanted && !wanted.has(f.path.toLowerCase())) continue;
      if (this.o.can && !(await this.o.can(`${fileKind(f.path) === 'manuscript' ? 'manuscript' : 'asset'}.read`))) continue;
      const e = await this.entry(f, st);
      if (e.status === 'checked-out-by-me') { skipped.push({ path: f.path, why: 'You have it checked out.' }); continue; }
      if (e.status === 'modified-unprotected') { skipped.push({ path: f.path, why: 'The copy on disk was changed without a check-out.' }); continue; }
      if (e.status === 'not-local' && !(o.fetchMissing || wanted)) continue;
      if (e.status === 'latest' || f.currentVersion === 0) continue;
      const cur = (await this.store.versions(f.id))[0]!;
      await this.writeLocal(f.path, await this.blob(cur.hash), false);
      st.files[f.path] = { fileId: f.id, version: cur.n, hash: cur.hash };
      updated.push(f.path);
    }
    await this.save();
    return { updated, skipped };
  }

  /** Puts an older version at another path in the working folder (never over the file itself), so it can be compared or added as a new file. */
  async saveVersionAs(rel: string, version: number, as: string): Promise<string> {
    const p = this.clean(rel);
    const target = this.clean(as);
    if (target.toLowerCase() === p.toLowerCase()) throw new VaultError('conflict', 'Choose another name: the file itself is only changed by checking it out.');
    if (await this.readLocal(target)) throw new VaultError('exists', 'There is already a file with that name.');
    await this.writeLocal(target, await this.read(p, version), true);
    return target;
  }

  // ---- references, where-used, data cards -----------------------------------------------------------------------------------

  private async known(rel: string, level: 'read' | 'write'): Promise<VaultFileRow> {
    const p = this.clean(rel);
    await this.allow(p, level);
    return (await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.'));
  }
  private async linkWork<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (e) {
      if (e instanceof FileLinkError) throw new VaultError(e.code === 'exists' ? 'exists' : e.code === 'not-found' ? 'not-found' : 'invalid', e.message);
      throw e;
    }
  }

  /** What the file uses (a cover's source PSD and fonts), each at a version or the latest. */
  async references(rel: string): Promise<FileRef[]> {
    return this.store.references((await this.known(rel, 'read')).id);
  }
  /** Where the file is used: the files that refer to it, and whether each names an older version. */
  async whereUsed(rel: string): Promise<FileRef[]> {
    return this.store.whereUsed((await this.known(rel, 'read')).id);
  }
  /** `rel` uses `to`, at `version` or the latest. Needs write access to `rel` and read access to `to`. */
  async addReference(rel: string, to: string, version?: number | null, note?: string): Promise<void> {
    const from = await this.known(rel, 'write');
    const target = await this.known(to, 'read');
    await this.linkWork(() => this.store.addReference({ fileId: from.id, refersToId: target.id, version: version ?? null, note }));
  }
  /** Points a reference at another version (null: the latest). References are never updated automatically. */
  async setReferenceVersion(rel: string, to: string, version: number | null): Promise<void> {
    const from = await this.known(rel, 'write');
    const target = await this.known(to, 'read');
    await this.linkWork(() => this.store.setReferenceVersion({ fileId: from.id, refersToId: target.id, version }));
  }
  async removeReference(rel: string, to: string): Promise<void> {
    const from = await this.known(rel, 'write');
    const target = await this.known(to, 'read');
    await this.store.removeReference({ fileId: from.id, refersToId: target.id });
  }
  async card(rel: string): Promise<DataCard> {
    return this.store.card((await this.known(rel, 'read')).id);
  }
  /** Replaces the file's data card (an empty value removes a field). */
  async setCard(rel: string, fields: Record<string, string>, projectId?: string | null): Promise<DataCard> {
    const f = await this.known(rel, 'write');
    return this.linkWork(() => this.store.setCard({ fileId: f.id, fields, projectId: projectId ?? null }));
  }

  // ---- administration ------------------------------------------------------------------------------------------------------

  /** An administrator takes the lock from whoever holds it. Needs `vault.force` and a typed reason; the holder's unsaved work is kept aside on their machine, never deleted. */
  async forceRelease(rel: string, reason: string): Promise<void> {
    const p = this.clean(rel);
    if (this.o.can && !(await this.o.can('vault.force'))) throw new VaultError('denied', 'You are not allowed to do that (vault.force).');
    const file = await ((await this.fileAt(p)) ?? Promise.reject(new VaultError('not-found', 'That file is not in the vault.')));
    const r = await this.store.forceRelease({ fileId: file.id, reason });
    if (!r.ok) throw new VaultError(r.reason === 'reason-required' ? 'invalid' : 'conflict', r.reason === 'reason-required' ? 'Say why you are removing the lock.' : 'Nobody has this file checked out.');
    // the administrator may be on the holder's own machine (one computer, one person); keep the copy aside there too
    await this.keepOrphansAside();
  }

  /**
   * Finds locks that were removed from under this person on this machine. Their copy is renamed next to the original ("Name (lock removed
   * 2026-11-10).ext"), flagged in the local state, and the vault's version put back; the removal is marked as seen. Returns what was kept.
   */
  async keepOrphansAside(): Promise<{ path: string; savedAs: string | null; removedBy: string; reason: string }[]> {
    const out: { path: string; savedAs: string | null; removedBy: string; reason: string }[] = [];
    const st = await this.state();
    const files = await this.store.list();
    for (const o of (await this.store.orphans()).filter((x) => x.machine === this.o.machine)) {
      const f = files.find((x) => x.id === o.fileId);
      if (!f) continue;
      const local = st.files[f.path];
      const disk = await this.readLocal(f.path);
      let savedAs: string | null = null;
      if (disk && local && sha256(disk) !== local.hash) {
        const dot = f.path.lastIndexOf('.');
        const slash = f.path.lastIndexOf('/');
        const stem = dot > slash ? f.path.slice(0, dot) : f.path;
        const ext = dot > slash ? f.path.slice(dot) : '';
        for (let n = 0; ; n++) {
          const cand = `${stem} (lock removed ${o.removedAt.slice(0, 10)}${n ? ` ${n + 1}` : ''})${ext}`;
          if (!(await this.readLocal(cand))) { savedAs = cand; break; }
        }
        await this.writeLocal(savedAs, disk, true);
        st.orphans.push({ path: f.path, savedAs, removedBy: o.removedBy, removedAt: o.removedAt, reason: o.reason, version: local.version });
      }
      if (f.currentVersion > 0) await this.restoreCurrent(f);
      await this.store.acknowledgeOrphans({ machine: this.o.machine, fileId: f.id });
      out.push({ path: f.path, savedAs, removedBy: o.removedBy, reason: o.reason });
    }
    await this.save();
    return out;
  }

  /** Copies kept aside after a lock was removed, newest last. */
  async orphans(): Promise<LocalState['orphans']> {
    return [...(await this.state()).orphans];
  }
}
