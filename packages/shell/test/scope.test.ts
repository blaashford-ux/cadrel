import { describe, expect, it } from 'vitest';
import { createProject, emptyTree, setArchived, type ProjectTree, type ResolvedViewScope, type ViewScope } from '@cadrel/kernel';
import { ScopeHost, scopeMenu } from '../src/main/scope';
import { sanitizeSettings } from '../src/main/settings';

function world(remember?: (ids: Record<'dragon' | 'b1' | 'b2' | 'lost' | 'only', string>) => Partial<ViewScope>) {
  let tree: ProjectTree = emptyTree();
  const add = (name: string, parentId: string | null = null) => {
    const r = createProject(tree, { name, parentId });
    tree = r.tree;
    return r.project.id;
  };
  const dragon = add('Dragon Rider');
  const b1 = add('Book 1', dragon);
  const b2 = add('Book 2', dragon);
  const lost = add('The Lost King');
  const only = add('The Lost King', lost);
  const ids = { dragon, b1, b2, lost, only };
  const remembered = remember?.(ids);
  const saved: ViewScope[] = [];
  const told: ResolvedViewScope[] = [];
  const host = new ScopeHost({ tree: async () => tree, remembered: () => remembered, remember: (s) => saved.push(s), announce: (s) => told.push(s) });
  return { host, saved, told, ids, get tree() { return tree; }, archive: (id: string) => (tree = setArchived(tree, id, true)) };
}

describe('the scope the app shows', () => {
  it('starts at the first Project with all its Books when nothing was remembered', async () => {
    const w = world();
    expect(await w.host.get()).toMatchObject({ project: w.ids.dragon, book: null, books: [w.ids.b1, w.ids.b2] });
  });

  it('starts where the Studio left off', async () => {
    const gone = world(() => ({ project: 'x', book: null }));
    expect((await gone.host.get()).project).toBe(gone.ids.dragon); // what was remembered is gone, so the default
    const again = world((ids) => ({ project: ids.lost, book: null }));
    expect(await again.host.get()).toMatchObject({ project: again.ids.lost, bookImplied: true });
  });

  it('changing the Project starts at all its Books; naming a Book keeps the Project', async () => {
    const w = world();
    await w.host.set({ book: w.ids.b2 });
    expect(await w.host.get()).toMatchObject({ project: w.ids.dragon, book: w.ids.b2 });
    const r = await w.host.set({ project: w.ids.lost });
    expect(r).toMatchObject({ project: w.ids.lost, book: w.ids.only, bookImplied: true });
    expect(await w.host.set({ project: w.ids.dragon })).toMatchObject({ project: w.ids.dragon, book: null });
  });

  it('refuses a Book that is not the Project’s, answering with the scope that resulted', async () => {
    const w = world();
    expect(await w.host.set({ book: w.ids.only })).toMatchObject({ project: w.ids.dragon, book: null });
  });

  it('remembers every change for the Studio and tells everyone once per change', async () => {
    const w = world();
    await w.host.set({ book: w.ids.b1 });
    await w.host.set({ book: w.ids.b1 }); // no change: nothing to say
    await w.host.set({ book: w.ids.b2 });
    expect(w.told.map((s) => s.book)).toEqual([w.ids.b1, w.ids.b2]);
    expect(w.saved.at(-1)).toEqual({ project: w.ids.dragon, book: w.ids.b2 });
  });

  it('moves the scope, and says so, when the Project or Book it names is archived', async () => {
    const w = world();
    await w.host.set({ project: w.ids.dragon, book: w.ids.b2 });
    w.told.length = 0;
    w.archive(w.ids.b2);
    await w.host.refresh();
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ project: w.ids.dragon, book: w.ids.b1, bookImplied: true }); // one Book left
    w.archive(w.ids.dragon);
    await w.host.refresh();
    expect(w.told.at(-1)).toMatchObject({ project: w.ids.lost });
    await w.host.refresh();
    expect(w.told).toHaveLength(2); // nothing changed since: silent
  });

  it('does not remember a Book that was only implied, so a second Book brings back all Books', async () => {
    let t: ProjectTree = emptyTree();
    const mk = (name: string, parentId: string | null = null) => {
      const r = createProject(t, { name, parentId });
      t = r.tree;
      return r.project.id;
    };
    const series = mk('Dragon Rider');
    const first = mk('Book 1', series);
    const saved: ViewScope[] = [];
    const host = new ScopeHost({ tree: async () => t, remembered: () => undefined, remember: (s) => saved.push(s), announce: () => undefined });
    expect(await host.set({ project: series })).toMatchObject({ book: first, bookImplied: true });
    expect(saved.at(-1)).toEqual({ project: series, book: null });
    mk('Book 2', series);
    await host.refresh();
    expect(await host.get()).toMatchObject({ project: series, book: null, bookImplied: false });
  });

  it('announces when a Book is added to the Project the scope is in, so the switcher can list it', async () => {
    const w = world();
    await w.host.refresh();
    expect(w.told).toHaveLength(1);
  });
});

describe('the remembered scope in a Studio’s settings', () => {
  it('is kept as two ids and nothing else', () => {
    expect(sanitizeSettings({ scope: { project: 'p1', book: 'b1', extra: 1 } }).scope).toEqual({ project: 'p1', book: 'b1' });
    expect(sanitizeSettings({ scope: { project: 'p1' } }).scope).toEqual({ project: 'p1', book: null });
  });
  it('ignores a damaged value instead of failing', () => {
    expect(sanitizeSettings({ scope: 'x' }).scope).toBeUndefined();
    expect(sanitizeSettings({ scope: { project: 5, book: '' } }).scope).toEqual({ project: null, book: null });
    expect(sanitizeSettings({ scope: { project: 'p'.repeat(200) } }).scope?.project).toBeNull();
  });
});

describe('the scope menu', () => {
  it('lists the Projects, then the Books of the current one with All books, marking what is chosen', async () => {
    const w = world();
    await w.host.set({ book: w.ids.b2 });
    const items = scopeMenu(w.tree, await w.host.get());
    expect(items.map((i) => i.label ?? '—')).toEqual(['Project', 'Dragon Rider', 'The Lost King', '—', 'Book', 'All books', 'Book 1', 'Book 2']);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Dragon Rider', 'Book 2']);
    expect(items.find((i) => i.label === 'The Lost King')?.set).toEqual({ project: w.ids.lost });
    expect(items.find((i) => i.label === 'Book 1')?.set).toEqual({ project: w.ids.dragon, book: w.ids.b1 });
    expect(items.find((i) => i.label === 'All books')?.set).toEqual({ project: w.ids.dragon, book: null });
    expect(items.filter((i) => i.disabled).map((i) => i.label)).toEqual(['Project', 'Book']); // headings only
  });

  it('marks All books when no Book is chosen', async () => {
    const w = world();
    const items = scopeMenu(w.tree, await w.host.get());
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Dragon Rider', 'All books']);
  });

  it('offers no Books when the Project has one, since there is nothing to choose', async () => {
    const w = world((ids) => ({ project: ids.lost, book: null }));
    const items = scopeMenu(w.tree, await w.host.get());
    expect(items.map((i) => i.label ?? '—')).toEqual(['Project', 'Dragon Rider', 'The Lost King']);
  });

  it('says so when there are no Projects', () => {
    expect(scopeMenu(emptyTree(), { project: null, book: null, books: [], bookImplied: false })).toEqual([{ label: 'No projects yet', disabled: true }]);
  });
});
