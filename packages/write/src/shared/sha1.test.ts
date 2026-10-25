import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha1Hex } from './sha1';

describe('sha1Hex', () => {
  it('matches known vectors', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('matches Node for assorted inputs, including multi-block and non-ASCII text', () => {
    const inputs = ['manuscripts/book one.md', 'é—日本語—🙂', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(1000), 'The Lost King/Manuscript/Chapter 1.md'];
    for (const s of inputs) expect(sha1Hex(s), s.slice(0, 20)).toBe(createHash('sha1').update(s).digest('hex'));
  });
});
