import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ocr, assemblePages, cleanOcr, extractBuffer, extractFile, kindOf, looksLikeEndOfSample, normalizeText, unwrap } from '../src/index.js';

const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

const epub = () =>
  zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Quiet Dragon</dc:title></metadata>
      <manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c1b" href="ch1b.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch%202.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c1b"/><itemref idref="c2"/></spine></package>`,
    'OEBPS/nav.xhtml': '<html><body><nav><ol><li>Chapter One</li></ol></nav></body></html>',
    'OEBPS/ch1.xhtml': '<html><head><title>x</title><style>p{}</style></head><body><h1>Chapter One</h1><p>"Not again," said the dragon.</p><p>It was Tuesday.</p></body></html>',
    'OEBPS/ch1b.xhtml': '<html><body><div><p>The baker sighed.<br/>Then she baked.</p></div></body></html>',
    'OEBPS/ch 2.xhtml': '<html><body><h1>Chapter Two</h1><p>Nothing happened.</p><script>alert(1)</script></body></html>',
  });

const docx = () =>
  zip({
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">The dragon </w:t></w:r><w:r><w:t>sighed.</w:t></w:r></w:p>
      <w:p/>
      <w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter Two</w:t></w:r></w:p>
      <w:p><w:r><w:t>Later.</w:t></w:r></w:p></w:body></w:document>`,
  });

function pdf(pages: string[][], opts: { imageOnly?: boolean } = {}): Promise<Buffer> {
  return new Promise(async (resolve) => {
    const doc = new PDFDocument({ size: 'A5', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (let i = 0; i < pages.length; i++) {
      if (i) doc.addPage();
      if (opts.imageOnly) doc.image(await sharp({ create: { width: 200, height: 200, channels: 3, background: '#eee' } }).png().toBuffer(), 40, 40);
      else for (const para of pages[i]!) doc.fontSize(11).text(para, { align: 'left' }).moveDown(1.2);
    }
    doc.end();
  });
}

describe('plain text and markdown', () => {
  it('normalises and finds chapters', async () => {
    const r = await extractBuffer(Buffer.from('﻿Chapter 1\r\n\r\nHello.\r\n\r\n\r\n\r\nChapter 2\r\n\r\nBye.'), 'txt');
    expect(r.text).toBe('Chapter 1\n\nHello.\n\nChapter 2\n\nBye.');
    expect(r.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });
  it('strips markdown syntax and uses headings as chapters', async () => {
    const r = await extractBuffer(Buffer.from('# One\n\nSome *bold* and **strong** [link](http://x) text.\n\n## Two\n\n> quoted'), 'md');
    expect(r.text).toBe('One\n\nSome bold and strong link text.\n\nTwo\n\nquoted');
    expect(r.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(r.text.slice(r.chapters[1]!.start, r.chapters[1]!.start + 3)).toBe('Two');
  });
});

describe('EPUB', () => {
  it('reads spine order, decoded paths, titles, headings, and merges heading-less files', async () => {
    const r = await extractBuffer(epub(), 'epub');
    expect(r.title).toBe('The Quiet Dragon');
    expect(r.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(r.text).toContain('"Not again," said the dragon.');
    expect(r.text).toContain('The baker sighed.\nThen she baked.');
    expect(r.text).not.toContain('alert');
    expect(r.text).not.toContain('Chapter One\n\nChapter One'); // the nav page is skipped
    const c2 = r.chapters[1]!;
    expect(r.text.slice(c2.start, c2.end)).toBe('Chapter Two\n\nNothing happened.');
  });
  it('rejects things that are not EPUBs', async () => {
    await expect(extractBuffer(zip({ 'a.txt': 'x' }), 'epub')).rejects.toThrow(/not an EPUB/);
    await expect(extractBuffer(Buffer.from('plain'), 'epub')).rejects.toThrow();
  });
});

describe('DOCX', () => {
  it('keeps paragraphs and heading chapters', async () => {
    const r = await extractBuffer(docx(), 'docx');
    expect(r.text).toBe('Chapter One\n\nThe dragon sighed.\n\nSecond paragraph.\n\nChapter Two\n\nLater.');
    expect(r.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
  });
  it('rejects other zips', async () => {
    await expect(extractBuffer(zip({ 'x.txt': 'x' }), 'docx')).rejects.toThrow(/not a Word document/);
  });
});

describe('PDF', () => {
  it('extracts text page by page with paragraphs', async () => {
    const buf = await pdf([['Chapter 1', 'The dragon looked at the baker and sighed. "Not again," she said.', 'Second paragraph of the first page.'], ['The second page continues here.']]);
    const r = await extractBuffer(buf, 'pdf');
    expect(r.pages).toBe(2);
    expect(r.text).toContain('The dragon looked at the baker and sighed.');
    expect(r.text).toContain('The second page continues here.');
    expect(r.text.split('\n\n').length).toBeGreaterThanOrEqual(3);
    expect(r.warnings).toEqual([]);
    expect(r.chapters.map((c) => c.title)).toEqual(['Chapter 1']);
  });
  it('warns about a PDF with no text layer', async () => {
    const r = await extractBuffer(await pdf([[], []], { imageOnly: true }), 'pdf');
    expect(r.text).toBe('');
    expect(r.warnings.join(' ')).toMatch(/no text layer|scanned/);
  });
  it('rejects non-PDFs', async () => {
    await expect(extractBuffer(Buffer.from('not a pdf'), 'pdf')).rejects.toThrow();
  });
});

describe('files', () => {
  it('picks the kind by extension and refuses the rest', async () => {
    expect(kindOf('a.EPUB')).toBe('epub');
    expect(kindOf('a.markdown')).toBe('md');
    expect(kindOf('a.exe')).toBeNull();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-txt-'));
    fs.writeFileSync(path.join(d, 'b.txt'), 'Hello world.');
    expect((await extractFile(path.join(d, 'b.txt'))).text).toBe('Hello world.');
    await expect(extractFile(path.join(d, 'c.exe'))).rejects.toThrow(/unsupported/);
    fs.rmSync(d, { recursive: true });
  });
});

describe('text helpers', () => {
  it('normalises', () => {
    expect(normalizeText('a b­c  \n\n\n\nd')).toBe('a bc\n\nd');
  });
  it('unwraps hard-wrapped paragraphs and re-joins hyphenated words', () => {
    expect(unwrap('The quick brown\nfox jumped over the la-\nzy dog.\n\nNext para.')).toBe('The quick brown fox jumped over the lazy dog.\n\nNext para.');
  });
});

describe('OCR helpers', () => {
  it('drops reader chrome and unwraps', () => {
    expect(cleanOcr('Page 3 of 55\nThe dragon sighed and\nlooked away.\n\n12%\nLocation 140')).toBe('The dragon sighed and looked away.');
  });
  it('joins a sentence that runs across a page turn, but not a new paragraph', () => {
    expect(assemblePages(['She opened the door and', 'saw the dragon.'])).toBe('She opened the door and saw the dragon.');
    expect(assemblePages(['She left.', 'The next day came.'])).toBe('She left.\n\nThe next day came.');
    expect(assemblePages(['', '  '])).toBe('');
  });
  it('recognises the end-of-sample screen', () => {
    expect(looksLikeEndOfSample("You've reached the end of your free sample.")).toBe(true);
    expect(looksLikeEndOfSample('The dragon sighed.')).toBe(false);
  });
});

describe('OCR on rendered pages', () => {
  let ocr: Ocr;
  beforeAll(async () => { ocr = await Ocr.create(); }, 60000);
  afterAll(async () => { await ocr?.close(); });

  const page = (lines: string[], opts: { w?: number; chrome?: boolean } = {}) => {
    const w = opts.w ?? 900;
    const body = lines.map((l, i) => `<text x="60" y="${140 + i * 44}" font-family="DejaVu Serif, serif" font-size="28" fill="#111">${l.replace(/&/g, '&amp;')}</text>`).join('');
    const chrome = opts.chrome ? '<rect width="900" height="60" fill="#232f3e"/><text x="20" y="40" font-family="DejaVu Sans" font-size="24" fill="white">Menu Settings Fonts</text>' : '';
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="520"><rect width="100%" height="100%" fill="#fbf7ee"/>${chrome}${body}</svg>`)).png().toBuffer();
  };

  it('reads a rendered page of prose', async () => {
    const r = await ocr.recognize(await page(['The dragon looked at the baker and sighed.', '"Not again," she said. "It is Tuesday."']));
    expect(r.confidence).toBeGreaterThan(70);
    expect(r.text.replace(/\s+/g, ' ')).toContain('The dragon looked at the baker and sighed.');
    expect(r.text).toContain('It is Tuesday');
  }, 60000);

  it('crops to the reader area so page chrome is left out', async () => {
    const img = await page(['Only this sentence matters here.'], { chrome: true });
    const withAll = await ocr.recognize(img);
    expect(withAll.text).toContain("Menu");
    const cropped = await ocr.recognize(img, { left: 0, top: 80, width: 900, height: 440 });
    expect(cropped.text).toContain('Only this sentence matters here');
    expect(cropped.text).not.toContain("Menu");
  }, 60000);

  it('reads light text on a dark page (reader dark theme)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="100%" height="100%" fill="#1b1b1b"/><text x="60" y="140" font-family="DejaVu Serif, serif" font-size="28" fill="#e8e8e8">The dragon looked at the baker.</text></svg>';
    const r = await ocr.recognize(await sharp(Buffer.from(svg)).png().toBuffer());
    expect(r.text).toContain('The dragon looked at the baker');
  }, 60000);

  it('copes with a small screenshot by enlarging it', async () => {
    const small = await sharp(await page(['The baker sighed and baked the bread.'])).resize({ width: 450 }).png().toBuffer();
    const r = await ocr.recognize(small);
    expect(r.text.toLowerCase()).toContain('baker');
  }, 60000);
});
