import { describe, expect, it } from 'vitest';
import type { DirNode } from '../shared/api';
import { splitChapters } from '../shared/chapters';
import { buildRows, filterTree, navigate } from './treeRows';

const tree: DirNode = {
  kind: 'dir', name: 'root', path: '/r',
  children: [
    { kind: 'dir', name: 'Book', path: '/r/Book', children: [
      { kind: 'file', name: 'story.md', path: '/r/Book/story.md' },
      { kind: 'file', name: 'notes.md', path: '/r/Book/notes.md' }
    ] },
    { kind: 'file', name: 'readme.md', path: '/r/readme.md' },
    { kind: 'dir', name: 'Drafts', path: '/r/Drafts', children: [] }
  ]
};
const docs = new Map([['/r/Book/story.md', splitChapters('intro words\n# One\na b c\n# Two\nd\n')]]);

describe('buildRows', () => {
  it('shows only top level when nothing is expanded', () => {
    expect(buildRows(tree, new Set(), docs, '').map((r) => r.label)).toEqual(['Book', 'readme.md', 'Drafts']);
  });

  it('nests folders, files and chapters with depth, parents and word counts', () => {
    const rows = buildRows(tree, new Set(['/r/Book', '/r/Book/story.md']), docs, '');
    expect(rows.map((r) => [r.label, r.depth])).toEqual([
      ['Book', 0], ['story.md', 1], ['(Preamble)', 2], ['One', 2], ['Two', 2], ['notes.md', 1], ['readme.md', 0], ['Drafts', 0]
    ]);
    const one = rows.find((r) => r.label === 'One')!;
    expect(one).toMatchObject({ kind: 'chapter', chapter: 1, parentKey: '/r/Book/story.md', words: 4 });
  });

  it('filters by file name, auto-expanding the folders that lead to matches', () => {
    const rows = buildRows(tree, new Set(), docs, 'STORY');
    expect(rows.map((r) => r.label)).toEqual(['Book', 'story.md']);
    expect(buildRows(tree, new Set(), docs, 'zzz')).toEqual([]);
  });

  it('shows empty folders without an expand arrow, even if marked expanded', () => {
    const rows = buildRows(tree, new Set(['/r/Drafts']), docs, '');
    const drafts = rows.find((r) => r.label === 'Drafts')!;
    expect(drafts).toMatchObject({ kind: 'dir', expandable: false, expanded: false });
    expect(rows[rows.length - 1]).toBe(drafts); // no phantom children
  });

  it('a filter also matches folder names, keeping an empty folder that matches', () => {
    expect(buildRows(tree, new Set(), docs, 'draft').map((r) => r.label)).toEqual(['Drafts']);
    expect(buildRows(tree, new Set(), docs, 'book').map((r) => r.label)).toEqual(['Book', 'story.md', 'notes.md']);
  });

  it('carries the export mark onto file rows only', () => {
    const t: DirNode = {
      kind: 'dir', name: 'r', path: '/r',
      children: [
        { kind: 'file', name: 'a.md', path: '/r/a.md', marked: true },
        { kind: 'file', name: 'b.md', path: '/r/b.md', marked: false },
        { kind: 'file', name: 'c.md', path: '/r/c.markdown', exportBlocked: true },
        { kind: 'file', name: 'd.md', path: '/r/d.md' }
      ]
    };
    const rows = buildRows(t, new Set(), new Map(), '');
    expect(rows.map((r) => [r.label, r.marked ?? false, r.exportBlocked ?? false])).toEqual([
      ['a.md', true, false], ['b.md', false, false], ['c.md', false, true], ['d.md', false, false]
    ]);
  });

  it('filterTree leaves the tree alone for an empty query', () => {
    expect(filterTree(tree, '  ')).toBe(tree);
  });
});

describe('navigate (arrow-key tree behaviour)', () => {
  const rows = buildRows(tree, new Set(['/r/Book', '/r/Book/story.md']), docs, '');
  const keyOf = (label: string) => rows.find((r) => r.label === label)!.key;

  it('moves up/down and clamps at the ends; Home/End jump', () => {
    expect(navigate(rows, keyOf('Book'), 'ArrowDown').focus).toBe(keyOf('story.md'));
    expect(navigate(rows, keyOf('Book'), 'ArrowUp').focus).toBe(keyOf('Book'));
    expect(navigate(rows, keyOf('Drafts'), 'ArrowDown').focus).toBe(keyOf('Drafts'));
    expect(navigate(rows, keyOf('One'), 'Home').focus).toBe(keyOf('Book'));
    expect(navigate(rows, keyOf('One'), 'End').focus).toBe(keyOf('Drafts'));
  });

  it('Right expands a closed node, then enters it; Left collapses, then goes to the parent', () => {
    expect(navigate(rows, keyOf('readme.md'), 'ArrowRight')).toEqual({ expand: keyOf('readme.md') });
    expect(navigate(rows, keyOf('Book'), 'ArrowRight').focus).toBe(keyOf('story.md'));
    expect(navigate(rows, keyOf('Book'), 'ArrowLeft')).toEqual({ collapse: keyOf('Book') });
    expect(navigate(rows, keyOf('One'), 'ArrowLeft').focus).toBe(keyOf('story.md'));
    expect(navigate(rows, keyOf('notes.md'), 'ArrowLeft').focus).toBe(keyOf('Book'));
  });

  it('Right/Left on an empty folder do nothing special', () => {
    expect(navigate(rows, keyOf('Drafts'), 'ArrowRight')).toEqual({});
    expect(navigate(rows, keyOf('Drafts'), 'ArrowLeft')).toEqual({});
  });

  it('Enter activates the focused row; empty tree is a no-op', () => {
    expect(navigate(rows, keyOf('Two'), 'Enter')).toEqual({ activate: keyOf('Two') });
    expect(navigate([], null, 'ArrowDown')).toEqual({});
  });
});
