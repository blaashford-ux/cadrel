import { describe, expect, it } from 'vitest';
import { basename, dirname, isInside, joinPath, remapPath, validateName, withMarkdownExt } from './paths';

describe('validateName', () => {
  it.each(['notes', 'my file.md', 'ch 1 - intro', 'é.md'])('accepts %j', (n) => expect(validateName(n)).toBeNull());
  it.each(['', '  ', 'a/b', 'a\\b', 'x:y', 'what?', 'a*b', '..', 'name.', 'CON', 'nul.md', 'com1', 'a|b', 'q"q'])(
    'rejects %j',
    (n) => expect(validateName(n)).not.toBeNull()
  );
});

describe('path helpers', () => {
  it('adds .md only when missing', () => {
    expect(withMarkdownExt('a')).toBe('a.md');
    expect(withMarkdownExt('a.MD')).toBe('a.MD');
    expect(withMarkdownExt('a.markdown')).toBe('a.markdown');
    expect(withMarkdownExt('a.txt')).toBe('a.txt.md');
  });
  it('basename/dirname/joinPath for both separators', () => {
    expect(basename('C:\\a\\b.md')).toBe('b.md');
    expect(dirname('C:\\a\\b.md')).toBe('C:\\a');
    expect(joinPath('C:\\a', 'b.md')).toBe('C:\\a\\b.md');
    expect(joinPath('/a/', 'b.md')).toBe('/a/b.md');
    expect(dirname('/a/b.md')).toBe('/a');
  });
  it('remapPath moves a folder and everything under it, but not look-alikes', () => {
    expect(remapPath('/r/a', '/r/a', '/r/z')).toBe('/r/z');
    expect(remapPath('/r/a/x.md', '/r/a', '/r/z')).toBe('/r/z/x.md');
    expect(remapPath('C:\\r\\a\\x.md', 'C:\\r\\a', 'C:\\r\\z')).toBe('C:\\r\\z\\x.md');
    expect(remapPath('/r/ab/x.md', '/r/a', '/r/z')).toBe('/r/ab/x.md');
  });
  it('isInside', () => {
    expect(isInside('/r/a/x.md', '/r/a')).toBe(true);
    expect(isInside('/r/ab', '/r/a')).toBe(false);
  });
});
