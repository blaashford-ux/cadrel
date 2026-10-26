import { describe, expect, it } from 'vitest';
import { isSidecarName, sidecarOwner, sidecarPathFor, sidecarStem, stemOf } from './sidecar';

describe('sidecar naming', () => {
  it('book.md → book.export.json beside it (both separators)', () => {
    expect(sidecarPathFor('/p/Novels/book.md')).toBe('/p/Novels/book.export.json');
    expect(sidecarPathFor('C:\\p\\book.markdown')).toBe('C:\\p\\book.export.json');
    expect(sidecarPathFor('/p/my.book.v2.md')).toBe('/p/my.book.v2.export.json');
  });
  it('recognises sidecars and strips the suffix', () => {
    expect(isSidecarName('a.export.json')).toBe(true);
    expect(isSidecarName('A.EXPORT.JSON')).toBe(true);
    expect(isSidecarName('a.json')).toBe(false);
    expect(sidecarStem('a.b.export.json')).toBe('a.b');
    expect(stemOf('x.markdown')).toBe('x');
  });
  it('.md owns the sidecar over .markdown', () => {
    expect(sidecarOwner(['book.markdown', 'book.md'])).toBe('book.md');
    expect(sidecarOwner(['book.markdown'])).toBe('book.markdown');
    expect(sidecarOwner([])).toBeUndefined();
  });
});
