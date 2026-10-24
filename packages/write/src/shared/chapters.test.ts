import { describe, expect, it } from 'vitest';
import { deleteChapter, insertChapter, joinChapters, moveChapter, splitChapters, updateChapter } from './chapters';

const titles = (s: string) => splitChapters(s).chapters.map((c) => (c.isPreamble ? '(pre)' : c.title));

describe('splitChapters', () => {
  it('handles empty input', () => {
    const d = splitChapters('');
    expect(d.chapters).toHaveLength(1);
    expect(d.chapters[0].isPreamble).toBe(true);
    expect(joinChapters(d)).toBe('');
  });

  it('treats a file with no H1 as a single preamble chapter', () => {
    expect(titles('just text\n\n## sub\n')).toEqual(['(pre)']);
  });

  it('splits on H1 with a preamble', () => {
    expect(titles('intro\n\n# One\na\n# Two\nb\n')).toEqual(['(pre)', 'One', 'Two']);
  });

  it('has no preamble when the file starts with an H1', () => {
    expect(titles('# One\na\n')).toEqual(['One']);
  });

  it('keeps H2+ inside their chapter', () => {
    const d = splitChapters('# One\n## sub\n### deeper\n# Two\n');
    expect(d.chapters).toHaveLength(2);
    expect(d.chapters[0].raw).toBe('# One\n## sub\n### deeper\n');
  });

  it('ignores # inside fenced code blocks', () => {
    expect(titles('# One\n```\n# not a heading\n```\n~~~\n# nor this\n~~~\n# Two\n')).toEqual(['One', 'Two']);
  });

  it('only closes a fence with a matching, long-enough fence', () => {
    expect(titles('# A\n````\n```\n# inside\n````\n# B\n')).toEqual(['A', 'B']);
  });

  it('ignores # inside YAML front matter', () => {
    expect(titles('---\n# comment\ntitle: x\n---\n# Real\n')).toEqual(['(pre)', 'Real']);
  });

  it('does not treat #hashtag or 4-space-indented # as H1', () => {
    expect(titles('#hashtag\n    # code\n# Real\n')).toEqual(['(pre)', 'Real']);
  });

  it('strips closing hashes and handles empty headings', () => {
    expect(titles('# Title ##\n# \n#\n')).toEqual(['Title', '', '']);
  });

  it('supports Setext H1', () => {
    expect(titles('Intro\n=====\ntext\n\nNext\n===\n')).toEqual(['Intro', 'Next']);
  });

  it('does not treat a list item followed by === as Setext', () => {
    expect(titles('- item\n===\n')).toEqual(['(pre)']);
  });

  it('detects titles with trailing whitespace and up to 3 leading spaces', () => {
    expect(titles('   # Indented  \n')).toEqual(['Indented']);
  });
});

describe('round-trip fidelity', () => {
  const samples = [
    '',
    '\n',
    'no newline at end',
    '# A',
    '# A\n',
    'pre\n# A\r\ntext\r\n# B\r\n',
    '﻿# Bom\ntext\n',
    '---\ntitle: x\n---\n\n# A\n\n```\n# c\n```\n\n# B\n\n\n',
    'A\r# B\r',
    'Setext\n===\nbody\n'
  ];
  it.each(samples)('join(split(x)) === x for %j', (s) => {
    expect(joinChapters(splitChapters(s))).toBe(s);
  });

  it('holds for randomly generated documents', () => {
    const pieces = ['# H\n', '## h2\n', 'text\n', '\n', '```\n', '~~~\n', '# in\n', '---\n', 'T\n', '===\n', '\r\n', '#x', ' '];
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let n = 0; n < 500; n++) {
      let s = '';
      for (let k = 0; k < 30; k++) s += pieces[Math.floor(rnd() * pieces.length)];
      expect(joinChapters(splitChapters(s))).toBe(s);
    }
  });
});

describe('updateChapter', () => {
  it('only changes the targeted chapter', () => {
    const src = '# A\r\none\r\n# B\r\ntwo\r\n# C\r\nthree\r\n';
    const d = splitChapters(src);
    const out = updateChapter(d, 1, '# B\nedited\nmore');
    expect(out.chapters[0].raw).toBe(d.chapters[0].raw);
    expect(out.chapters[2].raw).toBe(d.chapters[2].raw);
    expect(joinChapters(out)).toBe('# A\r\none\r\n# B\r\nedited\r\nmore\r\n# C\r\nthree\r\n');
    expect(joinChapters(d)).toBe(src); // original unchanged
  });

  it('keeps the last chapter without forcing a trailing newline', () => {
    const d = splitChapters('# A\nx\n# B\ny');
    expect(joinChapters(updateChapter(d, 1, '# B\nz'))).toBe('# A\nx\n# B\nz');
  });

  it('preserves blank lines before the next chapter and the final newline', () => {
    const d = splitChapters('# A\nx\n\n\n# B\ny\n');
    expect(joinChapters(updateChapter(d, 0, '# A\nedited'))).toBe('# A\nedited\n\n\n# B\ny\n');
    expect(joinChapters(updateChapter(d, 1, '# B\nz'))).toBe('# A\nx\n\n\n# B\nz\n');
  });

  it('updates the title when the heading is renamed', () => {
    const d = splitChapters('# A\nx\n');
    expect(updateChapter(d, 0, '# Renamed\nx\n').chapters[0].title).toBe('Renamed');
  });

  it('throws on a bad index', () => {
    expect(() => updateChapter(splitChapters('# A\n'), 5, 'x')).toThrow(RangeError);
  });
});

describe('chapter structure edits', () => {
  const T = (d: { chapters: { title: string; isPreamble: boolean }[] }) => d.chapters.map((c) => (c.isPreamble ? '(pre)' : c.title));

  it('moves a chapter down and up, keeping others byte-identical', () => {
    const d = splitChapters('# A\na\n\n# B\nb\n\n# C\nc\n');
    const down = moveChapter(d, 0, 1)!;
    expect(joinChapters(down.doc)).toBe('# B\nb\n\n# A\na\n\n# C\nc\n');
    expect(down.index).toBe(1);
    const up = moveChapter(down.doc, 1, -1)!;
    expect(joinChapters(up.doc)).toBe('# A\na\n\n# B\nb\n\n# C\nc\n');
  });

  it('moving the last chapter (no final newline) up does not glue headings and keeps "no final newline"', () => {
    const d = splitChapters('# A\na\n# B\nb');
    const r = moveChapter(d, 1, -1)!;
    expect(joinChapters(r.doc)).toBe('# B\nb\n# A\na');
    expect(T(r.doc)).toEqual(['B', 'A']);
    expect(r.index).toBe(0);
  });

  it('keeps CRLF', () => {
    const d = splitChapters('# A\r\na\r\n# B\r\nb');
    expect(joinChapters(moveChapter(d, 1, -1)!.doc)).toBe('# B\r\nb\r\n# A\r\na');
  });

  it('refuses to move the preamble, past the preamble, or off the ends', () => {
    const d = splitChapters('intro\n# A\na\n# B\nb\n');
    expect(moveChapter(d, 0, 1)).toBeNull();
    expect(moveChapter(d, 1, -1)).toBeNull();
    expect(moveChapter(d, 2, 1)).toBeNull();
    expect(joinChapters(moveChapter(d, 1, 1)!.doc)).toBe('intro\n# B\nb\n# A\na\n');
  });

  it('inserts a chapter after another, including at the end of a file with no final newline', () => {
    const d = splitChapters('# A\na\n# B\nb');
    const mid = insertChapter(d, 0, 'New');
    expect(joinChapters(mid.doc)).toBe('# A\na\n# New\n\n# B\nb');
    expect(T(mid.doc)).toEqual(['A', 'New', 'B']);
    expect(mid.index).toBe(1);
    const end = insertChapter(d, 1, 'Last');
    expect(joinChapters(end.doc)).toBe('# A\na\n# B\nb\n# Last');
    expect(end.index).toBe(2);
  });

  it('inserts into an empty file', () => {
    const r = insertChapter(splitChapters(''), 0, 'First');
    expect(T(r.doc)).toEqual(['First']);
    expect(r.index).toBe(0);
  });

  it('deletes a chapter and keeps the rest intact', () => {
    const d = splitChapters('pre\n# A\na\n\n# B\nb\n\n# C\nc');
    expect(joinChapters(deleteChapter(d, 2)!)).toBe('pre\n# A\na\n\n# C\nc');
    expect(joinChapters(deleteChapter(d, 3)!)).toBe('pre\n# A\na\n\n# B\nb');
    expect(deleteChapter(d, 9)).toBeNull();
  });

  it('every edit result re-splits to what it claims', () => {
    const d = splitChapters('# A\n```\n# x\n```\n# B\nb\n');
    const r = moveChapter(d, 1, -1)!;
    expect(T(r.doc)).toEqual(['B', 'A']);
    expect(joinChapters(r.doc)).toBe('# B\nb\n# A\n```\n# x\n```\n');
  });
});

describe('chapter heading level', () => {
  const src = '# Book\n\nintro\n\n## One\na\n\n### detail\nx\n\n## Two\nb\n';

  it('splits at the chosen level and keeps everything else inside the chapters', () => {
    const d = splitChapters(src, 2);
    expect(d.level).toBe(2);
    expect(d.chapters.map((c) => (c.isPreamble ? '(pre)' : c.title))).toEqual(['(pre)', 'One', 'Two']);
    expect(d.chapters[0].raw).toBe('# Book\n\nintro\n\n');
    expect(d.chapters[1].raw).toBe('## One\na\n\n### detail\nx\n\n');
  });

  it('is lossless at every level', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) expect(joinChapters(splitChapters(src + '#### four\n##### five\n###### six\n', level))).toBe(src + '#### four\n##### five\n###### six\n');
  });

  it('only matches the exact level (## is not a level-1 heading and # is not level 2)', () => {
    expect(splitChapters('## a\n# b\n', 1).chapters.map((c) => c.title)).toEqual(['', 'b']);
    expect(splitChapters('## a\n# b\n', 2).chapters.map((c) => c.title)).toEqual(['a']);
    expect(splitChapters('#hashtag\n', 1).chapters).toHaveLength(1);
  });

  it('supports Setext underlines for levels 1 and 2 only', () => {
    expect(splitChapters('Title\n---\nbody\n', 2).chapters.map((c) => c.title)).toEqual(['Title']);
    expect(splitChapters('Title\n---\nbody\n', 1).chapters).toHaveLength(1);
    expect(splitChapters('Title\n===\nbody\n', 3).chapters).toHaveLength(1);
  });

  it('does not take a scene break --- for a level-2 heading', () => {
    expect(splitChapters('## A\ntext\n\n---\n\nmore\n', 2).chapters.map((c) => c.title)).toEqual(['A']);
  });

  it('clamps nonsense levels', () => {
    expect(splitChapters('# a\n', 0).level).toBe(1);
    expect(splitChapters('# a\n', 99).level).toBe(6);
    expect(splitChapters('# a\n', NaN).level).toBe(1);
  });

  it('structural edits keep the level: new chapters use that many #', () => {
    const doc = splitChapters('## One\na\n\n## Two\nb\n', 2);
    const ins = insertChapter(doc, 0, 'Middle');
    expect(joinChapters(ins.doc)).toBe('## One\na\n\n## Middle\n\n## Two\nb\n');
    expect(ins.doc.chapters.map((c) => c.title)).toEqual(['One', 'Middle', 'Two']);
    expect(ins.doc.level).toBe(2);
    expect(moveChapter(doc, 0, 1)!.doc.chapters.map((c) => c.title)).toEqual(['Two', 'One']);
    expect(deleteChapter(doc, 0)!.chapters.map((c) => c.title)).toEqual(['Two']);
    expect(updateChapter(doc, 0, '## Uno\nz').chapters[0].title).toBe('Uno');
  });
});
