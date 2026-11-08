/**
 * Keeps a Studio's project files on the phone in step with the Studio's vault.
 *
 * The vault is check-out / check-in: one person holds a file at a time, and every check-in is a new version. The phone works with it like this:
 *
 *  - A project the person may see is a folder in the app's own storage, with the vault's text files (Markdown, plain text, Fountain) in it. The
 *    folder has the `.cadrel/project.json` Write expects, so the editor opens it like any project of its own.
 *  - Writing is just writing to those files, also with no connection. A pass (when there is a connection, soon after an edit, when the app comes
 *    to the front, and every minute while it is open) brings in new versions and adds new files. It never makes a version of an edit: a change
 *    stays on the phone, listed as unsaved, and is never overwritten, until the person saves a version (`saveVersion`), so history holds what they
 *    chose to keep. Saving takes the file's lock, makes the version and gives the lock back at once, so the phone never keeps a file from the desktop.
 *  - If the file moved on in the meantime (someone saved a newer version first), or someone holds it, the phone's text is kept as a separate
 *    "conflict" file and also sent to the Studio as a new file. Nothing is overwritten and nothing is lost; the person decides.
 *  - New files in a project are added to the vault. The vault cannot rename or delete, so neither can the phone.
 *  - What the person may do is decided by the Studio's server on every call; the phone also asks up front (`canAt`) so it can say so in words.
 *
 * Images and other non-text files are not brought to the phone: its storage and editor work with text.
 */
import { cleanVaultPath, hex, sha256, type CheckInResult, type CheckOutResult, type AddFileResult, type Project, type ProjectTree, type VaultListing } from '@cadrel/kernel';
import { StudioApiError, StudioOfflineError } from '@cadrel/studio-client';
import type { SyncApi, SyncStatus, SyncSummary } from '@cadrel/write/src/shared/api';
import { errorCode, type FsPort } from '@cadrel/write/src/shared/fsPort';
import { conflictName, safeName, uniqueName } from './names';

/** What the sync needs from the Studio. The shared `StudioClient` provides it. */
export interface StudioPort {
  me(): Promise<{ personId: string; role: string; name: string; studioId: string }>;
  tree(): Promise<ProjectTree>;
  vault<T>(method: string, arg?: unknown): Promise<T>;
  rpc<T>(path: string[], args: unknown[]): Promise<T>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | null>;
}

/** The files the phone edits: text. The vault may hold more; those stay on the Studio. */
export const TEXT_FILE = /\.(md|markdown|txt|fountain)$/i;
const NO_PROJECT = '_';
const PROJECT_DIR = '.cadrel';

export interface SyncedFile {
  id: string;
  /** Where the vault keeps it. */
  path: string;
  project: string;
  /** Where it is inside the project's folder. */
  rel: string;
  /** The vault version this phone last had. */
  version: number;
  /** The vault's hash of that version. */
  hash: string;
  /** The hash of the text as the phone last read it from storage: if it still is, the file has not been edited here. */
  base: string;
  mtimeMs: number;
  size: number;
}

interface LocalProject {
  folder: string;
  name: string;
  /** What the vault's paths for this project start with (its name and a slash), which is not repeated inside the folder. */
  prefix: string;
  canWrite: boolean;
}

interface Persisted {
  files: Record<string, SyncedFile>;
  projects: Record<string, LocalProject>;
  lastSyncAt: number | null;
}

export interface StudioSyncOptions {
  fs: FsPort;
  port: StudioPort;
  /** The folder holding this Studio's projects on the phone. */
  root: string;
  stateFile: string;
  /** Names this phone to the vault's lock (stable, one per install). */
  machine: string;
  /** What a person would call it: "Pixel 8". Used in conflict file names and version comments. */
  device: string;
  now?: () => Date;
  /** Called with the person's own message when the Studio no longer accepts this phone (it was removed). */
  onRevoked?: (message: string) => void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const hashOf = async (text: string): Promise<string> => hex(await sha256(enc.encode(text)));
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const startsWithCI = (text: string, prefix: string) => text.toLowerCase().startsWith(prefix.toLowerCase());
const isMissing = (e: unknown) => errorCode(e) === 'ENOENT';
const isDenied = (e: unknown) => (e as { name?: string; capability?: string } | null)?.name === 'PermissionDenied' || (e as { constructor?: { name?: string } } | null)?.constructor?.name === 'PermissionDenied';

const blankStatus = (): SyncStatus => ({ connected: true, state: 'idle', lastSyncAt: null, message: null, summary: null, pendingDeletes: [], localChanges: 0, progress: null });

export class StudioSync implements SyncApi {
  private data: Persisted = { files: {}, projects: {}, lastSyncAt: null };
  private loaded = false;
  private status: SyncStatus = blankStatus();
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<SyncStatus> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lockedBy = new Map<string, string>();
  private revoked = false;

  constructor(private readonly o: StudioSyncOptions) {}

  private now = (): Date => this.o.now?.() ?? new Date();

  // ---- state on the phone ------------------------------------------------------------------------------------------------------

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await this.o.fs.readText(this.o.stateFile)) as Partial<Persisted>;
      this.data = { files: raw.files && typeof raw.files === 'object' ? raw.files : {}, projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {}, lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : null };
      this.status.lastSyncAt = this.data.lastSyncAt;
    } catch {
      /* first time, or unreadable: start from nothing; the next pass brings everything back */
    }
  }

  private async save(): Promise<void> {
    await this.o.fs.mkdir(dirOf(this.o.stateFile), { recursive: true });
    await this.o.fs.writeText(this.o.stateFile, JSON.stringify(this.data));
  }

  private projectDir(p: LocalProject): string {
    return `${this.o.root}/${p.folder}`;
  }
  private abs(e: Pick<SyncedFile, 'project' | 'rel'>): string {
    return `${this.projectDir(this.data.projects[e.project]!)}/${e.rel}`;
  }

  // ---- what the editor may do (asked before it writes) -------------------------------------------------------------------------

  /** The project folder a path inside the root belongs to, or null. */
  private projectOf(path: string): { id: string; project: LocalProject } | null {
    const p = path.replace(/\\/g, '/');
    for (const [id, project] of Object.entries(this.data.projects)) if (p === this.projectDir(project) || p.startsWith(`${this.projectDir(project)}/`)) return { id, project };
    return null;
  }

  /** Throws, in words, if the person may not change this file (or add one here). Everything else is allowed, with or without a connection. */
  assertWritable(path: string): void {
    const at = this.projectOf(path);
    if (!at) return;
    if (!at.project.canWrite) throw new Error('You can read this project, but your role in the Studio does not let you change it.');
    const holder = this.lockedBy.get(path.replace(/\\/g, '/'));
    if (holder) throw new Error(`${holder} has this file checked out. You can read it, and change it once they have checked it in.`);
  }

  // ---- the status the app shows ------------------------------------------------------------------------------------------------

  getSyncStatus = async (): Promise<SyncStatus> => this.status;
  onSyncStatus = (cb: (s: SyncStatus) => void): (() => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
  /** Signing in is joining the Studio; a pass is all there is to do here. */
  connectSync = (): Promise<SyncStatus> => this.syncNow();
  confirmDeletes = async (): Promise<SyncStatus> => this.status;
  /** Nothing to disconnect: leaving a Studio is its own action (the Studio settings). */
  disconnectSync = async (): Promise<void> => undefined;

  syncSoon(ms = 4000): void {
    if (this.revoked) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, ms);
  }

  startPolling(everyMs: number, shouldRun: () => boolean = () => true): void {
    this.stopPolling();
    this.poll = setInterval(() => shouldRun() && void this.syncNow(), everyMs);
  }
  stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass, never two at once: a request that arrives during a pass makes one more pass after it. */
  syncNow = async (): Promise<SyncStatus> => {
    await this.load();
    if (this.revoked) return this.status;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.syncSoon(500);
      }
    });
    return this.running;
  };

  private async pass(): Promise<SyncStatus> {
    const started = Date.now();
    const sum: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], skipped: [], errors: [], rootCreated: false, durationMs: 0, unsaved: [] };
    this.set({ state: 'syncing', message: null, progress: null });
    try {
      await this.run(sum);
      this.data.lastSyncAt = this.now().getTime();
      await this.save();
      sum.durationMs = Date.now() - started;
      this.set({
        state: 'idle',
        lastSyncAt: this.data.lastSyncAt,
        summary: sum,
        progress: null,
        message: sum.errors.length ? `${sum.errors.length} file${sum.errors.length === 1 ? '' : 's'} could not be synced.` : sum.conflicts.length ? 'Some files were changed in two places. Both versions were kept.' : null,
        localChanges: this.status.localChanges + (sum.downloaded + sum.conflicts.length > 0 ? 1 : 0)
      });
    } catch (e) {
      await this.save().catch(() => undefined);
      if (e instanceof StudioOfflineError) this.set({ state: 'error', progress: null, message: 'No connection. What you write is kept on this phone and is sent when you are back online.' });
      else if (e instanceof StudioApiError && (e.status === 401 || e.status === 403)) {
        this.revoked = true;
        const message = 'This Studio no longer accepts this phone. Ask its owner for a new invitation.';
        this.set({ state: 'error', progress: null, message });
        this.o.onRevoked?.(message);
      } else this.set({ state: 'error', progress: null, message: e instanceof Error ? e.message : String(e) });
    }
    return this.status;
  }

  // ---- one pass ----------------------------------------------------------------------------------------------------------------

  private async run(sum: SyncSummary): Promise<void> {
    const { port } = this.o;
    const me = await port.me();
    const [tree, listing] = await Promise.all([port.tree(), port.vault<VaultListing[]>('list')]);
    const names = new Map<string, string>();
    for (const p of await port.rpc<{ id: string; name: string }[]>(['people', 'list'], []).catch(() => [])) names.set(p.id, p.name);

    const remote = listing.filter((f) => TEXT_FILE.test(f.path));
    const nonText = listing.length - remote.length;
    if (nonText > 0) sum.skipped.push({ path: '(images and other files)', reason: `${nonText} file${nonText === 1 ? ' is' : 's are'} not text, so ${nonText === 1 ? 'it stays' : 'they stay'} on the Studio` });

    await this.syncProjects(tree, remote);
    await this.mkdir(this.o.root);

    this.lockedBy.clear();
    const seen = new Set<string>();
    let done = 0;
    const total = remote.length;
    for (const file of remote) {
      seen.add(file.id);
      this.set({ progress: { done: done++, total } });
      try {
        await this.syncFile(file, me, names, sum);
      } catch (e) {
        if (e instanceof StudioOfflineError || (e instanceof StudioApiError && (e.status === 401 || e.status === 403))) throw e;
        sum.errors.push({ path: file.path, message: isDenied(e) ? 'Your role in the Studio does not allow that.' : e instanceof Error ? e.message : String(e) });
      }
    }

    // Files that left the list (the person lost access, or the vault's file was removed): keep any unsent edit aside, then let the copy go.
    for (const e of Object.values(this.data.files)) {
      if (seen.has(e.id) || !this.data.projects[e.project]) continue;
      const abs = this.abs(e);
      if (await this.edited(e, abs).catch(() => false)) await this.rescue(abs, e);
      await this.o.fs.rm(abs, { force: true });
      delete this.data.files[e.id];
      sum.deleted++;
    }

    await this.pushNewFiles(sum);
  }

  /** Makes a folder (with the `.cadrel/project.json` Write opens it by) for every project that has text files, and finds out what the person may do in it. */
  private async syncProjects(tree: ProjectTree, remote: VaultListing[]): Promise<void> {
    const byId = new Map<string, Project>(tree.projects.map((p) => [p.id, p]));
    const groups = new Map<string, VaultListing[]>();
    for (const f of remote) groups.set(f.projectId ?? NO_PROJECT, [...(groups.get(f.projectId ?? NO_PROJECT) ?? []), f]);

    for (const [id, files] of groups) {
      const project = byId.get(id);
      // A person with a role on the whole Studio (not on a project) is not shown the project tree, but may read its files: those are named by their folder.
      const shown = id === NO_PROJECT ? 'Studio files' : project ? this.displayName(project, byId) : this.commonFolder(files) ?? 'Project';
      let local = this.data.projects[id];
      if (!local) {
        const taken = Object.values(this.data.projects).map((p) => p.folder);
        local = this.data.projects[id] = { folder: uniqueName(safeName(shown), taken), name: shown, prefix: '', canWrite: false };
      }
      local.name = shown;
      local.prefix = this.prefixFor(shown, files);
      try {
        local.canWrite = (await this.o.port.rpc<boolean>(['canAt'], ['manuscript.write', id === NO_PROJECT ? null : id])) === true;
      } catch (e) {
        if (e instanceof StudioOfflineError) throw e;
        local.canWrite = false;
      }
      await this.writeProjectFile(id, local);
    }
  }

  /** The first folder name all of a project's files share ("Book 1" for "Book 1/Draft.md" and "Book 1/Notes/A.md"), or null. */
  private commonFolder(files: VaultListing[]): string | null {
    const first = files.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : null));
    const head = first[0];
    return head && first.every((x) => x !== null && x.toLowerCase() === head.toLowerCase()) ? head : null;
  }

  /** A book is "Book 1" on the Studio and the person knows its series; two books with one name are told apart by their series. */
  private displayName(p: Project, all: Map<string, Project>): string {
    const same = [...all.values()].filter((x) => x.name === p.name && x.id !== p.id);
    const parent = p.parentId ? all.get(p.parentId) : null;
    return same.length && parent ? `${parent.name}: ${p.name}` : p.name;
  }

  /** If every path in the project starts with its name and a slash, that part is not repeated as a folder inside the project. */
  private prefixFor(name: string, files: VaultListing[]): string {
    const candidate = `${safeName(name)}/`;
    return files.length === 0 || files.every((f) => startsWithCI(f.path, candidate)) ? candidate : '';
  }

  private async writeProjectFile(id: string, p: LocalProject): Promise<void> {
    const dir = `${this.projectDir(p)}/${PROJECT_DIR}`;
    await this.mkdir(dir);
    const file = `${dir}/project.json`;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await this.o.fs.readText(file)) as Record<string, unknown>;
    } catch {
      /* new */
    }
    const next = { ...meta, version: 1, id: typeof meta.id === 'string' && meta.id ? meta.id : `studio-${id}`, name: p.name, templateId: meta.templateId ?? 'blank', templateName: meta.templateName ?? 'Studio', createdAt: meta.createdAt ?? this.now().toISOString() };
    if (JSON.stringify(next) !== JSON.stringify(meta)) await this.o.fs.writeText(file, JSON.stringify(next, null, 2));
  }

  private async mkdir(dir: string): Promise<void> {
    await this.o.fs.mkdir(dir, { recursive: true });
  }

  private relOf(local: LocalProject, path: string): string {
    return local.prefix && startsWithCI(path, local.prefix) ? path.slice(local.prefix.length) : path;
  }

  private async stat(abs: string): Promise<{ mtimeMs: number; size: number } | null> {
    const s = await this.o.fs.stat(abs);
    return s && s.isFile ? { mtimeMs: s.mtimeMs, size: s.size } : null;
  }

  /** Has the text on the phone been changed since this phone last read it from the vault? (Looks at the text only when the file's time or size moved.) */
  private async edited(e: SyncedFile, abs: string): Promise<boolean> {
    const s = await this.stat(abs);
    if (!s) return false;
    if (s.mtimeMs === e.mtimeMs && s.size === e.size) return false;
    const text = await this.o.fs.readText(abs);
    if ((await hashOf(text)) === e.base) {
      e.mtimeMs = s.mtimeMs;
      e.size = s.size;
      return false;
    }
    return true;
  }

  private async download(file: VaultListing, local: LocalProject, projectId: string, previous?: SyncedFile): Promise<SyncedFile> {
    let text = '';
    if (file.hash) {
      const bytes = await this.o.port.getBlob(file.hash);
      if (!bytes) throw new Error('The file’s contents are not on the Studio.');
      text = dec.decode(bytes);
    }
    const rel = previous?.rel ?? this.relOf(local, file.path);
    const abs = `${this.projectDir(local)}/${rel}`;
    await this.mkdir(dirOf(abs));
    await this.o.fs.writeText(abs, text);
    const back = await this.o.fs.readText(abs);
    const s = (await this.stat(abs)) ?? { mtimeMs: 0, size: 0 };
    const entry: SyncedFile = { id: file.id, path: file.path, project: projectId, rel, version: file.currentVersion, hash: file.hash ?? '', base: await hashOf(back), mtimeMs: s.mtimeMs, size: s.size };
    this.data.files[file.id] = entry;
    return entry;
  }

  private async syncFile(file: VaultListing, me: { personId: string }, names: Map<string, string>, sum: SyncSummary): Promise<void> {
    const projectId = file.projectId ?? NO_PROJECT;
    const local = this.data.projects[projectId]!;
    const e = this.data.files[file.id];

    const holder = file.lock && !(file.lock.personId === me.personId && file.lock.machine === this.o.machine) ? file.lock : null;
    const guardLock = (entry: SyncedFile) => {
      if (holder) this.lockedBy.set(this.abs(entry), names.get(holder.personId) ?? 'Someone');
    };

    if (!e) {
      const target = `${this.projectDir(local)}/${this.relOf(local, file.path)}`;
      if (await this.stat(target)) await this.keepAsConflict(target, sum); // a file of the same name made here first: it is kept as a conflict copy
      guardLock(await this.download(file, local, projectId));
      sum.downloaded++;
      return;
    }

    const abs = this.abs(e);
    if (!(await this.stat(abs))) {
      // deleted on the phone: the vault cannot delete, so the file comes back
      guardLock(await this.download(file, local, projectId, e));
      sum.downloaded++;
      return;
    }
    if (await this.edited(e, abs)) {
      if (!local.canWrite) {
        // a role that cannot change this project can never save this edit: it is kept aside and the original put back
        await this.rescue(abs, e);
        guardLock(await this.download(file, local, e.project, e));
        sum.errors.push({ path: file.path, message: 'You can read this project but not change it, so your edit was kept aside on this phone and the original restored.' });
        return;
      }
      // changed here: left exactly as it is (even if a newer version exists) until the person saves a version
      sum.unsaved!.push({ id: file.id, name: `${local.name}/${e.rel}` });
      guardLock(e);
      return;
    }
    if (file.currentVersion > e.version || file.hash !== e.hash) {
      guardLock(await this.download(file, local, projectId, e));
      sum.downloaded++;
      return;
    }
    guardLock(e);
  }

  /** Saves the phone's edit of a file as its next version, or keeps it as a conflict copy if the file has moved on or is held. */
  private async push(file: VaultListing, e: SyncedFile, abs: string, local: LocalProject, me: { personId: string }, sum: SyncSummary, comment = ''): Promise<void> {
    const text = await this.o.fs.readText(abs);
    const bytes = enc.encode(text);
    const hash = hex(await sha256(bytes));
    if (hash === file.hash) {
      // the same text as the vault's (edited back): nothing to send
      const s = (await this.stat(abs)) ?? { mtimeMs: e.mtimeMs, size: e.size };
      Object.assign(e, { version: file.currentVersion, hash, base: await hashOf(text), mtimeMs: s.mtimeMs, size: s.size });
      return;
    }
    if (!local.canWrite) {
      await this.rescue(abs, e);
      await this.download(file, local, e.project, e);
      sum.errors.push({ path: file.path, message: 'You can read this project but not change it, so your edit was kept aside on this phone and the original restored.' });
      return;
    }

    const own = !!file.lock && file.lock.personId === me.personId && file.lock.machine === this.o.machine;
    let baseVersion: number;
    if (own) baseVersion = file.lock!.baseVersion; // a lock this phone took in an earlier pass that did not finish
    else {
      const co = await this.o.port.vault<CheckOutResult>('checkOut', { fileId: file.id, machine: this.o.machine });
      if (!co.ok) return this.conflict(file, e, abs, local, sum);
      baseVersion = co.baseVersion;
    }
    const release = () => this.o.port.vault('undoCheckOut', { fileId: file.id, machine: this.o.machine }).catch(() => undefined);
    if (baseVersion !== e.version) {
      await release();
      return this.conflict(file, e, abs, local, sum);
    }
    let ci: CheckInResult;
    try {
      await this.o.port.putBlob(hash, bytes);
      ci = await this.o.port.vault<CheckInResult>('checkIn', { fileId: file.id, machine: this.o.machine, hash, size: bytes.length, comment: comment.trim() || `Saved on ${this.o.device}` });
    } catch (err) {
      await release();
      throw err;
    }
    if (!ci.ok) return this.conflict(file, e, abs, local, sum);
    const s = (await this.stat(abs)) ?? { mtimeMs: e.mtimeMs, size: e.size };
    Object.assign(e, { version: ci.version, hash, base: await hashOf(text), mtimeMs: s.mtimeMs, size: s.size });
    sum.uploaded++;
  }

  /** The phone's text goes to a file of its own beside the original (sent to the Studio as a new file in the same pass), and the original is brought back to the Studio's version. */
  private async conflict(file: VaultListing, e: SyncedFile, abs: string, local: LocalProject, sum: SyncSummary): Promise<void> {
    await this.keepAsConflict(abs, sum);
    await this.download(file, local, e.project, e);
  }

  /** Copies a file to "<name> (conflict <device> <date>)", a name nothing in its folder has. Returns the copy's path. */
  private async keepAsConflict(abs: string, sum: SyncSummary): Promise<string> {
    const dir = dirOf(abs);
    const taken = new Set((await this.o.fs.readdir(dir).catch(() => [])).map((x) => x.name.toLowerCase()));
    const first = conflictName(baseOf(abs), this.o.device, this.now());
    let name = first;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = first.replace(/(\.[^.]*)?$/, ` ${i}$1`);
    const to = `${dir}/${name}`;
    await this.o.fs.copy(abs, to);
    sum.conflicts.push(to);
    return to;
  }

  /** A copy of text the phone could not send and is about to replace, kept where the person can find it. */
  private async rescue(abs: string, e: SyncedFile): Promise<void> {
    const local = this.data.projects[e.project];
    if (!local) return;
    const dir = `${this.projectDir(local)}/${PROJECT_DIR}/unsent`;
    await this.mkdir(dir);
    await this.o.fs.copy(abs, `${dir}/${this.now().toISOString().replace(/[:.]/g, '-')} ${baseOf(abs)}`);
  }

  /** Text files in a project's folder that the vault does not have yet are added to it. */
  private async pushNewFiles(sum: SyncSummary): Promise<void> {
    const tracked = new Set(Object.values(this.data.files).map((f) => this.abs(f)));
    for (const [projectId, local] of Object.entries(this.data.projects)) {
      const dir = this.projectDir(local);
      for (const rel of await this.walk(dir, '')) {
        const abs = `${dir}/${rel}`;
        if (tracked.has(abs) || !TEXT_FILE.test(rel)) continue;
        if (!local.canWrite) {
          sum.skipped.push({ path: abs, reason: 'you can read this project but not add to it' });
          continue;
        }
        try {
          await this.addNew(projectId, local, rel, abs, sum);
        } catch (e) {
          if (e instanceof StudioOfflineError || (e instanceof StudioApiError && (e.status === 401 || e.status === 403))) throw e;
          sum.errors.push({ path: abs, message: isDenied(e) ? 'Your role in the Studio does not allow adding files here.' : e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  private async walk(dir: string, rel: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await this.o.fs.readdir(rel ? `${dir}/${rel}` : dir);
    } catch (e) {
      if (isMissing(e)) return out;
      throw e;
    }
    for (const en of entries) {
      if (en.name.startsWith('.') || en.isSymbolicLink) continue;
      const r = rel ? `${rel}/${en.name}` : en.name;
      if (en.isDirectory) out.push(...(await this.walk(dir, r)));
      else if (en.isFile) out.push(r);
    }
    return out;
  }

  private async addNew(projectId: string, local: LocalProject, rel: string, abs: string, sum: SyncSummary): Promise<void> {
    const text = await this.o.fs.readText(abs);
    const bytes = enc.encode(text);
    const hash = hex(await sha256(bytes));
    const clean = cleanVaultPath(`${local.prefix}${rel}`);
    if (!clean.ok) {
      sum.errors.push({ path: abs, message: clean.reason });
      return;
    }
    await this.o.port.putBlob(hash, bytes);
    const add = (path: string) => this.o.port.vault<AddFileResult>('addFile', { path, hash, size: bytes.length, comment: `Created on ${this.o.device}`, machine: this.o.machine, ...(projectId === NO_PROJECT ? {} : { projectId }) });
    let path = clean.path;
    let r = await add(path);
    let at = abs;
    let atRel = rel;
    if (!r.ok && r.reason === 'exists') {
      // the Studio has a file there that this phone does not have (a file this role cannot see, or one made at the same time): this one gets its own name
      const renamed = conflictName(baseOf(rel), this.o.device, this.now());
      atRel = dirOf(rel) ? `${dirOf(rel)}/${renamed}` : renamed;
      at = `${this.projectDir(local)}/${atRel}`;
      await this.o.fs.rename(abs, at);
      sum.conflicts.push(at);
      path = `${local.prefix}${atRel}`;
      r = await add(path);
    }
    if (!r.ok) {
      sum.errors.push({ path: at, message: r.reason === 'locked' ? 'That file is held by someone else.' : 'The Studio did not accept this file.' });
      return;
    }
    const s = (await this.stat(at)) ?? { mtimeMs: 0, size: 0 };
    this.data.files[r.id] = { id: r.id, path, project: projectId, rel: atRel, version: r.version, hash, base: await hashOf(text), mtimeMs: s.mtimeMs, size: s.size };
    sum.uploaded++;
  }

  // ---- what the app needs to know ----------------------------------------------------------------------------------------------

  /**
   * Saves a file's changes as a new version: the person's act, never the clock's. The Studio decides who may; with no connection this says so
   * and the change stays on the phone. `saved`: one new version; `conflict`: the file had moved on or someone holds it, so the phone's text is a
   * file of its own beside it; `unchanged`: it was changed back to what the Studio has.
   */
  saveVersion = async (fileId: string, comment = ''): Promise<{ outcome: 'saved' | 'conflict' | 'unchanged'; version: number | null }> => {
    await this.load();
    const e = this.data.files[fileId];
    if (!e || !this.data.projects[e.project]) throw new Error('That file is not on this phone.');
    while (this.running) await this.running.catch(() => undefined); // never during a pass
    const sum: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], skipped: [], errors: [], rootCreated: false, durationMs: 0 };
    const before = e.version;
    try {
      const file = (await this.o.port.vault<VaultListing[]>('list')).find((f) => f.id === fileId);
      if (!file) throw new Error('That file is no longer in the Studio, or your role cannot see it.');
      await this.push(file, e, this.abs(e), this.data.projects[e.project]!, await this.o.port.me(), sum, comment);
    } catch (err) {
      if (err instanceof StudioOfflineError) throw new Error('No connection to the Studio. Your changes are kept on this phone; save a version when you are back online.');
      throw isDenied(err) ? new Error('Your role in the Studio does not allow changing this file.') : err;
    }
    await this.save();
    void this.syncNow();
    if (sum.errors.length) throw new Error(sum.errors[0]!.message);
    if (sum.conflicts.length) return { outcome: 'conflict', version: null };
    return sum.uploaded > 0 ? { outcome: 'saved', version: this.data.files[fileId]?.version ?? null } : { outcome: 'unchanged', version: before };
  };

  /** Whether any file has been changed here and not yet saved as a version. */
  async unsentCount(): Promise<number> {
    await this.load();
    let n = 0;
    for (const e of Object.values(this.data.files)) if (this.data.projects[e.project] && (await this.edited(e, this.abs(e)).catch(() => false))) n++;
    return n;
  }
}
