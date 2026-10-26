import { describe, expect, it } from 'vitest';
import { estimateRows, locateRow, type RowEnv } from './rows';

// 10px per character, 100px wide = 10 characters a row
const env: RowEnv = { width: 100, measure: (t, s) => t.length * 10 * s };

describe('estimated rows', () => {
  it('counts blank lines and wraps text to the width', () => {
    expect(estimateRows('', env)).toBe(0);
    expect(estimateRows('hello\n', env)).toBe(1);
    expect(estimateRows('hello\n\nhello world foo\n', env)).toBe(1 + 1 + 2); // "hello world foo": hello / world foo
  });
  it('ignores Markdown markers, and makes headings wrap sooner', () => {
    expect(estimateRows('**hello** _world_', env)).toBe(2);
    expect(estimateRows('# hello', env)).toBe(2); // 5 characters at 2.1x = 105px, so the word breaks across 2 rows
  });
  it('breaks a word longer than a row, and keeps list and quote text narrower', () => {
    expect(estimateRows('abcdefghijklmnopqrstuvwxyz', env)).toBe(3);
    expect(estimateRows('> aaaa bbbb cccc', env)).toBeGreaterThanOrEqual(2);
  });
  it('locates a row in a chapter, clamping at the ends', () => {
    expect(locateRow([5, 4, 3], 1).chapter).toBe(0);
    expect(locateRow([5, 4, 3], 6).chapter).toBe(1);
    expect(locateRow([5, 4, 3], 12).chapter).toBe(2);
    expect(locateRow([5, 4, 3], 99).chapter).toBe(2);
    expect(locateRow([5, 4, 3], 0).chapter).toBe(0);
  });
});
