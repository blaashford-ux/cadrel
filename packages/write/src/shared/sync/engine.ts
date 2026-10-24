/**
 * One sync pass between a local Root Folder and its mirror in Drive (docs/sync-rules.md). It scans both sides, asks the
 * planner what to do, and runs the actions, remembering what both sides held afterwards. It never blocks editing: files
 * are read and written one at a time, and a local file that changed since the scan is left alone until the next pass.
 */
import { makeFiles } from '../backend/files';
import type { FsPort } from '../fsPort';
import { md5Hex } from '../md5';
import { joinParts } from '../paths';
import { mergeMarks, sanitizeMarks } from '../editedMarks';
import { mergeReviewFiles, parseReviewFile, serializeReviewFile } from '../review/comments';
import { localDate, mergeProgress, sanitizeProgress } from '../progress';
import { DRIVE_ROOT_NAME, type DriveApi, type DriveFile } from './drive';
import { isCompliantPath, nameKey } from './names';
import { plan, planRemoteRenames, type LocalFile, type RemoteFile, type SyncAction } from './planner';
import { classify } from './rules';

export interface SyncState {
  version: 1;
  /** Drive folder that mirrors the Root Folder. */
  rootId: string | null;
  /** What both sides held after the last sync, by relative path. */
  files: Record<string, { id: string; md5: string }>;
  /** Folders known to both sides, by relative path → Drive id. */
  folders: Record<string, string>;
  /** Local content hashes, keyed by path, so unchanged files aren't re-read. */
  cache: Record<string, { mtimeMs: number; size: number; md5: string }>;
}

export const emptySyncState = (): SyncState => ({ version: 1, rootId: null, files: {}, folders: {}, cache: {} });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Defensive parse of the saved state; anything odd is dropped (the next pass simply re-checks those files). */
export function sanitizeSyncState(raw: unknown): SyncState {
  const out = emptySyncState();
  if (!isObj(raw)) return out;
  if (typeof raw.rootId === 'string') out.rootId = raw.rootId;
  if (isObj(raw.files)) for (const [p, v] of Object.entries(raw.files)) if (isObj(v) && typeof v.id === 'string' && typeof v.md5 === 'string') out.files[p] = { id: v.id, md5: v.md5 };
  if (isObj(raw.folders)) for (const [p, v] of Object.entries(raw.folders)) if (typeof v === 'string') out.folders[p] = v;
  if (isObj(raw.cache)) for (const [p, v] of Object.entries(raw.cache)) if (isObj(v) && typeof v.mtimeMs === 'number' && typeof v.size === 'number' && typeof v.md5 === 'string') out.cache[p] = { mtimeMs: v.mtimeMs, size: v.size, md5: v.md5 };
  return out;
}

export interface StateStore {
  load(): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
}

export interface SyncOptions {
  fs: FsPort;
  /** The local Root Folder. */
  root: string;
  drive: DriveApi;
  store: StateStore;
  /** Short device name for conflict copies, e.g. "Pixel". */
  device: string;
  now?: () => Date;
  /** Moves a local file out of the way (the app's trash). Defaults to deleting it. */
  trashLocal?: (path: string) => Promise<void>;
  /** Run the deletes even though the plan would remove a large share of the files. */
  allowDeletes?: boolean;
  includeExports?: boolean;
  /** How many files transfer at once (default 4: fast, and gentle on Drive's rate limits). */
  concurrency?: number;
  /** Called as the pass moves along, so the UI can show "120 of 400". */
  onProgress?(p: SyncProgress): void;
  /** Called whenever a file or folder on this device changed during the pass (callers should throttle what they do with it). */
  onLocalChange?(): void;
}

export interface SyncProgress {
  phase: 'scanning' | 'syncing';
  done: number;
  total: number;
}

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  renamed: number;
  /** Conflict copies made (prose both devices changed). */
  conflicts: string[];
  merged: string[];
  skipped: { path: string; reason: string }[];
  errors: { path: string; message: string }[];
  /** Files the plan wanted to delete but didn't, because that is a large share of everything: ask the user, then sync again with `allowDeletes`. */
  pendingDeletes: string[];
  /** True when any local file or folder changed, so the UI should refresh. */
  changedLocal: boolean;
  /** No `MDEdit` folder was visible in Drive, so a new one was made. On a second device this means it can't see the first device's files. */
  rootCreated: boolean;
}

const emptyReport = (): SyncReport => ({ uploaded: [], downloaded: [], deletedLocal: [], deletedRemote: [], renamed: 0, conflicts: [], merged: [], skipped: [], errors: [], pendingDeletes: [], changedLocal: false, rootCreated: false });

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const TEXT_EXT = /\.(md|markdown|json|txt|csv|html?|css|xml|ya?ml)$/i;

/** Files whose content can travel as text. Everything else (images…) isn't synced yet. */
function syncable(path: string, includeExports: boolean | undefined): boolean {
  const cls = classify(path, { includeExports });
  return cls !== null && (cls !== 'asset' || TEXT_EXT.test(path));
}

/** Runs `fn` over `items` with at most `limit` in flight. `fn` must handle its own errors. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export async function syncOnce(o: SyncOptions): Promise<SyncReport> {
  const { fs, drive } = o;
  const report = emptyReport();
  const state = await o.store.load();
  const files = makeFiles(fs);
  const full = (rel: string) => (rel === '' ? o.root : joinParts(o.root, ...rel.split('/')));
  const now = o.now ?? (() => new Date());
  const concurrency = o.concurrency ?? 4;
  const changed = () => {
    report.changedLocal = true;
    o.onLocalChange?.();
  };
  o.onProgress?.({ phase: 'scanning', done: 0, total: 0 });

  try {
    // ---- Drive side ---------------------------------------------------------------------------------------
    let all = await drive.listAll();
    let rootId = findRoot(all, state.rootId);
    if (!rootId) {
      rootId = (await drive.createFolder(DRIVE_ROOT_NAME, null)).id;
      report.rootCreated = true;
    }
    state.rootId = rootId;

    let remote = readTree(all, rootId);
    const fixes = planRemoteRenames(remote.files);
    if (fixes.length > 0) {
      await applyRemoteRenames(drive, remote, fixes, report);
      all = await drive.listAll();
      remote = readTree(all, rootId);
    }
    const remoteFiles = remote.files.filter((f) => syncable(f.path, o.includeExports));

    // ---- local side ---------------------------------------------------------------------------------------
    const local = await scanLocal(o, state, report);

    // ---- plan -----------------------------------------------------------------------------------------------
    const base = Object.entries(state.files).map(([path, v]) => ({ path, id: v.id, md5: v.md5 }));
    const p = plan({ local: local.files, remote: remoteFiles, base, device: o.device, today: localDate(now()), includeExports: o.includeExports });
    report.skipped.push(...p.skipped);
    let actions = p.actions;
    if (p.confirmDeletes && !o.allowDeletes) {
      report.pendingDeletes = actions.filter((a) => a.type === 'deleteLocal' || a.type === 'deleteRemote').map((a) => ('path' in a ? a.path : ''));
      actions = actions.filter((a) => a.type !== 'deleteLocal' && a.type !== 'deleteRemote');
    }

    // ---- run --------------------------------------------------------------------------------------------------
    const localByKey = new Map(local.files.map((f) => [nameKey(f.path), f]));
    const folderIds = new Map<string, string>([['', rootId]]);
    const folderPaths = new Map<string, string>(remote.folderPaths);
    for (const [path, id] of remote.folders) folderIds.set(path, id);
    const remoteById = new Map(all.map((f) => [f.id, f]));

    const makingFolder = new Map<string, Promise<string>>();
    /** The Drive folder for a relative path, created (once, even if many uploads ask at the same moment) if it isn't there. */
    const ensureRemoteFolder = (rel: string): Promise<string> => {
      if (rel === '') return Promise.resolve(rootId!);
      const key = nameKey(rel);
      const known = folderIds.get(key);
      if (known) return Promise.resolve(known);
      let pending = makingFolder.get(key);
      if (!pending) {
        pending = (async () => {
          const parent = await ensureRemoteFolder(dirOf(rel));
          const made = await drive.createFolder(nameOf(rel), parent);
          folderIds.set(key, made.id);
          folderPaths.set(key, rel);
          state.folders[rel] = made.id;
          return made.id;
        })().finally(() => makingFolder.delete(key));
        makingFolder.set(key, pending);
      }
      return pending;
    };
    const madeDirs = new Set<string>();
    const ensureLocalDir = async (rel: string) => {
      if (rel === '' || madeDirs.has(rel)) return;
      await fs.mkdir(full(rel), { recursive: true });
      madeDirs.add(rel);
    };
    const md5Now = async (path: string): Promise<string | null> => {
      try {
        return md5Hex(await fs.readText(full(path)));
      } catch {
        return null;
      }
    };
    /** True when the file still holds what the scan saw, so it is safe to overwrite or delete it. One `stat` unless it really changed. */
    const unchanged = async (path: string) => {
      const seen = localByKey.get(nameKey(path));
      const st = await fs.stat(full(path));
      if (!seen) return st === null; // it wasn't there at the scan: it must still not be
      if (!st) return false;
      return st.mtimeMs === seen.modifiedMs || (await md5Now(path)) === seen.md5;
    };
    const remember = (path: string, text: string, id: string) => {
      state.files[path] = { id, md5: md5Hex(text) };
    };
    const writeLocal = async (path: string, text: string) => {
      await ensureLocalDir(dirOf(path));
      const stamp = await files.writeFileAtomic(full(path), text);
      changed();
      state.cache[path] = { mtimeMs: stamp.mtimeMs, size: stamp.size, md5: md5Hex(text) }; // known, so the next scan needn't re-read it
    };

    const phase = (a: SyncAction) => (a.type === 'renameLocal' || a.type === 'renameRemote' ? 0 : a.type === 'deleteLocal' || a.type === 'deleteRemote' ? 2 : 1);
    let done = 0;
    let sinceSave = 0;
    o.onProgress?.({ phase: 'syncing', done, total: actions.length });
    for (const group of [0, 1, 2]) {
      await pool(
        actions.filter((a) => phase(a) === group),
        group === 1 ? concurrency : group === 2 ? concurrency : 1, // renames can depend on each other's folders
        async (a) => {
          try {
            await run(a);
          } catch (e) {
            report.errors.push({ path: actionPath(a), message: e instanceof Error ? e.message : String(e) });
          }
          o.onProgress?.({ phase: 'syncing', done: ++done, total: actions.length });
          // A long first sync saves its memory as it goes, so an interruption doesn't start over.
          if (++sinceSave >= 50) {
            sinceSave = 0;
            await o.store.save(state);
          }
        }
      );
    }

    async function run(a: SyncAction): Promise<void> {
      switch (a.type) {
        case 'upload': {
          const text = await fs.readText(full(a.path));
          const saved = a.id ? await drive.updateFile(a.id, text) : await drive.createFile(nameOf(a.path), await ensureRemoteFolder(dirOf(a.path)), text);
          remember(a.path, text, saved.id);
          report.uploaded.push(a.path);
          return;
        }
        case 'download': {
          if (!(await unchanged(a.path))) return skip(a.path);
          const text = await drive.download(a.id);
          await writeLocal(a.path, text);
          remember(a.path, text, a.id);
          report.downloaded.push(a.path);
          return;
        }
        case 'keepBoth': {
          if (!(await unchanged(a.path))) return skip(a.path);
          const mine = await fs.readText(full(a.path));
          const theirs = await drive.download(a.id);
          await writeLocal(a.copyPath, mine); // this device's version is safe locally before anything is overwritten
          await writeLocal(a.path, theirs);
          const copy = await drive.createFile(nameOf(a.copyPath), await ensureRemoteFolder(dirOf(a.copyPath)), mine);
          remember(a.path, theirs, a.id);
          remember(a.copyPath, mine, copy.id);
          report.conflicts.push(a.copyPath);
          return;
        }
        case 'mergeProgress': {
          if (!(await unchanged(a.path))) return skip(a.path);
          const parse = (t: string) => {
            try {
              return sanitizeProgress(JSON.parse(t));
            } catch {
              return sanitizeProgress(null);
            }
          };
          const merged = mergeProgress(parse(await fs.readText(full(a.path))), parse(await drive.download(a.id)));
          const text = JSON.stringify(merged, null, 2) + '\n';
          await writeLocal(a.path, text);
          await drive.updateFile(a.id, text);
          remember(a.path, text, a.id);
          report.merged.push(a.path);
          return;
        }
        case 'mergeMarks': {
          if (!(await unchanged(a.path))) return skip(a.path);
          const parse = (t: string) => {
            try {
              return sanitizeMarks(JSON.parse(t));
            } catch {
              return sanitizeMarks(null);
            }
          };
          const merged = mergeMarks(parse(await fs.readText(full(a.path))), parse(await drive.download(a.id)));
          const text = JSON.stringify(merged, null, 2) + '\n';
          await writeLocal(a.path, text);
          await drive.updateFile(a.id, text);
          remember(a.path, text, a.id);
          report.merged.push(a.path);
          return;
        }
        case 'mergeNotes': {
          if (!(await unchanged(a.path))) return skip(a.path);
          const mine = await fs.readText(full(a.path));
          const theirs = await drive.download(a.id);
          const a1 = parseReviewFile(mine);
          const b1 = parseReviewFile(theirs);
          // A copy that can't be read gives way to the one that can; if neither can, the other device's copy is kept.
          const text = a1 && b1 ? serializeReviewFile(mergeReviewFiles(a1, b1)) : a1 ? mine : theirs;
          await writeLocal(a.path, text);
          await drive.updateFile(a.id, text);
          remember(a.path, text, a.id);
          report.merged.push(a.path);
          return;
        }
        case 'deleteLocal': {
          if (!(await unchanged(a.path))) return skip(a.path);
          await (o.trashLocal ?? ((x) => fs.rm(x)))(full(a.path));
          delete state.files[a.path];
          delete state.cache[a.path];
          changed();
          report.deletedLocal.push(a.path);
          return;
        }
        case 'deleteRemote': {
          await drive.trash(a.id);
          delete state.files[a.path];
          report.deletedRemote.push(a.path);
          return;
        }
        case 'renameLocal': {
          if (!(await unchanged(a.from))) return skip(a.from);
          await ensureLocalDir(dirOf(a.to));
          await fs.rename(full(a.from), full(a.to));
          const entry = state.files[a.from];
          if (entry) state.files[a.to] = entry;
          delete state.files[a.from];
          delete state.cache[a.from];
          changed();
          report.renamed++;
          return;
        }
        case 'renameRemote': {
          const parent = await ensureRemoteFolder(dirOf(a.to));
          await drive.rename(a.id, nameOf(a.to), { from: remoteById.get(a.id)?.parentId ?? null, to: parent });
          const entry = state.files[a.from];
          if (entry) state.files[a.to] = entry;
          delete state.files[a.from];
          report.renamed++;
          return;
        }
        case 'markSynced':
          state.files[a.path] = { id: a.id, md5: a.md5 };
          return;
        case 'forget':
          delete state.files[a.path];
          delete state.cache[a.path];
          return;
      }
    }
    function skip(path: string) {
      report.skipped.push({ path, reason: 'It changed while syncing; it will be checked again next time.' });
    }

    // ---- folders ----------------------------------------------------------------------------------------------
    await syncFolders();

    async function syncFolders(): Promise<void> {
      const localDirs = new Set(local.dirs);
      // The scan's list is right unless this pass changed folders (a rename or delete), in which case check each one.
      if (report.changedLocal) for (const d of [...localDirs]) if (!(await fs.stat(full(d)))?.isDirectory) localDirs.delete(d);
      const localKeys = new Set([...localDirs].map(nameKey));
      const hasLocalKey = (dir: string) => localKeys.has(nameKey(dir));
      /** Any file at all counts (images, junk…): a folder is only removed when it holds no files, so nothing unsynced is lost. */
      const holdsLocalFiles = async (d: string): Promise<boolean> => {
        for (const e of await fs.readdir(full(d)).catch(() => [])) {
          const rel = d ? `${d}/${e.name}` : e.name;
          if (e.isFile || (e.isDirectory && (await holdsLocalFiles(rel)))) return true;
        }
        return false;
      };
      const gone = new Set([...report.deletedRemote, ...report.deletedLocal].map(nameKey));
      const holdsRemoteFiles = (dir: string) => remote.files.some((f) => nameKey(f.path).startsWith(nameKey(dir) + '/') && !gone.has(nameKey(f.path)));

      // Folders both sides knew about: if one side removed it, remove it from the other once it holds no files.
      // (While deletes await the user's confirmation, leave every folder as it is.)
      if (report.pendingDeletes.length === 0) {
        for (const dir of Object.keys(state.folders).sort((a, b) => b.length - a.length)) {
          const inLocal = hasLocalKey(dir);
          const inRemote = folderIds.has(nameKey(dir));
          if (!inLocal && !inRemote) {
            delete state.folders[dir];
          } else if (!inLocal && inRemote) {
            if (holdsRemoteFiles(dir)) {
              await ensureLocalDir(dir); // its files come back to this device
              changed();
            } else {
              await drive.trash(folderIds.get(nameKey(dir))!).catch((e) => report.errors.push({ path: dir, message: String(e) }));
              folderIds.delete(nameKey(dir));
              delete state.folders[dir];
            }
          } else if (inLocal && !inRemote) {
            if (await holdsLocalFiles(dir)) {
              await ensureRemoteFolder(dir);
            } else {
              await fs.rm(full(dir), { recursive: true, force: true });
              for (const m of [...madeDirs]) if (m === dir || m.startsWith(dir + '/')) madeDirs.delete(m);
              for (const d of [...localDirs]) if (d === dir || d.startsWith(dir + '/')) (localDirs.delete(d), localKeys.delete(nameKey(d)));
              delete state.folders[dir];
              changed();
            }
          }
        }
      }
      // New folders: make them on the other side and remember them.
      for (const dir of [...localDirs].sort()) {
        if (!isCompliantPath(dir)) continue;
        if (!folderIds.has(nameKey(dir))) await ensureRemoteFolder(dir);
        state.folders[dir] = folderIds.get(nameKey(dir))!;
      }
      for (const [key, id] of [...folderIds].filter(([k]) => k !== '').sort()) {
        const dir = folderPaths.get(key) ?? key;
        if (!isCompliantPath(dir) || dir.split('/').some((seg) => seg.startsWith('.') && seg !== '.mdedit')) continue;
        if (!hasLocalKey(dir) && !(await fs.stat(full(dir)))) {
          await ensureLocalDir(dir);
          changed();
        }
        state.folders[dir] = id;
      }
    }
  } finally {
    await o.store.save(state);
  }
  for (const list of [report.uploaded, report.downloaded, report.deletedLocal, report.deletedRemote, report.conflicts, report.merged]) list.sort();
  return report;
}

function actionPath(a: SyncAction): string {
  return 'path' in a ? a.path : 'from' in a ? a.from : '';
}

// ---- Drive tree -----------------------------------------------------------------------------------------------

/** The Drive folder that mirrors the Root: the remembered one if it still exists, else the oldest top-level `MDEdit` folder. */
function findRoot(all: DriveFile[], remembered: string | null): string | null {
  if (remembered && all.some((f) => f.id === remembered && f.isFolder)) return remembered;
  const ids = new Set(all.map((f) => f.id));
  const candidates = all.filter((f) => f.isFolder && f.name === DRIVE_ROOT_NAME && (f.parentId === null || !ids.has(f.parentId)));
  return candidates.sort((a, b) => a.modifiedMs - b.modifiedMs)[0]?.id ?? null;
}

interface Tree {
  files: RemoteFile[];
  /** nameKey(path) → folder id. */
  folders: Map<string, string>;
  /** nameKey(path) → the folder's path as spelled in Drive. */
  folderPaths: Map<string, string>;
  /** Drive folder id → relative path. */
  idToPath: Map<string, string>;
}

function readTree(all: DriveFile[], rootId: string): Tree {
  const byId = new Map(all.map((f) => [f.id, f]));
  const memo = new Map<string, string | null>([[rootId, '']]);
  const pathOf = (id: string, depth = 0): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    const f = byId.get(id);
    if (!f || !f.parentId || depth > 40) return null;
    const parent = pathOf(f.parentId, depth + 1);
    const p = parent === null ? null : parent === '' ? f.name : `${parent}/${f.name}`;
    memo.set(id, p);
    return p;
  };
  const tree: Tree = { files: [], folders: new Map(), folderPaths: new Map(), idToPath: new Map([[rootId, '']]) };
  for (const f of all) {
    const p = pathOf(f.id);
    if (p === null || p === '') continue;
    if (f.isFolder) {
      tree.folders.set(nameKey(p), f.id);
      tree.folderPaths.set(nameKey(p), p);
      tree.idToPath.set(f.id, p);
    } else if (f.md5) tree.files.push({ path: p, id: f.id, md5: f.md5, modifiedMs: f.modifiedMs });
  }
  return tree;
}

/** Renames files (and folders in their paths) on Drive so every name is Windows-compliant. */
async function applyRemoteRenames(drive: DriveApi, tree: Tree, fixes: { id: string; from: string; to: string }[], report: SyncReport): Promise<void> {
  const doneFolders = new Set<string>();
  for (const fix of fixes) {
    const from = fix.from.split('/');
    const to = fix.to.split('/');
    try {
      for (let i = 0; i < from.length - 1; i++) {
        if (from[i] === to[i]) continue;
        const folderPath = from.slice(0, i + 1).join('/');
        const id = tree.folders.get(nameKey(folderPath));
        if (id && !doneFolders.has(id)) {
          doneFolders.add(id);
          await drive.rename(id, to[i]);
        }
      }
      if (from[from.length - 1] !== to[to.length - 1]) await drive.rename(fix.id, to[to.length - 1]);
      report.renamed++;
    } catch (e) {
      report.errors.push({ path: fix.from, message: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ---- local tree ---------------------------------------------------------------------------------------------

async function scanLocal(o: SyncOptions, state: SyncState, report: SyncReport): Promise<{ files: LocalFile[]; dirs: string[] }> {
  const { fs } = o;
  const dirs: string[] = [];
  const cache: SyncState['cache'] = {};
  const found: { rel: string; full: string; mtimeMs: number; size: number }[] = [];

  // Walk the folders (one listing each). Size and time come with the listing where the platform provides them, so an unchanged file costs nothing.
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    const subdirs: { full: string; rel: string }[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childFull = joinParts(dir, e.name);
      if (e.isDirectory) {
        if (e.name.startsWith('.') && e.name !== '.mdedit') continue;
        dirs.push(childRel);
        subdirs.push({ full: childFull, rel: childRel });
      } else if (e.isFile) {
        if (classify(childRel, { includeExports: o.includeExports }) === null) continue;
        if (!syncable(childRel, o.includeExports)) {
          report.skipped.push({ path: childRel, reason: 'Only text files sync for now.' });
          continue;
        }
        found.push({ rel: childRel, full: childFull, mtimeMs: e.mtimeMs ?? NaN, size: e.size ?? NaN });
      }
    }
    for (const d of subdirs) await walk(d.full, d.rel);
  };
  await walk(o.root, '');

  // Hash only what changed: a file is re-read when its size or modification time differs from the last time.
  const out: LocalFile[] = [];
  await pool(found, o.concurrency ?? 4, async (f) => {
    let { mtimeMs, size } = f;
    if (Number.isNaN(mtimeMs) || Number.isNaN(size)) {
      const st = await fs.stat(f.full);
      if (!st) return;
      ({ mtimeMs, size } = st);
    }
    const cached = state.cache[f.rel];
    let md5 = cached && cached.mtimeMs === mtimeMs && cached.size === size ? cached.md5 : null;
    if (md5 === null) {
      try {
        md5 = md5Hex(await fs.readText(f.full));
      } catch {
        return;
      }
    }
    cache[f.rel] = { mtimeMs, size, md5 };
    out.push({ path: f.rel, md5, modifiedMs: mtimeMs });
  });
  state.cache = cache;
  return { files: out, dirs };
}
