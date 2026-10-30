/**
 * What a person is looking at: the Project they are working in and, inside it, a Book or all of its Books (docs/UI-MODEL.md).
 * Not the permission scope (`scopePathFor`): this only decides what the screens show, and it is the same for every page and module.
 *
 * The UI has two levels over the project tree. A **Project** is a top-level project (a Series by default). A **Book** is a direct child
 * of one. Anything deeper belongs to the Book it sits under. Pure: functions take a tree and return values.
 */
import { childrenOf, getProject, subtreeIds, type Project, type ProjectTree } from './projects';

/** What was asked for or remembered. Ids only; either may be gone by the time it is used. */
export interface ViewScope {
  project: string | null;
  /** Null means all the Project's books. */
  book: string | null;
}

/** A scope checked against a tree. */
export interface ResolvedViewScope extends ViewScope {
  /** The Project's open Books, in order (empty when the Project has none). */
  books: string[];
  /** The Project has exactly one open Book, so that Book is the scope and there is nothing to choose. */
  bookImplied: boolean;
}

export const NO_SCOPE: ViewScope = { project: null, book: null };

/** The Projects a person can work in: top-level and not archived, in order. */
export const viewProjects = (t: ProjectTree): Project[] => childrenOf(t, null).filter((p) => p.status !== 'archived');

/** A Project's open Books: its direct children that are not archived. (Closing a Book, which hides it, arrives with Book stages.) */
export const viewBooks = (t: ProjectTree, projectId: string): Project[] => childrenOf(t, projectId).filter((p) => p.status !== 'archived');

/**
 * The scope to use: what was asked for where it still exists, else a sensible default. The Project is the one asked for, else the first.
 * The Book is the one asked for if it is still an open Book of that Project; a Project with a single open Book always has that Book.
 */
export function resolveViewScope(t: ProjectTree, want: Partial<ViewScope> | null | undefined): ResolvedViewScope {
  const projects = viewProjects(t);
  const project = projects.find((p) => p.id === want?.project) ?? projects[0] ?? null;
  if (!project) return { ...NO_SCOPE, books: [], bookImplied: false };
  const books = viewBooks(t, project.id).map((b) => b.id);
  const [only] = books;
  if (books.length === 1 && only !== undefined) return { project: project.id, book: only, books, bookImplied: true };
  const asked = want?.book ?? null;
  const book = asked !== null && books.includes(asked) ? asked : null;
  return { project: project.id, book, books, bookImplied: false };
}

/**
 * The scope that shows a given project record: for a Project, that Project (all books); for a Book or anything under one, that Project and
 * Book. Null when it does not exist or sits under an archived Project.
 */
export function viewScopeOf(t: ProjectTree, id: string): ViewScope | null {
  const own = getProject(t, id);
  if (!own) return null;
  const chain: Project[] = [];
  for (let p: Project | undefined = own; p; p = p.parentId ? getProject(t, p.parentId) : undefined) chain.unshift(p);
  const [top, book] = chain;
  if (!top || top.status === 'archived') return null;
  return { project: top.id, book: book && book.id !== top.id ? book.id : null };
}

/**
 * Whether a record that belongs to `projectId` (null: to the studio, not to any project) is inside the scope. A Project scope covers the
 * Project and everything under it. A Book scope covers that Book and everything under it, and also what belongs to the Project itself
 * (series level: its bible, characters, notes), because a Book reads those. A record of the studio is outside every scope.
 */
export function inViewScope(t: ProjectTree, scope: ViewScope, projectId: string | null): boolean {
  if (!scope.project || !projectId) return false;
  if (!scope.book) return subtreeIds(t, scope.project).includes(projectId);
  return projectId === scope.project || subtreeIds(t, scope.book).includes(projectId);
}

/** True when two scopes name the same Project and Book. */
export const sameViewScope = (a: ViewScope, b: ViewScope): boolean => a.project === b.project && a.book === b.book;
