import type { RootListing } from '@cadrel/write/src/shared/projects';
import type { Overview, MarketCategoryRow, WriteProjectRow } from '../shared/api';

/** The facts Home and Dashboard need from each module, flattened so the page never sees a module's internal types. */

export function summariseWrite(listing: RootListing): Overview['write'] {
  const projects: WriteProjectRow[] = listing.projects.map((p) => ({
    name: p.name,
    status: p.meta.status,
    words: p.words,
    goalWords: p.meta.goal?.targetWords ?? null,
    lastEdited: p.lastEdited,
    archived: p.meta.archived
  }));
  // Most recently edited first; projects never written to go last.
  projects.sort((a, b) => (b.lastEdited ?? -1) - (a.lastEdited ?? -1) || a.name.localeCompare(b.name));
  return { ok: true, root: listing.root, exists: listing.exists, projects, error: null };
}

export const writeUnavailable = (error: unknown): Overview['write'] => ({ ok: false, root: null, exists: false, projects: [], error: message(error) });

export interface MarketFacts {
  status: { libraryRoot: string | null; port: number; serverRunning: boolean; serverError?: string | null };
  /** Absent when no library is chosen yet. */
  categories?: { name: string | null; key: string; listedBooks: number; capturedBooks: number; listCaptures: number; lastListCapture: string | null }[];
  queue?: { state: 'pending' | 'opened' | 'skipped' }[];
}

export function summariseMarket(f: MarketFacts): Overview['market'] {
  const categories: MarketCategoryRow[] = (f.categories ?? []).map((c) => ({
    key: c.key,
    name: c.name ?? c.key,
    listedBooks: c.listedBooks,
    capturedBooks: c.capturedBooks,
    listCaptures: c.listCaptures,
    lastListCapture: c.lastListCapture
  }));
  return {
    ok: true,
    libraryRoot: f.status.libraryRoot,
    serverRunning: f.status.serverRunning,
    serverError: f.status.serverError ?? null,
    port: f.status.port,
    categories,
    queued: (f.queue ?? []).filter((q) => q.state === 'pending').length,
    error: null
  };
}

export const marketUnavailable = (error: unknown): Overview['market'] => ({
  ok: false,
  libraryRoot: null,
  serverRunning: false,
  serverError: null,
  port: null,
  categories: [],
  queued: 0,
  error: message(error)
});

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
