import { describe, expect, it } from 'vitest';
import { formatBytes, outputFileName, resolveOutputDir, sanitizeFileName } from './outputs';

describe('sanitizeFileName', () => {
  it('keeps normal titles exactly (case, punctuation, unicode)', () => {
    expect(sanitizeFileName("The Lost King's Return — Part 1")).toBe("The Lost King's Return — Part 1");
  });
  it('replaces characters Windows forbids and tidies the result', () => {
    expect(sanitizeFileName('What? A "Story": 1/2 <draft>|*')).toBe('What A Story 1 2 draft');
    expect(sanitizeFileName('  Trailing dots...  ')).toBe('Trailing dots');
    expect(sanitizeFileName('a\u0000b\u001fc')).toBe('a b c');
  });
  it('never returns an empty or over-long name', () => {
    expect(sanitizeFileName('???')).toBe('Book');
    expect(sanitizeFileName('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('outputFileName (the skill’s naming)', () => {
  it.each([
    ['epub', 'The Book - Ebook.epub'],
    ['pdf', 'The Book - Print Interior.pdf'],
    ['docx', 'The Book - Ebook.docx']
  ] as const)('%s', (kind, name) => expect(outputFileName(kind, 'The Book')).toBe(name));
});

describe('resolveOutputDir', () => {
  it('relative → beside the manuscript', () => {
    expect(resolveOutputDir('/p/Novels/book.md', 'Exports')).toBe('/p/Novels/Exports');
    expect(resolveOutputDir('/p/Novels/book.md', './out/')).toBe('/p/Novels/out');
    expect(resolveOutputDir('C:\\p\\book.md', 'Exports')).toBe('C:\\p\\Exports');
  });
  it('absolute paths are used as given (Windows drive, UNC and POSIX)', () => {
    expect(resolveOutputDir('/p/book.md', 'D:\\Books\\Out\\')).toBe('D:\\Books\\Out');
    expect(resolveOutputDir('/p/book.md', '\\\\server\\share\\out')).toBe('\\\\server\\share\\out');
    expect(resolveOutputDir('C:\\p\\book.md', '/var/out')).toBe('/var/out');
  });
  it('blank → the manuscript’s own folder', () => {
    expect(resolveOutputDir('/p/book.md', '  ')).toBe('/p');
  });
});

describe('formatBytes', () => {
  it('KB and MB', () => {
    expect(formatBytes(10)).toBe('1 KB');
    expect(formatBytes(340 * 1024)).toBe('340 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB');
  });
});
