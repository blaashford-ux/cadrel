/**
 * The slice of Google Drive the sync engine needs, so it can be tested against an in-memory Drive and run against
 * the real one (driveRest.ts). Under the narrow `drive.file` permission, `listAll` only returns files this app made.
 */
export interface DriveFile {
  id: string;
  name: string;
  /** Null for something directly in My Drive (or whose parent this app can't see). */
  parentId: string | null;
  isFolder: boolean;
  /** MD5 of the stored bytes; null for folders. */
  md5: string | null;
  modifiedMs: number;
}

export interface DriveApi {
  /** Everything the app can see that isn't in the trash. */
  listAll(): Promise<DriveFile[]>;
  createFolder(name: string, parentId: string | null): Promise<DriveFile>;
  createFile(name: string, parentId: string, content: string): Promise<DriveFile>;
  updateFile(id: string, content: string): Promise<DriveFile>;
  download(id: string): Promise<string>;
  /** Renames and/or moves (`move.from` is the current parent). */
  rename(id: string, name: string, move?: { from: string | null; to: string }): Promise<DriveFile>;
  /** One file by id (null when it is gone or this app has not been given access to it). */
  getFile(id: string): Promise<DriveFile | null>;
  /**
   * Lets anyone who has the link open the file: `reader` to view, `writer` to also change its content. Writers can't
   * re-share it. Calling again changes the role.
   */
  shareByLink(id: string, role: 'reader' | 'writer'): Promise<void>;
  /** Stops link sharing (the owner keeps the file). */
  unshare(id: string): Promise<void>;
  /** Moves to Drive's trash (recoverable there); trashing a folder trashes what is inside. */
  trash(id: string): Promise<void>;
}

/** The folder in Drive that holds every project (it mirrors the Root Folder). */
export const DRIVE_ROOT_NAME = 'MDEdit';

/** Folder (beside the sync root, so it never syncs into the Root Folder) that holds files shared for review. */
export const DRIVE_REVIEWS_NAME = 'MDEdit Reviews';
