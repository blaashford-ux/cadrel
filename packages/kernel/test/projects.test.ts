import { describe, expect, it } from 'vitest';
import {
  ancestorsOf, childrenOf, createProject, deleteProject, descendantsOf, emptyTree, kindLabel, linkRecord, moveProject, outline, pathOf,
  projectFor, projectsFor, relinkRecord, scopePathFor, sanitizeTree, setArchived, subtreeIds, unlinkRecord, updateProject, type ProjectTree
} from '../src/projects';

function build() {
  let t: ProjectTree = emptyTree();
  const add = (name: string, parentId: string | null = null, kind?: string) => {
    const r = createProject(t, { name, parentId, kind });
    t = r.tree;
    return r.project.id;
  };
  const series = add('Dragon Rider', null, 'Series');
  const b1 = add('Book 1', series, 'Book');
  const b2 = add('Book 2', series, 'Book');
  const solo = add('Standalone');
  return { get t() { return t; }, set t(v) { t = v; }, series, b1, b2, solo };
}

describe('project tree', () => {
  it('nests to any depth and orders siblings as created', () => {
    const s = build();
    expect(childrenOf(s.t, s.series).map((p) => p.name)).toEqual(['Book 1', 'Book 2']);
    expect(childrenOf(s.t, null).map((p) => p.name)).toEqual(['Dragon Rider', 'Standalone']);
    const deep = createProject(s.t, { name: 'Prologue', parentId: s.b1 });
    expect(pathOf(deep.tree, deep.project.id)).toBe('Dragon Rider / Book 1 / Prologue');
    expect(ancestorsOf(deep.tree, deep.project.id).map((p) => p.name)).toEqual(['Dragon Rider', 'Book 1']);
    expect(descendantsOf(deep.tree, s.series).map((p) => p.name)).toEqual(['Book 1', 'Book 2', 'Prologue']);
    expect(subtreeIds(deep.tree, s.b1)).toEqual([s.b1, deep.project.id]);
  });

  it('needs a name, and keeps names unique among siblings only', () => {
    const s = build();
    expect(() => createProject(s.t, { name: '   ' })).toThrow(/needs a name/);
    expect(() => createProject(s.t, { name: 'book 1', parentId: s.series })).toThrow(/already exists/);
    expect(() => createProject(s.t, { name: 'Book 1', parentId: s.solo })).not.toThrow();
    expect(() => updateProject(s.t, s.b2, { name: 'Book 1' })).toThrow(/already exists/);
    expect(() => createProject(s.t, { name: 'x', parentId: 'nope' })).toThrow(/no project/);
  });

  it('labels kinds, defaulting by position', () => {
    const s = build();
    expect(kindLabel(s.t, s.t.projects.find((p) => p.id === s.series)!)).toBe('Series');
    const plain = createProject(s.t, { name: 'Plain' });
    expect(kindLabel(plain.tree, plain.project)).toBe('Project');
    const sub = createProject(plain.tree, { name: 'Sub', parentId: plain.project.id });
    expect(kindLabel(sub.tree, sub.project)).toBe('Subproject');
  });

  it('renames and re-kinds', () => {
    const s = build();
    s.t = updateProject(s.t, s.b1, { name: 'The First Book', kind: 'Novel' });
    const p = s.t.projects.find((x) => x.id === s.b1)!;
    expect([p.name, p.kind]).toEqual(['The First Book', 'Novel']);
  });

  it('moves a project under another or to the top, and at a position', () => {
    const s = build();
    s.t = moveProject(s.t, s.solo, s.series, 0);
    expect(childrenOf(s.t, s.series).map((p) => p.name)).toEqual(['Standalone', 'Book 1', 'Book 2']);
    s.t = moveProject(s.t, s.b2, null);
    expect(childrenOf(s.t, null).map((p) => p.name)).toEqual(['Dragon Rider', 'Book 2']);
    expect(childrenOf(s.t, s.series).map((p) => p.order)).toEqual([0, 1]);
  });

  it('refuses to move a project into itself or its own subprojects, or onto a clashing name', () => {
    const s = build();
    expect(() => moveProject(s.t, s.series, s.b1)).toThrow(/into itself/);
    expect(() => moveProject(s.t, s.series, s.series)).toThrow(/into itself/);
    const clash = createProject(s.t, { name: 'Book 1' });
    expect(() => moveProject(clash.tree, clash.project.id, s.series)).toThrow(/already exists/);
  });

  it('archives with everything below, restores one level at a time', () => {
    const s = build();
    s.t = setArchived(s.t, s.series, true);
    expect(s.t.projects.filter((p) => p.status === 'archived').map((p) => p.name).sort()).toEqual(['Book 1', 'Book 2', 'Dragon Rider']);
    expect(outline(s.t).map((r) => r.project.name)).toEqual(['Standalone']);
    expect(outline(s.t, { archived: true })).toHaveLength(4);
    expect(() => setArchived(s.t, s.b1, false)).toThrow(/parent/);
    expect(() => createProject(s.t, { name: 'Book 3', parentId: s.series })).toThrow(/archived/);
    s.t = setArchived(s.t, s.series, false);
    expect(s.t.projects.find((p) => p.id === s.series)!.status).toBe('active');
    expect(s.t.projects.find((p) => p.id === s.b1)!.status).toBe('archived');
  });

  it('outline gives depth and whether a row has children', () => {
    const s = build();
    expect(outline(s.t).map((r) => [r.project.name, r.depth, r.hasChildren])).toEqual([
      ['Dragon Rider', 0, true], ['Book 1', 1, false], ['Book 2', 1, false], ['Standalone', 0, false]
    ]);
  });

  it('deletes a leaf, and a branch only on request, taking its links', () => {
    const s = build();
    s.t = linkRecord(s.t, s.b1, 'write', 'Dragon Rider 1');
    expect(() => deleteProject(s.t, s.series)).toThrow(/2 subprojects/);
    const leaf = deleteProject(s.t, s.b1);
    expect(leaf.removed).toEqual([s.b1]);
    expect(leaf.tree.links).toEqual([]);
    const all = deleteProject(s.t, s.series, { cascade: true });
    expect(all.removed.sort()).toEqual([s.series, s.b1, s.b2].sort());
    expect(all.tree.projects.map((p) => p.name)).toEqual(['Standalone']);
  });

  it('links a module record to one project; linking again moves it', () => {
    const s = build();
    s.t = linkRecord(s.t, s.b1, 'write', 'DR1');
    s.t = linkRecord(s.t, s.series, 'market', 'epic-fantasy');
    expect(projectFor(s.t, 'write', 'DR1')?.id).toBe(s.b1);
    s.t = linkRecord(s.t, s.b2, 'write', 'DR1');
    expect(projectFor(s.t, 'write', 'DR1')?.id).toBe(s.b2);
    expect(s.t.links).toHaveLength(2);
    s.t = relinkRecord(s.t, 'write', 'DR1', 'Dragon Rider 1');
    expect(projectFor(s.t, 'write', 'Dragon Rider 1')?.id).toBe(s.b2);
    s.t = unlinkRecord(s.t, 'write', 'Dragon Rider 1');
    expect(projectFor(s.t, 'write', 'Dragon Rider 1')).toBeUndefined();
    expect(() => linkRecord(s.t, 'nope', 'write', 'x')).toThrow();
  });

  it('lets a Market category belong to several projects, and unlinks it from one at a time', () => {
    const s = build();
    s.t = linkRecord(s.t, s.b1, 'market', 'epic-fantasy');
    s.t = linkRecord(s.t, s.b2, 'market', 'epic-fantasy'); // kept in book 1 as well
    s.t = linkRecord(s.t, s.b2, 'market', 'epic-fantasy'); // not doubled
    expect(projectsFor(s.t, 'market', 'epic-fantasy').map((p) => p.id).sort()).toEqual([s.b1, s.b2].sort());
    expect(s.t.links).toHaveLength(2);
    s.t = unlinkRecord(s.t, 'market', 'epic-fantasy', s.b1);
    expect(projectsFor(s.t, 'market', 'epic-fantasy').map((p) => p.id)).toEqual([s.b2]);
    s.t = linkRecord(s.t, s.b1, 'market', 'epic-fantasy');
    s.t = unlinkRecord(s.t, 'market', 'epic-fantasy'); // without a project: from all of them
    expect(projectsFor(s.t, 'market', 'epic-fantasy')).toEqual([]);
    // a manuscript still has one project only
    s.t = linkRecord(s.t, s.b1, 'write', 'DR1');
    s.t = linkRecord(s.t, s.b2, 'write', 'DR1');
    expect(projectsFor(s.t, 'write', 'DR1').map((p) => p.id)).toEqual([s.b2]);
  });

  it('keeps every project’s link to a shared category when a saved tree is read back, and one per manuscript', () => {
    const t = sanitizeTree({
      projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      links: [
        { projectId: 'a', module: 'market', ref: 'fantasy' }, { projectId: 'b', module: 'market', ref: 'fantasy' }, { projectId: 'a', module: 'market', ref: 'fantasy' },
        { projectId: 'a', module: 'write', ref: 'X' }, { projectId: 'b', module: 'write', ref: 'X' }
      ]
    });
    expect(t.links.map((l) => `${l.projectId}:${l.module}:${l.ref}`)).toEqual(['a:market:fantasy', 'b:market:fantasy', 'a:write:X']);
  });

  it('gives the permission scope path of a project: studio, then each project down to it', () => {
    const s = build();
    expect(scopePathFor(s.t, s.b1)).toEqual([{ kind: 'studio', id: 'studio' }, { kind: 'project', id: s.series }, { kind: 'project', id: s.b1 }]);
    expect(scopePathFor(s.t, s.solo, 's1')).toEqual([{ kind: 'studio', id: 's1' }, { kind: 'project', id: s.solo }]);
  });

  it('sanitizeTree survives garbage, orphans, cycles and double claims', () => {
    expect(sanitizeTree(null)).toEqual({ projects: [], links: [] });
    expect(sanitizeTree('x')).toEqual({ projects: [], links: [] });
    const t = sanitizeTree({
      projects: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'c', name: 'C', parentId: 'ghost' },
        { id: 'a', name: 'dupe' },
        { name: 'no id' },
        { id: 'd', name: 'D', status: 'weird', kind: '  Book  ' }
      ],
      links: [
        { projectId: 'a', module: 'write', ref: 'X' },
        { projectId: 'b', module: 'write', ref: 'X' },
        { projectId: 'zzz', module: 'write', ref: 'Y' },
        { projectId: 'a', module: 'write' }
      ]
    });
    expect(t.projects.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.projects.find((p) => p.id === 'c')!.parentId).toBeNull();
    // exactly one of the cycle's edges is cut
    expect(t.projects.filter((p) => p.id === 'a' || p.id === 'b').filter((p) => p.parentId === null)).toHaveLength(1);
    expect(t.projects.find((p) => p.id === 'd')).toMatchObject({ status: 'active', kind: 'Book' });
    expect(t.links).toEqual([{ projectId: 'a', module: 'write', ref: 'X' }]);
    // and the result is a usable tree
    expect(() => outline(t)).not.toThrow();
  });
});
