import { describe, expect, it } from 'vitest';
import {
  complianceError, conflictCopyName, isCompliantName, isConflictCopyName, MAX_NAME_LENGTH, nameKey, toCompliantName, toCompliantPath, uniqueCompliantName
} from './names';

describe('complianceError', () => {
  it('accepts ordinary names', () => {
    for (const n of ['Chapter 1.md', 'The Lost King', 'notes.v2.md', '.mdedit', 'é.md']) expect(complianceError(n)).toBeNull();
  });

  it('rejects illegal characters, reserved names, trailing dots and spaces', () => {
    for (const n of ['a:b.md', 'a?.md', 'a|b', 'CON', 'nul.txt', 'COM1.md', 'lpt9', 'x.', 'x ', ' x', '', '..']) expect(complianceError(n), n).not.toBeNull();
  });

  it('rejects names over the length cap and names that are not NFC', () => {
    expect(complianceError('a'.repeat(MAX_NAME_LENGTH))).toBeNull();
    expect(complianceError('a'.repeat(MAX_NAME_LENGTH + 1))).not.toBeNull();
    expect(complianceError('é.md')).not.toBeNull(); // e + combining acute
    expect(complianceError('é.md')).toBeNull();
  });
});

describe('toCompliantName', () => {
  it('replaces illegal characters and trims trailing dots and spaces', () => {
    expect(toCompliantName('Act 1: The Fall?.md')).toBe('Act 1_ The Fall_.md');
    expect(toCompliantName('draft... ')).toBe('draft');
    expect(toCompliantName('a/b\\c')).toBe('a_b_c');
  });

  it('defuses reserved names and keeps the extension', () => {
    expect(toCompliantName('CON')).toBe('CON_');
    expect(toCompliantName('aux.md')).toBe('aux_.md');
    expect(toCompliantName('Com3.txt')).toBe('Com3_.txt');
    expect(toCompliantName('PRN.tar.gz')).toBe('PRN_.tar.gz');
  });

  it('never returns an empty name', () => {
    for (const n of ['', ' ', '...', '??'.slice(0, 0)]) expect(toCompliantName(n)).toBe('Untitled');
  });

  it('normalises to NFC and caps the length without losing the extension', () => {
    expect(toCompliantName('é.md')).toBe('é.md');
    const long = toCompliantName('x'.repeat(300) + '.md');
    expect(long.length).toBe(MAX_NAME_LENGTH);
    expect(long.endsWith('.md')).toBe(true);
  });

  it('is idempotent and always produces a compliant name', () => {
    for (const n of ['Act 1: The Fall?.md', 'CON', 'x'.repeat(500), 'é .', 'a\u0000b', '  lead.md', 'PRN.tar.gz', '....md']) {
      const once = toCompliantName(n);
      expect(isCompliantName(once), n).toBe(true);
      expect(toCompliantName(once)).toBe(once);
    }
  });
});

describe('toCompliantPath', () => {
  it('fixes every segment', () => {
    expect(toCompliantPath('Book: One/Ch?1.md')).toBe('Book_ One/Ch_1.md');
  });
});

describe('uniqueCompliantName', () => {
  it('returns the name when free and numbers it when taken, ignoring case and normalisation', () => {
    expect(uniqueCompliantName('Ch1.md', ['other.md'])).toBe('Ch1.md');
    expect(uniqueCompliantName('Ch1.md', ['ch1.md'])).toBe('Ch1 2.md');
    expect(uniqueCompliantName('Ch1.md', ['CH1.md', 'Ch1 2.md'])).toBe('Ch1 3.md');
    expect(uniqueCompliantName('é.md', ['é.md'])).toBe('é 2.md');
  });

  it('keeps a long name within the cap when numbering it', () => {
    const name = 'y'.repeat(MAX_NAME_LENGTH - 3) + '.md';
    expect(uniqueCompliantName(name, [name]).length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
});

describe('conflictCopyName', () => {
  it('names a copy after the device and date, before the extension', () => {
    expect(conflictCopyName('Chapter 3.md', 'Pixel', '2026-10-05')).toBe('Chapter 3 (conflict - Pixel - 2026-10-05).md');
  });

  it('is compliant even for awkward device names, and unique against what is there', () => {
    const first = conflictCopyName('a.md', 'My: Phone?', '2026-10-05');
    expect(isCompliantName(first)).toBe(true);
    expect(conflictCopyName('a.md', 'My: Phone?', '2026-10-05', [first])).not.toBe(first);
  });

  it('stays within the length cap for long names', () => {
    expect(conflictCopyName('z'.repeat(110) + '.md', 'Pixel', '2026-10-05').length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it('is recognised by isConflictCopyName', () => {
    expect(isConflictCopyName('Chapter 3 (conflict - Pixel - 2026-10-05).md')).toBe(true);
    expect(isConflictCopyName('Chapter 3 (conflict - Pixel - 2026-10-05) 2.md')).toBe(true);
    expect(isConflictCopyName('Chapter 3.md')).toBe(false);
  });
});

describe('nameKey', () => {
  it('folds case and Unicode normalisation', () => {
    expect(nameKey('Ch1.MD')).toBe(nameKey('ch1.md'));
    expect(nameKey('é')).toBe(nameKey('é'));
  });
});
