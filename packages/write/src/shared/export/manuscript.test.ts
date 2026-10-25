import { describe, expect, it } from 'vitest';
import { applySmartQuotes, inlinesToPlain, parseManuscript, type Block } from './manuscript';

const para = (b: Block) => (b.t === 'para' ? inlinesToPlain(b.inlines) : `<${b.t}>`);

describe('parseManuscript', () => {
  it('splits chapters on Heading 1 and keeps the title verbatim', () => {
    const m = parseManuscript('# Chapter 1: Coming Back\n\nFirst.\n\nSecond.\n\n# Chapter 2: Gone\n\nThird.\n');
    expect(m.chapters.map((c) => c.title)).toEqual(['Chapter 1: Coming Back', 'Chapter 2: Gone']);
    expect(m.chapters[0].blocks.map(para)).toEqual(['First.', 'Second.']);
    expect(m.warnings).toEqual([]);
  });

  it('parses emphasis, strong, links and hard breaks, and joins soft line breaks', () => {
    const m = parseManuscript('# C\n\nA *soft* **loud** [site](https://x.com) line\ncontinues.  \nNext.\n');
    const p = m.chapters[0].blocks[0];
    expect(p.t === 'para' && p.inlines.map((i) => i.t)).toEqual(['text', 'em', 'text', 'strong', 'text', 'link', 'text', 'br', 'text']);
    expect(para(p).replace(/\s+/g, ' ')).toBe('A soft loud site line continues. Next.');
  });

  it('turns thematic breaks (* * *, ---, ***) into scene breaks and tidies them', () => {
    const m = parseManuscript('# C\n\n* * *\n\nA\n\n---\n\n***\n\nB\n\n* * *\n');
    expect(m.chapters[0].blocks.map(para)).toEqual(['A', '<scene>', 'B']);
    expect(m.warnings.join()).toMatch(/ended with a scene break/);
  });

  it('treats text before the first heading as dropped, with a warning (but not YAML front matter)', () => {
    const withYaml = parseManuscript('---\ntitle: x\n---\n# One\n\nA\n');
    expect(withYaml.warnings).toEqual([]);
    expect(withYaml.chapters).toHaveLength(1);
    const withIntro = parseManuscript('Some intro words here.\n\n# One\n\nA\n');
    expect(withIntro.warnings[0]).toMatch(/before the first Heading 1 was left out \(4 words\)/);
  });

  it('does not split on # inside code fences', () => {
    const m = parseManuscript('# One\n\n```\n# not a chapter\n```\n\ntext\n');
    expect(m.chapters).toHaveLength(1);
    expect(m.chapters[0].blocks[0]).toMatchObject({ t: 'code' });
  });

  it('H2+ become sub-headings; quotes and lists are kept', () => {
    const m = parseManuscript('# One\n\n## Part\n\n> quoted\n\n- a\n- b\n\n1. x\n');
    expect(m.chapters[0].blocks.map((b) => b.t)).toEqual(['sub', 'quote', 'list', 'list']);
    const lists = m.chapters[0].blocks.filter((b) => b.t === 'list');
    expect(lists.map((l) => l.t === 'list' && [l.ordered, l.items.length])).toEqual([[false, 2], [true, 1]]);
  });

  it('warns about images and raw HTML, and about empty chapters', () => {
    const m = parseManuscript('# One\n\nText ![alt](a.png) more <b>x</b>\n\n<div>block</div>\n\n# Empty\n');
    expect(m.warnings.some((w) => /image/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /HTML/.test(w))).toBe(true);
    expect(m.warnings.some((w) => /“Empty”: this chapter is empty/.test(w))).toBe(true);
  });

  it('handles Setext H1, CRLF files and a BOM', () => {
    const m = parseManuscript('﻿Title One\r\n=====\r\n\r\nBody.\r\n\r\n# Two\r\n\r\nMore.\r\n');
    expect(m.chapters.map((c) => c.title)).toEqual(['Title One', 'Two']);
    expect(m.chapters[0].blocks.map(para)).toEqual(['Body.']);
  });

  it('strips inline markup from chapter titles but keeps the words', () => {
    expect(parseManuscript('# Chapter 1: *The* **Door**\n\nx\n').chapters[0].title).toBe('Chapter 1: The Door');
  });

  it('returns no chapters for a file with no headings', () => {
    const m = parseManuscript('just prose\n');
    expect(m.chapters).toEqual([]);
    expect(m.warnings).toHaveLength(1);
  });

  it('counts words per chapter', () => {
    expect(parseManuscript('# One\n\nthree little words\n').chapters[0].words).toBe(4);
  });
});

describe('applySmartQuotes', () => {
  const ms = (src: string) => parseManuscript(src);
  const first = (m: ReturnType<typeof ms>) => para(m.chapters[0].blocks[0]);

  it('converts straight quotes across inline boundaries', () => {
    const { manuscript, applied } = applySmartQuotes(ms('# "One"\n\n"*Hello*," she said. "It\'s fine."\n'), 'auto');
    expect(applied).toBe(true);
    expect(first(manuscript)).toBe('“Hello,” she said. “It’s fine.”');
    expect(manuscript.chapters[0].title).toBe('“One”');
  });

  it('opening quote inside emphasis stays an opening quote', () => {
    const { manuscript } = applySmartQuotes(ms('# C\n\nShe said *"yes"* quietly.\n'), 'always');
    expect(first(manuscript)).toBe('She said “yes” quietly.');
  });

  it("auto leaves text alone when it already has typographic quotes, 'always' forces, 'never' skips", () => {
    const src = '# C\n\n“Curly” and "straight".\n';
    expect(applySmartQuotes(ms(src), 'auto').applied).toBe(false);
    expect(first(applySmartQuotes(ms(src), 'always').manuscript)).toBe('“Curly” and “straight”.');
    expect(applySmartQuotes(ms('# C\n\n"x"\n'), 'never').applied).toBe(false);
  });

  it('never touches code or link targets', () => {
    const m = applySmartQuotes(ms('# C\n\n`"code"` [a "b"](https://x.com/"q")\n'), 'always').manuscript;
    const p = m.chapters[0].blocks[0];
    expect(p.t === 'para' && p.inlines[0]).toEqual({ t: 'code', text: '"code"' });
    expect(p.t === 'para' && p.inlines[2]).toMatchObject({ t: 'link', url: expect.stringContaining('"q"') });
  });
});
