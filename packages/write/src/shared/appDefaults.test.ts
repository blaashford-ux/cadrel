import { describe, expect, it } from 'vitest';
import { bookFromDefaults, defaultAppDefaults, sanitizeAppDefaults } from './appDefaults';

describe('app defaults', () => {
  it('start at chapter level 1 with a blank-year, title-less template', () => {
    const d = defaultAppDefaults();
    expect(d.chapterLevel).toBe(1);
    expect(d.book.title).toBe('');
    expect(d.book.copyright.year).toBe('');
    expect(d.book.copyright.fictionDisclaimer).toBe(true);
  });

  it('sanitising anything yields valid defaults', () => {
    expect(sanitizeAppDefaults(null)).toEqual(defaultAppDefaults());
    expect(sanitizeAppDefaults('x')).toEqual(defaultAppDefaults());
    expect(sanitizeAppDefaults([])).toEqual(defaultAppDefaults());
    expect(sanitizeAppDefaults({ chapterLevel: 'two', book: 7 })).toEqual(defaultAppDefaults());
  });

  it('clamps the level and keeps valid template fields', () => {
    const d = sanitizeAppDefaults({
      chapterLevel: 9,
      book: { author: 'Pen Name', title: 'should go', subtitle: 'also', copyright: { year: '', publisher: 'Acme' }, back: { about: { enabled: true, text: 'Bio' } } }
    });
    expect(d.chapterLevel).toBe(6);
    expect(d.book.author).toBe('Pen Name');
    expect(d.book.title).toBe('');
    expect(d.book.subtitle).toBe('');
    expect(d.book.copyright).toMatchObject({ year: '', publisher: 'Acme' });
    expect(d.book.back.about).toMatchObject({ enabled: true, text: 'Bio' });
  });

  it('never carries per-book data into the template (excluded chapters, cover image)', () => {
    const d = sanitizeAppDefaults({ book: { export: { excludedChapters: ['x'], epub: { coverImage: 'C:/c.png' } } } });
    expect(d.book.export.excludedChapters).toEqual([]);
    expect(d.book.export.epub.coverImage).toBe('');
  });

  it('a new book is the template titled from its file, with the current year when the year is blank', () => {
    const t = sanitizeAppDefaults({ chapterLevel: 2, book: { author: 'Me', export: { pdf: { trim: '6x9' } }, dedication: { enabled: true, text: 'For you' } } });
    const b = bookFromDefaults(t, { title: 'my-novel', year: 2042 });
    expect(b).toMatchObject({ title: 'my-novel', author: 'Me', marked: true });
    expect(b.copyright.year).toBe('2042');
    expect(b.export.pdf.trim).toBe('6x9');
    expect(b.dedication).toEqual({ enabled: true, text: 'For you' });
  });

  it('a fixed template year is kept, and the template object is not mutated', () => {
    const t = sanitizeAppDefaults({ book: { copyright: { year: '2020' } } });
    const before = JSON.stringify(t);
    const b = bookFromDefaults(t, { title: 'x', year: 2042 });
    expect(b.copyright.year).toBe('2020');
    b.author = 'changed';
    expect(JSON.stringify(t)).toBe(before);
  });
});
