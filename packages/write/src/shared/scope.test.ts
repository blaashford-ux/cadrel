import { describe, expect, it } from 'vitest';
import { folderInScope, inScope, scopedFolderOf, scopedFolders, type ScopeLink, type WriteScope } from './scope';

const link = (ref: string, over: Partial<ScopeLink> = {}): ScopeLink => ({ module: 'write', ref, projectId: 'p', projectName: 'Dragon Rider', level: 'book', bookId: 'b', bookName: ref, closed: false, ...over });
const scope = (links: ScopeLink[]): WriteScope => ({ project: 'p', projectName: 'Dragon Rider', book: null, bookName: null, showClosed: false, links });

describe('the folders in scope', () => {
  it('is no restriction without a scope (Write on its own, or no projects yet)', () => {
    expect(scopedFolders(null)).toBeNull();
    expect(scopedFolders({ ...scope([]), project: null })).toBeNull();
    expect(inScope([{ path: '/w/A' }], null)).toHaveLength(1);
    expect(folderInScope('/w/Anything', null)).toBe(true);
  });

  it('lists the series first, then Books, then what is inside Books, naming each', () => {
    const f = scopedFolders(scope([link('Cover files', { level: 'inside', bookName: 'Ash', projectName: 'Cover' }), link('Ash'), link('Bible', { level: 'project', bookId: null, bookName: null }), link('Ember', { bookName: 'Book 1: Ember' })]))!;
    expect(f.map((x) => [x.folder, x.role, x.label])).toEqual([['Bible', 'series', 'Series'], ['Ash', 'book', 'Ash'], ['Ember', 'book', 'Book 1: Ember'], ['Cover files', 'inside', 'Cover']]);
  });

  it('puts closed Books last and marks them', () => {
    const f = scopedFolders(scope([link('Ember', { closed: true }), link('Ash'), link('Bible', { level: 'project', bookId: null })]))!;
    expect(f.map((x) => [x.folder, x.closed])).toEqual([['Bible', false], ['Ash', false], ['Ember', true]]);
  });

  it('ignores other modules’ records, and lists a folder once', () => {
    const f = scopedFolders(scope([link('dragon-fantasy', { module: 'market' }), link('Ash'), link('Ash')]))!;
    expect(f.map((x) => x.folder)).toEqual(['Ash']);
  });

  it('is an empty list (not no restriction) when the Project has no manuscripts linked', () => {
    expect(scopedFolders(scope([]))).toEqual([]);
  });

  it('keeps only the project folders that are in scope, matching by the folder name', () => {
    const f = scopedFolders(scope([link('Ash'), link('Ember')]));
    const all = [{ path: '/w/Ash' }, { path: 'C:\\Projects\\Ember' }, { path: '/w/Other' }];
    expect(inScope(all, f).map((x) => x.path)).toEqual(['/w/Ash', 'C:\\Projects\\Ember']);
    expect(folderInScope('/w/Other', f)).toBe(false);
    expect(scopedFolderOf('/w/Ash', f)?.role).toBe('book');
    expect(scopedFolderOf('/w/Other', f)).toBeUndefined();
  });
});
