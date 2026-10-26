/**
 * The few file-system operations the app's back-end needs, so the same logic (scanning, projects, drafts, settings,
 * sync) runs over Node's `fs` in the Windows app and over the phone's storage on Android.
 * Paths are plain strings in the platform's own style; names inside them are always compliant (see sync/names.ts).
 */

export interface FsEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  /** Size and modification time, when the platform returns them with the listing (the phone does). Saves a `stat` per file. */
  size?: number;
  mtimeMs?: number;
}

export interface FsStat {
  isDirectory: boolean;
  isFile: boolean;
  mtimeMs: number;
  size: number;
}

export interface FsPort {
  /** UTF-8 text. Throws `ENOENT` when missing. */
  readText(path: string): Promise<string>;
  /** Creates or overwrites; with `exclusive`, throws `EEXIST` if the file is there. The parent folder must exist. */
  writeText(path: string, content: string, opts?: { exclusive?: boolean }): Promise<void>;
  /** Throws `ENOENT` when the folder is missing. */
  readdir(path: string): Promise<FsEntry[]>;
  /** Null when nothing is there. */
  stat(path: string): Promise<FsStat | null>;
  /** Without `recursive`, throws `EEXIST` if it exists and `ENOENT` if the parent is missing; with it, never throws for "exists". */
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Moves a file or folder. Throws `ENOENT` when `from` is missing. */
  rename(from: string, to: string): Promise<void>;
  /** With `force`, a missing path is not an error. A folder needs `recursive`. */
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** Copies a file (overwriting) or a whole folder (throws `EEXIST` if the target folder exists). */
  copy(from: string, to: string): Promise<void>;
}

/** An Error carrying a Node-style `code`, so callers can treat "missing" and "exists" the same on every platform. */
export function fsError(code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY', path: string): Error {
  const messages = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'is a directory', ENOTEMPTY: 'directory not empty' };
  return Object.assign(new Error(`${code}: ${messages[code]}, '${path}'`), { code });
}

export const errorCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
