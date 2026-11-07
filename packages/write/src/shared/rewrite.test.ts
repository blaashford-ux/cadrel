import { describe, expect, it } from 'vitest';
import { sanitizeProjectMeta } from './projects';
import { addRewriteLink, dropRewriteLinksUnder, mapScroll, remapRewriteLinks, removeRewriteLink, rewriteFileName, rewriteLinkOf, sanitizeRewriteLinks, type Blocks, type RewriteLink } from './rewrite';

const ok = (p: string) => p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

describe('links between an original and its rewrite', () => {
  const A: RewriteLink = { original: 'Book.md', rewrite: 'Book (rewrite).md' };

  it('finds the link from either file, saying which side the file is', () => {
    expect(rewriteLinkOf([A], 'Book.md')).toMatchObject({ role: 'original', other: 'Book (rewrite).md' });
    expect(rewriteLinkOf([A], 'Book (rewrite).md')).toMatchObject({ role: 'rewrite', other: 'Book.md' });
    expect(rewriteLinkOf([A], 'book.MD')).toMatchObject({ role: 'original' }); // file names are not case-sensitive on Windows
    expect(rewriteLinkOf([A], 'Other.md')).toBeNull();
    expect(rewriteLinkOf([], 'Book.md')).toBeNull();
  });

  it('adds a link, and refuses a file that is already in one or linked to itself', () => {
    const links = addRewriteLink([], 'Book.md', 'Book (rewrite).md');
    expect(links).toEqual([A]);
    expect(() => addRewriteLink(links, 'Book.md', 'Other.md')).toThrow(/already linked/);
    expect(() => addRewriteLink(links, 'Other.md', 'Book (rewrite).md')).toThrow(/already linked/);
    expect(() => addRewriteLink(links, 'X.md', 'x.md')).toThrow(/itself/);
    expect(addRewriteLink(links, 'Two.md', 'Two (rewrite).md')).toHaveLength(2);
  });

  it('takes a link away from either file and leaves the others', () => {
    const two = [A, { original: 'Two.md', rewrite: 'Two (rewrite).md' }];
    expect(removeRewriteLink(two, 'Book.md')).toEqual([two[1]]);
    expect(removeRewriteLink(two, 'Book (rewrite).md')).toEqual([two[1]]);
    expect(removeRewriteLink(two, 'None.md')).toEqual(two);
  });

  it('follows a renamed file, or a renamed folder and everything in it', () => {
    expect(remapRewriteLinks([A], 'Book.md', 'Novel.md')).toEqual([{ original: 'Novel.md', rewrite: 'Book (rewrite).md' }]);
    const inFolder = [{ original: 'Drafts/Book.md', rewrite: 'Drafts/Book (rewrite).md' }];
    expect(remapRewriteLinks(inFolder, 'Drafts', 'Old')).toEqual([{ original: 'Old/Book.md', rewrite: 'Old/Book (rewrite).md' }]);
    expect(remapRewriteLinks([A], 'Drafts', 'Old')).toEqual([A]);
    expect(remapRewriteLinks([{ original: 'Drafts2/B.md', rewrite: 'Drafts2/C.md' }], 'Drafts', 'Old')).toEqual([{ original: 'Drafts2/B.md', rewrite: 'Drafts2/C.md' }]); // a look-alike
  });

  it('drops the links of a deleted file or folder, not of a look-alike', () => {
    expect(dropRewriteLinksUnder([A], 'Book.md')).toEqual([]);
    expect(dropRewriteLinksUnder([A], 'Book (rewrite).md')).toEqual([]);
    expect(dropRewriteLinksUnder([{ original: 'D/B.md', rewrite: 'D/C.md' }, A], 'D')).toEqual([A]);
    expect(dropRewriteLinksUnder([{ original: 'D2/B.md', rewrite: 'D2/C.md' }], 'D')).toHaveLength(1);
  });

  it('names the rewrite beside the original, and numbers it when the name is taken', () => {
    expect(rewriteFileName('Book.md', new Set())).toBe('Book (rewrite).md');
    expect(rewriteFileName('Book.md', new Set(['Book (rewrite).md']))).toBe('Book (rewrite 2).md');
    expect(rewriteFileName('Book.md', new Set(['book (REWRITE).md', 'Book (rewrite 2).md']))).toBe('Book (rewrite 3).md');
    expect(rewriteFileName('Chapter.one.md', new Set())).toBe('Chapter.one (rewrite).md');
    expect(rewriteFileName('README', new Set())).toBe('README (rewrite).md');
  });

  it('keeps only well-formed links when reading what was stored', () => {
    const raw = [
      A,
      { original: 'Book.md', rewrite: 'Another.md' }, // Book.md is already in a link
      { original: 'Same.md', rewrite: 'same.md' },
      { original: '../evil.md', rewrite: 'x.md' },
      { original: 'No.md' },
      'text',
      null,
      { original: 'Win\\Chapter.md', rewrite: 'Win\\Chapter (rewrite).md' }
    ];
    expect(sanitizeRewriteLinks(raw, ok)).toEqual([A, { original: 'Win/Chapter.md', rewrite: 'Win/Chapter (rewrite).md' }]);
    expect(sanitizeRewriteLinks('nope', ok)).toEqual([]);
    expect(sanitizeRewriteLinks(Array.from({ length: 300 }, (_, i) => ({ original: `o${i}.md`, rewrite: `r${i}.md` })), ok)).toHaveLength(200);
  });

  it('is kept in a project’s metadata, empty by default and cleaned on reading', () => {
    const meta = sanitizeProjectMeta({}, 'P', '2026-11-01');
    expect(meta.rewriteLinks).toEqual([]);
    const back = sanitizeProjectMeta({ ...meta, rewriteLinks: [A, { original: '../x.md', rewrite: 'y.md' }] }, 'P', '2026-11-01');
    expect(back.rewriteLinks).toEqual([A]);
    expect(sanitizeProjectMeta({ ...meta, rewriteLinks: undefined }, 'P', '2026-11-01').rewriteLinks).toEqual([]); // a project saved before rewrite mode
  });
});

describe('scrolling two panes together', () => {
  const pane = (n: number, h: number): Blocks => ({ tops: Array.from({ length: n }, (_, i) => i * h), total: n * h });

  it('carries the same paragraph and how far into it across when both have the same number', () => {
    const a = pane(10, 100);
    const b = { tops: [0, 40, 120, 130, 300, 340, 500, 520, 700, 760], total: 900 }; // same count, different heights
    expect(mapScroll(a, b, 0)).toBe(0);
    expect(mapScroll(a, b, 100)).toBe(40); // the top of paragraph 2 meets the top of paragraph 2
    expect(mapScroll(a, b, 150)).toBe(80); // half way into it: half way into the other (40..120)
    expect(mapScroll(a, b, 1000)).toBe(900); // the end meets the end
  });

  it('keeps the panes roughly level when one has more paragraphs than the other', () => {
    const short = pane(10, 100); // 1000 tall
    const long = pane(20, 100); // 2000 tall
    expect(mapScroll(short, long, 0)).toBe(0);
    expect(mapScroll(short, long, 500)).toBe(1000); // half way through one is half way through the other
    expect(mapScroll(long, short, 1000)).toBe(500);
    expect(mapScroll(short, long, 250)).toBe(500);
  });

  it('is its own opposite for equal panes and never leaves the other pane', () => {
    const a = pane(8, 90);
    for (const t of [0, 45, 90, 333, 719, 720]) expect(mapScroll(a, a, t)).toBeCloseTo(Math.min(t, 720), 6);
    const b = pane(3, 50);
    for (const t of [-50, 0, 10_000]) {
      const r = mapScroll(a, b, t);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(b.total);
    }
  });

  it('falls back to a share of the height when a pane has nothing in it', () => {
    expect(mapScroll({ tops: [], total: 1000 }, pane(4, 100), 500)).toBe(200);
    expect(mapScroll(pane(4, 100), { tops: [], total: 800 }, 200)).toBe(400);
    expect(mapScroll({ tops: [], total: 0 }, pane(4, 100), 0)).toBe(0);
  });

  it('handles a pane whose first block is below the top (a title or padding)', () => {
    const a: Blocks = { tops: [60, 160, 260], total: 360 };
    const b: Blocks = { tops: [20, 120, 220], total: 320 };
    expect(mapScroll(a, b, 0)).toBe(0); // above the first paragraph: the top meets the top
    expect(mapScroll(a, b, 30)).toBe(10); // half way down the space above it: half way down the space above the other's
    expect(mapScroll(a, b, 60)).toBe(20);
    expect(mapScroll(a, b, 160)).toBe(120);
  });
});
