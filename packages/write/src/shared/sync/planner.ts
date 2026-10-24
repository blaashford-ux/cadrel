/**
 * The sync planner: given what is on this device, what is on Drive, and what was true at the last successful sync,
 * decide what to do. Pure (no I/O, no clock, no randomness), so every rule in docs/sync-rules.md is unit-tested.
 * The executor runs the actions in order and records the new base state after each one succeeds.
 *
 * Content identity is the MD5 of the file's bytes, which is also what Drive reports as `md5Checksum`. Bytes are synced
 * untouched (line endings included), so equal MD5s mean equal files and touching a file never creates a conflict.
 */
import { classify, MAX_REL_PATH, type FileClass } from './rules';
import { conflictCopyName, isCompliantPath, nameKey, toCompliantPath, uniqueCompliantName } from './names';

export interface LocalFile { path: string; md5: string; modifiedMs: number }
export interface RemoteFile { path: string; id: string; md5: string; modifiedMs: number }
/** What both sides held after the last sync of this file. */
export interface BaseFile { path: string; id: string; md5: string }

export type SyncAction =
  /** Send the local file to Drive. `id` is null when the file is new on Drive. */
  | { type: 'upload'; path: string; id: string | null }
  | { type: 'download'; path: string; id: string }
  | { type: 'deleteLocal'; path: string }
  | { type: 'deleteRemote'; path: string; id: string }
  | { type: 'renameLocal'; from: string; to: string }
  | { type: 'renameRemote'; id: string; from: string; to: string }
  /** Both sides changed prose: Drive's version takes `path`, this device's version is kept as `copyPath` and uploaded as a new file. */
  | { type: 'keepBoth'; path: string; id: string; copyPath: string }
  /** Both sides changed a progress file: download, merge per day, write locally, upload the merge. */
  | { type: 'mergeProgress'; path: string; id: string }
  /** Both sides changed the edited-chapter marks: download, merge chapter by chapter, write locally, upload the merge. */
  | { type: 'mergeMarks'; path: string; id: string }
  /** Both sides changed a reviewer's notes file: download, merge note by note, write locally, upload the merge. */
  | { type: 'mergeNotes'; path: string; id: string }
  /** Both sides already hold identical bytes: just remember that. */
  | { type: 'markSynced'; path: string; id: string; md5: string }
  /** The file is gone from both sides: drop it from the base state. */
  | { type: 'forget'; path: string };

export interface PlanInput {
  local: LocalFile[];
  remote: RemoteFile[];
  base: BaseFile[];
  /** Short device name for conflict copies, e.g. "Pixel". */
  device: string;
  /** Today's local date, YYYY-MM-DD, for conflict copies. */
  today: string;
  includeExports?: boolean;
}

export interface Plan {
  actions: SyncAction[];
  /** Files the planner will not touch, with the reason (shown to the user). */
  skipped: { path: string; reason: string }[];
  /**
   * True when the plan deletes a large share of the files (an unmounted drive or emptied Drive folder looks exactly
   * like this). The executor must ask before running the deletes.
   */
  confirmDeletes: boolean;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const RANK: Record<SyncAction['type'], number> = {
  renameLocal: 0, renameRemote: 1, keepBoth: 2, mergeProgress: 3, mergeMarks: 3, mergeNotes: 3, download: 4, upload: 5, markSynced: 6, forget: 7, deleteLocal: 8, deleteRemote: 9,
};
const actionPath = (a: SyncAction) => ('path' in a ? a.path : 'from' in a ? a.from : '');

// ---- names that arrive from Drive ------------------------------------------------------------------

/**
 * Renames needed so every remote path is Windows-compliant and unique (case-insensitively, per folder).
 * `from`/`to` are full paths; when only a folder segment changes, the executor renames that folder on Drive.
 * The first file to claim a name keeps it; later ones (oldest first) get " 2", " 3"…
 */
export function planRemoteRenames(remote: readonly RemoteFile[]): { id: string; from: string; to: string }[] {
  const taken = new Map<string, string[]>();
  const claim = (path: string) => { const d = dirOf(path); (taken.get(d) ?? taken.set(d, []).get(d)!).push(nameOf(path)); };
  const free = (path: string) => !(taken.get(dirOf(path)) ?? []).some((n) => nameKey(n) === nameKey(nameOf(path)));

  const out: { id: string; from: string; to: string }[] = [];
  const ordered = [...remote].sort((a, b) =>
    Number(isCompliantPath(b.path)) - Number(isCompliantPath(a.path)) || a.modifiedMs - b.modifiedMs || a.id.localeCompare(b.id));
  for (const r of ordered) {
    const target = toCompliantPath(r.path);
    if (target === r.path && free(r.path)) { claim(r.path); continue; }
    const dir = dirOf(target);
    const to = free(target) ? target : join(dir, uniqueCompliantName(nameOf(target), taken.get(dir) ?? []));
    claim(to);
    out.push({ id: r.id, from: r.path, to });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

// ---- the plan ------------------------------------------------------------------------------------

export function plan(input: PlanInput): Plan {
  const skipped: Plan['skipped'] = [];
  const opts = { includeExports: input.includeExports };
  const syncable = <T extends { path: string }>(items: readonly T[], side: 'local' | 'remote'): T[] =>
    items.filter((f) => {
      if (classify(f.path, opts) === null) return false;
      if (f.path.length > MAX_REL_PATH) { skipped.push({ path: f.path, reason: 'The path is too long for Windows.' }); return false; }
      if (!isCompliantPath(f.path)) {
        skipped.push({ path: f.path, reason: side === 'remote' ? 'The name is not valid on Windows yet; it will be renamed.' : 'The name is not valid on Windows.' });
        return false;
      }
      return true;
    });

  const local = new Map(syncable(input.local, 'local').map((f) => [nameKey(f.path), f]));
  const remote = new Map(syncable(input.remote, 'remote').map((f) => [nameKey(f.path), f]));
  const base = new Map(input.base.filter((b) => classify(b.path, opts) !== null).map((b) => [nameKey(b.path), b]));
  const actions: SyncAction[] = [];

  // Renames made on Drive (or by Drive for Desktop) keep their file ID, so they arrive as moves, not delete + create.
  const baseById = new Map([...base.values()].map((b) => [b.id, b]));
  for (const r of [...remote.values()]) {
    const b = baseById.get(r.id);
    if (!b || nameKey(b.path) === nameKey(r.path) || remote.has(nameKey(b.path))) continue;
    base.delete(nameKey(b.path));
    base.set(nameKey(r.path), { ...b, path: r.path });
    const l = local.get(nameKey(b.path));
    if (l && !local.has(nameKey(r.path))) {
      actions.push({ type: 'renameLocal', from: l.path, to: r.path });
      local.delete(nameKey(b.path));
      local.set(nameKey(r.path), { ...l, path: r.path });
    }
  }

  // Names already in use per folder, so conflict copies never collide with anything.
  const used = new Map<string, string[]>();
  const use = (p: string) => { const d = dirOf(p); (used.get(d) ?? used.set(d, []).get(d)!).push(nameOf(p)); };
  for (const f of local.values()) use(f.path);
  for (const f of remote.values()) use(f.path);

  const keepBoth = (path: string, id: string): SyncAction => {
    const copyPath = join(dirOf(path), conflictCopyName(nameOf(path), input.device, input.today, used.get(dirOf(path)) ?? []));
    use(copyPath);
    return { type: 'keepBoth', path, id, copyPath };
  };

  const conflict = (path: string, l: LocalFile, r: RemoteFile): SyncAction => {
    const cls = classify(path, opts) as FileClass;
    if (cls === 'prose') return keepBoth(path, r.id);
    if (cls === 'progress') return { type: 'mergeProgress', path, id: r.id };
    if (cls === 'marks') return { type: 'mergeMarks', path, id: r.id };
    if (cls === 'notes') return { type: 'mergeNotes', path, id: r.id };
    // Settings and small assets: the most recent write wins; Drive keeps the older version in its revision history.
    return l.modifiedMs > r.modifiedMs ? { type: 'upload', path, id: r.id } : { type: 'download', path, id: r.id };
  };

  const keys = [...new Set([...local.keys(), ...remote.keys(), ...base.keys()])].sort();
  for (const key of keys) {
    const l = local.get(key), r = remote.get(key), b = base.get(key);
    const path = (r ?? l ?? b)!.path;
    if (!b) {
      if (l && r) actions.push(l.md5 === r.md5 ? { type: 'markSynced', path, id: r.id, md5: r.md5 } : conflict(path, l, r));
      else if (l) actions.push({ type: 'upload', path, id: null });
      else if (r) actions.push({ type: 'download', path, id: r.id });
      continue;
    }
    const lc = l !== undefined && l.md5 !== b.md5;
    const rc = r !== undefined && r.md5 !== b.md5;
    if (l && r) {
      if (!lc && !rc) { if (b.id !== r.id) actions.push({ type: 'markSynced', path, id: r.id, md5: r.md5 }); }
      else if (lc && !rc) actions.push({ type: 'upload', path, id: r.id });
      else if (!lc && rc) actions.push({ type: 'download', path, id: r.id });
      else actions.push(l.md5 === r.md5 ? { type: 'markSynced', path, id: r.id, md5: r.md5 } : conflict(path, l, r));
    } else if (l) {
      // Deleted on Drive. An edit made here since the last sync wins and the file is created again.
      actions.push(l.md5 !== b.md5 ? { type: 'upload', path, id: null } : { type: 'deleteLocal', path });
    } else if (r) {
      // Deleted here. An edit made on Drive since the last sync wins and the file comes back.
      actions.push(r.md5 !== b.md5 ? { type: 'download', path, id: r.id } : { type: 'deleteRemote', path, id: r.id });
    } else {
      actions.push({ type: 'forget', path });
    }
  }

  // A local rename shows up as "gone" + "new file with the same content": turn that pair into a rename so Drive keeps the file's ID and history.
  const renamed: SyncAction[] = [];
  const deletes = actions.filter((a): a is Extract<SyncAction, { type: 'deleteRemote' }> => a.type === 'deleteRemote');
  const creates = actions.filter((a): a is Extract<SyncAction, { type: 'upload' }> => a.type === 'upload' && a.id === null);
  const consumed = new Set<SyncAction>();
  for (const c of creates) {
    const l = local.get(nameKey(c.path));
    const d = deletes.find((x) => !consumed.has(x) && base.get(nameKey(x.path))?.md5 === l?.md5);
    if (!d || !l) continue;
    consumed.add(d); consumed.add(c);
    renamed.push({ type: 'renameRemote', id: d.id, from: d.path, to: c.path });
  }
  const finalActions = [...actions.filter((a) => !consumed.has(a)), ...renamed];

  const removals = finalActions.filter((a) => a.type === 'deleteLocal' || a.type === 'deleteRemote').length;
  const confirmDeletes = removals >= Math.max(3, Math.ceil(base.size / 2)) || (local.size === 0 && base.size > 0 && removals > 0);

  finalActions.sort((a, b) => RANK[a.type] - RANK[b.type] || actionPath(a).localeCompare(actionPath(b)));
  return { actions: finalActions, skipped, confirmDeletes };
}
