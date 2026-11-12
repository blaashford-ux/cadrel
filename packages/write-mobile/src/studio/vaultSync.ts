/**
 * Keeps a Studio's project files on the phone in step with the Studio's vault.
 *
 * The vault is check-out / check-in: one person holds a file at a time, and every check-in is a new version. The phone works with it the same way
 * the computer does: **check a file out, edit it, check it in**. Only a check-in makes a version; nothing local is ever versioned.
 *
 *  - A project the person may see is a folder in the app's own storage, with the vault's text files (Markdown, plain text, Fountain) in it. The
 *    folder has the `.cadrel/project.json` Write expects, so the editor opens it like any project of its own.
 *  - A file nobody has checked out is read-only here: the editor refuses before anything is typed (`assertWritable`). Checking it out
 *    (`checkOut`) takes the Studio's lock for this phone; editing then works, also with no connection; checking it in (`checkIn`) makes the version
 *    and gives the lock back. A file held on the computer (or by someone else) can be read, and changed once they have checked it in.
 *  - A pass (when there is a connection, soon after an edit, when the app comes to the front, and every minute while it is open) brings in new
 *    versions and adds new files (a file made here stays checked out to the person who made it). It never touches a file this phone has checked
 *    out, and never makes a version of anything.
 *  - A file changed here with no check-out (only possible from an older version of this app) is left exactly as it is and listed; the person can
 *    check it out keeping the changes.
 *  - **Notes** (`.cadrel/review/*.json`) travel with the project's files but are not checked out: they are merged with the Studio's copy (each
 *    note by its id, the newer wins, replies united) and saved at most every couple of minutes, so notes made on the phone and on the computer
 *    both end up on both.
 *  - New files in a project are added to the vault. The vault cannot rename or delete, so neither can the phone.
 *  - What the person may do is decided by the Studio's server on every call; the phone also asks up front (`canAt`) so it can say so in words.
 *
 * Images and other non-text files are not brought to the phone: its storage and editor work with text.
 */
import { cleanVaultPath, hex, sha256, type CheckInResult, type CheckOutResult, type AddFileResult, type Project, type ProjectTree, type VaultListing } from '@cadrel/kernel';
import { StudioApiError, StudioOfflineError } from '@cadrel/studio-client';
import type { FileLock, FileLockApi, SyncApi, SyncStatus, SyncSummary } from '@cadrel/write/src/shared/api';
import { mergeReviewText } from '@cadrel/write/src/shared/review/comments';
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
  /** The Studio's change counters (two rows on its server). Without it every look is a full pass. */
  version?(): Promise<{ data: string }>;
}

/** The files the phone edits: text. The vault may hold more; those stay on the Studio. */
export const TEXT_FILE = /\.(md|markdown|txt|fountain)$/i;
/** A project's notes: not a file to check out, but kept in step by merging. */
export const NOTES_FILE = /(^|\/)\.cadrel\/review\/[^/]+\.json$/i;
/** The least time between two saves of the same notes file, so a flurry of notes is one version. */
const NOTES_EVERY_MS = 2 * 60_000;
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
  /** This phone has the file checked out (it holds the Studio's lock): it can be edited, also with no connection, until it is checked in. */
  held?: boolean;
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
  /** The Studio's change counter as it was before the last clean pass: while it is still that, a pass would find nothing new on the Studio. */
  private seenVersion: string | null = null;
  /** Who has each file, as the last pass saw it: what the editor and the check-out button say. */
  private views = new Map<string, { mine: boolean; by: string | null; since: string | null; version: number }>();
  private notesPushedAt = new Map<string, number>();
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

  /** The file this path is, if the phone has it from the Studio. */
  private fileAtPath(path: string): SyncedFile | null {
    const p = path.replace(/\\/g, '/');
    return Object.values(this.data.files).find((e) => this.data.projects[e.project] && this.abs(e) === p) ?? null;
  }

  /** Throws, in words, if the person may not change this file (or add one here). Everything else is allowed, with or without a connection. */
  assertWritable(path: string): void {
    const at = this.projectOf(path);
    if (!at) return;
    if (!at.project.canWrite) throw new Error('You can read this project, but your role in the Studio does not let you change it.');
    const e = this.fileAtPath(path);
    if (!e || NOTES_FILE.test(e.rel)) return; // a file not made yet, or notes: written as usual
    if (e.held || this.views.get(e.id)?.mine) return;
    const by = this.views.get(e.id)?.by;
    throw new Error(by ? `${by} has this file checked out. You can read it, and change it once they have checked it in.` : 'This file is checked in. Check it out to edit it.');
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
    // Only to hear about changes made elsewhere: what is done here starts a pass by itself (syncSoon), so a look that finds the Studio's counter
    // unchanged costs two rows instead of a pass that lists the whole vault and asks for people and projects as well.
    this.poll = setInterval(() => {
      if (shouldRun()) void this.look();
    }, everyMs);
  }
  private async look(): Promise<void> {
    if (this.running || this.revoked) return;
    const v = await this.o.port.version?.().then((x) => x.data, () => null);
    if (v != null && v === this.seenVersion) return;
    await this.syncNow();
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
    const sum: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], skipped: [], errors: [], rootCreated: false, durationMs: 0, checkedOut: [], unprotected: [] };
    this.set({ state: 'syncing', message: null, progress: null });
    const before = (await this.o.port.version?.().then((x) => x.data, () => null)) ?? null; // read first: a change that lands during the pass is seen at the next look
    this.seenVersion = null;
    try {
      await this.run(sum);
      if (!sum.errors.length) this.seenVersion = before;
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

    const remote = listing.filter((f) => TEXT_FILE.test(f.path) || NOTES_FILE.test(f.path));
    const nonText = listing.length - remote.length;
    if (nonText > 0) sum.skipped.push({ path: '(images and other files)', reason: `${nonText} file${nonText === 1 ? ' is' : 's are'} not text, so ${nonText === 1 ? 'it stays' : 'they stay'} on the Studio` });

    await this.syncProjects(tree, remote);
    await this.mkdir(this.o.root);

    this.views.clear();
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

    // who has it: this phone (it holds the lock), someone else, or nobody
    const mine = !!file.lock && file.lock.personId === me.personId && file.lock.machine === this.o.machine;
    const holder = file.lock && !mine ? file.lock : null;
    this.views.set(file.id, { mine, by: holder ? (holder.personId === me.personId ? 'you, on another device' : names.get(holder.personId) ?? 'someone') : null, since: file.lock?.since ?? null, version: file.currentVersion });
    if (e && !!e.held !== mine) e.held = mine; // the Studio's word: a lock taken here is kept, one taken away (released by an administrator) is gone

    if (!e) {
      const target = `${this.projectDir(local)}/${this.relOf(local, file.path)}`;
      if (await this.stat(target)) await this.keepAsConflict(target, sum); // a file of the same name made here first: it is kept as a conflict copy
      await this.download(file, local, projectId);
      sum.downloaded++;
      return;
    }

    const abs = this.abs(e);
    if (!(await this.stat(abs))) {
      // deleted on the phone: the vault cannot delete, so the file comes back
      await this.download(file, local, projectId, e);
      sum.downloaded++;
      return;
    }
    const edited = await this.edited(e, abs);
    if (NOTES_FILE.test(e.rel)) {
      if (edited) await this.syncNotes(file, e, abs, local, me, sum);
      else if (file.currentVersion > e.version || file.hash !== e.hash) {
        await this.download(file, local, projectId, e);
        sum.downloaded++;
      }
      return;
    }
    if (mine) {
      // this phone has it checked out: what is in it is the person's, whatever the Studio has
      sum.checkedOut!.push({ id: file.id, name: `${local.name}/${e.rel}`, path: abs, changed: edited });
      return;
    }
    if (edited) {
      if (!local.canWrite) {
        // a role that cannot change this project can never save this edit: it is kept aside and the original put back
        await this.rescue(abs, e);
        await this.download(file, local, e.project, e);
        sum.errors.push({ path: file.path, message: 'You can read this project but not change it, so your edit was kept aside on this phone and the original restored.' });
        return;
      }
      // changed here with no check-out: left exactly as it is, even if a newer version exists; never versioned, never overwritten
      sum.unprotected!.push({ id: file.id, name: `${local.name}/${e.rel}`, path: abs });
      return;
    }
    if (file.currentVersion > e.version || file.hash !== e.hash) {
      await this.download(file, local, projectId, e);
      sum.downloaded++;
    }
  }

  /**
   * Notes changed here. If the Studio has a newer copy (notes made on the computer) the two are merged first, so neither side's notes are lost; the
   * merged file is then saved as the next version, at most every couple of minutes. Not notes after all (unreadable): both are kept.
   */
  private async syncNotes(file: VaultListing, e: SyncedFile, abs: string, local: LocalProject, me: { personId: string }, sum: SyncSummary): Promise<void> {
    const behind = file.currentVersion > e.version;
    if (!behind && this.now().getTime() - (this.notesPushedAt.get(file.id) ?? 0) < NOTES_EVERY_MS) return;
    if (behind) {
      const bytes = file.hash ? await this.o.port.getBlob(file.hash) : null;
      const remoteText = bytes ? dec.decode(bytes) : '';
      const merged = mergeReviewText(await this.o.fs.readText(abs), remoteText);
      if (merged === null) return this.conflict(file, e, abs, local, sum);
      await this.o.fs.writeText(abs, merged);
      // the merged copy is a change on top of the Studio's newest notes
      Object.assign(e, { version: file.currentVersion, hash: file.hash ?? '', base: await hashOf(remoteText) });
    }
    await this.push(file, e, abs, local, me, sum, 'Notes');
    this.notesPushedAt.set(file.id, this.now().getTime());
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
      for (const rel of [...(await this.walk(dir, '')), ...(await this.noteFiles(dir))]) {
        const abs = `${dir}/${rel}`;
        if (tracked.has(abs) || !(TEXT_FILE.test(rel) || NOTES_FILE.test(rel))) continue;
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

  /** The project's notes files (`.cadrel/review/*.json`), which `walk` does not look at (it skips the project's own hidden folders). */
  private async noteFiles(dir: string): Promise<string[]> {
    const names = await this.o.fs.readdir(`${dir}/.cadrel/review`).catch(() => []);
    return names.filter((n) => n.isFile && /\.json$/i.test(n.name)).map((n) => `.cadrel/review/${n.name}`);
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
    const entry: SyncedFile = { id: r.id, path, project: projectId, rel: atRel, version: r.version, hash, base: await hashOf(text), mtimeMs: s.mtimeMs, size: s.size };
    this.data.files[r.id] = entry;
    sum.uploaded++;
    // a file made here stays checked out to its author, who goes on writing in it; notes are never checked out
    if (!NOTES_FILE.test(atRel)) {
      const co = await this.o.port.vault<CheckOutResult>('checkOut', { fileId: r.id, machine: this.o.machine }).catch(() => null);
      if (co?.ok) {
        entry.held = true;
        this.views.set(r.id, { mine: true, by: null, since: this.now().toISOString(), version: r.version });
      }
    }
  }

  // ---- what the app needs to know ----------------------------------------------------------------------------------------------

  // ---- check out, edit, check in ---------------------------------------------------------------------------------------------

  /** What the editor shows for a file: checked in (read-only), checked out by this phone, or someone else's. Files the Studio does not have are written as usual. */
  private async lockOf(e: SyncedFile): Promise<FileLock> {
    if (NOTES_FILE.test(e.rel)) return { kind: 'unmanaged' };
    const v = this.views.get(e.id);
    const edited = await this.edited(e, this.abs(e)).catch(() => false);
    if (e.held || v?.mine) return { kind: 'mine', version: e.version, since: v?.since ?? '', changed: edited };
    if (v?.by) return { kind: 'other', version: v.version, by: v.by, since: v.since ?? '' };
    if (edited) return { kind: 'unprotected', version: e.version };
    return { kind: 'free', version: e.version };
  }

  private known(path: string): SyncedFile {
    const e = this.fileAtPath(path);
    if (!e) throw new Error('That file is not one of the Studio’s files on this phone.');
    return e;
  }

  /** What the Studio says about one file right now. A phone with no connection says so in words: check-out and check-in need one. */
  private async listed(e: SyncedFile): Promise<VaultListing> {
    try {
      const file = (await this.o.port.vault<VaultListing[]>('list')).find((f) => f.id === e.id);
      if (!file) throw new Error('That file is no longer in the Studio, or your role cannot see it.');
      return file;
    } catch (err) {
      if (err instanceof StudioOfflineError) throw new Error('No connection to the Studio. Check-out and check-in need one; what you have checked out can still be edited.');
      throw err;
    }
  }

  /**
   * Takes the file to edit it: the Studio's lock is taken for this phone, and the newest version is the one to start from. With `keepChanges`, a
   * file that was changed here with no check-out is taken as it is, if it is still based on the newest version.
   */
  private checkOutFile = async (path: string, o: { keepChanges?: boolean } = {}): Promise<FileLock> => {
    await this.load();
    const e = this.known(path);
    const local = this.data.projects[e.project]!;
    if (!local.canWrite) throw new Error('You can read this project, but your role in the Studio does not let you change it.');
    const before = await this.listed(e);
    const me = await this.o.port.me();
    if (before.lock && !(before.lock.personId === me.personId && before.lock.machine === this.o.machine)) {
      const by = before.lock.personId === me.personId ? 'you, on another device' : 'someone else';
      throw new Error(`${by[0]!.toUpperCase()}${by.slice(1)} has this file checked out. You can read it, and change it once it has been checked in.`);
    }
    const edited = await this.edited(e, this.abs(e));
    if (edited && !o.keepChanges) throw new Error('This copy was changed without checking it out, so it is left as it is. Check it out keeping your changes, or ask for the Studio’s version to be fetched again.');
    const release = () => this.o.port.vault('undoCheckOut', { fileId: e.id, machine: this.o.machine }).catch(() => undefined);
    const co = await this.o.port.vault<CheckOutResult>('checkOut', { fileId: e.id, machine: this.o.machine });
    if (!co.ok) throw new Error('Someone has just checked this file out. Try again when they have checked it in.');
    if (edited && co.baseVersion !== e.version) {
      await release();
      throw new Error('A newer version was saved since this copy was taken, so your changes cannot be checked out onto it. They are kept as they are.');
    }
    if (!edited) {
      const now = (await this.listed(e)) ?? before; // the lock is ours: nobody can change the file now, so this is the version to start from
      if (now.currentVersion !== e.version || now.hash !== e.hash) await this.download(now, local, e.project, e);
    }
    e.held = true;
    this.views.set(e.id, { mine: true, by: null, since: this.now().toISOString(), version: co.baseVersion });
    await this.save();
    return this.lockOf(e);
  };

  /** Saves what is in the file as a new version and gives the lock back. Nothing changed: the lock is given back and no version is made. */
  private checkInFile = async (path: string, comment = ''): Promise<FileLock> => {
    await this.load();
    const e = this.known(path);
    const file = await this.listed(e);
    const me = await this.o.port.me();
    if (!file.lock || file.lock.personId !== me.personId || file.lock.machine !== this.o.machine) {
      e.held = false;
      throw new Error('You do not have this file checked out here, so there is nothing to check in.');
    }
    const abs = this.abs(e);
    const text = await this.o.fs.readText(abs);
    const bytes = enc.encode(text);
    const hash = hex(await sha256(bytes));
    try {
      if (hash === file.hash) {
        await this.o.port.vault('undoCheckOut', { fileId: e.id, machine: this.o.machine });
      } else {
        await this.o.port.putBlob(hash, bytes);
        const ci = await this.o.port.vault<CheckInResult>('checkIn', { fileId: e.id, machine: this.o.machine, hash, size: bytes.length, comment: comment.trim() || `Checked in from ${this.o.device}` });
        if (!ci.ok) throw new Error('Your check-out was taken away, so this was not saved to the Studio. Your copy is kept on this phone.');
        const s = (await this.stat(abs)) ?? { mtimeMs: e.mtimeMs, size: e.size };
        Object.assign(e, { version: ci.version, hash, base: await hashOf(text), mtimeMs: s.mtimeMs, size: s.size });
      }
    } catch (err) {
      if (err instanceof StudioOfflineError) throw new Error('No connection to the Studio, so nothing was checked in. The file stays checked out here and can still be edited.');
      throw isDenied(err) ? new Error('Your role in the Studio does not allow changing this file.') : err;
    }
    e.held = false;
    this.views.set(e.id, { mine: false, by: null, since: null, version: e.version });
    await this.save();
    void this.syncNow();
    return this.lockOf(e);
  };

  /** Gives the lock back without a new version; this phone's copy goes back to the newest version. */
  private undoCheckOutFile = async (path: string): Promise<FileLock> => {
    await this.load();
    const e = this.known(path);
    const file = await this.listed(e);
    await this.o.port.vault('undoCheckOut', { fileId: e.id, machine: this.o.machine });
    await this.download(file, this.data.projects[e.project]!, e.project, e);
    e.held = false;
    this.views.set(e.id, { mine: false, by: null, since: null, version: file.currentVersion });
    await this.save();
    return this.lockOf(e);
  };

  /** What the editor's Check out / Check in buttons use. */
  readonly fileLock: FileLockApi = {
    state: async (path) => {
      await this.load();
      const e = this.fileAtPath(path);
      return e ? this.lockOf(e) : { kind: 'unmanaged' };
    },
    checkOut: (path, o) => this.checkOutFile(path, o),
    checkIn: (path, comment) => this.checkInFile(path, comment),
    undoCheckOut: (path) => this.undoCheckOutFile(path)
  };

  /** How many files are changed here: the ones this phone has checked out, and any changed without a check-out. */
  async unsentCount(): Promise<number> {
    await this.load();
    let n = 0;
    for (const e of Object.values(this.data.files)) if (this.data.projects[e.project] && (await this.edited(e, this.abs(e)).catch(() => false))) n++;
    return n;
  }
}
