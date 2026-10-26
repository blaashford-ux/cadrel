import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Hex } from './md5';

describe('md5Hex', () => {
  it('matches known vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('matches Node across block boundaries, non-ASCII text and line endings', () => {
    const inputs = ['x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(5000), 'é—日本語—🙂', '# One\r\nline\r\n', 'a\nb\r\nc\rd'];
    for (const s of inputs) expect(md5Hex(s), s.slice(0, 12)).toBe(createHash('md5').update(s).digest('hex'));
  });
});
