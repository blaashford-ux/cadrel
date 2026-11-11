import { describe, expect, it } from 'vitest';
import type { AssignmentRecord, ProjectTree } from '@cadrel/kernel';
import { accessOn } from '../src/renderer/projectAccess';

const proj = (id: string, parentId: string | null) => ({ id, name: id, parentId, kind: 'Book', status: 'active' as const, order: 0, workflowId: null, stage: null, createdAt: '', updatedAt: '' });
// Series > Book 1 > Draft ; Series > Book 2
const tree = { projects: [proj('S', null), proj('B1', 'S'), proj('D', 'B1'), proj('B2', 'S')], links: [] } as unknown as ProjectTree;
const grant = (id: string, scope: AssignmentRecord['scope'], expiresAt: string | null = null): AssignmentRecord =>
  ({ id, studioId: 'st', subject: { kind: 'person', id: 'p1' }, roleId: 'role_author', scope, expiresAt, grantedBy: 'o', grantedAt: '' }) as AssignmentRecord;

describe('who holds a role on a project', () => {
  it('counts roles given on it, above it and for the whole Studio, closest first, and not those below it, elsewhere or on a file', () => {
    const list = [
      grant('studio', { kind: 'studio', id: 'st' }),
      grant('series', { kind: 'project', id: 'S' }),
      grant('here', { kind: 'project', id: 'B1' }),
      grant('below', { kind: 'project', id: 'D' }),
      grant('other', { kind: 'project', id: 'B2' }),
      grant('file', { kind: 'file', id: 'f1' }),
      grant('otherstudio', { kind: 'studio', id: 'someone-else' })
    ];
    const got = accessOn(tree, list, 'B1', 'st');
    expect(got.map((h) => [h.assignment.id, h.source, h.from])).toEqual([['here', 'here', null], ['series', 'above', 'S'], ['studio', 'studio', null]]);
    // one level down, Book 1's role now comes from above too
    expect(accessOn(tree, list, 'D', 'st').map((h) => [h.assignment.id, h.source])).toEqual([['below', 'here'], ['series', 'above'], ['here', 'above'], ['studio', 'studio']]);
  });

  it('leaves out a role that has ended, and a project that is not there', () => {
    const list = [grant('ended', { kind: 'project', id: 'B1' }, '2020-01-01T00:00:00.000Z'), grant('live', { kind: 'project', id: 'B1' }, '2999-01-01T00:00:00.000Z')];
    expect(accessOn(tree, list, 'B1', 'st').map((h) => h.assignment.id)).toEqual(['live']);
    expect(accessOn(tree, list, 'nope', 'st')).toEqual([]);
  });
});
