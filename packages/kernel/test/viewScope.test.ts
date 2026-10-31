import { describe, expect, it } from 'vitest';
import { createProject, emptyTree, setArchived, type ProjectTree } from '../src/projects';
import { inViewScope, resolveViewScope, sameViewScope, viewBooks, viewLevel, viewProjects, viewScopeOf } from '../src/viewScope';

function studio() {
  let t: ProjectTree = emptyTree();
  const add = (name: string, parentId: string | null = null, kind?: string) => {
    const r = createProject(t, { name, parentId, kind });
    t = r.tree;
    return r.project.id;
  };
  const dragon = add('Dragon Rider', null, 'Series');
  const b1 = add('Book 1', dragon, 'Book');
  const b2 = add('Book 2', dragon, 'Book');
  const sub = add('Cover art', b2); // below a Book: belongs to it
  const lost = add('The Lost King');
  const only = add('The Lost King', lost, 'Book');
  const empty = add('Empty series');
  return { get t() { return t; }, set t(v) { t = v; }, dragon, b1, b2, sub, lost, only, empty };
}

describe('Projects and Books as the UI sees them', () => {
  it('a Project is a top-level project that is not archived; a Book is a direct child of one', () => {
    const s = studio();
    expect(viewProjects(s.t).map((p) => p.name)).toEqual(['Dragon Rider', 'The Lost King', 'Empty series']);
    expect(viewBooks(s.t, s.dragon).map((b) => b.name)).toEqual(['Book 1', 'Book 2']); // not "Cover art", which is under a Book
    s.t = setArchived(s.t, s.b1, true);
    expect(viewBooks(s.t, s.dragon).map((b) => b.name)).toEqual(['Book 2']);
    s.t = setArchived(s.t, s.empty, true);
    expect(viewProjects(s.t).map((p) => p.name)).toEqual(['Dragon Rider', 'The Lost King']);
  });
});

describe('resolving a scope', () => {
  it('keeps what was asked for while it still exists', () => {
    const s = studio();
    expect(resolveViewScope(s.t, { project: s.dragon, book: s.b2 })).toMatchObject({ project: s.dragon, book: s.b2, bookImplied: false, books: [s.b1, s.b2] });
    expect(resolveViewScope(s.t, { project: s.dragon, book: null })).toMatchObject({ project: s.dragon, book: null });
  });

  it('falls back to the first Project when nothing, or something gone, was asked for', () => {
    const s = studio();
    expect(resolveViewScope(s.t, null).project).toBe(s.dragon);
    expect(resolveViewScope(s.t, { project: 'gone' }).project).toBe(s.dragon);
    expect(resolveViewScope(s.t, { project: s.b1 }).project).toBe(s.dragon); // a Book is not a Project
    s.t = setArchived(s.t, s.dragon, true);
    expect(resolveViewScope(s.t, { project: s.dragon }).project).toBe(s.lost);
  });

  it('drops a Book that is not an open Book of the Project (another Project’s, archived, deeper, or gone)', () => {
    const s = studio();
    expect(resolveViewScope(s.t, { project: s.dragon, book: s.only }).book).toBeNull();
    expect(resolveViewScope(s.t, { project: s.dragon, book: s.sub }).book).toBeNull();
    expect(resolveViewScope(s.t, { project: s.dragon, book: 'gone' }).book).toBeNull();
    s.t = setArchived(s.t, s.b2, true);
    expect(resolveViewScope(s.t, { project: s.dragon, book: s.b2 })).toMatchObject({ book: s.b1, bookImplied: true }); // one Book left: it is implied
  });

  it('a Project with one open Book always has that Book, and a Project with none has none', () => {
    const s = studio();
    expect(resolveViewScope(s.t, { project: s.lost, book: null })).toMatchObject({ book: s.only, bookImplied: true, books: [s.only] });
    expect(resolveViewScope(s.t, { project: s.empty })).toMatchObject({ project: s.empty, book: null, bookImplied: false, books: [] });
  });

  it('is empty in a studio with no Projects', () => {
    expect(resolveViewScope(emptyTree(), { project: 'x', book: 'y' })).toEqual({ project: null, book: null, showClosed: false, books: [], closed: [], bookImplied: false });
  });

  it('is idempotent', () => {
    const s = studio();
    const once = resolveViewScope(s.t, { project: s.dragon, book: s.b1 });
    expect(sameViewScope(resolveViewScope(s.t, once), once)).toBe(true);
  });
});

describe('the scope that shows a given record', () => {
  it('a Project shows all its Books; a Book, or anything under it, shows that Book', () => {
    const s = studio();
    expect(viewScopeOf(s.t, s.dragon)).toEqual({ project: s.dragon, book: null });
    expect(viewScopeOf(s.t, s.b2)).toEqual({ project: s.dragon, book: s.b2 });
    expect(viewScopeOf(s.t, s.sub)).toEqual({ project: s.dragon, book: s.b2 });
  });

  it('is null for a record that is gone or under an archived Project', () => {
    const s = studio();
    expect(viewScopeOf(s.t, 'gone')).toBeNull();
    s.t = setArchived(s.t, s.dragon, true);
    expect(viewScopeOf(s.t, s.b1)).toBeNull();
  });
});

describe('what is inside a scope', () => {
  const s = studio();
  const all = { project: s.dragon, book: null };
  const book2 = { project: s.dragon, book: s.b2 };

  it('all books: the Project and everything under it, nothing else', () => {
    expect(inViewScope(s.t, all, s.dragon)).toBe(true);
    expect(inViewScope(s.t, all, s.b1)).toBe(true);
    expect(inViewScope(s.t, all, s.sub)).toBe(true);
    expect(inViewScope(s.t, all, s.lost)).toBe(false);
    expect(inViewScope(s.t, all, s.only)).toBe(false);
  });

  it('one Book: that Book and what is under it, plus the Project’s own (series-level) records, not the other Books', () => {
    expect(inViewScope(s.t, book2, s.b2)).toBe(true);
    expect(inViewScope(s.t, book2, s.sub)).toBe(true);
    expect(inViewScope(s.t, book2, s.dragon)).toBe(true);
    expect(inViewScope(s.t, book2, s.b1)).toBe(false);
    expect(inViewScope(s.t, book2, s.lost)).toBe(false);
  });

  it('a record of the studio itself, or no scope, is outside', () => {
    expect(inViewScope(s.t, all, null)).toBe(false);
    expect(inViewScope(s.t, { project: null, book: null }, s.dragon)).toBe(false);
  });
});

describe('closed Books', () => {
  it('are hidden from the scope unless closed Books are being shown', () => {
    const s = studio();
    const closed = new Set([s.b1]);
    expect(resolveViewScope(s.t, { project: s.dragon }, closed)).toMatchObject({ books: [s.b2], closed: [s.b1], showClosed: false, book: s.b2, bookImplied: true });
    expect(resolveViewScope(s.t, { project: s.dragon, showClosed: true }, closed)).toMatchObject({ books: [s.b1, s.b2], closed: [s.b1], showClosed: true, book: null, bookImplied: false });
  });

  it('a Book that becomes closed while chosen is dropped, unless closed Books are shown', () => {
    const s = studio();
    const closed = new Set([s.b2]);
    expect(resolveViewScope(s.t, { project: s.dragon, book: s.b2 }, closed).book).toBe(s.b1); // only Book 1 is left open: implied
    expect(resolveViewScope(s.t, { project: s.dragon, book: s.b2, showClosed: true }, closed).book).toBe(s.b2);
  });

  it('a Project whose Books are all closed offers none', () => {
    const s = studio();
    expect(resolveViewScope(s.t, { project: s.dragon }, new Set([s.b1, s.b2]))).toMatchObject({ books: [], closed: [s.b1, s.b2], book: null, bookImplied: false });
  });

  it('what is inside a closed Book is outside the scope, closed Books being hidden', () => {
    const s = studio();
    const hidden = resolveViewScope(s.t, { project: s.dragon }, new Set([s.b2]));
    expect(inViewScope(s.t, hidden, s.sub)).toBe(false); // "Cover art" sits under the closed Book 2
    expect(inViewScope(s.t, hidden, s.b2)).toBe(false);
    expect(inViewScope(s.t, hidden, s.b1)).toBe(true);
    expect(inViewScope(s.t, hidden, s.dragon)).toBe(true);
    const shown = resolveViewScope(s.t, { project: s.dragon, showClosed: true }, new Set([s.b2]));
    expect(inViewScope(s.t, shown, s.sub)).toBe(true);
  });

  it('a closed Book that is chosen (while shown) is inside its own scope', () => {
    const s = studio();
    const r = resolveViewScope(s.t, { project: s.dragon, book: s.b2, showClosed: true }, new Set([s.b2]));
    expect(inViewScope(s.t, r, s.b2)).toBe(true);
    expect(inViewScope(s.t, r, s.sub)).toBe(true);
  });
});

describe('where a project sits for the UI', () => {
  it('a Project, a Book, or something inside a Book', () => {
    const s = studio();
    expect(viewLevel(s.t, s.dragon)).toBe('project');
    expect(viewLevel(s.t, s.b1)).toBe('book');
    expect(viewLevel(s.t, s.sub)).toBe('inside');
    expect(viewLevel(s.t, 'gone')).toBeNull();
  });
});
