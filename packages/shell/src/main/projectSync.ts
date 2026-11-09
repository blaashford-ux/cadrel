/**
 * Keeps the projects folder and the Studio's vault the same thing. The vault's working folder IS the Projects folder, so nothing is "added to
 * the vault" by hand and no file is kept in two places. How a file is changed is the classic way: **check it out, edit it, check it in**, and only a
 * check-in makes a version. Nothing local is ever versioned.
 *
 *  - A new file in a project's folder is added to the vault (with its project, so a role on one book sees that book's files) and stays checked out
 *    to its author, who goes on writing in it; their first check-in is its next version.
 *  - A file nobody has checked out is read-only on this computer. A newer version saved elsewhere (another computer, the phone) is brought in;
 *    files this computer lacks are fetched.
 *  - A file changed in the folder without a check-out (something got round the read-only) is left exactly as it is and listed; the person can
 *    check it out keeping their changes, or discard them. It is never overwritten and never versioned.
 *  - A file somebody has checked out is left alone, and said so.
 *  - **Notes** (`<project>/.cadrel/review/*.json`) travel with the project's files but are not checked out: they are always writable and are kept in
 *    step by merging (each note by its id, the newer wins, replies united, deletions kept), so notes made on the phone and on the computer both
 *    end up on both. They are saved at most every couple of minutes, so they do not fill a file's history.
 *
 * It looks at the folder every few seconds with nothing but file sizes and times (no network), and only does a full pass, which asks the
 * Studio's server, when something changed, when the window gets focus, and every few minutes to hear about changes made elsewhere.
 * Electron-free: tested in test/projectSync.test.ts.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { LocalVault } from '@cadrel/store';
import { mergeReviewText } from '@cadrel/write/src/shared/review/comments';

/** Too large for the Studio's file store (the Worker accepts 95 MB); left alone and listed. */
export const MAX_FILE_BYTES = 95 * 1024 * 1024;
const NEVER_NAMES = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;
const NEVER_EXT = /\.(tmp|temp|bak|swp|crdownload|part|lock)$|~$/i;
const NEVER_FOLDERS = new Set(['exports', 'export', 'trash', 'node_modules']);
/** The least time between two saves of the same notes file, so notes made in a flurry are one version, not twenty. */
const NOTES_EVERY_MS = 2 * 60_000;

/** A project's notes file: where Write keeps what each reviewer (the author, an AI, a beta reader) has noted on its chapters. */
export const isNotesFile = (rel: string): boolean => /(^|\/)\.cadrel\/review\/[^/]+\.json$/i.test(rel);
/** The folders on the way to a notes file. */
const isNotesDir = (rel: string): boolean => /(^|\/)\.cadrel(\/review)?$/i.test(rel);

/** Whether a path (relative to the Projects folder, "/" separated) is Cadrel's, a tool's or a program's scratch rather than the person's file. */
export function neverTracked(rel: string): boolean {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (NEVER_NAMES.test(name) || NEVER_EXT.test(name) || name.startsWith('~$') || name.startsWith('.~')) return true;
  return parts.some((p, i) => p.startsWith('.') || (i < parts.length - 1 && NEVER_FOLDERS.has(p.toLowerCase())));
}

/** What the vault is not to look at when it walks the folder: everything `neverTracked` says, except the way to a project's notes and the notes. */
export const vaultIgnores = (rel: string): boolean => (isNotesFile(rel) || isNotesDir(rel) ? false : neverTracked(rel));

export interface SyncSummary {
  added: number;
  received: number;
  /** Files changed in the folder without a check-out: left exactly as they are until the person checks them out (keeping the changes) or discards them. */
  unprotected: string[];
  /** Notes files merged with a newer copy from elsewhere. */
  notesMerged: number;
  conflicts: { path: string; savedAs: string }[];
  /** Files somebody has checked out, whose changes here wait. */
  held: string[];
  tooLarge: string[];
  errors: { path: string; message: string }[];
}

export interface SyncStatus {
  /** `off`: this Studio's files are not available here; `offline`: the Studio's server cannot be reached (what is written is kept and sent later). */
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error';
  lastAt: number | null;
  message: string | null;
  summary: SyncSummary | null;
}

export interface ProjectSyncOptions {
  vault(): LocalVault | null;
  /** The Projects folder. */
  dir: string;
  /** The folders that are projects: folder name (any case) → the project it is linked to, or null for a folder no project owns yet. */
  projects(): Promise<Map<string, string | null>>;
  /** The Studio's server cannot be reached right now. */
  offline?(): boolean;
  now?(): number;
  /** Told whenever the status changes. */
  onStatus?(s: SyncStatus): void;
}

const empty = (): SyncSummary => ({ added: 0, received: 0, unprotected: [], notesMerged: 0, conflicts: [], held: [], tooLarge: [], errors: [] });

export class ProjectSync {
  private status: SyncStatus = { state: 'idle', lastAt: null, message: null, summary: null };
  private running: Promise<SyncStatus> | null = null;
  private again = false;
  private snapshot = new Map<string, string>();
  private lastFull = 0;
  private timer: NodeJS.Timeout | null = null;
  private notesSavedAt = new Map<string, number>();

  constructor(private readonly o: ProjectSyncOptions) {}

  current(): SyncStatus {
    return this.status;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.o.onStatus?.(this.status);
  }

  /**
   * Starts watching: a quick look every `lookMs`, a full pass when it sees a change, and one at least every `fullMs` to hear about changes made
   * elsewhere. The first pass is now.
   */
  start(o: { lookMs?: number; fullMs?: number } = {}): void {
    this.stop();
    const look = o.lookMs ?? 15_000;
    const full = o.fullMs ?? 3 * 60_000;
    void this.sync();
    this.timer = setInterval(() => {
      void (async () => {
        if (this.running) return;
        if (this.now() - this.lastFull >= full || (await this.changed())) await this.sync();
      })();
    }, look);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One full pass now (or after the one in progress, which may have missed what was just written). */
  sync(): Promise<SyncStatus> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        const total = empty();
        let passes = 0;
        do {
          this.again = false;
          await this.pass(total);
        } while (this.again && ++passes < 3);
      } finally {
        this.running = null;
      }
      return this.status;
    })();
    return this.running;
  }

  // ---- the quick look ------------------------------------------------------------------------------------------------------

  /** The files in project folders (notes included) with their size and time, with nothing read. */
  private async scan(folders: Set<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (rel: string): Promise<void> => {
      const entries = await fsp.readdir(path.join(this.o.dir, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (rel === '' && !folders.has(e.name.toLowerCase())) continue; // only the projects' folders
        if (vaultIgnores(r)) continue;
        if (e.isDirectory()) await walk(r);
        else if (e.isFile()) {
          const s = await fsp.stat(path.join(this.o.dir, r)).catch(() => null);
          if (s) out.set(r, `${s.mtimeMs}:${s.size}`);
        }
      }
    };
    await walk('');
    return out;
  }

  private async changed(): Promise<boolean> {
    try {
      const now = await this.scan(new Set([...(await this.o.projects()).keys()].map((k) => k.toLowerCase())));
      if (now.size !== this.snapshot.size) return true;
      for (const [k, v] of now) if (this.snapshot.get(k) !== v) return true;
      return false;
    } catch {
      return false;
    }
  }

  // ---- a full pass ---------------------------------------------------------------------------------------------------------

  private async pass(total: SyncSummary): Promise<void> {
    const vault = this.o.vault();
    if (!vault) {
      this.set({ state: 'off', message: 'This Studio’s files are kept by its owner.', summary: null });
      this.lastFull = 0; // not ready yet (a Studio only joined opens its server a moment after start): look again at the next quick look
      return;
    }
    this.set({ state: 'syncing', message: null });
    const sum = total;
    try {
      const projects = await this.o.projects();
      const byFolder = new Map([...projects].map(([k, v]) => [k.toLowerCase(), v]));
      const entries = await vault.list();
      const protect: string[] = [];
      let missing = 0;
      for (const e of entries) {
        const folder = e.path.split('/')[0]!.toLowerCase();
        const notes = isNotesFile(e.path);
        try {
          if (e.status === 'untracked') {
            // only a file inside a project's folder is the Studio's business; anything loose in the Projects folder stays the person's
            if (e.path.includes('/') && byFolder.has(folder) && (notes || !neverTracked(e.path))) {
              if ((e.size ?? 0) > MAX_FILE_BYTES) sum.tooLarge.push(e.path);
              else {
                await vault.add(e.path, notes ? 'Notes' : 'Added automatically', byFolder.get(folder) ?? null);
                // a file made here stays checked out to its author, who goes on writing in it; notes are never checked out
                if (!notes) await vault.checkOut(e.path);
                sum.added++;
              }
            }
          } else if (e.status === 'modified-unprotected') {
            if (notes) await this.mergeNotes(vault, e.path, e.localVersion, e.version, sum);
            else sum.unprotected.push(e.path); // never versioned, never overwritten
          } else if (e.status === 'out-of-date') {
            const r = await vault.getLatest([e.path]);
            sum.received += r.updated.length;
          } else if (e.status === 'latest') {
            if (!notes) protect.push(e.path);
          } else if (e.status === 'checked-out-by-other' && e.modified) {
            sum.held.push(e.path);
          } else if (e.status === 'not-local') missing++;
        } catch (err) {
          if (this.o.offline?.() || (err as Error)?.name === 'StudioOfflineError') throw err;
          sum.errors.push({ path: e.path, message: (err as Error)?.message ?? String(err) });
        }
      }
      if (missing > 0) sum.received += (await vault.getLatest(undefined, { fetchMissing: true })).updated.length;
      await vault.protect(protect);
      this.lastFull = this.now();
      this.snapshot = await this.scan(new Set([...byFolder.keys()]));
      const away = this.o.offline?.() === true;
      this.set({
        state: away ? 'offline' : sum.errors.length ? 'error' : 'idle',
        lastAt: this.now(),
        summary: sum,
        message: away ? 'No connection to the Studio. What you write is kept here and saved when it is back.' : sum.errors.length ? `${sum.errors.length} file${sum.errors.length === 1 ? '' : 's'} could not be saved.` : null
      });
    } catch (e) {
      this.lastFull = this.now();
      if (this.o.offline?.() || (e as Error)?.name === 'StudioOfflineError') this.set({ state: 'offline', summary: sum, message: 'No connection to the Studio. What you write is kept here and saved when it is back.' });
      else this.set({ state: 'error', summary: sum, message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * A notes file changed here. If nobody saved a newer one, it is saved as the next version (at most every couple of minutes). If a newer one
   * exists (notes made on the phone), the two are merged first, so neither side's notes are lost, and the merged file is what is saved.
   */
  private async mergeNotes(vault: LocalVault, rel: string, localVersion: number | null, version: number | null, sum: SyncSummary): Promise<void> {
    const behind = localVersion !== null && version !== null && localVersion < version;
    if (!behind && this.now() - (this.notesSavedAt.get(rel) ?? 0) < NOTES_EVERY_MS) return; // soon: a flurry of notes is one version
    if (behind) {
      const local = await fsp.readFile(path.join(this.o.dir, ...rel.split('/')), 'utf8').catch(() => '');
      const remote = new TextDecoder().decode(await vault.read(rel));
      const merged = mergeReviewText(local, remote);
      if (merged === null) {
        const r = await vault.saveChanges(rel, 'Notes'); // not notes files after all: both are kept as for any file
        if (r.outcome === 'conflict') sum.conflicts.push({ path: rel, savedAs: r.savedAs! });
        return;
      }
      await fsp.writeFile(path.join(this.o.dir, ...rel.split('/')), merged);
      await vault.adoptCurrent(rel);
      sum.notesMerged++;
    }
    const r = await vault.saveChanges(rel, 'Notes');
    if (r.outcome === 'saved') this.notesSavedAt.set(rel, this.now());
    else if (r.outcome === 'conflict') sum.conflicts.push({ path: rel, savedAs: r.savedAs! });
    else if (r.outcome === 'held') sum.held.push(rel);
  }
}
