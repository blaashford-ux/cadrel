import { describe, expect, it } from 'vitest';
import { appliesTo } from '../src/renderer/associationText';
import type { ProjectTree } from '@cadrel/kernel';

const tree = {
  projects: [
    { id: 's', name: 'Dragon Rider', parentId: null, status: 'active' },
    { id: 'b1', name: 'Book 1', parentId: 's', status: 'active' }
  ],
  links: []
} as unknown as ProjectTree;

describe('where an association applies', () => {
  it('says "the whole project" for the project itself and "this book" for a book', () => {
    expect(appliesTo(tree, 's', 's')).toBe('the whole project');
    expect(appliesTo(tree, 'b1', 'b1')).toBe('this book');
  });
  it('names the book when the project page shows a book’s association', () => {
    expect(appliesTo(tree, 'b1', 's')).toBe('Book 1');
  });
});
