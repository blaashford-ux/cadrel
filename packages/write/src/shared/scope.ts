/**
 * Write inside Cadrel shows only what belongs to the Project (and Book) Cadrel is showing (docs/UI-MODEL.md). Cadrel tells it the scope
 * through `window.cadrelScope`; Write on its own has none and shows everything. These are the shapes it reads and what it makes of them,
 * with no dependence on Cadrel's code.
 */
import { basename } from './paths';

/** A module's record attached to a project, as Cadrel's scope reports it. */
export interface ScopeLink {
  module: string;
  ref: string;
  projectId: string;
  projectName: string;
  level: 'project' | 'book' | 'inside';
  bookId: string | null;
  bookName: string | null;
  closed: boolean;
}

export interface WriteScope {
  project: string | null;
  projectName: string | null;
  book: string | null;
  bookName: string | null;
  showClosed: boolean;
  links: ScopeLink[];
}

/** One manuscript folder that is in scope, and how to label it. */
export interface ScopedFolder {
  /** The folder's name in the Projects folder (what Cadrel links by). */
  folder: string;
  /** The Project's own material (series level), a Book's, or something inside a Book. */
  role: 'series' | 'book' | 'inside';
  /** What to call it: "Series", the Book's name, or the sub-project's. */
  label: string;
  closed: boolean;
}

const ROLE_ORDER = { series: 0, book: 1, inside: 2 } as const;

/**
 * The manuscript folders in scope, in the order to show them (the series first, then each Book, then what is inside Books; closed last), or
 * null when there is no scope to apply (Write outside Cadrel, or a Studio with no projects): then everything is shown.
 */
export function scopedFolders(scope: WriteScope | null | undefined): ScopedFolder[] | null {
  if (!scope || !scope.project) return null;
  const seen = new Set<string>();
  const out: ScopedFolder[] = [];
  for (const l of scope.links) {
    if (l.module !== 'write' || seen.has(l.ref)) continue;
    seen.add(l.ref);
    out.push({ folder: l.ref, role: l.level === 'project' ? 'series' : l.level, label: l.level === 'project' ? 'Series' : l.level === 'book' ? l.bookName ?? l.projectName : l.projectName, closed: l.closed });
  }
  return out.sort((a, b) => Number(a.closed) - Number(b.closed) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
}

/** The projects of a listing that are in scope (all of them when there is no scope). */
export function inScope<T extends { path: string }>(items: T[], folders: ScopedFolder[] | null): T[] {
  if (!folders) return items;
  const wanted = new Set(folders.map((f) => f.folder));
  return items.filter((i) => wanted.has(basename(i.path)));
}

/** Whether a project folder (by its path) is in scope; true when there is no scope. */
export const folderInScope = (path: string, folders: ScopedFolder[] | null): boolean => !folders || folders.some((f) => f.folder === basename(path));

/** The scope's entry for a project folder (by path), if it is in scope. */
export const scopedFolderOf = (path: string, folders: ScopedFolder[] | null): ScopedFolder | undefined => folders?.find((f) => f.folder === basename(path));
