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
  const closed = new Set<string>();
  const saved: ViewScope[] = [];
  const told: ResolvedViewScope[] = [];
  const host = new ScopeHost({ tree: async () => tree, closed: async () => closed, remembered: () => remembered, remember: (s) => saved.push(s), announce: (s) => told.push(s) });
  return { host, saved, told, ids, get tree() { return tree; }, close: (id: string) => closed.add(id), reopen: (id: string) => closed.delete(id), archive: (id: string) => (tree = setArchived(tree, id, true)) };
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
    expect(w.saved.at(-1)).toEqual({ project: w.ids.dragon, book: w.ids.b2, showClosed: false });
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
    const host = new ScopeHost({ tree: async () => t, closed: async () => new Set(), remembered: () => undefined, remember: (s) => saved.push(s), announce: () => undefined });
    expect(await host.set({ project: series })).toMatchObject({ book: first, bookImplied: true });
    expect(saved.at(-1)).toEqual({ project: series, book: null, showClosed: false });
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

describe('changes that overlap', () => {
  it('a refresh that began before a choice does not put the old choice back', async () => {
    let t: ProjectTree = emptyTree();
    const mk = (name: string, parentId: string | null = null) => {
      const r = createProject(t, { name, parentId });
      t = r.tree;
      return r.project.id;
    };
    const series = mk('Dragon Rider');
    const b1 = mk('Book 1', series);
    const b2 = mk('Book 2', series);
    // Working out which Books are closed is slow the first time (the refresh's) and quick after, so without ordering the choice would be made
    // while the refresh was still working from what it had read before it, and the refresh would then write that back.
    let reads = 0;
    const slow = () => new Promise((r) => setTimeout(r, ++reads === 1 ? 40 : 2));
    const host = new ScopeHost({ tree: async () => t, closed: async () => (await slow(), new Set<string>()), remembered: () => undefined, remember: () => undefined, announce: () => undefined });
    const refreshing = host.refresh(); // reads the tree, then would write what it found
    const choosing = host.set({ book: b2 });
    await Promise.all([refreshing, choosing]);
    expect(await host.get()).toMatchObject({ project: series, book: b2 });
    void b1;
  });

  it('keeps working after a change fails', async () => {
    let fail = true;
    const host = new ScopeHost({ tree: async () => { if (fail) { fail = false; throw new Error('boom'); } return emptyTree(); }, closed: async () => new Set(), remembered: () => undefined, remember: () => undefined, announce: () => undefined });
    await expect(host.refresh()).rejects.toThrow('boom');
    await expect(host.refresh()).resolves.toBeUndefined();
  });
});

describe('closed Books and showing them', () => {
  it('a Book that closes leaves the scope, and everyone is told', async () => {
    const w = world();
    await w.host.set({ book: w.ids.b2 });
    w.told.length = 0;
    w.close(w.ids.b2);
    await w.host.refresh();
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ book: w.ids.b1, bookImplied: true, books: [w.ids.b1], closed: [w.ids.b2] });
  });

  it('closed Books can be shown, and the choice is remembered with the Studio', async () => {
    const w = world();
    w.close(w.ids.b1);
    expect((await w.host.get()).books).toEqual([w.ids.b2]);
    const shown = await w.host.set({ showClosed: true });
    expect(shown).toMatchObject({ showClosed: true, books: [w.ids.b1, w.ids.b2], closed: [w.ids.b1], book: null });
    expect(w.saved.at(-1)).toMatchObject({ showClosed: true });
    expect((await w.host.set({ showClosed: false })).showClosed).toBe(false);
  });

  it('changing the Book or Project keeps whether closed Books are shown', async () => {
    const w = world();
    await w.host.set({ showClosed: true });
    expect((await w.host.set({ project: w.ids.lost })).showClosed).toBe(true);
  });

  it('a closed Book can be chosen while shown, and is dropped again when hidden', async () => {
    const w = world();
    w.close(w.ids.b1);
    await w.host.set({ showClosed: true, book: w.ids.b1 });
    expect((await w.host.get()).book).toBe(w.ids.b1);
    expect(await w.host.set({ showClosed: false })).toMatchObject({ book: w.ids.b2, bookImplied: true });
  });

  it('the menu marks closed Books and offers the switch only when it matters', async () => {
    const w = world();
    expect(scopeMenu(w.tree, await w.host.get()).some((i) => i.checkbox)).toBe(false);
    w.close(w.ids.b1);
    w.close(w.ids.b2);
    await w.host.refresh();
    const items = scopeMenu(w.tree, await w.host.get());
    const sw = items.find((i) => i.checkbox);
    expect(sw).toMatchObject({ label: 'Show closed books', checked: false, set: { showClosed: true } });
    await w.host.set({ showClosed: true });
    const on = scopeMenu(w.tree, await w.host.get());
    expect(on.find((i) => i.checkbox)).toMatchObject({ checked: true, set: { showClosed: false } });
    expect(on.map((i) => i.label)).toContain('Book 1 (closed)');
  });
});

describe('the remembered scope in a Studio’s settings', () => {
  it('is kept as two ids and nothing else', () => {
    expect(sanitizeSettings({ scope: { project: 'p1', book: 'b1', extra: 1 } }).scope).toEqual({ project: 'p1', book: 'b1' });
    expect(sanitizeSettings({ scope: { project: 'p1' } }).scope).toEqual({ project: 'p1', book: null });
  });
  it('keeps whether closed Books are shown', () => {
    expect(sanitizeSettings({ scope: { project: 'p', book: null, showClosed: true } }).scope).toEqual({ project: 'p', book: null, showClosed: true });
    expect(sanitizeSettings({ scope: { project: 'p', showClosed: 'yes' } }).scope).toEqual({ project: 'p', book: null });
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
    expect(scopeMenu(emptyTree(), { project: null, book: null, showClosed: false, books: [], closed: [], bookImplied: false })).toEqual([{ label: 'No projects yet', disabled: true }]);
  });
});
