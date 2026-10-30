import type { WriteApi } from './api';

/**
 * The calls Cadrel Reader never makes: writing files, making and managing projects, and sharing as an author. On Windows the module does not
 * register their channels (see electron/readerMode.ts); on the phone there is no channel to remove, so the same calls are replaced here.
 */
export const READER_REFUSED_CALLS = [
  'writeFile', 'createFile', 'createFolder', 'renameNode', 'trashNode',
  'createProject', 'updateProject', 'renameProject', 'duplicateProject', 'deleteProject', 'convertFolder', 'addMissingTemplateParts', 'moveProjects',
  'getShareStatus', 'listShares', 'stopSharing', 'inviteReviewer', 'getShareChapters', 'revokeReviewer'
] as const satisfies readonly (keyof WriteApi)[];

/** `api` with every call in `READER_REFUSED_CALLS` answering "Cadrel Reader can't do that" instead of doing it. */
export function withoutAuthorCalls<T extends object>(api: T): T {
  const out = { ...api } as Record<string, unknown>;
  for (const name of READER_REFUSED_CALLS) out[name] = () => Promise.reject(new Error('Cadrel Reader is for reading and giving feedback, so it can’t do that.'));
  return out as T;
}
