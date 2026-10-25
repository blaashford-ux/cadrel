import { describe, expect, it } from 'vitest';
import { formatChapterHeading, numberToWords } from './headings';

describe('numberToWords', () => {
  it.each([[1, 'One'], [12, 'Twelve'], [20, 'Twenty'], [21, 'Twenty-One'], [99, 'Ninety-Nine'], [100, 'One Hundred'], [101, 'One Hundred One'], [342, 'Three Hundred Forty-Two']])(
    '%i → %s',
    (n, w) => expect(numberToWords(n)).toBe(w)
  );
  it('leaves out-of-range numbers as digits', () => expect(numberToWords(1000)).toBe('1000'));
});

describe('formatChapterHeading', () => {
  it('verbatim keeps the heading exactly as written', () => {
    expect(formatChapterHeading('Chapter 1: Coming Back', 'verbatim')).toEqual({ prefix: 'Chapter 1: Coming Back', rest: null, plain: 'Chapter 1: Coming Back' });
  });
  it('numberWord splits "Chapter N: Title" into a word prefix and an italic title', () => {
    expect(formatChapterHeading('Chapter 12: Coming Back', 'numberWord')).toEqual({ prefix: 'Chapter Twelve', rest: 'Coming Back', plain: 'Chapter Twelve: Coming Back' });
    expect(formatChapterHeading('CHAPTER 3 - The Door', 'numberWord').plain).toBe('Chapter Three: The Door');
    expect(formatChapterHeading('Chapter 7', 'numberWord')).toEqual({ prefix: 'Chapter Seven', rest: null, plain: 'Chapter Seven' });
  });
  it('leaves headings that are not numbered alone', () => {
    for (const t of ['Prologue', 'Epilogue: After', 'The Beginning', 'Chapter One: Words']) {
      expect(formatChapterHeading(t, 'numberWord').plain).toBe(t);
    }
  });
});
