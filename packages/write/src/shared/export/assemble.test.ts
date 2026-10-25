import { describe, expect, it } from 'vitest';
import { assembleBook } from './assemble';
import { defaultBookDetails } from './model';

const SRC = '# Chapter 1: Coming Back\n\n"Hi," she said.\n\n* * *\n\nMore.\n\n# Chapter 2: Leaving\n\nBye.\n\n# Scratch\n\nignore me\n';
const env = { now: new Date('2031-05-06T07:08:09.123Z'), uuid: () => 'abc' };
const details = () => defaultBookDetails({ title: 'My Book', author: 'Me', year: 2031 });

describe('assembleBook', () => {
  it('builds chapters, front matter and a contents list of real content only', () => {
    const d = details();
    d.back.about = { enabled: true, heading: '', text: 'Bio.' };
    const { build, errors } = assembleBook(SRC, d, env);
    expect(errors).toEqual([]);
    expect(build!.chapters.map((c) => [c.id, c.title])).toEqual([['chapter1', 'Chapter 1: Coming Back'], ['chapter2', 'Chapter 2: Leaving'], ['chapter3', 'Scratch']]);
    expect(build!.toc.map((t) => t.label)).toEqual(['Chapter 1: Coming Back', 'Chapter 2: Leaving', 'Scratch', 'ABOUT THE AUTHOR']);
    expect(build!.toc.map((t) => t.label).join()).not.toMatch(/title page|copyright|contents/i);
    expect(build!.front.map((p) => p.id)).toEqual(['title', 'copyright']);
    expect(build!.meta).toMatchObject({ id: 'urn:uuid:abc', title: 'My Book', author: 'Me', year: '2031', language: 'en', modified: '2031-05-06T07:08:09Z', rights: 'Copyright © 2031 by Me' });
  });

  it('excludes chapters by title and says so', () => {
    const d = details();
    d.export.excludedChapters = ['Scratch'];
    const { build } = assembleBook(SRC, d, env);
    expect(build!.chapters.map((c) => c.title)).toEqual(['Chapter 1: Coming Back', 'Chapter 2: Leaving']);
    expect(build!.chapters.map((c) => c.id)).toEqual(['chapter1', 'chapter2']);
    expect(build!.warnings.some((w) => /1 chapter was excluded/.test(w))).toBe(true);
  });

  it('applies the chapter heading style to headings and the contents list', () => {
    const d = details();
    d.export.chapterHeading = 'numberWord';
    const { build } = assembleBook(SRC, d, env);
    expect(build!.chapters[0].heading).toEqual({ prefix: 'Chapter One', rest: 'Coming Back', plain: 'Chapter One: Coming Back' });
    expect(build!.toc[0].label).toBe('Chapter One: Coming Back');
  });

  it('applies smart quotes and reports it', () => {
    const { build } = assembleBook(SRC, details(), env);
    const p = build!.chapters[0].blocks[0];
    expect(JSON.stringify(p)).toContain('“Hi,”');
    expect(build!.warnings).toContain('Straight quotes were converted to typographic quotes.');
  });

  it('refuses to build without a title, an author or any chapters, listing every problem', () => {
    const d = details();
    d.title = ' ';
    d.author = '';
    expect(assembleBook(SRC, d, env).errors).toHaveLength(2);
    expect(assembleBook('no headings here', details(), env).errors[0]).toMatch(/no chapters/);
    const all = details();
    all.export.excludedChapters = ['Chapter 1: Coming Back', 'Chapter 2: Leaving', 'Scratch'];
    expect(assembleBook(SRC, all, env).errors[0]).toMatch(/no chapters/);
  });

  it('carries parser and link warnings through', () => {
    const d = details();
    d.back.links = { enabled: true, heading: '', intro: '', items: [{ label: 'x', url: 'ftp://nope' }] };
    const { build } = assembleBook('intro text\n\n# One\n\nA\n', d, env);
    expect(build!.warnings.some((w) => /before the first Heading 1/.test(w))).toBe(true);
    expect(build!.warnings.some((w) => /isn’t a web or email address/.test(w))).toBe(true);
  });
});

describe('assembleBook with a different chapter heading level', () => {
  const SRC2 = '# My Book\n\nignored intro\n\n## Chapter One\n\nHello.\n\n### A sub heading\n\nMore.\n\n## Chapter Two\n\nBye.\n';

  it('chapters are the level-2 headings; the text above the first is left out with a matching warning', () => {
    const r = assembleBook(SRC2, details(), { ...env, chapterLevel: 2 });
    expect(r.errors).toEqual([]);
    expect(r.build!.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(r.build!.warnings.join('\n')).toMatch(/before the first Heading 2/);
  });

  it('turns the next level down into sub-headings (### under ## chapters becomes a level-2 sub-heading)', () => {
    const r = assembleBook(SRC2, details(), { ...env, chapterLevel: 2 });
    const subs = r.build!.chapters[0].blocks.filter((b) => b.t === 'sub');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ t: 'sub', level: 2 });
  });

  it('the no-chapters error names the chosen level', () => {
    const r = assembleBook('# Only a title\n\ntext\n', details(), { ...env, chapterLevel: 3 });
    expect(r.errors.join(' ')).toMatch(/Heading 3 \(a line starting with “### ”\)/);
  });

  it('level 1 still behaves as before', () => {
    const r = assembleBook(SRC, details(), env);
    expect(r.build!.chapters.map((c) => c.title)).toContain('Chapter 1: Coming Back');
  });
});
