import { describe, expect, it } from 'vitest';
import { parseNumberFilter } from '../src/renderer/views/DataTable.js';

describe('number filter expressions', () => {
  const pass = (f: string, v: number | null) => parseNumberFilter(f)!(v);
  it('understands comparisons, ranges, equality and blank', () => {
    expect(pass('>100', 101)).toBe(true);
    expect(pass('>100', 100)).toBe(false);
    expect(pass('>=100', 100)).toBe(true);
    expect(pass('<5', 4.5)).toBe(true);
    expect(pass('<=5', 6)).toBe(false);
    expect(pass('10-50', 50)).toBe(true);
    expect(pass('10..50', 9)).toBe(false);
    expect(pass('50-10', 20)).toBe(true);
    expect(pass('1,500', 1500)).toBe(true);
    expect(pass('7', 7)).toBe(true);
    expect(pass('=7', 8)).toBe(false);
    expect(pass('blank', null)).toBe(true);
    expect(pass('blank', 3)).toBe(false);
  });
  it('treats an empty box as no filter, blanks as failing a number test, and rejects nonsense so the box can be flagged', () => {
    expect(pass('', null)).toBe(true);
    expect(pass('>1', null)).toBe(false);
    expect(parseNumberFilter('abc')).toBeNull();
    expect(parseNumberFilter('>')).toBeNull();
  });
});
