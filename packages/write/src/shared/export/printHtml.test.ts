import { describe, expect, it } from 'vitest';
import { assembleBook, type BookBuild } from './assemble';
import { defaultBookDetails, type BookDetails } from './model';
import { buildPrintHtml, pageCss, POST_LAYOUT_SCRIPT, postLayoutConfig, printBody, printCss } from './printHtml';

const SRC = '# Chapter 1: A\n\nOne "quoted" & <b>.\n\n* * *\n\nTwo.\n\n# Chapter 2: B\n\nThree.\n';
const book = (edit: (d: BookDetails) => void = () => undefined): BookBuild => {
  const d = defaultBookDetails({ title: 'T & "Q"', author: 'Au', year: 2031 });
  d.back.about = { enabled: true, heading: '', text: 'Bio' };
  edit(d);
  return assembleBook(SRC, d, { uuid: () => 'u', now: new Date('2031-01-01T00:00:00Z') }).build!;
};
const layout = (gutter = 0.375) => ({ trimKey: '5.5x8.5', gutter, outer: 0.5, top: 0.75, bottom: 0.75 });

describe('pageCss', () => {
  it('sets the exact trim size and mirrors the margins (gutter on the inside of each side)', () => {
    const css = pageCss(book(), layout(0.625));
    expect(css).toContain('@page { size: 5.5in 8.5in; }');
    expect(css).toMatch(/@page :right \{ margin: 0\.75in 0\.5in 0\.75in 0\.625in;/); // left = inside
    expect(css).toMatch(/@page :left \{ margin: 0\.75in 0\.625in 0\.75in 0\.5in;/); // right = inside
  });
  it('uses the chosen trim size', () => {
    expect(pageCss(book(), { ...layout(), trimKey: '6x9' })).toContain('size: 6in 9in');
    expect(pageCss(book(), { ...layout(), trimKey: '5.06x7.81' })).toContain('size: 5.06in 7.81in');
  });
  it('page numbers sit at the outer edge: bottom-right on recto, bottom-left on verso', () => {
    const css = pageCss(book(), layout());
    expect(css).toMatch(/@page :right \{[^}]*@bottom-right \{ content: counter\(page\)/);
    expect(css).toMatch(/@page :left \{[^}]*@bottom-left \{ content: counter\(page\)/);
  });
  it('page numbers can be switched off; running heads are opt-in', () => {
    const off = pageCss(book((d) => (d.export.pdf.pageNumbers = false)), layout());
    expect(off).not.toContain('counter(page)');
    expect(pageCss(book(), layout())).not.toContain('@top-center { content: " "');
    expect(pageCss(book((d) => (d.export.pdf.runningHead = 'title')), layout())).toContain('@top-center');
  });
  it('front matter and blank pages carry no footer or head', () => {
    const css = pageCss(book(), layout());
    expect(css).toMatch(/@page front \{[^}]*@bottom-left \{ content: none; \}[^}]*@bottom-right \{ content: none; \}/);
    expect(css).toMatch(/@page :blank \{[^}]*content: none/);
  });
});

describe('printCss options', () => {
  it('chapters break to a recto by default, to any page when off', () => {
    expect(printCss(book(), layout())).toContain('section.body { break-before: right; }');
    expect(printCss(book((d) => (d.export.pdf.rectoStarts = false)), layout())).toContain('section.body { break-before: page; }');
  });
  it.each([
    ['blockNoGap', 'p { margin: 0; text-indent: 0; }'],
    ['blockGap', 'p { margin: 0 0 1em 0; text-indent: 0; }'],
    ['indent', 'p { margin: 0; text-indent: 0.25in; }']
  ] as const)('paragraph style %s', (style, css) => {
    expect(printCss(book((d) => (d.export.pdf.paragraphStyle = style)), layout())).toContain(css);
  });
  it('uses the chosen font family with a serif fallback', () => {
    const css = printCss(book((d) => (d.export.pdf.font = 'Palatino Linotype')), layout());
    expect(css).toContain('font-family: "Palatino Linotype", serif;');
    expect(css).not.toContain('EB Garamond');
  });
  it('Garamond at the chosen size, justified, unhyphenated', () => {
    const css = printCss(book((d) => (d.export.pdf.fontSize = 10.5)), layout());
    expect(css).toContain('font-size: 10.5pt');
    expect(css).toContain('"EB Garamond", Garamond, serif');
    expect(css).toContain('text-align: justify');
    expect(css).toContain('hyphens: none');
  });
});

describe('printBody', () => {
  const body = printBody(book());
  it('orders front matter, contents, chapters, back matter', () => {
    const order = ['id="front-title"', 'id="front-copyright"', 'id="contents"', 'id="chapter1"', 'id="chapter2"', 'id="back-about"'].map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('contents list links every chapter and back page, with a dot-leader row and a number slot', () => {
    expect(body).toContain('<a href="#chapter1" data-toc-target="chapter1"><span class="toc-title">Chapter 1: A</span><span class="toc-dots"></span><span class="toc-num">000</span></a>');
    expect(body).toContain('data-toc-target="back-about"');
    expect(body).not.toMatch(/toc-title">(Title Page|Copyright)/);
  });
  it('has unique ids (so TOC links resolve to one place)', () => {
    const ids = [...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('escapes the title and text; print has no hyperlinks', () => {
    const html = buildPrintHtml(book(), layout(), { fontCss: '' });
    expect(html).toContain('<title>T &amp; &quot;Q&quot;</title>');
    expect(html).toContain('&amp;');
    expect(html).not.toMatch(/<a href="https?:/);
  });
  it('uses the scene-break glyph', () => {
    expect(printBody(book((d) => (d.export.sceneBreak = '~ ~ ~')))).toContain('<p class="scenebreak">~ ~ ~</p>');
  });
});

describe('buildPrintHtml', () => {
  it('is self-contained: fonts and scripts come from the caller, nothing is fetched', () => {
    const html = buildPrintHtml(book(), layout(), { fontCss: '@font-face{font-family:"EB Garamond";src:url(data:font/woff2;base64,AAAA)}', scripts: '<script>var x=1</script>' });
    expect(html).toContain('data:font/woff2;base64,AAAA');
    expect(html).toContain('<script>var x=1</script>');
    expect(html).toContain(POST_LAYOUT_SCRIPT.slice(0, 40));
    expect(html).not.toMatch(/(src|href)="https?:/);
  });
});

describe('postLayoutConfig', () => {
  it('no heads by default; author/title per side for authorTitle; openers are chapters and back pages', () => {
    expect(postLayoutConfig(book()).heads).toBeNull();
    expect(postLayoutConfig(book((d) => (d.export.pdf.runningHead = 'authorTitle')))).toEqual({
      heads: { recto: 'T & "Q"', verso: 'Au' },
      openers: ['chapter1', 'chapter2', 'back-about']
    });
    expect(postLayoutConfig(book((d) => (d.export.pdf.runningHead = 'author'))).heads).toEqual({ recto: 'Au', verso: 'Au' });
  });
});
