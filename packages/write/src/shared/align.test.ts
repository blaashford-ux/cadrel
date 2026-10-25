import { describe, expect, it } from 'vitest';
import { openerAlign, splitAligned, stripFences } from './align';
import { countWords } from './words';

describe('alignment fences', () => {
  it('recognises the four alignments and their spellings', () => {
    expect(openerAlign('::: center')).toBe('center');
    expect(openerAlign(':::centre')).toBe('center');
    expect(openerAlign('::: Right  ')).toBe('right');
    expect(openerAlign('::: justified')).toBe('justify');
    expect(openerAlign('::: left')).toBe('left');
    expect(openerAlign('::: sideways')).toBeNull();
    expect(openerAlign(':::')).toBeNull();
    expect(openerAlign('text ::: center')).toBeNull();
  });

  it('splits text into aligned runs', () => {
    const segs = splitAligned('before\n\n::: center\nmiddle\n:::\n\nafter\n');
    expect(segs).toEqual([
      { align: null, text: 'before\n\n' },
      { align: 'center', text: 'middle\n' },
      { align: null, text: '\nafter\n' }
    ]);
  });

  it('lets an opener end the previous fence, and an unclosed fence run to the end', () => {
    const segs = splitAligned('::: left\na\n::: right\nb\n');
    expect(segs.map((s) => [s.align, s.text])).toEqual([['left', 'a\n'], ['right', 'b\n']]);
  });

  it('ignores fences inside fenced code, and stray closers outside a fence', () => {
    const src = '```\n::: center\n```\n\n:::\n';
    expect(splitAligned(src).map((s) => s.align)).toEqual([null]);
    expect(stripFences(src)).toContain('::: center');
  });

  it('keeps CRLF line endings', () => {
    const segs = splitAligned('::: center\r\nx\r\n:::\r\n');
    expect(segs).toEqual([{ align: 'center', text: 'x\r\n' }]);
  });

  it('does not count fence lines as words', () => {
    expect(countWords('::: center\nOne two three\n:::\n')).toBe(3);
  });
});
