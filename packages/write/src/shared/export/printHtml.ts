import type { BookBuild } from './assemble';
import { fontStack } from './fonts';
import { blocksHtml, chapterHeadingHtml, esc, matterPageHtml } from './html';
import type { ParagraphStyle } from './model';
import { trimByKey } from './trim';


export interface PrintLayout {
  trimKey: string;
  /** Inside (binding-side) margin in inches. */
  gutter: number;
  outer: number;
  top: number;
  bottom: number;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

function paragraphCss(style: ParagraphStyle): string {
  switch (style) {
    case 'blockGap':
      return 'p { margin: 0 0 1em 0; text-indent: 0; }';
    case 'blockNoGap':
      return 'p { margin: 0; text-indent: 0; }';
    case 'indent':
      return 'p { margin: 0; text-indent: 0.25in; }\np.first { text-indent: 0; }';
  }
}

/** The @page rules: exact trim, mirrored margins, footer at the outer edge, optional running heads. */
export function pageCss(book: BookBuild, layout: PrintLayout): string {
  const s = book.settings.pdf;
  const trim = trimByKey(layout.trimKey);
  const { gutter: g, outer: o, top: t, bottom: b } = layout;
  
  const rightBoxes: string[] = [];
  const leftBoxes: string[] = [];
  if (s.pageNumbers) {
    // page number at the outer edge: right on recto (odd) pages, left on verso (even) pages
    rightBoxes.push('@bottom-right { content: counter(page); text-align: right; vertical-align: middle; font-size: 9pt; }'); // replaced at layout time by labels (see POST_LAYOUT_SCRIPT)
    leftBoxes.push('@bottom-left { content: counter(page); text-align: left; vertical-align: middle; font-size: 9pt; }');
  }
  if (s.runningHead !== 'none') {
    // The text itself is set after layout (see POST_LAYOUT_SCRIPT) so chapter openers can go without.
    const box = '@top-center { content: " "; text-align: center; vertical-align: middle; font-size: 9pt; font-variant: small-caps; letter-spacing: 0.05em; }';
    rightBoxes.push(box);
    leftBoxes.push(box);
  }

  const off = '@bottom-left { content: none; } @bottom-right { content: none; } @top-center { content: none; }';

  return `@page { size: ${fmt(trim.width)}in ${fmt(trim.height)}in; }
@page :right { margin: ${fmt(t)}in ${fmt(o)}in ${fmt(b)}in ${fmt(g)}in; ${rightBoxes.join(' ')} }
@page :left { margin: ${fmt(t)}in ${fmt(g)}in ${fmt(b)}in ${fmt(o)}in; ${leftBoxes.join(' ')} }
@page front { ${off} }
@page :blank { ${off} }`;
}

export function printCss(book: BookBuild, layout: PrintLayout): string {
  const s = book.settings.pdf;
  const breakBefore = s.rectoStarts ? 'right' : 'page';
  const stack = fontStack(s.font);
  return `${pageCss(book, layout)}

html { font-family: ${stack}; font-size: ${s.fontSize}pt; }
body { margin: 0; font-family: ${stack}; font-size: ${s.fontSize}pt; line-height: 1.25; color: #000; hyphens: none; -webkit-hyphens: none; }
p { text-align: justify; orphans: 2; widows: 2; }
${paragraphCss(s.paragraphStyle)}
em { font-style: italic; } strong { font-weight: 700; }
blockquote { margin: 1em 1.5em; }
pre { white-space: pre-wrap; font-size: 0.9em; }
h2.sub, h3.sub, h4.sub, h5.sub, h6.sub { text-align: center; margin: 1.5em 0 1em; font-weight: 700; break-after: avoid; }

section.front { page: front; }
section.titlepage { break-before: page; text-align: center; padding-top: 28%; }
section.copyright { break-before: page; }
section.centered-page { break-before: ${breakBefore}; padding-top: 22%; }
section.toc { break-before: ${breakBefore}; }
section.body { break-before: ${breakBefore}; }
section.backpage { break-before: ${breakBefore}; }

p.booktitle { text-align: center; font-size: 2.4em; font-weight: 700; margin: 0 0 0.4em; text-indent: 0; line-height: 1.1; }
p.booksubtitle { text-align: center; font-style: italic; font-size: 1.3em; margin: 0 0 2em; text-indent: 0; }
p.bookauthor { text-align: center; font-weight: 700; font-size: 1.3em; margin: 2em 0 0; text-indent: 0; }
.copyright p { text-align: left; text-indent: 0; }
.copyright p.crline { margin: 0 0 0.6em; }
.copyright p.crpara { margin: 0 0 0.9em; font-size: 0.9em; }
p.center { text-align: center; } p.right { text-align: right; }
p.linkline { text-align: left; text-indent: 0; margin: 0 0 0.6em; overflow-wrap: anywhere; }
p.scenebreak { text-align: center; margin: 1.2em 0; text-indent: 0; }

h1 { text-align: center; font-weight: 700; }
h1.chapter { font-size: 1.6em; margin: 0 0 2em; padding-top: 1.25in; break-after: avoid; }
h1.matter { font-size: 1.4em; margin: 0 0 1.5em; padding-top: 0.5in; break-after: avoid; }
h1.toc-title { font-size: 1.4em; margin: 0 0 1.5em; padding-top: 0.5in; }

.toc ol { list-style: none; padding: 0; margin: 0; }
.toc li { margin: 0 0 0.6em; }
.toc a { display: flex; align-items: baseline; color: inherit; text-decoration: none; }
.toc .toc-title { flex: none; max-width: 80%; }
.toc .toc-dots { flex: 1; overflow: hidden; margin: 0 0.4em; white-space: nowrap; }
.toc .toc-dots::after { content: '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .'; }
.toc .toc-num { flex: none; min-width: 2em; text-align: right; font-variant-numeric: lining-nums tabular-nums; }

/* Page numbers are labelled after layout (they count from the first chapter); show those. */
.pagedjs_margin-bottom-left .pagedjs_margin-content::after,
.pagedjs_margin-bottom-right .pagedjs_margin-content::after { content: attr(data-pn) !important; }
.pagedjs_margin-top-center .pagedjs_margin-content::after { content: attr(data-rh) !important; }
`;
}

export function printBody(book: BookBuild): string {
  const sceneBreak = book.settings.sceneBreak;
  const sections: string[] = [];
  for (const p of book.front) {
    const cls = p.id === 'title' ? 'titlepage' : p.id === 'copyright' ? 'copyright' : 'centered-page';
    sections.push(`<section class="front ${cls}" id="front-${p.id}">\n${matterPageHtml(p, 'print')}\n</section>`);
  }
  const toc = book.toc
    .map((t) => `<li><a href="#${esc(t.id)}" data-toc-target="${esc(t.id)}"><span class="toc-title">${esc(t.label)}</span><span class="toc-dots"></span><span class="toc-num">000</span></a></li>`)
    .join('\n');
  sections.push(`<section class="front toc" id="contents">\n<h1 class="toc-title">CONTENTS</h1>\n<ol>\n${toc}\n</ol>\n</section>`);

  book.chapters.forEach((c, i) => {
    sections.push(
      `<section class="body" id="${c.id}">\n<h1 class="chapter">${chapterHeadingHtml(c)}</h1>\n${blocksHtml(c.blocks, 'print', sceneBreak)}\n</section>`
    );
  });
  for (const p of book.back) {
    sections.push(`<section class="backpage" id="back-${p.id}">\n${matterPageHtml(p, 'print')}\n</section>`);
  }
  return sections.join('\n');
}

/** Arguments for window.__mdeditPostLayout: running-head text per side, and the sections that open a page group. */
export function postLayoutConfig(book: BookBuild): { heads: { recto: string; verso: string } | null; openers: string[] } {
  const rh = book.settings.pdf.runningHead;
  const m = book.meta;
  const heads =
    rh === 'author' ? { recto: m.author, verso: m.author }
    : rh === 'title' ? { recto: m.title, verso: m.title }
    : rh === 'authorTitle' ? { recto: m.title, verso: m.author }
    : null;
  return { heads, openers: [...book.chapters.map((c) => c.id), ...book.back.map((p) => `back-${p.id}`)] };
}

/**
 * Runs after Paged.js has paginated. Numbers the body pages from the first chapter (counting blank
 * versos, like a real book), writes the labels into the footer boxes, and fills in the contents
 * page. Doing this ourselves keeps the footers and the contents list consistent by construction.
 * Also exposes the labels as window.__mdeditLabels for verification.
 */
export const POST_LAYOUT_SCRIPT = `
window.__mdeditPostLayout = function (firstBodyId, config) {
  var area = document.querySelector('.pagedjs_pages');
  var pages = Array.prototype.slice.call(area.querySelectorAll('.pagedjs_page'));
  var first = area.querySelector('#' + firstBodyId);
  var startIdx = first ? pages.indexOf(first.closest('.pagedjs_page')) : -1;
  var labels = pages.map(function (pg, i) { return startIdx >= 0 && i >= startIdx ? String(i - startIdx + 1) : ''; });
  pages.forEach(function (pg, i) {
    pg.querySelectorAll('.pagedjs_margin-bottom-left .pagedjs_margin-content, .pagedjs_margin-bottom-right .pagedjs_margin-content')
      .forEach(function (el) { el.setAttribute('data-pn', labels[i]); });
  });
  area.querySelectorAll('a[data-toc-target]').forEach(function (a) {
    var target = area.querySelector('#' + a.getAttribute('data-toc-target'));
    var pg = target && target.closest('.pagedjs_page');
    var idx = pg ? pages.indexOf(pg) : -1;
    var num = a.querySelector('.toc-num');
    if (num) num.textContent = idx >= 0 ? labels[idx] : '';
  });
  var openerIdx = {};
  ((config && config.openers) || []).forEach(function (id) {
    var el = area.querySelector('#' + id);
    var pg = el && el.closest('.pagedjs_page');
    if (pg) openerIdx[pages.indexOf(pg)] = true;
  });
  if (config && config.heads) {
    pages.forEach(function (pg, i) {
      var recto = (i + 1) % 2 === 1;
      var text = i < startIdx || openerIdx[i] ? '' : recto ? config.heads.recto : config.heads.verso;
      pg.querySelectorAll('.pagedjs_margin-top-center .pagedjs_margin-content').forEach(function (el) { el.setAttribute('data-rh', text); });
    });
  }
  window.__mdeditLabels = labels;
  return pages.length;
};
`;

/** A complete, self-contained HTML document for Paged.js to paginate. */
export function buildPrintHtml(book: BookBuild, layout: PrintLayout, assets: { fontCss: string; scripts?: string }): string {
  return `<!DOCTYPE html>
<html lang="${esc(book.meta.language)}">
<head>
<meta charset="utf-8"/>
<title>${esc(book.meta.title)}</title>
<style>
${assets.fontCss}
${printCss(book, layout)}
</style>
${assets.scripts ?? ''}
<script>${POST_LAYOUT_SCRIPT}</script>
</head>
<body>
${printBody(book)}
</body>
</html>
`;
}
