import { describe, expect, it } from 'vitest';
import { sanitizeAppDefaults } from '../appDefaults';
import { applyOverrides, diffOverrides, getPath, LEAF_PATHS, overridesFromLegacyBook, pathLabel, pickOverrides, resolveInherited, sanitizeOverrides, valueLabel } from './layers';
import { defaultBookDetails } from './model';

const app = (book: Record<string, unknown> = {}) => sanitizeAppDefaults({ book }).book;

describe('field paths', () => {
  it('cover every setting except the book’s identity, with lists as single fields', () => {
    expect(LEAF_PATHS).toContain('export.pdf.chapterSink');
    expect(LEAF_PATHS).toContain('back.links.items');
    expect(LEAF_PATHS).toContain('copyright.extraLines');
    expect(LEAF_PATHS).not.toContain('title');
    expect(LEAF_PATHS).not.toContain('marked');
    expect(LEAF_PATHS.some((p) => p.startsWith('back.links.items.'))).toBe(false);
  });
});

describe('applyOverrides / sanitizeOverrides', () => {
  it('lays only the named fields over the base, validated', () => {
    const d = applyOverrides(app(), { 'export.pdf.fontSize': 12, 'back.about.text': 'Bio', 'export.pdf.chapterSink': 99, nonsense: 1 });
    expect(d.export.pdf.fontSize).toBe(12);
    expect(d.back.about.text).toBe('Bio');
    expect(d.export.pdf.chapterSink).toBe(3); // clamped
    expect(d.export.pdf.trim).toBe(defaultBookDetails().export.pdf.trim);
  });
  it('does not touch the base', () => {
    const base = app();
    applyOverrides(base, { author: 'X' });
    expect(base.author).toBe('');
  });
  it('drops unknown paths and bad values from untrusted input', () => {
    expect(sanitizeOverrides({ author: 'A', 'nope.x': 1, 'export.pdf.fontSize': 'big' })).toEqual({ author: 'A', 'export.pdf.fontSize': defaultBookDetails().export.pdf.fontSize });
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([1])).toEqual({});
  });
});

describe('diff / pick', () => {
  it('diffOverrides lists the fields that differ', () => {
    const a = app();
    const b = structuredClone(a);
    b.author = 'Z';
    b.export.pdf.runningHead = 'title';
    expect(diffOverrides(a, b)).toEqual({ author: 'Z', 'export.pdf.runningHead': 'title' });
  });
  it('pickOverrides copies the named fields’ values', () => {
    const d = defaultBookDetails({ author: 'Q' });
    expect(pickOverrides(d, ['author', 'bogus'])).toEqual({ author: 'Q' });
  });
  it('getPath reads nested fields', () => {
    expect(getPath(defaultBookDetails(), 'export.pdf.trim')).toBe('5.5x8.5');
  });
});

describe('resolveInherited', () => {
  it('app settings, then the project’s fields, with origins', () => {
    const r = resolveInherited(app({ author: 'App', copyright: { publisher: 'App Press' } }), { author: 'Project', 'export.pdf.fontSize': 10 });
    expect(r.details.author).toBe('Project');
    expect(r.details.copyright.publisher).toBe('App Press');
    expect(r.details.export.pdf.fontSize).toBe(10);
    expect(r.origins.author).toBe('project');
    expect(r.origins['copyright.publisher']).toBe('app');
  });
  it('a project never supplies book-only fields; a blank year means this year', () => {
    const r = resolveInherited(app(), { 'export.excludedChapters': ['x'], 'export.epub.coverImage': '/c.png' }, new Date('2030-05-01T00:00:00Z'));
    expect(r.details.export.excludedChapters).toEqual([]);
    expect(r.details.export.epub.coverImage).toBe('');
    expect(r.details.copyright.year).toBe('2030');
    expect(r.details.title).toBe('');
  });
});

describe('legacy project books', () => {
  it('keep what differs from the built-in app defaults', () => {
    const old = defaultBookDetails({ author: 'Project Author', year: 2020 });
    old.copyright.year = '';
    old.export.pdf.chapterSink = 0.5;
    old.title = 'ignored';
    expect(overridesFromLegacyBook(old)).toEqual({ author: 'Project Author', 'export.pdf.chapterSink': 0.5 });
  });
});

describe('labels', () => {
  it('names fields readably', () => {
    expect(pathLabel('export.pdf.chapterSink')).toBe('PDF › Chapter sink');
    expect(pathLabel('back.about.text')).toBe('Back matter › About › Text');
    expect(pathLabel('author')).toBe('Author');
    expect(valueLabel(true)).toBe('On');
    expect(valueLabel([])).toBe('None');
    expect(valueLabel(['a', 'b'])).toBe('2 items');
    expect(valueLabel('')).toBe('(blank)');
  });
});
