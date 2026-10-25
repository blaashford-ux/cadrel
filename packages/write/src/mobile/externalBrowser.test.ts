import { describe, expect, it } from 'vitest';
import { parsePickedLink } from './externalBrowser';

describe('parsePickedLink', () => {
  it('reads the picked file ids', () => {
    expect(parsePickedLink('cadrel-write://picked?ids=abc123%2Cdef456')).toEqual(['abc123', 'def456']);
  });
  it('gives an empty list when the picker was cancelled or failed', () => {
    expect(parsePickedLink('cadrel-write://picked?cancelled=1')).toEqual([]);
    expect(parsePickedLink('cadrel-write://picked?error=1')).toEqual([]);
  });
  it('ignores other links and unsafe ids', () => {
    expect(parsePickedLink('https://example.com/?ids=abc')).toBeNull();
    expect(parsePickedLink('cadrel-write://other?ids=abc')).toBeNull();
    expect(parsePickedLink('cadrel-write://picked?ids=a%2F..%2Fb,ok_id1')).toEqual(['ok_id1']);
  });
});
