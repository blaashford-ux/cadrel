/**
 * What the person has allowed AI tools to do to their documents. Everything that changes a manuscript is off until they switch it on
 * (Cadrel → Settings → MCP), so an AI app can read and leave review notes but cannot create or edit files unless it was opted in.
 *
 * The app writes this to a small file beside the studio's other settings; the MCP server reads it again on every call that would
 * change a file, so switching a permission takes effect at once, without restarting the AI app. A missing, damaged or unreadable file
 * means everything is off.
 */
import type { FsPort } from '../fsPort';

export interface AiAccess {
  /** May make new manuscript files in a project (never overwriting an existing one). */
  createFiles: boolean;
  /** May change the text of existing manuscript files. */
  editFiles: boolean;
}

export const AI_ACCESS_FILE = 'ai-access.json';

export const NO_AI_ACCESS: AiAccess = { createFiles: false, editFiles: false };

/** Only a literal `true` switches a permission on. */
export function sanitizeAccess(raw: unknown): AiAccess {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { createFiles: r.createFiles === true, editFiles: r.editFiles === true };
}

/** A reader for the access file at `file`; fails closed. */
export function accessReader(fs: Pick<FsPort, 'readText'>, file: string | undefined): () => Promise<AiAccess> {
  return async () => {
    if (!file) return NO_AI_ACCESS;
    try {
      return sanitizeAccess(JSON.parse(await fs.readText(file)));
    } catch {
      return NO_AI_ACCESS;
    }
  };
}
