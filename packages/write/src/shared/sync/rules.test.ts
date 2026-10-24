import { describe, expect, it } from 'vitest';
import { classify } from './rules';

describe('classify', () => {
  it('treats Markdown as prose', () => {
    expect(classify('Novel/Manuscript/Chapter 1.md')).toBe('prose');
    expect(classify('Novel/notes.MARKDOWN')).toBe('prose');
  });

  it('knows the small config files', () => {
    expect(classify('Novel/.mdedit/project.json')).toBe('meta');
    expect(classify('Novel/Manuscript/Book.export.json')).toBe('meta');
    expect(classify('.mdedit/settings.json')).toBe('meta');
    expect(classify('Novel/.mdedit/progress.json')).toBe('progress');
    expect(classify('Novel/.mdedit/progress-3fa9c01b22de.json')).toBe('progress');
  });

  it('syncs reviewers’ notes files, and nothing else in .mdedit/review', () => {
    expect(classify('Novel/.mdedit/review/owner.json')).toBe('notes');
    expect(classify('Novel/.mdedit/review/ai-claude-line-edit.json')).toBe('notes');
    expect(classify('Novel/.mdedit/review/owner.json.bak')).toBeNull();
    expect(classify('Novel/.mdedit/review/sub/x.json')).toBeNull();
    expect(classify('Novel/.mdedit/review/notes.txt')).toBeNull();
    expect(classify('Shared With Me/Novel/.mdedit/review/owner.json')).toBeNull();
  });

  it('syncs other small files as assets', () => {
    expect(classify('Novel/Research/map.png')).toBe('asset');
  });

  it('never syncs temp, backup and OS files', () => {
    for (const p of ['Novel/a.md.mdedit-1234.tmp', 'Novel/.mdedit/project.json.bak', 'Novel/a.md.bak', 'Novel/Thumbs.db', 'Novel/desktop.ini', 'Novel/.DS_Store', 'Novel/~$a.md', 'Novel/.~lock.a.md#']) {
      expect(classify(p), p).toBeNull();
    }
  });

  it('keeps per-device data inside .mdedit local', () => {
    expect(classify('Novel/.mdedit/drafts/x.json')).toBeNull();
    expect(classify('Novel/.mdedit/cache.json')).toBeNull();
  });

  it('skips hidden folders such as .git', () => {
    expect(classify('Novel/.git/config')).toBeNull();
    expect(classify('Novel/.obsidian/a.md')).toBeNull();
  });

  it('leaves out Exports/ unless asked', () => {
    expect(classify('Novel/Exports/book.epub')).toBeNull();
    expect(classify('Novel/Exports/book.epub', { includeExports: true })).toBe('asset');
    expect(classify('Novel/Manuscript/Exports/a.md')).toBe('prose'); // only a project's own Exports folder
  });

  it('never syncs projects shared with you', () => {
    expect(classify('Shared With Me/Novel/Book.md')).toBeNull();
  });
});

describe('edited-chapter marks', () => {
  it('travel and are merged', () => {
    expect(classify('Novel/.mdedit/edited.json')).toBe('marks');
  });
});
