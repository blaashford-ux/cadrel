import { describe, expect, it } from 'vitest';
import { splitChapters } from './chapters';
import { blockLines, chapterStartLine, countLines, lineStarts, locateLine, totalLines } from './lines';

const doc = splitChapters('# One\n\nalpha\nbeta\n\n# Two\n\ngamma\n\n# Three\n\ndelta');

describe('line numbers', () => {
  it('counts lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\r\nb\r\n')).toBe(2);
    expect(countLines('a\n\nb')).toBe(3);
  });

  it('finds where each chapter starts and the file total', () => {
    expect([0, 1, 2].map((i) => chapterStartLine(doc, i))).toEqual([1, 6, 10]);
    expect(totalLines(doc)).toBe(12);
  });

  it('locates a file line in its chapter', () => {
    expect(locateLine(doc, 1)).toEqual({ chapter: 0, line: 1 });
    expect(locateLine(doc, 5)).toEqual({ chapter: 0, line: 5 });
    expect(locateLine(doc, 6)).toEqual({ chapter: 1, line: 1 });
    expect(locateLine(doc, 12)).toEqual({ chapter: 2, line: 3 });
  });

  it('clamps out-of-range lines', () => {
    expect(locateLine(doc, 0)).toEqual({ chapter: 0, line: 1 });
    expect(locateLine(doc, 999)).toEqual({ chapter: 2, line: 3 });
    expect(locateLine(splitChapters(''), 5).line).toBe(1);
  });

  it('splits blocks on blank lines but not inside code fences', () => {
    expect(blockLines('# T\n\npara\nmore\n\n```\na\n\nb\n```\n\nlast\n')).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 4 },
      { start: 6, end: 10 },
      { start: 12, end: 12 }
    ]);
  });

  it('lists line start offsets', () => {
    expect(lineStarts('ab\ncd\r\nef')).toEqual([0, 3, 7]);
  });
});

describe('blockLines with alignment fences', () => {
  it('treats a fence and everything in it as one block, blank lines included', () => {
    const md = 'before\n\n::: center\nA\n\nB\n:::\n\nafter\n';
    expect(blockLines(md)).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 7 },
      { start: 9, end: 9 }
    ]);
  });
  it('an opener ends the fence before it, and an unclosed fence runs to the end', () => {
    expect(blockLines('::: left\na\n::: right\nb\n\nc\n')).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 6 }
    ]);
  });
  it('leaves fences inside a code block alone', () => {
    expect(blockLines('```\n::: center\n```\n')).toEqual([{ start: 1, end: 3 }]);
  });
});
