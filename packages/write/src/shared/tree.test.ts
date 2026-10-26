import { describe, expect, it } from 'vitest';
import type { DirNode } from './api';
import { collectFiles, collectOrphans, flattenPaths } from './tree';

describe('flattenPaths', () => {
  it('collects the root, nested folders and files', () => {
    const tree: DirNode = {
      kind: 'dir', name: 'r', path: '/r',
      children: [
        { kind: 'dir', name: 'a', path: '/r/a', children: [{ kind: 'file', name: 'x.md', path: '/r/a/x.md' }] },
        { kind: 'file', name: 'y.md', path: '/r/y.md' }
      ]
    };
    expect([...flattenPaths(tree)].sort()).toEqual(['/r', '/r/a', '/r/a/x.md', '/r/y.md']);
  });
});

describe('collectFiles / collectOrphans', () => {
  const tree: DirNode = {
    kind: 'dir', name: 'r', path: '/r', orphanSidecars: ['/r/old.export.json'],
    children: [
      { kind: 'dir', name: 'a', path: '/r/a', orphanSidecars: ['/r/a/x.export.json'], children: [{ kind: 'file', name: 'x.md', path: '/r/a/x.md', marked: true }] },
      { kind: 'file', name: 'y.md', path: '/r/y.md', marked: false },
      { kind: 'file', name: 'z.md', path: '/r/z.md' }
    ]
  };
  it('finds marked files at any depth', () => {
    expect(collectFiles(tree, (f) => f.marked === true).map((f) => f.path)).toEqual(['/r/a/x.md']);
  });
  it('finds orphaned sidecars at any depth', () => {
    expect(collectOrphans(tree)).toEqual(['/r/old.export.json', '/r/a/x.export.json']);
  });
});
