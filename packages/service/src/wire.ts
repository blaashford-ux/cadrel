/**
 * How the service's calls and answers cross to the Studio's server and back as JSON. Values are plain except that a Set or a Map (the project
 * visibility has them) is written as `{"$set": [...]}` / `{"$map": [...]}` and read back. An error is carried with its kind, so the app can
 * show the same message and tell a refusal from a mistake as it does when the service is in the same process.
 */
import { BusinessError, CatalogueError, FileLinkError, PeopleError, WorkError, WorkflowError } from '@cadrel/kernel';
import { PermissionDenied } from './errors';

export const encodeValue = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x) => (x instanceof Set ? { $set: [...x] } : x instanceof Map ? { $map: [...x] } : x));

export const decodeValue = (text: string): unknown =>
  JSON.parse(text, (_k, x) => (x && typeof x === 'object' && Array.isArray((x as { $set?: unknown }).$set) ? new Set((x as { $set: unknown[] }).$set) : x && typeof x === 'object' && Array.isArray((x as { $map?: unknown }).$map) ? new Map((x as { $map: [unknown, unknown][] }).$map) : x));

export interface WireError {
  error: string;
  kind: string;
  code?: string;
  reasons?: string[];
  capability?: string;
  reason?: string;
}

/** The error to send, or null for one that is a bug (not meant to be shown), which the caller reports generally. */
export function encodeError(e: unknown): WireError | null {
  if (e instanceof PermissionDenied) return { error: e.message, kind: 'PermissionDenied', capability: e.capability, reason: e.reason };
  for (const [name, cls] of Object.entries(KINDS)) {
    if (e instanceof cls) {
      const x = e as unknown as { code?: string; reasons?: string[] };
      return { error: e.message, kind: name, ...(x.code ? { code: x.code } : {}), ...(x.reasons ? { reasons: x.reasons } : {}) };
    }
  }
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError || !(e instanceof Error)) return null;
  return { error: e.message, kind: 'Error' };
}

export function decodeError(w: WireError): Error {
  if (w.kind === 'PermissionDenied') {
    const e = new PermissionDenied(w.capability ?? '', w.reason ?? '');
    e.message = w.error;
    return e;
  }
  const make = KINDS[w.kind] as unknown as (new (code: string, message: string, reasons?: string[]) => Error) | undefined;
  if (make) return new make(w.code ?? '', w.error, w.reasons ?? []);
  return new Error(w.error);
}

const KINDS: Record<string, new (...a: never[]) => Error> = { BusinessError, CatalogueError, FileLinkError, PeopleError, WorkError, WorkflowError };
