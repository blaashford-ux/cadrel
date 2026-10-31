/**
 * Which folder does a call mean? Inside Cadrel a project is a Project (a series) with Books under it, each Book with its own manuscript folder
 * (docs/UI-MODEL.md). The assistant names a Project, and a Book when the Project has several; this finds the folder, and when it cannot it says
 * what to ask instead of guessing. The assistant is told the Project and Book explicitly: nothing here follows what the person has open.
 */
import { getProject, linksOf, pathOf, viewBooks, viewLevel, type Project, type ProjectTree } from '@cadrel/kernel';
import type { Studio } from '@cadrel/studio';
import { AgentError } from '@cadrel/write/src/shared/agent/tools';
import type { Earlier } from '@cadrel/write/src/shared/agent/trackers';
import type { ProjectRef } from '@cadrel/write/mcp/server';

export interface ResolverOptions {
  studio: Studio;
  /** The Books that are closed (in a Done stage). Absent where the workflows are not known: then none is treated as closed. */
  closed?: () => Promise<ReadonlySet<string>>;
}

const lower = (s: string) => s.trim().toLowerCase();

/** A project by id, by path ("Dragon Rider / Book 1") or by a name that is unique; null if there is none, an AgentError if it is ambiguous. */
export function findProject(t: ProjectTree, ref: string): Project | null {
  const byId = getProject(t, ref);
  if (byId) return byId;
  const want = ref.split('/').map(lower);
  const hits = t.projects.filter((p) => {
    if (p.status === 'archived') return false;
    const path = pathOf(t, p.id).split(' / ').map(lower);
    return path.length >= want.length && want.every((w, i) => path[path.length - want.length + i] === w);
  });
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new AgentError(`"${ref}" matches ${hits.length} projects (${hits.map((h) => pathOf(t, h.id)).join('; ')}). Use a fuller path, such as "Series / Book".`);
  return null;
}

/**
 * A project or Book by whatever the assistant said: an id, a name, or a path. A path whose last part is only the start of a Book's name
 * ("Dragon Rider / Book 3") finds that Book, as `book: "Book 3"` would.
 */
export function findNode(t: ProjectTree, ref: string): Project | null {
  const exact = findProject(t, ref);
  if (exact) return exact;
  const parts = ref.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const head = findProject(t, parts[0]!);
  if (!head || viewLevel(t, head.id) !== 'project') return null;
  return findBook(t, head, parts[1]!);
}

/** The Book among a Project's Books: by id, exact name, or a name it starts with or contains, as long as that picks one. */
export function findBook(t: ProjectTree, project: Project, ref: string): Project {
  const books = viewBooks(t, project.id);
  const byId = books.find((b) => b.id === ref);
  if (byId) return byId;
  const want = lower(ref);
  for (const test of [(n: string) => n === want, (n: string) => n.startsWith(want), (n: string) => n.includes(want)]) {
    const hits = books.filter((b) => test(lower(b.name)));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new AgentError(`"${ref}" matches several books of ${project.name}: ${hits.map((h) => h.name).join('; ')}. Use more of the name.`);
  }
  throw new AgentError(`${project.name} has no book "${ref}". Its books: ${books.map((b) => b.name).join('; ') || '(none yet)'}.`);
}

/** The Book a project belongs to: itself if it is a Book, the Book above it if it is inside one, null for a Project. */
export function bookOf(t: ProjectTree, p: Project): Project | null {
  const level = viewLevel(t, p.id);
  if (level === 'book') return p;
  if (level !== 'inside') return null;
  for (let q: Project | undefined = p; q; q = q.parentId ? getProject(t, q.parentId) : undefined) if (q.parentId && getProject(t, q.parentId)?.parentId === null) return q;
  return null;
}

const folderOf = (t: ProjectTree, id: string): string | null => linksOf(t, id, 'write')[0]?.ref ?? null;

export function makeProjectResolver(o: ResolverOptions): { resolve(ref: ProjectRef): Promise<string>; earlier(folder: string): Promise<Earlier> } {
  const tree = async () => (await o.studio.read()).tree;
  const closedSet = async () => (o.closed ? await o.closed() : new Set<string>());

  async function resolve(ref: ProjectRef): Promise<string> {
    const t = await tree();
    const node = findNode(t, ref.project);
    if (!node) {
      // Not something in the project tree: a plain manuscript folder name from list_projects (or one not linked to a project yet).
      if (ref.book) throw new AgentError(`There is no project "${ref.project}" to take a book from. Use studio_projects to see the Projects and their Books.`);
      return ref.project;
    }
    const closed = await closedSet();
    const level = viewLevel(t, node.id);
    const open = level === 'project' ? viewBooks(t, node.id).filter((b) => !closed.has(b.id)) : [];
    let target: Project;
    if (ref.book) {
      if (level !== 'project') throw new AgentError(`"${node.name}" is a book, not a project, so there is no book to choose in it. Leave out book, or name the series.`);
      target = findBook(t, node, ref.book);
    } else if (level !== 'project') {
      target = node;
    } else if (open.length === 1 && (ref.level === 'book' || !folderOf(t, node.id))) {
      target = open[0]!; // the only open Book is the default
    } else if (ref.level === 'either' && folderOf(t, node.id)) {
      return folderOf(t, node.id)!; // series-level material lives in the Project's own folder
    } else if (open.length === 0 && folderOf(t, node.id)) {
      return folderOf(t, node.id)!; // a project that has no Books yet is one level: its folder is the manuscript's
    } else if (open.length === 0) {
      throw new AgentError(`${node.name} has no manuscript folder and no open books yet. Add one on Cadrel's Projects page.`);
    } else {
      throw new AgentError(`${node.name} has ${open.length} open books (${open.map((b) => b.name).join('; ')}). Say which one with book${ref.level === 'either' ? ', or, for series-level material, add a folder to the series first' : ''}.`);
    }
    const folder = folderOf(t, target.id);
    if (!folder) throw new AgentError(`${target.name} has no manuscript folder yet. Add one on Cadrel's Projects page, then try again.`);
    const book = bookOf(t, target);
    if (ref.write && book && closed.has(book.id)) throw new AgentError(`${book.name} is closed, so it is read-only. Reopen it in Cadrel to change it; you can still read it.`);
    return folder;
  }

  /**
   * Where the tracker ledgers of the Book in `folder` live, and what came before it. A series with a manuscript folder of its own keeps one
   * ledger file for all its Books, there (each Book's ledger inside under its id); the Books before this one are read from it. A series with
   * no folder of its own, or a book on its own, keeps one file per Book in its own folder, and this gives the folders of the Books before it.
   * Every earlier Book counts, closed or not: it is where the story has been.
   */
  async function earlier(folder: string): Promise<Earlier> {
    const t = await tree();
    const link = t.links.find((l) => l.module === 'write' && l.ref === folder);
    const own = link ? getProject(t, link.projectId) : undefined;
    const book = own ? bookOf(t, own) : null;
    if (!book?.parentId || !own || own.id !== book.id) return [];
    const parent = getProject(t, book.parentId);
    if (!parent) return [];
    const before = viewBooks(t, parent.id).filter((b) => b.order < book.order);
    const seriesFolder = folderOf(t, parent.id);
    if (seriesFolder) return { folder: seriesFolder, book: book.id, bookName: book.name, before: before.map((b) => ({ id: b.id, name: b.name, folder: folderOf(t, b.id) })) };
    return before.map((b) => folderOf(t, b.id)).filter((f): f is string => !!f);
  }

  return { resolve, earlier };
}
