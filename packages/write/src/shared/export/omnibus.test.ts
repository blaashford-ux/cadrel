import { describe, expect, it } from 'vitest';
import { assembleBook } from './assemble';
import { composeOmnibus, defaultOmnibusRecipe, describeBook, moveItem, sanitizeOmnibusRecipe, suggestOmnibusTitle, type OmnibusBook } from './omnibus';
import { defaultBookDetails } from './model';

const details = (o: { title: string; subtitle?: string; author?: string; dedication?: string; epigraph?: [string, string]; excluded?: string[] }) => {
  const d = defaultBookDetails({ title: o.title, author: o.author ?? 'Ash Wilder', year: 2026 });
  d.subtitle = o.subtitle ?? '';
  if (o.dedication) d.dedication = { enabled: true, text: o.dedication };
  if (o.epigraph) d.epigraph = { enabled: true, text: o.epigraph[0], attribution: o.epigraph[1] };
  d.export.excludedChapters = o.excluded ?? [];
  d.copyright.isbn = '978-1-23456-789-7';
  return d;
};
const book = (path: string, source: string, d: ReturnType<typeof details>, chapterLevel = 1): OmnibusBook => ({ path, source, details: d, chapterLevel });
const ONE = book('Manuscripts/One.md', '# Chapter 1: Waking\n\nShe woke.\n\n# Chapter 2: Rising\n\nShe rose.\n\n# About the Author\n\nAsh writes.\n', details({ title: 'Dragon Rider', subtitle: 'Book One of the Ember Wars', dedication: 'For Mum', epigraph: ['The ash remembers.', 'Old saying'] }));
const TWO = book('Manuscripts/Two.md', '# Chapter 1: Burning\n\nIt burned.\n\n# Chapter 2: Cooling\n\nIt cooled.\n\n# Acknowledgements\n\nThanks.\n', details({ title: 'Dragon Rebel', excluded: ['Chapter 2: Cooling'] }));
const recipe = (o: Partial<ReturnType<typeof defaultOmnibusRecipe>> = {}) => defaultOmnibusRecipe({ title: 'Dragon Rider Omnibus', files: [ONE.path, TWO.path], ...o });

describe('composing an omnibus', () => {
  it('needs two books, a title and an author, and says each missing thing in words', () => {
    expect(composeOmnibus(recipe(), [ONE]).errors).toEqual(['An omnibus needs at least two manuscripts. Pick the books to put together.']);
    expect(composeOmnibus(recipe({ title: ' ' }), [ONE, TWO]).errors).toEqual(['The omnibus needs a title.']);
    const anon = book('a.md', '# One\n\nx\n', details({ title: 'A', author: '' }));
    expect(composeOmnibus(recipe(), [anon, { ...anon, path: 'b.md' }]).errors).toEqual(['The omnibus needs an author or pen name.']);
    expect(composeOmnibus(recipe({ author: 'Ash Wilder' }), [anon, { ...anon, path: 'b.md' }]).errors).toEqual([]);
  });
  it('puts a title page before each book’s chapters, in the order given, numbered and with its subtitle, dedication and epigraph', () => {
    const c = composeOmnibus(recipe(), [ONE, TWO]);
    expect(c.errors).toEqual([]);
    const heads = c.source.split('\n').filter((l) => l.startsWith('# '));
    expect(heads).toEqual(['# Book One: Dragon Rider', '# Chapter 1: Waking', '# Chapter 2: Rising', '# Book Two: Dragon Rebel', '# Chapter 1: Burning', '# Acknowledgements']);
    expect(c.source).toContain('*Book One of the Ember Wars*');
    expect(c.source).toContain('*For Mum*');
    expect(c.source).toContain('*The ash remembers.*');
    expect(c.source).toContain('Old saying');
    expect(c.source).toContain('::: center');
    expect(c.parts.map((p) => [p.heading, p.chapters])).toEqual([['Book One: Dragon Rider', 2], ['Book Two: Dragon Rebel', 2]]);
  });
  it('leaves out what each book’s own Book Details exclude, and every book’s back matter but the last’s unless asked', () => {
    const c = composeOmnibus(recipe(), [ONE, TWO]);
    expect(c.source).not.toContain('About the Author'); // book one's, not the last
    expect(c.source).not.toContain('Cooling'); // excluded in book two's Book Details
    expect(c.source).toContain('# Acknowledgements'); // the last book's back matter stays
    expect(c.warnings.join(' ')).toContain('Dragon Rider');
    const all = composeOmnibus(recipe({ allBackMatter: true }), [ONE, TWO]);
    expect(all.source).toContain('# About the Author');
  });
  it('can leave the numbers and each book’s own front matter off, and spells the number out unless the heading style does', () => {
    const plain = composeOmnibus(recipe({ numberBooks: false, bookFront: false }), [ONE, TWO]);
    expect(plain.source).toContain('# Dragon Rider\n');
    expect(plain.source).not.toContain('For Mum');
    const numbered = structuredClone(ONE);
    numbered.details.export.chapterHeading = 'numberWord'; // this style spells numbers itself, so the heading carries the digit
    expect(composeOmnibus(recipe(), [numbered, TWO]).source).toContain('# Book 1: Dragon Rider');
  });
  it('makes the omnibus its own book: its title and author, no book’s ISBN, no dedication, the first book’s layout, the last book’s back matter', () => {
    const first = structuredClone(ONE);
    first.details.export.pdf.trim = '6x9';
    const last = structuredClone(TWO);
    last.details.back.about = { enabled: true, heading: 'About', text: 'Ash writes.' };
    const c = composeOmnibus(recipe({ isbn: '978-0-00-000000-0', coverImage: 'C:/art/omnibus.jpg', subtitle: 'Books 1 and 2', outputs: { epub: true, pdf: false, docx: true } }), [first, last]);
    expect(c.details).toMatchObject({ title: 'Dragon Rider Omnibus', subtitle: 'Books 1 and 2', author: 'Ash Wilder', marked: false });
    expect(c.details.copyright.isbn).toBe('978-0-00-000000-0');
    expect(c.details.dedication.enabled).toBe(false);
    expect(c.details.epigraph.enabled).toBe(false);
    expect(c.details.export.pdf.trim).toBe('6x9');
    expect(c.details.export.outputs).toEqual({ epub: true, pdf: false, docx: true });
    expect(c.details.export.epub.coverImage).toBe('C:/art/omnibus.jpg');
    expect(c.details.export.excludedChapters).toEqual([]);
    expect(c.details.back.about.text).toBe('Ash writes.');
  });
  it('warns when the books name different authors, unless one is chosen', () => {
    const other = book('b.md', '# One\n\nx\n', details({ title: 'B', author: 'Someone Else' }));
    expect(composeOmnibus(recipe(), [ONE, other]).warnings.join(' ')).toContain('different authors');
    expect(composeOmnibus(recipe({ author: 'Both of Us' }), [ONE, other]).warnings.join(' ')).not.toContain('different authors');
  });
  it('refuses books whose chapters start at different heading levels, and a book with no chapters', () => {
    expect(composeOmnibus(recipe(), [ONE, { ...TWO, chapterLevel: 2 }]).errors[0]).toContain('different heading levels');
    const empty = book('c.md', 'no chapters here\n', details({ title: 'Empty' }));
    expect(composeOmnibus(recipe(), [ONE, empty]).errors.join(' ')).toContain('“Empty” has no chapters');
  });
  it('keeps what a title says from becoming Markdown', () => {
    const odd = book('o.md', '# One\n\nx\n', details({ title: 'Fire *and* #Ice [1]', subtitle: 'A <b>tale</b>' }));
    const c = composeOmnibus(recipe(), [odd, TWO]);
    expect(c.source).toContain('# Book One: Fire \\*and\\* \\#Ice \\[1\\]');
    expect(c.source).toContain('*A \\<b\\>tale\\</b\\>*');
  });
  it('is a real book once assembled: the title pages are chapters, in order, and the omnibus details are what is exported', () => {
    const c = composeOmnibus(recipe({ subtitle: 'The Ember Wars, Books 1 and 2' }), [ONE, TWO]);
    const built = assembleBook(c.source, c.details, { now: new Date('2026-11-27T00:00:00Z'), uuid: () => '123e4567-e89b-12d3-a456-426614174000', chapterLevel: c.chapterLevel });
    expect(built.errors).toEqual([]);
    const b = built.build!;
    expect(b.meta).toMatchObject({ title: 'Dragon Rider Omnibus', subtitle: 'The Ember Wars, Books 1 and 2', author: 'Ash Wilder', isbn: '' });
    expect(b.chapters.map((x) => x.title)).toEqual(['Book One: Dragon Rider', 'Chapter 1: Waking', 'Chapter 2: Rising', 'Book Two: Dragon Rebel', 'Chapter 1: Burning', 'Acknowledgements']);
    expect(b.warnings.join(' ')).not.toContain('empty');
  });
});

describe('the recipe', () => {
  it('is read back from a project’s metadata, whatever is in it, keeping only safe paths and each once', () => {
    expect(sanitizeOmnibusRecipe(null)).toBeNull();
    expect(sanitizeOmnibusRecipe([])).toBeNull();
    const r = sanitizeOmnibusRecipe({ title: ' T ', files: ['a.md', 'a.md', '../x.md', 'b\\c.md', 7], outputs: { epub: false, pdf: 'yes' }, numberBooks: 'no', bookFront: false }, (p) => !p.includes('..'))!;
    expect(r.title).toBe('T');
    expect(r.files).toEqual(['a.md', 'b/c.md']);
    expect(r.outputs).toEqual({ epub: false, pdf: true, docx: false });
    expect(r.numberBooks).toBe(true);
    expect(r.bookFront).toBe(false);
  });
  it('suggests a title from the project’s name, and moves a book up or down', () => {
    expect(suggestOmnibusTitle('Dragon Rider')).toBe('Dragon Rider Omnibus');
    expect(suggestOmnibusTitle('  ')).toBe('');
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
  it('describes a manuscript for the dialog from its Book Details, or from its file name when it has none', () => {
    expect(describeBook('M/One.md', ONE.source, ONE.details, 1)).toMatchObject({ title: 'Dragon Rider', subtitle: 'Book One of the Ember Wars', author: 'Ash Wilder', chapters: 3, hasDetails: true });
    expect(describeBook('M/Draft Two.md', '# A\n\nx y z\n', null, 1)).toMatchObject({ title: 'Draft Two', author: '', chapters: 1, words: expect.any(Number), hasDetails: false });
  });
});
