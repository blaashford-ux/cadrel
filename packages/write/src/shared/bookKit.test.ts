import { describe, expect, it } from 'vitest';
import type { AuthorKitBook } from './api';
import { addAlsoBy, alsoByCandidates, insertText, onAlsoBy } from './bookKit';

const book = (title: string, o: Partial<AuthorKitBook> = {}): AuthorKitBook => ({ asin: `B0${title.length}`, title, url: `https://www.amazon.com/dp/${title}`, penNames: ['Ann Pen'], series: null, position: null, ...o });
const books = [
  book('Standalone'), book('Saga 2', { series: 'Saga', position: 2 }), book('Saga 1', { series: 'Saga', position: 1 }), book('Other Name', { penNames: ['Bea Pen'] }), book('Current')
];

describe('inserting a saved block', () => {
  it('fills an empty field and follows existing text after a blank line', () => {
    expect(insertText('', '  For Mum.  ')).toBe('For Mum.');
    expect(insertText('   ', 'x')).toBe('x');
    expect(insertText('One.\n', 'Two.')).toBe('One.\n\nTwo.');
  });
});

describe('Also by, from My Books', () => {
  it('offers the books under this author’s name in series order, without the book being made', () => {
    expect(alsoByCandidates(books, { author: ' ann  pen', title: 'Current' }).map((b) => b.title)).toEqual(['Saga 1', 'Saga 2', 'Standalone']);
  });
  it('offers every book when asked, or when none carry the name', () => {
    expect(alsoByCandidates(books, { author: 'Ann Pen', title: 'Current', all: true })).toHaveLength(4);
    expect(alsoByCandidates(books, { author: 'Nobody', title: 'Current' })).toHaveLength(4);
  });
  it('adds the chosen books once, with their links, and never twice', () => {
    const chosen = alsoByCandidates(books, { author: 'Ann Pen', title: 'Current' });
    const first = addAlsoBy([{ title: 'saga 1', url: '', blurb: 'kept' }], chosen);
    expect(first.map((i) => i.title)).toEqual(['saga 1', 'Saga 2', 'Standalone']);
    expect(first[0]!.blurb).toBe('kept');
    expect(first[1]).toEqual({ title: 'Saga 2', url: 'https://www.amazon.com/dp/Saga 2', blurb: '', cover: '' });
    const withCard = addAlsoBy([], [chosen[0]!], [{ cover: 'data:image/jpeg;base64,AA==', blurb: 'A blurb.' }]);
    expect(withCard[0]).toMatchObject({ blurb: 'A blurb.', cover: 'data:image/jpeg;base64,AA==' });
    expect(addAlsoBy(first, chosen)).toEqual(first);
    expect(onAlsoBy(first, chosen[2]!)).toBe(true);
    expect(onAlsoBy([], chosen[2]!)).toBe(false);
  });
});
