import { describe, expect, it } from 'vitest';
import { KDP_PACK, packAgeMonths, runPreflight, type DocumentFacts, type EpubFacts, type PreflightFacts } from '../src';

const doc = (path: string, o: Partial<DocumentFacts> = {}): DocumentFacts => ({ path, wellFormed: true, brokenLinks: [], missingImages: [], duplicateIds: [], heading: null, types: [], ...o });
const HASH = 'a'.repeat(64);
function good(): PreflightFacts {
  const docs = [doc('OEBPS/title.xhtml', { types: ['titlepage'] }), doc('OEBPS/copyright.xhtml', { types: ['copyright-page'] }), doc('OEBPS/ch1.xhtml', { types: ['chapter'], heading: 'One' }), doc('OEBPS/ch2.xhtml', { types: ['chapter'], heading: 'Two' }), doc('OEBPS/about.xhtml', { heading: 'About the Author' }), doc('OEBPS/alsoby.xhtml', { heading: 'Also by Ash Wilder' })];
  const epub: EpubFacts = {
    zip: { readable: true, entries: ['mimetype', 'META-INF/container.xml'], mimetypeFirst: true, mimetypeStored: true, mimetypeText: 'application/epub+zip' },
    rootfile: 'OEBPS/content.opf',
    opf: { path: 'OEBPS/content.opf', wellFormed: true, version: '3.0', title: 'Dragon Rider: Book Four', creators: ['Ash Wilder'], language: 'en', identifiers: ['urn:isbn:9781234567897'], publisher: null, modified: '2026-11-19T00:00:00Z', series: 'Dragon Rider', seriesIndex: '4',
      manifest: docs.map((d, i) => ({ id: `i${i}`, href: d.path.replace('OEBPS/', ''), mediaType: 'application/xhtml+xml', properties: [], present: true })), spine: docs.map((_d, i) => ({ idref: `i${i}`, known: true })), duplicateIds: [] },
    nav: { path: 'OEBPS/nav.xhtml', hasToc: true, entries: [{ label: 'One', href: 'ch1.xhtml', target: 'OEBPS/ch1.xhtml', resolved: true }, { label: 'Two', href: 'ch2.xhtml', target: 'OEBPS/ch2.xhtml', resolved: true }], landmarks: ['cover'] },
    ncx: true,
    documents: docs,
    cover: { path: 'OEBPS/images/cover.jpg', format: 'jpeg', width: 1600, height: 2560, bytes: 900_000, hash: HASH },
    titlePage: { title: 'Dragon Rider: Book Four', author: 'Ash Wilder' },
    bytes: 2_000_000
  };
  return {
    epub,
    book: { title: 'Dragon Rider: Book Four', subtitle: '', author: 'Ash Wilder', series: 'Dragon Rider', seriesNumber: 4, isbn: '978-1-234-56789-7', asin: null, language: 'en', price: 4.99, publishedOn: null, blurb: 'A dragon at dusk.', keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    approvedCover: { assetId: 'as1', version: 3, hash: HASH, format: 'jpeg', width: 1600, height: 2560, colour: 'rgb', dpi: 300, bytes: 900_000 },
    epubCover: { colour: 'rgb', dpi: 300 }
  };
}
const ids = (f: PreflightFacts) => runPreflight(f).map((x) => `${x.grade}:${x.ruleId}`);

describe('Preflight rules', () => {
  it('a sound book with every page, a matching catalogue and the approved cover has nothing to say', () => {
    expect(runPreflight(good())).toEqual([]);
  });

  it('EPUB validity: each planted defect is found, saying what was measured and what was expected', () => {
    const f = good();
    f.epub.opf!.manifest[2]!.present = false;
    f.epub.opf!.spine.push({ idref: 'ghost', known: false });
    f.epub.zip.mimetypeFirst = false;
    f.epub.documents[2]!.brokenLinks = ['ch9.xhtml'];
    f.epub.documents[3]!.wellFormed = false;
    const found = runPreflight(f);
    expect(found.find((x) => x.ruleId === 'epub.manifest')).toMatchObject({ grade: 'error', measured: 'ch1.xhtml is absent', expected: 'every manifest item present' });
    expect(found.map((x) => x.ruleId)).toEqual(expect.arrayContaining(['epub.spine', 'epub.mimetype', 'doc.links', 'doc.xml']));
    expect(found.every((x) => x.measured && x.expected)).toBe(true);
  });

  it('an unreadable zip or a missing package stops the rest from guessing', () => {
    const f = good();
    f.epub.zip = { readable: false, error: 'bad end of central directory', entries: [], mimetypeFirst: false, mimetypeStored: false, mimetypeText: null };
    expect(runPreflight(f)[0]).toMatchObject({ ruleId: 'epub.zip', grade: 'error', measured: 'bad end of central directory' });
    const g = good();
    g.epub.rootfile = null;
    expect(runPreflight(g)[0]).toMatchObject({ ruleId: 'epub.container', grade: 'error' });
  });

  it('navigation: a contents entry that points nowhere, a missing nav, out-of-order entries and too few entries', () => {
    const f = good();
    f.epub.nav!.entries[1] = { label: 'Two', href: 'gone.xhtml', target: 'OEBPS/gone.xhtml', resolved: false };
    expect(ids(f)).toContain('error:nav.link');
    const g = good();
    g.epub.nav = null;
    expect(ids(g)).toContain('error:nav.missing');
    const h = good();
    h.epub.nav!.entries.reverse();
    expect(ids(h)).toContain('warning:nav.order');
    const k = good();
    k.epub.documents = [...k.epub.documents, ...Array.from({ length: 8 }, (_v, i) => doc(`OEBPS/x${i}.xhtml`, { types: ['chapter'], heading: `X${i}` }))];
    expect(ids(k)).toContain('warning:nav.coverage');
    const n = good();
    n.epub.ncx = false;
    expect(ids(n)).toEqual(['suggestion:nav.ncx']);
  });

  it('front and back matter: a missing title page or copyright page is a warning, the optional pages a suggestion', () => {
    const f = good();
    f.epub.documents = f.epub.documents.filter((d) => !/title|copyright|about|alsoby/.test(d.path));
    f.epub.nav!.entries = f.epub.nav!.entries.slice(0, 2);
    expect(ids(f)).toEqual(expect.arrayContaining(['warning:matter.titlepage', 'warning:matter.copyright', 'suggestion:matter.about', 'suggestion:matter.alsoby']));
  });

  it('names and series: a title, an author, a series and a number that disagree with the catalogue are errors', () => {
    const f = good();
    f.epub.opf!.title = 'Dragon Rider: Book Three';
    f.epub.opf!.creators = ['Blake Ashford'];
    f.epub.opf!.series = 'Dragon Riders';
    f.epub.opf!.seriesIndex = '3';
    f.epub.titlePage = { title: 'Dragon Rider: Book Three', author: 'Blake Ashford' };
    const found = runPreflight(f);
    expect(found.find((x) => x.ruleId === 'names.title')).toMatchObject({ grade: 'error', measured: 'Dragon Rider: Book Three', expected: 'Dragon Rider: Book Four' });
    expect(found.map((x) => `${x.grade}:${x.ruleId}`)).toEqual(expect.arrayContaining(['error:names.author', 'warning:names.authorpage', 'error:names.series']));
    const g = good();
    g.epub.opf!.seriesIndex = '3';
    expect(runPreflight(g).find((x) => x.ruleId === 'names.seriesnumber')).toMatchObject({ measured: '3', expected: '4' });
    const h = good();
    h.epub.opf!.series = null;
    expect(ids(h)).toEqual(['warning:names.series']);
    const k = good();
    k.book.series = null;
    expect(ids(k)).toEqual(['warning:names.series']);
  });

  it('a title with a subtitle in the catalogue matches an EPUB that carries both', () => {
    const f = good();
    f.book.title = 'Dragon Rider';
    f.book.subtitle = 'Book Four';
    f.epub.opf!.title = 'Dragon Rider Book Four';
    f.epub.titlePage = { title: 'Dragon Rider', author: 'Ash Wilder' };
    expect(runPreflight(f)).toEqual([]);
  });

  it('the cover: size and shape against the KDP pack, with the graded boundaries', () => {
    const at = (w: number, h: number, bytes = 900_000) => {
      const f = good();
      f.epub.cover = { ...f.epub.cover!, width: w, height: h, bytes };
      f.approvedCover = null;
      return runPreflight(f).filter((x) => x.ruleId.startsWith('cover.') && x.ruleId !== 'cover.approved').map((x) => `${x.grade}:${x.ruleId}`);
    };
    expect(at(1600, 2560)).toEqual([]);
    expect(at(400, 450)).toEqual(['error:cover.size']); // under 500 on the longest side
    expect(at(500, 800)).toEqual(['warning:cover.size']); // accepted, under the older page's 625 × 1000 guidance
    expect(at(625, 1000)).toEqual(['suggestion:cover.recommended']);
    expect(at(1600, 1600)).toEqual(['suggestion:cover.ratio']);
    expect(at(1600, 10_001)).toContain('error:cover.size');
    expect(at(1600, 2560, 51 * 1024 * 1024)).toEqual(['error:cover.bytes']);
    const f = good();
    f.epub.cover = { ...f.epub.cover!, format: 'webp' };
    expect(ids(f)).toContain('error:cover.format');
    const g = good();
    g.epub.cover = null;
    expect(ids(g)).toContain('error:cover.missing');
    const c = good();
    c.epubCover = { colour: 'cmyk', dpi: 72 };
    c.epub.cover!.width = 1000;
    c.epub.cover!.height = 1600;
    expect(ids(c)).toEqual(expect.arrayContaining(['suggestion:cover.colour', 'suggestion:cover.dpi']));
  });

  it('the EPUB’s cover must be the approved asset version, and the check says so when there is none or it differs', () => {
    const f = good();
    f.epub.cover!.hash = 'b'.repeat(64);
    expect(runPreflight(f).find((x) => x.ruleId === 'cover.approved')).toMatchObject({ grade: 'warning', measured: 'file bbbbbbbbbbbb', expected: 'approved version 3, file aaaaaaaaaaaa' });
    const g = good();
    g.approvedCover = null;
    expect(runPreflight(g).find((x) => x.ruleId === 'cover.approved')).toMatchObject({ grade: 'warning', measured: 'no approved cover' });
  });

  it('retailer metadata: blurb length, keywords, title length, price', () => {
    const f = good();
    f.book.blurb = 'x'.repeat(4001);
    f.book.keywords = ['one', 'x'.repeat(51)];
    f.book.price = null;
    expect(ids(f)).toEqual(expect.arrayContaining(['error:meta.blurb', 'suggestion:meta.keywords', 'error:meta.keywordlength', 'warning:meta.price']));
    const g = good();
    g.book.blurb = null;
    g.book.keywords = null;
    g.book.isbn = null;
    expect(ids(g)).toEqual(expect.arrayContaining(['warning:meta.blurb', 'warning:meta.keywords', 'suggestion:meta.identifier']));
    const h = good();
    h.book.keywords = Array.from({ length: 8 }, (_v, i) => `k${i}`);
    expect(ids(h)).toContain('error:meta.keywords');
    const t = good();
    t.book.title = 'T'.repeat(190);
    t.book.subtitle = 'S'.repeat(20);
    t.epub.opf!.title = `${t.book.title} ${t.book.subtitle}`;
    t.epub.titlePage = { title: t.book.title, author: 'Ash Wilder' };
    expect(ids(t)).toEqual(['error:meta.title']);
  });

  it('a pack says when it was read, how old that is, and what it does not check', () => {
    expect(KDP_PACK.verified).toBe('2026-11-19');
    expect(packAgeMonths(KDP_PACK, '2026-12-18T00:00:00Z')).toBe(0);
    expect(packAgeMonths(KDP_PACK, '2027-05-20T00:00:00Z')).toBe(6);
    expect(packAgeMonths({ verified: '' }, '2027-05-20')).toBeNull();
    expect(KDP_PACK.notChecked.length).toBeGreaterThan(0);
    expect(KDP_PACK.sources.every((s) => s.rule && s.url)).toBe(true);
  });
});
