import { describe, expect, it } from 'vitest';
import { fileFromArgv } from './launch';

describe('fileFromArgv', () => {
  it('finds an absolute Markdown path (packaged: exe then file; dev: electron, ".", file)', () => {
    expect(fileFromArgv(['/home/u/notes/book.md'], '/x')).toBe('/home/u/notes/book.md');
    expect(fileFromArgv(['.', '/home/u/book.markdown'], '/x')).toBe('/home/u/book.markdown');
  });
  it('resolves a relative path against the working directory', () => {
    expect(fileFromArgv(['sub/a.md'], '/work')).toBe('/work/sub/a.md');
    expect(fileFromArgv(['../a.MD'], '/work/x')).toBe('/work/a.MD');
  });
  it('ignores flags, the app path, and non-Markdown arguments', () => {
    expect(fileFromArgv(['--no-sandbox', '--smoke-test=/tmp/out.json', '.', 'readme.txt', '/app'], '/x')).toBeNull();
    expect(fileFromArgv([], '/x')).toBeNull();
  });
  it('takes the first Markdown file and strips surrounding quotes', () => {
    expect(fileFromArgv(['"/p/with space/a.md"', '/p/b.md'], '/x')).toBe('/p/with space/a.md');
  });
  it('does not mistake a flag value that ends in .md for a file', () => {
    expect(fileFromArgv(['--file=/p/a.md'], '/x')).toBeNull();
  });
});
