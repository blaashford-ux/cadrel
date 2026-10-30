import { getProject, resolveViewScope, sameViewScope, viewBooks, viewProjects, type ProjectTree, type ResolvedViewScope, type ViewScope } from '@cadrel/kernel';
import type { ScopeView } from '../shared/api';

export interface ScopeHostOptions {
  /** The Studio's project tree as it is now. */
  tree(): Promise<ProjectTree>;
  /** What this Studio remembered last time (its own settings file), if anything. */
  remembered(): Partial<ViewScope> | undefined;
  /** Remembers the scope for this Studio. */
  remember(scope: ViewScope): void;
  /** Tells every window and module view that the scope changed. */
  announce(scope: ScopeView): void;
}

/**
 * The one scope (Project and Book) the whole app shows (docs/UI-MODEL.md). The shell's pages and the Write, Market and Finance views all read
 * it from here and are told when it changes, so they cannot disagree. What is remembered is only a request: it is checked against the
 * Studio's tree every time, so a Project or Book that was archived or deleted never leaves the app pointing at nothing.
 */
export class ScopeHost {
  private want: Partial<ViewScope> | undefined;
  private shown: ScopeView | null = null;

  constructor(private readonly o: ScopeHostOptions) {
    this.want = o.remembered();
  }

  /** The scope now. */
  async get(): Promise<ScopeView> {
    const tree = await this.o.tree();
    const r = resolveViewScope(tree, this.want);
    return { ...r, projectName: r.project ? getProject(tree, r.project)?.name ?? null : null, bookName: r.book && !r.bookImplied ? getProject(tree, r.book)?.name ?? null : null };
  }

  /**
   * Changes the Project and/or the Book. Choosing another Project starts at all its Books (unless a Book is named); naming only a Book
   * keeps the Project. Returns the scope that resulted, which may differ from the request (a Book that is not the Project's is dropped).
   */
  async set(change: Partial<ViewScope>): Promise<ScopeView> {
    const now = await this.get();
    const project = change.project !== undefined ? change.project : now.project;
    const book = change.book !== undefined ? change.book : change.project !== undefined && change.project !== now.project ? null : now.book;
    this.want = { project, book };
    return this.settle();
  }

  /** Call after the tree may have changed (a project made, archived, moved or deleted): moves the scope if what it named is gone. */
  async refresh(): Promise<void> {
    await this.settle();
  }

  private async settle(): Promise<ScopeView> {
    const r = await this.get();
    // A Book that is only implied (the Project has just that one) was not chosen, so it is not remembered: when a second Book appears the
    // scope goes back to all Books instead of staying on the first.
    const chosen = { project: r.project, book: r.bookImplied ? null : r.book };
    this.want = chosen;
    this.o.remember(chosen);
    if (!this.shown || !sameViewScope(this.shown, r) || this.shown.books.join() !== r.books.join() || this.shown.projectName !== r.projectName || this.shown.bookName !== r.bookName) {
      this.shown = r;
      this.o.announce(r);
    }
    return r;
  }
}

/** One line of the scope menu. `set` is what choosing it does; a line without it only labels or separates. */
export interface ScopeMenuItem {
  label?: string;
  type?: 'separator';
  checked?: boolean;
  disabled?: boolean;
  set?: Partial<ViewScope>;
}

/**
 * The menu the rail's scope button opens: the Studio's Projects, then (when the Project has more than one open Book) its Books with "All books".
 * It is a native menu because the module views (Write, Market, Finance) sit above the shell's page, so a list drawn in the page would be
 * hidden behind them. A Project with one Book has nothing to choose, so only the Projects are listed.
 */
export function scopeMenu(tree: ProjectTree, now: ResolvedViewScope): ScopeMenuItem[] {
  const projects = viewProjects(tree);
  if (!projects.length) return [{ label: 'No projects yet', disabled: true }];
  const out: ScopeMenuItem[] = [{ label: 'Project', disabled: true }];
  for (const p of projects) out.push({ label: p.name, checked: p.id === now.project, set: { project: p.id } });
  if (now.project && !now.bookImplied && now.books.length > 1) {
    out.push({ type: 'separator' }, { label: 'Book', disabled: true }, { label: 'All books', checked: now.book === null, set: { project: now.project, book: null } });
    for (const b of viewBooks(tree, now.project)) out.push({ label: b.name, checked: b.id === now.book, set: { project: now.project, book: b.id } });
  }
  return out;
}
