import { describe, expect, it } from 'vitest';
import { hasTypographicQuotes, smartenString } from './quotes';

const s = smartenString;

describe('smartenString', () => {
  it('converts simple double quotes', () => {
    expect(s('"Hello," she said.')).toBe('“Hello,” she said.');
    expect(s('He said, "Go."')).toBe('He said, “Go.”');
  });
  it('handles quotes after dashes and before punctuation', () => {
    expect(s('"Wait—"')).toBe('“Wait—”');
    expect(s('She said—"No."')).toBe('She said—“No.”');
    expect(s('"No."—He left.')).toBe('“No.”—He left.');
    expect(s('("Yes")')).toBe('(“Yes”)');
  });
  it('apostrophes inside words and possessives', () => {
    expect(s("don't, it's, o'clock, Mary's")).toBe('don’t, it’s, o’clock, Mary’s');
    expect(s("the dogs' bowls")).toBe('the dogs’ bowls');
    expect(s("talkin' fast")).toBe('talkin’ fast');
  });
  it('single quotes nested in double quotes', () => {
    expect(s(`"He said 'run' and I did."`)).toBe('“He said ‘run’ and I did.”');
    expect(s(`"'Stay,' he told me."`)).toBe('“‘Stay,’ he told me.”');
  });
  it('leading elisions are apostrophes, not opening quotes', () => {
    expect(s("rock 'n' roll")).toBe('rock ’n’ roll');
    expect(s("in the '90s, 'til dawn, 'cause")).toBe('in the ’90s, ’til dawn, ’cause');
  });
  it('is length-preserving and idempotent on already-typographic text', () => {
    for (const x of ['"a" \'b\' it\'s', '“a” ‘b’', 'no quotes at all', '""', "''"]) {
      expect(s(x)).toHaveLength(x.length);
      expect(s(s(x))).toBe(s(x));
    }
  });
  it('a quote at the very start opens, at the very end closes', () => {
    expect(s('"a"')).toBe('“a”');
    expect(s('"')).toBe('”');
  });
});

describe('hasTypographicQuotes', () => {
  it('detects curly quotes', () => {
    expect(hasTypographicQuotes('a “b”')).toBe(true);
    expect(hasTypographicQuotes("it’s")).toBe(true);
    expect(hasTypographicQuotes('"plain"')).toBe(false);
  });
});
