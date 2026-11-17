import { describe, expect, it } from 'vitest';
import { lockBadge } from './FileLockBadge';
import { rowsFiles } from './treeRows';

describe('check-out icon', () => {
  it('draws nothing where a file has no check-out', () => {
    expect(lockBadge(undefined)).toBeNull();
    expect(lockBadge({ kind: 'unmanaged' })).toBeNull();
  });
  it('is an open padlock when checked in, closed when checked out, and names who', () => {
    expect(lockBadge({ kind: 'free', version: 3 })).toMatchObject({ icon: 'unlock', cls: 'in' });
    expect(lockBadge({ kind: 'mine', version: 3, since: '', changed: false })).toMatchObject({ icon: 'lock', cls: 'mine', text: 'Checked out by you' });
    const o = lockBadge({ kind: 'other', version: 3, by: 'Ann', since: '2026-11-01T00:00:00Z' });
    expect(o).toMatchObject({ icon: 'lock', cls: 'other' });
    expect(o!.text).toMatch(/^Checked out by Ann since /);
  });
  it('asks about every editable file in the tree but not web pages', () => {
    const root = { kind: 'dir' as const, name: 'p', path: '/p', children: [{ kind: 'file' as const, name: 'a.md', path: '/p/a.md' }, { kind: 'file' as const, name: 'r.html', path: '/p/r.html', html: true }, { kind: 'dir' as const, name: 'd', path: '/p/d', children: [{ kind: 'file' as const, name: 'b.md', path: '/p/d/b.md' }] }] };
    expect(rowsFiles(root)).toEqual(['/p/a.md', '/p/d/b.md']);
  });
});
