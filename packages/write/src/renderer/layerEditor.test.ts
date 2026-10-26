import { describe, expect, it } from 'vitest';
import { sanitizeAppDefaults } from '../shared/appDefaults';
import { layerEditor, type LayerState } from './layerEditor';

const inherited = sanitizeAppDefaults({ book: { author: 'App Author', copyright: { publisher: 'App Press' } } }).book;

/** An editor over a state that is updated in place, like a component would. */
function setup(initial: LayerState = { overrides: {} }, scope: 'project' | 'book' = 'project') {
  let state = initial;
  const make = () => layerEditor({ inherited, state, scope, origins: { 'copyright.publisher': 'project' }, onChange: (s) => (state = s) });
  return { editor: make, state: () => state };
}

describe('layerEditor', () => {
  it('shows the inherited values until a field is changed', () => {
    const { editor } = setup();
    expect(editor().details.author).toBe('App Author');
    expect(editor().isOwn('author')).toBe(false);
  });
  it('changing a field makes it this layer’s own, and only that field', () => {
    const { editor, state } = setup();
    editor().edit((d) => void (d.export.pdf.chapterSink = 0.4));
    expect(state().overrides).toEqual({ 'export.pdf.chapterSink': 0.4 });
    expect(editor().details.export.pdf.chapterSink).toBe(0.4);
    expect(editor().isOwn('export.pdf.chapterSink')).toBe(true);
  });
  it('set() works like edit() for a partial patch', () => {
    const { editor, state } = setup();
    editor().set({ author: 'Project Author' });
    expect(state().overrides).toEqual({ author: 'Project Author' });
  });
  it('reset hands a field back to what it inherits', () => {
    const { editor, state } = setup({ overrides: { author: 'Mine' } });
    expect(editor().details.author).toBe('Mine');
    editor().reset('author');
    expect(state().overrides).toEqual({});
    expect(editor().details.author).toBe('App Author');
    expect(editor().inheritedValue('author')).toBe('App Author');
  });
  it('an own field stays own even when edited back to the inherited value, until reset', () => {
    const { editor, state } = setup({ overrides: { author: 'Mine' } });
    editor().set({ author: 'App Author' });
    expect(state().overrides).toEqual({ author: 'App Author' });
  });
  it('says where an inherited field comes from', () => {
    const { editor } = setup();
    expect(editor().originOf('copyright.publisher')).toBe('project');
    expect(editor().originOf('author')).toBe('app');
  });
  it('a book layer also edits its own title and subtitle, which are not layered', () => {
    const { editor, state } = setup({ overrides: {}, identity: { title: 'T', subtitle: '', marked: true } }, 'book');
    editor().set({ title: 'New title', subtitle: 'Sub' });
    expect(state().identity).toEqual({ title: 'New title', subtitle: 'Sub', marked: true });
    expect(state().overrides).toEqual({});
    expect(editor().details.title).toBe('New title');
  });
});
