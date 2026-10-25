import { describe, expect, it } from 'vitest';
import { countWords } from './words';

describe('countWords', () => {
  it('counts plain words and ignores Markdown punctuation', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('# Title\n\nHello **bold** world\n\n- item one\n- item two\n\n---\n')).toBe(8);
  });
  it('treats contractions and hyphenated words as one', () => {
    expect(countWords("don't stop well-known")).toBe(3);
  });
  it('does not count link targets or HTML tags', () => {
    expect(countWords('See [the docs](https://example.com/a/b) now <br> ![alt text](img.png)')).toBe(6);
  });
  it('counts non-Latin letters and numbers', () => {
    expect(countWords('héllo wörld 123 日本語')).toBe(4);
  });
});
