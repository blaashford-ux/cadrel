/**
 * Collaboration: one author's copy of the manuscript kept in step with another's through a Drive file both can write.
 *
 * Each side calls `exchangeCollab` whenever it syncs. It reads the shared file, merges it with the local text (see `merge.ts`)
 * from the text both sides last agreed on, writes the result to the shared file (when it differs) and to the local file, and
 * reports the new agreed text for the caller to remember.
 */
import type { FsPort } from '../fsPort';
import type { DriveApi } from '../sync/drive';
import { mergeManuscript, sameChapters } from './merge';
import { isSharedProse, parsePackage, readProseFiles, type ReviewPackage } from './package';

export interface CollabInput {
  fs: FsPort;
  drive: DriveApi;
  /** The folder holding this side's copy. */
  dir: string;
  /** The shared file in Drive (a review package that both sides can write). */
  packageId: string;
  /** Heading level that splits chapters, when the shared file doesn't say. */
  level: number;
  /** Chapters this collaborator was given (keys); null when it is the whole manuscript. */
  scope: Set<string> | null;
  /** The file `scope` applies to (the other files are always shared whole). */
  scopeFile: string | null;
  /** The text both sides last agreed on, by file path. */
  base: Record<string, string> | null;
  /** Names for the two sides in conflict markers. */
  labels: { local: string; remote: string };
  now: () => Date;
}

export interface CollabResult {
  /** Local files that were written (changed or new). */
  localChanged: string[];
  /** Whether the shared file was updated. */
  remoteChanged: boolean;
  conflicts: number;
  /** The agreed text after this exchange, by file path. */
  base: Record<string, string>;
  /** The shared file is gone or can't be read. */
  gone: boolean;
}

/**
 * Brings this side's Markdown files and the shared file into step. A file only one side has is copied to the other (that is how
 * new files travel); a file both have is merged. Deleting a file is not passed on: the other side's copy brings it back.
 */
export async function exchangeCollab(o: CollabInput): Promise<CollabResult> {
  for (let attempt = 0; ; attempt++) {
    const file = await o.drive.getFile(o.packageId);
    if (!file) return { localChanged: [], remoteChanged: false, conflicts: 0, base: o.base ?? {}, gone: true };
    const remote = parsePackage(await o.drive.download(o.packageId));
    if (!remote) throw new Error('The shared copy of the manuscript can’t be read.');
    const level = remote.chapterLevel ?? o.level;
    // Only Markdown manuscripts outside hidden folders are accepted from the shared file, whatever it says.
    const theirs = new Map(remote.files.filter((f) => isSharedProse(f.path)).map((f) => [f.path, f.text]));
    const mine = new Map((await readProseFiles(o.fs, o.dir)).map((f) => [f.path, f.text]));

    const files: ReviewPackage['files'] = [];
    const writes: { path: string; text: string }[] = [];
    const base: Record<string, string> = {};
    let conflicts = 0;
    let remoteDiffers = remote.files.length !== theirs.size;
    for (const path of [...new Set([...theirs.keys(), ...mine.keys()])].sort()) {
      const l = mine.get(path);
      const r = theirs.get(path);
      if (r === undefined) {
        files.push({ path, text: l! });
        base[path] = l!;
        remoteDiffers = true;
      } else if (l === undefined) {
        files.push({ path, text: r });
        writes.push({ path, text: r });
        base[path] = r;
      } else {
        const m = mergeManuscript({ base: o.base?.[path] ?? null, local: l, remote: r, level, scope: path === o.scopeFile ? o.scope : null, labels: o.labels });
        conflicts += m.conflicts;
        if (m.local !== l) writes.push({ path, text: m.local });
        const same = sameChapters(m.shared, r, level);
        if (!same) remoteDiffers = true;
        files.push({ path, text: same ? r : m.shared });
        base[path] = same ? r : m.shared;
      }
    }

    if (remoteDiffers) {
      // Someone wrote the shared file while this was merging: start again from what they wrote.
      const now = await o.drive.getFile(o.packageId);
      if (now && now.md5 !== file.md5 && attempt < 2) continue;
      await o.drive.updateFile(o.packageId, JSON.stringify({ ...remote, files, publishedAt: o.now().toISOString(), chapterLevel: level }));
    }
    for (const w of writes) {
      const slash = w.path.lastIndexOf('/');
      if (slash > 0) await o.fs.mkdir(`${o.dir}/${w.path.slice(0, slash)}`, { recursive: true });
      await o.fs.writeText(`${o.dir}/${w.path}`, w.text);
    }
    return { localChanged: writes.map((w) => w.path), remoteChanged: remoteDiffers, conflicts, base, gone: false };
  }
}
