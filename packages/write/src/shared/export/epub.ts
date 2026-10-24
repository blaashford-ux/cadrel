import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { BookBuild, BuiltChapter } from './assemble';
import { blocksHtml, chapterHeadingHtml, esc, matterPageHtml } from './html';
import type { MatterPage } from './matter';
import { bundledFont, embeddedFileName, FONT_FILES, fontFaceCss, fontStack } from './fonts';
import type { ParagraphStyle } from './model';

/** The files of a bundled font family, to embed. Keys are FONT_FILES names. */
export type EpubFonts = Record<string, Uint8Array>;

export interface EpubCover {
  bytes: Uint8Array;
  /** 'jpg' | 'png' */
  ext: 'jpg' | 'png';
}

const XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';

/** The skill's EPUB stylesheet, with the per-book options applied. */
export function epubCss(opts: { fontSize: number; paragraphStyle: ParagraphStyle; dropCaps: boolean; font?: string; embedFont?: boolean }): string {
  const stack = fontStack(opts.font ?? 'EB Garamond');
  const bundled = bundledFont(opts.font ?? 'EB Garamond');
  const faces = opts.embedFont && bundled ? fontFaceCss(bundled, (f) => `fonts/${embeddedFileName(bundled, f)}`) + '\n' : '';
  const para =
    opts.paragraphStyle === 'blockGap'
      ? 'p { text-align: justify; text-indent: 0; margin: 0 0 1em 0; }'
      : opts.paragraphStyle === 'blockNoGap'
        ? 'p { text-align: justify; text-indent: 0; margin: 0; }'
        : 'p { text-align: justify; text-indent: 1.5em; margin: 0; }\np.first, p.center, p.right, p.scenebreak, p.booktitle, p.booksubtitle, p.bookauthor, p.crline, p.crpara, p.linkline { text-indent: 0; }';
  return `${faces}h1 {
  font-family: ${stack};
  font-size: 1.6em;
  margin-top: 1em;
  margin-bottom: 2em;
  text-align: center;
}
h2.sub, h3.sub, h4.sub, h5.sub, h6.sub { font-family: ${stack}; text-align: center; margin: 1.5em 0 1em 0; }

body, p { font-family: ${stack}; font-size: ${opts.fontSize}pt; }

${para}
p.first { margin-top: 0; }

p.scenebreak {
  text-align: center;
  margin: 1.2em 0;
  text-indent: 0;
}

blockquote { margin: 1em 2em; }
pre { white-space: pre-wrap; font-size: 0.9em; }

.titlepage { text-align: center; margin-top: 25%; }
p.booktitle { text-align: center; font-size: 2.4em; font-weight: bold; margin: 0 0 0.4em 0; text-indent: 0; }
p.booksubtitle { text-align: center; font-style: italic; font-size: 1.3em; margin: 0 0 2em 0; text-indent: 0; }
p.bookauthor { text-align: center; font-weight: bold; font-size: 1.3em; margin: 2em 0 0 0; text-indent: 0; }

.copyright p.crline { text-align: left; margin: 0 0 0.6em 0; }
.copyright p.crpara { text-align: left; margin: 0 0 0.9em 0; font-size: 0.9em; }
.centered-page { margin-top: 20%; }
p.center { text-align: center; }
p.right { text-align: right; }
p.linkline { text-align: left; margin: 0 0 0.6em 0; }
.backpage h1.matter { margin-top: 1em; }
p.cover { text-align: center; margin: 0; }
img.cover { max-width: 100%; height: auto; }
${
  opts.dropCaps
    ? `
/* Drop cap on the paragraph immediately after a chapter heading only. h1.chapter + p (not a class)
   structurally can't match the paragraph after a scene break. ::first-letter, not a wrapping span,
   for accessibility — a span makes screen readers pronounce the letter apart from the word. */
h1.chapter + p::first-letter {
  float: left;
  font-size: 3.2em;
  line-height: 0.8em;
  padding-right: 0.08em;
  padding-top: 0.05em;
  font-weight: bold;
}

@media amzn-kf8 {
  h1.chapter + p::first-letter { line-height: 1em; }
}
`
    : ''
}
#toc ol { list-style-type: none; padding-left: 0; }
#toc li { margin-bottom: 0.75em; line-height: 1.4; }
#toc a { text-decoration: none; }
`;
}

function xhtml(title: string, bodyHtml: string, css: string, lang: string, bodyClass = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html ${XHTML_NS} lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="${css}"/>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${bodyHtml}
</body>
</html>
`;
}

const textHref = (file: string) => `text/${file}.xhtml`;

interface Item {
  id: string;
  href: string;
  type: string;
  properties?: string;
}

/** Builds the EPUB 3 package (with an NCX for older Kindle firmware). Pure: bytes in, bytes out. */
export function buildEpub(book: BookBuild, cover?: EpubCover, fonts?: EpubFonts): Uint8Array {
  const s = book.settings;
  const m = book.meta;
  const bundled = bundledFont(s.epub.font);
  const embed = !!bundled && !!fonts && FONT_FILES.every((f) => fonts[f.file]);
  const css = epubCss({ fontSize: s.epub.fontSize, paragraphStyle: s.epub.paragraphStyle, dropCaps: s.epub.dropCaps, font: s.epub.font, embedFont: embed });
  const lang = m.language;
  const files: Record<string, string> = {};
  const items: Item[] = [];
  const spine: string[] = [];
  const add = (id: string, href: string, content: string, inSpine = true, type = 'application/xhtml+xml', properties?: string) => {
    files[`OEBPS/${href}`] = content;
    items.push({ id, href, type, ...(properties ? { properties } : {}) });
    if (inSpine) spine.push(id);
  };
  const page = (title: string, body: string, bodyClass = '') => xhtml(title, body, '../stylesheet.css', lang, bodyClass);

  // --- optional cover ---
  if (cover) {
    const img = `images/cover.${cover.ext}`;
    items.push({ id: 'cover-image', href: img, type: cover.ext === 'png' ? 'image/png' : 'image/jpeg', properties: 'cover-image' });
    add('cover', textHref('cover'), page('Cover', `<p class="cover"><img class="cover" src="../${img}" alt="Cover"/></p>`), true, 'application/xhtml+xml');
  }

  // --- front matter ---
  const front = (p: MatterPage) => matterPageHtml(p, 'ebook');
  for (const p of book.front) {
    const title = p.id === 'title' ? 'Title Page' : p.id === 'copyright' ? 'Copyright' : p.id === 'dedication' ? 'Dedication' : 'Epigraph';
    add(p.id, textHref(p.id), page(title, front(p)));
    // the Contents page sits after the copyright page / dedication / epigraph (see below)
  }

  // --- nav (EPUB 3 table of contents), after the front matter ---
  const hrefOf = (id: string) => textHref(id);
  const tocLis = book.toc.map((t) => `<li><a href="${hrefOf(t.id)}">${esc(t.label)}</a></li>`).join('\n');
  const firstChapter = book.chapters[0];
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html ${XHTML_NS} lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head>
<meta charset="utf-8"/>
<title>Contents</title>
<link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>CONTENTS</h1>
<ol>
${tocLis}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<h2>Guide</h2>
<ol>
${cover ? `<li><a epub:type="cover" href="${textHref('cover')}">Cover</a></li>\n` : ''}<li><a epub:type="bodymatter" href="${hrefOf(firstChapter.id)}">Start of Content</a></li>
</ol>
</nav>
</body>
</html>
`;
  files['OEBPS/nav.xhtml'] = nav;
  items.push({ id: 'nav', href: 'nav.xhtml', type: 'application/xhtml+xml', properties: 'nav' });
  spine.push('nav');

  // --- chapters ---
  const sceneBreak = s.sceneBreak;
  const chapterPage = (c: BuiltChapter) =>
    page(c.heading.plain || c.title || 'Chapter', `<h1 class="chapter" id="${c.id}">${chapterHeadingHtml(c)}</h1>\n${blocksHtml(c.blocks, 'ebook', sceneBreak)}`);
  for (const c of book.chapters) add(c.id, textHref(c.id), chapterPage(c));

  // --- back matter ---
  for (const p of book.back) add(`back-${p.id}`, textHref(`back-${p.id}`), page(p.heading || 'Notes', matterPageHtml(p, 'ebook')));

  // --- stylesheet, NCX, OPF, container ---
  files['OEBPS/stylesheet.css'] = css;
  items.push({ id: 'css', href: 'stylesheet.css', type: 'text/css' });

  const ncxPoints = book.toc
    .map((t, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(t.label)}</text></navLabel><content src="${hrefOf(t.id)}"/></navPoint>`)
    .join('\n');
  files['OEBPS/toc.ncx'] = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(lang)}">
<head>
<meta name="dtb:uid" content="${esc(m.id)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${esc(m.title)}</text></docTitle>
<navMap>
${ncxPoints}
</navMap>
</ncx>
`;
  items.push({ id: 'ncx', href: 'toc.ncx', type: 'application/x-dtbncx+xml' });

  const meta: string[] = [
    `<dc:identifier id="bookid">${esc(m.id)}</dc:identifier>`,
    `<dc:title id="dc-title">${esc(m.title)}</dc:title>`
  ];
  if (m.subtitle.trim()) {
    meta.push(`<dc:title id="dc-subtitle">${esc(m.subtitle)}</dc:title>`);
    meta.push('<meta refines="#dc-title" property="title-type">main</meta>');
    meta.push('<meta refines="#dc-subtitle" property="title-type">subtitle</meta>');
    meta.push('<meta refines="#dc-subtitle" property="display-seq">2</meta>');
  }
  meta.push(`<dc:creator id="dc-creator">${esc(m.author)}</dc:creator>`);
  meta.push('<meta refines="#dc-creator" property="role" scheme="marc:relators">aut</meta>');
  meta.push(`<dc:language>${esc(m.language)}</dc:language>`);
  if (m.publisher.trim()) meta.push(`<dc:publisher>${esc(m.publisher)}</dc:publisher>`);
  if (m.isbn.trim()) meta.push(`<dc:identifier id="dc-isbn">urn:isbn:${esc(m.isbn.replace(/[^0-9Xx]/g, ''))}</dc:identifier>`);
  if (m.description.trim()) meta.push(`<dc:description>${esc(m.description)}</dc:description>`);
  meta.push(`<dc:rights>${esc(m.rights)}</dc:rights>`);
  meta.push(`<meta property="dcterms:modified">${esc(m.modified)}</meta>`);
  if (cover) meta.push('<meta name="cover" content="cover-image"/>');

  if (embed && bundled) {
    FONT_FILES.forEach((f, i) => items.push({ id: `font-${i + 1}`, href: `fonts/${embeddedFileName(bundled, f)}`, type: 'font/ttf' }));
  }
  const manifest = items
    .map((i) => `<item id="${i.id}" href="${i.href}" media-type="${i.type}"${i.properties ? ` properties="${i.properties}"` : ''}/>`)
    .join('\n');
  files['OEBPS/content.opf'] = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta.join('\n')}
</metadata>
<manifest>
${manifest}
</manifest>
<spine toc="ncx">
${spine.map((id) => `<itemref idref="${id}"/>`).join('\n')}
</spine>
</package>
`;
  files['META-INF/container.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`;

  // `mimetype` first, STORED, exactly 20 bytes, no trailing newline (skill rule; epubcheck PKG-006/007).
  const mtime = new Date('1980-01-01T00:00:00');
  const zip: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0, mtime }] };
  for (const [name, text] of Object.entries(files)) zip[name] = [strToU8(text), { level: 6, mtime }];
  if (cover) zip[`OEBPS/images/cover.${cover.ext}`] = [cover.bytes, { level: 0, mtime }];
  if (embed && bundled && fonts) for (const f of FONT_FILES) zip[`OEBPS/fonts/${embeddedFileName(bundled, f)}`] = [fonts[f.file], { level: 6, mtime }];
  return zipSync(zip);
}

/**
 * Structural self-check of the invariants the skill calls out. Returns a list of problems
 * (empty = fine). This is not a replacement for epubcheck, which CI runs on generated books.
 */
export function verifyEpub(bytes: Uint8Array): string[] {
  const problems: string[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // First local file header must be an uncompressed, extra-field-free `mimetype` entry.
  if (bytes.length < 60 || dv.getUint32(0, true) !== 0x04034b50) return ['not a zip file'];
  const method = dv.getUint16(8, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen));
  if (name !== 'mimetype') problems.push('the first zip entry must be "mimetype"');
  if (method !== 0) problems.push('"mimetype" must be stored, not compressed');
  if (extraLen !== 0) problems.push('"mimetype" must not have an extra field');
  const size = dv.getUint32(22, true);
  if (size !== 20) problems.push(`"mimetype" must be exactly 20 bytes (it is ${size})`);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    return [...problems, `the zip could not be read: ${e}`];
  }
  const text = (n: string) => (files[n] ? new TextDecoder().decode(files[n]) : undefined);
  if (text('mimetype') !== 'application/epub+zip') problems.push('"mimetype" content is wrong');

  const container = text('META-INF/container.xml');
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) return [...problems, 'META-INF/container.xml does not point to a package file'];
  const opf = text(opfPath);
  if (!opf) return [...problems, `the package file ${opfPath} is missing`];
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = [...opf.matchAll(/<item\s+([^>]*?)\/>/g)].map((m) => ({
    id: /\bid="([^"]+)"/.exec(m[1])?.[1] ?? '',
    href: /\bhref="([^"]+)"/.exec(m[1])?.[1] ?? '',
    props: /\bproperties="([^"]+)"/.exec(m[1])?.[1] ?? ''
  }));
  const ids = new Set<string>();
  for (const it of manifest) {
    if (ids.has(it.id)) problems.push(`duplicate manifest id "${it.id}"`);
    ids.add(it.id);
    if (!files[base + it.href]) problems.push(`manifest item "${it.href}" is missing from the zip`);
  }
  for (const m of opf.matchAll(/<itemref\s+idref="([^"]+)"/g)) {
    if (!ids.has(m[1])) problems.push(`spine item "${m[1]}" is not in the manifest`);
  }
  const navItem = manifest.find((i) => i.props.split(/\s+/).includes('nav'));
  if (!navItem) problems.push('no navigation document (nav) in the manifest');
  else {
    if (navItem.href !== 'nav.xhtml') problems.push('nav.xhtml must live at the package root');
    const nav = text(base + navItem.href) ?? '';
    if (!/<nav[^>]*epub:type="toc"/.test(nav)) problems.push('the navigation document has no <nav epub:type="toc">');
    const targets = [...nav.matchAll(/<nav[^>]*epub:type="toc"[\s\S]*?<\/nav>/g)][0]?.[0].match(/href="([^"#]+)/g) ?? [];
    for (const t of targets) {
      const href = t.slice(6);
      if (!files[base + href]) problems.push(`the contents list links to a missing file: ${href}`);
      if (/title\.xhtml|copyright\.xhtml/.test(href)) problems.push(`the contents list must not include ${href}`);
    }
  }
  if (!manifest.some((i) => i.href === 'toc.ncx')) problems.push('no toc.ncx (needed by older Kindle firmware)');
  if (!/<meta property="dcterms:modified"/.test(opf)) problems.push('missing dcterms:modified');

  for (const it of manifest) {
    if (!it.href.endsWith('.xhtml')) continue;
    const doc = text(base + it.href) ?? '';
    const expected = it.href.startsWith('text/') ? '../stylesheet.css' : 'stylesheet.css';
    if (!doc.includes(`href="${expected}"`)) problems.push(`${it.href} must link the stylesheet as ${expected}`);
  }
  return problems;
}
