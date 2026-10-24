import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { assembleBook, type BookBuild } from './assemble';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildEpub, epubCss, verifyEpub } from './epub';
import { bundledFont, embeddedFileName, FONT_FILES } from './fonts';
import { defaultBookDetails, type BookDetails } from './model';
import { epubcheckAvailable, runEpubcheck } from './testing/epubcheck';

const SRC = `# Chapter 1: Coming Back

"It's *over*," she said. He didn't answer.

A second paragraph with **bold** & \\<angle\\> brackets and a [link](https://example.com/x?a=1&b=2).

* * *

After the break.

## A sub-heading

> A quoted line.

- one
- two

# Chapter 2: Leaving

Gone.

# Epilogue

The end.
`;

const env = { now: new Date('2031-05-06T07:08:09Z'), uuid: () => '123e4567-e89b-12d3-a456-426614174000' };
const details = (edit: (d: BookDetails) => void = () => undefined): BookDetails => {
  const d = defaultBookDetails({ title: 'The Lost King', author: 'A. Writer', year: 2031 });
  d.subtitle = 'A Tale of Two & More';
  d.copyright.matureNotice = true;
  d.copyright.contentWarning = true;
  d.copyright.publisher = 'Acme Press';
  d.copyright.isbn = '978-1-23456-789-7';
  d.dedication = { enabled: true, text: 'For everyone.' };
  d.epigraph = { enabled: true, text: 'To be or not.', attribution: 'Someone' };
  d.back.links = { enabled: true, heading: '', intro: 'More at:', items: [{ label: 'Newsletter', url: 'https://example.com/news?a=1&b=2' }, { label: 'Bad', url: 'javascript:alert(1)' }] };
  d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book Two', url: '' }] };
  d.back.about = { enabled: true, heading: '', text: 'Bio.' };
  edit(d);
  return d;
};
const book = (edit?: (d: BookDetails) => void): BookBuild => {
  const r = assembleBook(SRC, details(edit), env);
  expect(r.errors).toEqual([]);
  return r.build!;
};
const unzip = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, v]));
const read = (files: Record<string, Uint8Array>, name: string) => strFromU8(files[name]);

describe('buildEpub structure (skill rules)', () => {
  const bytes = buildEpub(book());
  const files = unzip(bytes);

  it('passes the built-in self-check', () => {
    expect(verifyEpub(bytes)).toEqual([]);
  });

  it('mimetype is first, stored, exactly 20 bytes, no newline', () => {
    expect(Object.keys(files)[0]).toBe('mimetype');
    expect(files['mimetype']).toHaveLength(20);
    expect(read(files, 'mimetype')).toBe('application/epub+zip');
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getUint16(8, true)).toBe(0); // stored
    expect(dv.getUint16(28, true)).toBe(0); // no extra field
  });

  it('has the skill’s file layout', () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/stylesheet.css', 'OEBPS/toc.ncx',
        'OEBPS/text/title.xhtml', 'OEBPS/text/copyright.xhtml', 'OEBPS/text/dedication.xhtml', 'OEBPS/text/epigraph.xhtml',
        'OEBPS/text/chapter1.xhtml', 'OEBPS/text/chapter2.xhtml', 'OEBPS/text/chapter3.xhtml',
        'OEBPS/text/back-links.xhtml', 'OEBPS/text/back-alsoBy.xhtml', 'OEBPS/text/back-about.xhtml', 'mimetype'
      ].sort()
    );
  });

  it('every file is well-formed XML', () => {
    for (const [name, data] of Object.entries(files)) {
      if (!/\.(xhtml|opf|ncx|xml)$/.test(name)) continue;
      const errors: string[] = [];
      new DOMParser({ onError: (_l, msg) => errors.push(msg) }).parseFromString(strFromU8(data), 'text/xml');
      expect({ name, errors }).toEqual({ name, errors: [] });
    }
  });

  it('spine order: title, copyright, dedication, epigraph, nav, chapters, back matter', () => {
    const opf = read(files, 'OEBPS/content.opf');
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    expect(spine).toEqual(['title', 'copyright', 'dedication', 'epigraph', 'nav', 'chapter1', 'chapter2', 'chapter3', 'back-links', 'back-alsoBy', 'back-about']);
  });

  it('nav lists only real content, with the heading CONTENTS', () => {
    const nav = read(files, 'OEBPS/nav.xhtml');
    expect(nav).toContain('<nav epub:type="toc" id="toc">');
    expect(nav).toContain('<h1>CONTENTS</h1>');
    const labels = [...nav.match(/<nav epub:type="toc"[\s\S]*?<\/nav>/)![0].matchAll(/<a href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Chapter 1: Coming Back', 'Chapter 2: Leaving', 'Epilogue', 'CONTINUE THE STORY', 'ALSO BY A. WRITER', 'ABOUT THE AUTHOR']);
    expect(nav).not.toMatch(/title\.xhtml|copyright\.xhtml/);
    expect(nav).toContain('href="stylesheet.css"'); // nav is at the OEBPS root
  });

  it('text files link the stylesheet as ../stylesheet.css', () => {
    for (const n of Object.keys(files).filter((k) => k.startsWith('OEBPS/text/'))) {
      expect(read(files, n)).toContain('href="../stylesheet.css"');
    }
  });

  it('toc.ncx mirrors the contents with sequential playOrder', () => {
    const ncx = read(files, 'OEBPS/toc.ncx');
    expect([...ncx.matchAll(/playOrder="(\d+)"/g)].map((m) => +m[1])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ncx).toContain('dtb:uid" content="urn:uuid:123e4567');
  });

  it('metadata: identifier, title + subtitle, creator, language, rights, publisher, ISBN, modified', () => {
    const opf = read(files, 'OEBPS/content.opf');
    expect(opf).toContain('<dc:identifier id="bookid">urn:uuid:123e4567-e89b-12d3-a456-426614174000</dc:identifier>');
    expect(opf).toContain('<dc:title id="dc-title">The Lost King</dc:title>');
    expect(opf).toContain('<dc:title id="dc-subtitle">A Tale of Two &amp; More</dc:title>');
    expect(opf).toContain('<dc:creator id="dc-creator">A. Writer</dc:creator>');
    expect(opf).toContain('<dc:language>en</dc:language>');
    expect(opf).toContain('<dc:rights>Copyright © 2031 by A. Writer</dc:rights>');
    expect(opf).toContain('<dc:publisher>Acme Press</dc:publisher>');
    expect(opf).toContain('urn:isbn:9781234567897');
    expect(opf).toContain('<meta property="dcterms:modified">2031-05-06T07:08:09Z</meta>');
  });

  it('is deterministic for the same input', () => {
    expect(Buffer.from(buildEpub(book())).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('buildEpub content', () => {
  const files = unzip(buildEpub(book()));
  const ch1 = read(files, 'OEBPS/text/chapter1.xhtml');

  it('chapter heading carries id and class; body has paragraphs, scene break glyph, sub-heading, quote, list', () => {
    expect(ch1).toContain('<h1 class="chapter" id="chapter1">Chapter 1: Coming Back</h1>');
    expect(ch1).toContain('<p class="scenebreak">•  •  •</p>');
    expect(ch1).toContain('<h2 class="sub">A sub-heading</h2>');
    expect(ch1).toContain('<blockquote>');
    expect(ch1).toContain('<ul><li>one</li><li>two</li></ul>');
  });

  it('escapes special characters and keeps real links (web only)', () => {
    expect(ch1).toContain('&amp; &lt;angle&gt; brackets');
    expect(ch1).toContain('<a href="https://example.com/x?a=1&amp;b=2">link</a>');
  });

  it('smart quotes were applied', () => {
    expect(ch1).toContain('“It’s <em>over</em>,” she said. He didn’t answer.');
  });

  it('title page is explicitly centred; copyright page follows the skill order', () => {
    const title = read(files, 'OEBPS/text/title.xhtml');
    expect(title).toContain('class="titlepage"');
    expect(title).toMatch(/booktitle">The Lost King[\s\S]*booksubtitle">A Tale of Two &amp; More[\s\S]*bookauthor">A\. Writer/);
    const css = read(files, 'OEBPS/stylesheet.css');
    expect(css).toMatch(/\.titlepage \{ text-align: center/);
    expect(css).toMatch(/p\.booktitle \{ text-align: center/);
    const cr = read(files, 'OEBPS/text/copyright.xhtml');
    const order = ['The Lost King', 'Copyright © 2031 by A. Writer', 'All rights reserved.', 'This is a work of fiction', 'No part of this book', 'mature themes', 'Add Content Warnings here', 'Published by Acme Press', 'ISBN:', 'First Edition'].map((t) => cr.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(cr).toContain('<strong>This book contains mature themes');
  });

  it('back matter: real hyperlinks for good URLs, nothing for bad ones', () => {
    const links = read(files, 'OEBPS/text/back-links.xhtml');
    expect(links).toContain('<a href="https://example.com/news?a=1&amp;b=2">Newsletter</a>');
    expect(links).not.toMatch(/javascript|Bad/);
    expect(links).toContain('<h1 class="matter">CONTINUE THE STORY</h1>');
  });

  it('back-matter headings are not given the chapter drop cap class', () => {
    expect(read(files, 'OEBPS/text/back-about.xhtml')).not.toContain('class="chapter"');
  });
});

describe('buildEpub options', () => {
  it('chapter heading style numberWord gives "Chapter One: <em>Coming Back</em>"', () => {
    const files = unzip(buildEpub(book((d) => (d.export.chapterHeading = 'numberWord'))));
    expect(read(files, 'OEBPS/text/chapter1.xhtml')).toContain('<h1 class="chapter" id="chapter1">Chapter One: <em>Coming Back</em></h1>');
    expect(read(files, 'OEBPS/nav.xhtml')).toContain('>Chapter One: Coming Back</a>');
  });

  it('drop caps only when enabled, and only on h1.chapter + p', () => {
    expect(epubCss({ fontSize: 11, paragraphStyle: 'blockGap', dropCaps: true })).toContain('h1.chapter + p::first-letter');
    expect(epubCss({ fontSize: 11, paragraphStyle: 'blockGap', dropCaps: false })).not.toContain('first-letter');
  });

  it.each([
    ['blockGap', 'margin: 0 0 1em 0'],
    ['blockNoGap', 'p { text-align: justify; text-indent: 0; margin: 0; }'],
    ['indent', 'text-indent: 1.5em']
  ] as const)('paragraph style %s', (style, css) => {
    expect(epubCss({ fontSize: 11, paragraphStyle: style, dropCaps: false })).toContain(css);
  });

  it('font size and family come through (Garamond, 11pt by default)', () => {
    const css = epubCss({ fontSize: 12, paragraphStyle: 'blockGap', dropCaps: true });
    expect(css).toContain('font-size: 12pt');
    expect(css).toContain('Garamond');
    expect(unzip(buildEpub(book())) ['OEBPS/stylesheet.css']).toBeTruthy();
    expect(read(unzip(buildEpub(book())), 'OEBPS/stylesheet.css')).toContain('font-size: 11pt');
  });

  it('custom scene break glyph', () => {
    const files = unzip(buildEpub(book((d) => (d.export.sceneBreak = '***'))));
    expect(read(files, 'OEBPS/text/chapter1.xhtml')).toContain('<p class="scenebreak">***</p>');
  });

  it('language and description go into the package', () => {
    const files = unzip(buildEpub(book((d) => { d.export.epub.language = 'fr'; d.export.epub.description = 'A <b>great</b> book'; })));
    const opf = read(files, 'OEBPS/content.opf');
    expect(opf).toContain('<dc:language>fr</dc:language>');
    expect(opf).toContain('<dc:description>A &lt;b&gt;great&lt;/b&gt; book</dc:description>');
    expect(read(files, 'OEBPS/text/chapter1.xhtml')).toContain('lang="fr"');
  });

  it('no subtitle, publisher, ISBN or back matter → none of their metadata or files', () => {
    const files = unzip(buildEpub(book((d) => { d.subtitle = ''; d.copyright.publisher = ''; d.copyright.isbn = ''; d.back.links.enabled = d.back.alsoBy.enabled = d.back.about.enabled = false; d.dedication.enabled = d.epigraph.enabled = false; })));
    const opf = read(files, 'OEBPS/content.opf');
    expect(opf).not.toMatch(/subtitle|dc:publisher|urn:isbn/);
    expect(Object.keys(files).some((k) => k.includes('back-') || k.includes('dedication'))).toBe(false);
  });

  it('embeds an optional cover image (manifest, cover page, landmarks) and still self-checks', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const bytes = buildEpub(book(), { bytes: png, ext: 'png' });
    expect(verifyEpub(bytes)).toEqual([]);
    const files = unzip(bytes);
    expect(Object.keys(files)).toContain('OEBPS/images/cover.png');
    const opf = read(files, 'OEBPS/content.opf');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    expect([...opf.matchAll(/<itemref idref="([^"]+)"/g)][0][1]).toBe('cover');
    expect(read(files, 'OEBPS/nav.xhtml')).toContain('epub:type="cover"');
  });
});

describe('verifyEpub catches broken books', () => {
  it('flags a missing manifest file and a compressed mimetype', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bad = zipSync({
      mimetype: strToU8('application/epub+zip'), // deflated at level 6 by default
      'META-INF/container.xml': strToU8('<container><rootfile full-path="OEBPS/content.opf"/></container>'),
      'OEBPS/content.opf': strToU8('<package><manifest><item id="a" href="gone.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="zzz"/></spine></package>')
    });
    const problems = verifyEpub(bad);
    expect(problems.some((p) => /missing from the zip/.test(p))).toBe(true);
    expect(problems.some((p) => /not in the manifest/.test(p))).toBe(true);
    expect(problems.some((p) => /no navigation document/.test(p))).toBe(true);
  });
  it('rejects non-zip input', () => {
    expect(verifyEpub(new Uint8Array(100))).toEqual(['not a zip file']);
  });
});

describe.skipIf(!epubcheckAvailable)('epubcheck (the real validator)', () => {
  it.each(['EB Garamond', 'Crimson Pro', 'Libre Baskerville'])('accepts a book that embeds the real %s font files', (family) => {
    const b = bundledFont(family)!;
    const fonts = Object.fromEntries(FONT_FILES.map((f) => [f.file, new Uint8Array(readFileSync(path.resolve(__dirname, '../../../assets/fonts', b.slug, f.file)))]));
    const r = runEpubcheck(buildEpub(book((d) => (d.export.epub.font = family)), undefined, fonts));
    expect(r.output).toContain('No errors or warnings detected');
    expect(r.ok).toBe(true);
  }, 120_000);

  it('accepts a fully featured book with zero errors or warnings', () => {
    const r = runEpubcheck(buildEpub(book()));
    expect(r.output).toContain('No errors or warnings detected');
    expect(r.ok).toBe(true);
  });
  it('accepts the minimal book, numberWord headings, no drop caps, and a cover', () => {
    const minimal = book((d) => { d.subtitle = ''; d.dedication.enabled = d.epigraph.enabled = false; d.back.links.enabled = d.back.alsoBy.enabled = d.back.about.enabled = false; d.copyright.publisher = d.copyright.isbn = ''; });
    expect(runEpubcheck(buildEpub(minimal)).ok).toBe(true);
    const styled = book((d) => { d.export.chapterHeading = 'numberWord'; d.export.epub.dropCaps = false; d.export.epub.paragraphStyle = 'indent'; });
    expect(runEpubcheck(buildEpub(styled)).ok).toBe(true);
    // a real 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const withCover = runEpubcheck(buildEpub(book(), { bytes: new Uint8Array(png), ext: 'png' }));
    expect(withCover.output).toContain('No errors or warnings detected');
  });
});

describe('embedded fonts', () => {
  const fakeFonts = () => Object.fromEntries(FONT_FILES.map((f) => [f.file, new Uint8Array([0, 1, 0, 0, f.weight & 255])]));

  it('a bundled family is embedded: four faces, manifest items, css @font-face, and still passes the self-check', () => {
    const b = book((d) => (d.export.epub.font = 'Crimson Pro'));
    const bytes = buildEpub(b, undefined, fakeFonts());
    const files = unzip(bytes);
    const crimson = bundledFont('Crimson Pro')!;
    for (const f of FONT_FILES) expect(files[`OEBPS/fonts/${embeddedFileName(crimson, f)}`]).toBeTruthy();
    const css = read(files, 'OEBPS/stylesheet.css');
    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).toContain('src: url("fonts/crimson-pro-Regular.ttf")');
    expect(css).toContain('body, p { font-family: "Crimson Pro", serif;');
    const opf = read(files, 'OEBPS/content.opf');
    expect(opf.match(/media-type="font\/ttf"/g)).toHaveLength(4);
    expect(verifyEpub(bytes)).toEqual([]);
  });

  it('the default family is embedded too, keeping the Garamond fallback', () => {
    const files = unzip(buildEpub(book(), undefined, fakeFonts()));
    expect(read(files, 'OEBPS/stylesheet.css')).toContain('font-family: "EB Garamond", Garamond, serif;');
    expect(Object.keys(files).filter((n) => n.startsWith('OEBPS/fonts/'))).toHaveLength(4);
  });

  it('a system font is only named, never embedded', () => {
    const files = unzip(buildEpub(book((d) => (d.export.epub.font = 'Georgia')), undefined, fakeFonts()));
    expect(Object.keys(files).some((n) => n.startsWith('OEBPS/fonts/'))).toBe(false);
    const css = read(files, 'OEBPS/stylesheet.css');
    expect(css).not.toContain('@font-face');
    expect(css).toContain('font-family: "Georgia", serif;');
  });

  it('no font files supplied: nothing is embedded and the book is still valid', () => {
    const bytes = buildEpub(book());
    expect(Object.keys(unzip(bytes)).some((n) => n.startsWith('OEBPS/fonts/'))).toBe(false);
    expect(verifyEpub(bytes)).toEqual([]);
  });
});
