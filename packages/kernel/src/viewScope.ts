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
  /** Closed Books are hidden unless this is on. */
  showClosed?: boolean;
}

/** A scope checked against a tree. */
export interface ResolvedViewScope {
  project: string | null;
  book: string | null;
  showClosed: boolean;
  /** The Books the scope offers, in order: the open ones, plus the closed ones when `showClosed` (empty when the Project has none). */
  books: string[];
  /** The Project's closed Books, hidden or not (a Book is closed when it has reached a Done stage; see `ProjectStages.closedBooks`). */
  closed: string[];
  /** The Project offers exactly one Book, so that Book is the scope and there is nothing to choose. */
  bookImplied: boolean;
}

export const NO_SCOPE: ViewScope = { project: null, book: null };

/** Where a project sits for the UI: a Project (top-level), a Book (directly under one), or something inside a Book. */
export type ViewLevel = 'project' | 'book' | 'inside';
export function viewLevel(t: ProjectTree, id: string): ViewLevel | null {
  const p = getProject(t, id);
  if (!p) return null;
  if (!p.parentId) return 'project';
  const parent = getProject(t, p.parentId);
  return parent && !parent.parentId ? 'book' : 'inside';
}

/** The Projects a person can work in: top-level and not archived, in order. */
export const viewProjects = (t: ProjectTree): Project[] => childrenOf(t, null).filter((p) => p.status !== 'archived');

/** A Project's open Books: its direct children that are not archived. (Closing a Book, which hides it, arrives with Book stages.) */
export const viewBooks = (t: ProjectTree, projectId: string): Project[] => childrenOf(t, projectId).filter((p) => p.status !== 'archived');

/**
 * The scope to use: what was asked for where it still exists, else a sensible default. The Project is the one asked for, else the first.
 * The Book is the one asked for if the Project still offers it; a Project that offers a single Book always has that Book. `closed` is the
 * ids of the Books that are closed: hidden from the scope unless `showClosed`.
 */
export function resolveViewScope(t: ProjectTree, want: Partial<ViewScope> | null | undefined, closed: ReadonlySet<string> = new Set()): ResolvedViewScope {
  const showClosed = want?.showClosed === true;
  const projects = viewProjects(t);
  const project = projects.find((p) => p.id === want?.project) ?? projects[0] ?? null;
  if (!project) return { ...NO_SCOPE, showClosed, books: [], closed: [], bookImplied: false };
  const every = viewBooks(t, project.id).map((b) => b.id);
  const shut = every.filter((id) => closed.has(id));
  const books = showClosed ? every : every.filter((id) => !closed.has(id));
  const [only] = books;
  if (books.length === 1 && only !== undefined) return { project: project.id, book: only, showClosed, books, closed: shut, bookImplied: true };
  const asked = want?.book ?? null;
  const book = asked !== null && books.includes(asked) ? asked : null;
  return { project: project.id, book, showClosed, books, closed: shut, bookImplied: false };
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
export function inViewScope(t: ProjectTree, scope: Pick<ResolvedViewScope, 'project' | 'book'> & Partial<Pick<ResolvedViewScope, 'showClosed' | 'closed'>>, projectId: string | null): boolean {
  if (!scope.project || !projectId) return false;
  // What is inside a closed Book is hidden along with it, unless closed Books are being shown.
  if (!scope.showClosed && scope.closed?.some((b) => b !== scope.book && subtreeIds(t, b).includes(projectId))) return false;
  if (!scope.book) return subtreeIds(t, scope.project).includes(projectId);
  return projectId === scope.project || subtreeIds(t, scope.book).includes(projectId);
}

/** True when two scopes name the same Project and Book. */
export const sameViewScope = (a: ViewScope, b: ViewScope): boolean => a.project === b.project && a.book === b.book && (a.showClosed === true) === (b.showClosed === true);

/** A module's record (a Write manuscript folder, a Market category) attached to a project, as the scope sees it. */
export interface ScopeLink {
  module: string;
  /** The module's own name for the record (a folder name, a category key). */
  ref: string;
  /** The project it is attached to, and that project's name. */
  projectId: string;
  projectName: string;
  /** Attached to the Project itself (series level), to a Book, or to something inside a Book. */
  level: ViewLevel;
  /** The Book it belongs to: itself for a Book, the Book above it for something inside one, null for the Project's own. */
  bookId: string | null;
  /** That Book's name. */
  bookName: string | null;
  /** It belongs to a closed Book (only listed while closed Books are being shown). */
  closed: boolean;
}

/**
 * The records of every module that are inside the scope, so a module can show only what belongs to the Project (and Book) without knowing the
 * project tree: Write lists the folders, Market the categories. What is inside a hidden closed Book is left out. A record linked to several
 * projects appears once for each one that is in scope.
 */
export function viewScopeLinks(t: ProjectTree, scope: ResolvedViewScope): ScopeLink[] {
  const out: ScopeLink[] = [];
  for (const l of t.links) {
    if (!inViewScope(t, scope, l.projectId)) continue;
    const level = viewLevel(t, l.projectId);
    if (!level) continue;
    let bookId: string | null = null;
    if (level === 'book') bookId = l.projectId;
    else if (level === 'inside') for (let p = getProject(t, l.projectId); p; p = p.parentId ? getProject(t, p.parentId) : undefined) if (p.parentId && getProject(t, p.parentId)?.parentId === null) bookId = p.id;
    out.push({ module: l.module, ref: l.ref, projectId: l.projectId, projectName: getProject(t, l.projectId)?.name ?? '', level, bookId, bookName: bookId ? getProject(t, bookId)?.name ?? null : null, closed: bookId !== null && scope.closed.includes(bookId) });
  }
  return out;
}
