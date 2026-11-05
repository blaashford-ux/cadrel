import { describe, expect, it } from 'vitest';
import { createProject, defaultRoles, emptyTree, linkRecord, projectVisibility, visibleTree, type Assignment, type PermissionContext, type ProjectTree } from '../src';

const roles = new Map(defaultRoles().map((r) => [r.id, r]));
const NOW = '2026-10-24T00:00:00Z';

function world() {
  let t: ProjectTree = emptyTree();
  const add = (name: string, parentId: string | null = null) => {
    const r = createProject(t, { name, parentId });
    t = r.tree;
    return r.project.id;
  };
  const ser = add('Dragon Rider');
  const b1 = add('Book 1', ser);
  const b2 = add('Book 2', ser);
  const solo = add('Secret');
  t = linkRecord(t, b2, 'write', 'Ash');
  t = linkRecord(t, solo, 'write', 'Hush');
  return { t, ser, b1, b2, solo };
}
const ctx = (assignments: Assignment[], teamIds: string[] = []): PermissionContext => ({ actor: { personId: 'p1', teamIds }, assignments, roles, now: NOW });
const give = (id: string, roleKey: string, scope: { kind: 'studio' | 'project'; id: string }, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { kind: 'person', id: 'p1' }, roleId: `role_${roleKey}`, scope, ...extra });

describe('which projects a person can see', () => {
  it('sees none until assigned, even with a studio-wide role', () => {
    const w = world();
    const v = projectVisibility(w.t, ctx([give('a', 'editor', { kind: 'studio', id: 's' })]), 's');
    expect(v.all).toBe(false);
    expect(v.visible.size).toBe(0);
    expect(visibleTree(w.t, v)).toEqual({ projects: [], links: [] });
  });

  it('a role on a Project reaches its Books; a role on a Book reaches that Book and shows the Project only as a container', () => {
    const w = world();
    const onSeries = projectVisibility(w.t, ctx([give('a', 'author', { kind: 'project', id: w.ser })]), 's');
    expect([...onSeries.assigned].sort()).toEqual([w.ser, w.b1, w.b2].sort());
    expect(onSeries.visible.has(w.solo)).toBe(false);

    const onBook = projectVisibility(w.t, ctx([give('a', 'author', { kind: 'project', id: w.b1 })]), 's');
    expect([...onBook.assigned]).toEqual([w.b1]);
    expect([...onBook.context]).toEqual([w.ser]);
    expect(onBook.visible.has(w.b2)).toBe(false);
    const seen = visibleTree(w.t, onBook);
    expect(seen.projects.map((p) => p.name).sort()).toEqual(['Book 1', 'Dragon Rider']);
    expect(seen.links).toEqual([]); // Book 2's and Secret's manuscripts are not in what this person sees
  });

  it('keeps the links of what is visible, and drops the rest', () => {
    const w = world();
    const v = projectVisibility(w.t, ctx([give('a', 'author', { kind: 'project', id: w.b2 })]), 's');
    expect(visibleTree(w.t, v).links).toEqual([{ projectId: w.b2, module: 'write', ref: 'Ash' }]);
  });

  it('a role given to a team the person is in counts; an expired one does not', () => {
    const w = world();
    const viaTeam: Assignment = { id: 't', subject: { kind: 'team', id: 'crew' }, roleId: 'role_editor', scope: { kind: 'project', id: w.solo } };
    expect(projectVisibility(w.t, ctx([viaTeam], ['crew']), 's').visible.has(w.solo)).toBe(true);
    expect(projectVisibility(w.t, ctx([viaTeam], []), 's').visible.has(w.solo)).toBe(false);
    expect(projectVisibility(w.t, ctx([give('x', 'editor', { kind: 'project', id: w.solo }, { expiresAt: '2026-01-01T00:00:00Z' })]), 's').visible.size).toBe(0);
  });

  it('the Owner and an Admin see every project; other studio-wide roles do not', () => {
    const w = world();
    for (const key of ['owner', 'admin']) {
      const v = projectVisibility(w.t, ctx([give('a', key, { kind: 'studio', id: 's' })]), 's');
      expect(v.all).toBe(true);
      expect(v.visible.size).toBe(w.t.projects.length);
      expect(visibleTree(w.t, v)).toBe(w.t);
    }
    for (const key of ['director', 'marketing', 'guest']) expect(projectVisibility(w.t, ctx([give('a', key, { kind: 'studio', id: 's' })]), 's').all).toBe(false);
  });

  it('ignores an assignment to a project that no longer exists', () => {
    const w = world();
    expect(projectVisibility(w.t, ctx([give('a', 'author', { kind: 'project', id: 'gone' })]), 's').visible.size).toBe(0);
  });
});
