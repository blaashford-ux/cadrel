import { DOMParser } from '@xmldom/xmldom';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { assembleBook, type BookBuild } from './assemble';
import { buildDocx, NBSP } from './docx';
import { defaultBookDetails, type BookDetails } from './model';

const SRC = `# Chapter 1: Coming Back

First paragraph with *italic* and **bold**.

Second paragraph with a [link](https://example.com/a?x=1&y=2) in it.

Third paragraph.

* * *

After the scene break.

## A sub-heading

Right after a sub-heading.

> A quoted paragraph.

- bullet one
- bullet two

# Chapter 2: Leaving

Only paragraph here.

Another one.
`;

const env = { now: new Date('2031-05-06T07:08:09Z'), uuid: () => 'abc' };
const details = (edit: (d: BookDetails) => void = () => undefined): BookDetails => {
  const d = defaultBookDetails({ title: 'The Lost King', author: 'A. Writer', year: 2031 });
  d.subtitle = 'A Tale';
  d.copyright.matureNotice = true;
  d.dedication = { enabled: true, text: 'For everyone.' };
  d.back.links = { enabled: true, heading: '', intro: 'More at:', items: [{ label: 'Newsletter', url: 'https://example.com/news' }, { label: 'Bad', url: 'javascript:alert(1)' }] };
  d.back.about = { enabled: true, heading: '', text: 'Bio.' };
  edit(d);
  return d;
};
const book = (edit?: (d: BookDetails) => void): BookBuild => assembleBook(SRC, details(edit), env).build!;
const parts = async (edit?: (d: BookDetails) => void) => {
  const bytes = await buildDocx(book(edit));
  const files = unzipSync(bytes);
  return { bytes, files, doc: strFromU8(files['word/document.xml']), styles: strFromU8(files['word/styles.xml']) };
};
const paragraphs = (doc: string) => doc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOfPara = (p: string) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
const isBlank = (p: string) => textOfPara(p) === NBSP;

describe('buildDocx — the non-breaking-space rule (the skill’s “single most important rule”)', () => {
  it('uses NBSP (U+00A0) paragraphs between body paragraphs and never empty text runs', async () => {
    const { bytes, files, doc } = await parts();
    // byte-level, not just visual: the raw UTF-8 bytes of a NBSP are C2 A0
    const raw = Buffer.from(files['word/document.xml']);
    expect(raw.includes(Buffer.from([0xc2, 0xa0]))).toBe(true);
    expect(doc).not.toMatch(/<w:t(?: [^>]*)?><\/w:t>/);
    expect(doc).not.toMatch(/<w:t(?: [^>]*)?\/>/);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(NBSP.charCodeAt(0)).toBe(160);
  });

  it('puts exactly one blank paragraph between consecutive body paragraphs, never after a heading, never doubled', async () => {
    const { doc } = await parts();
    const ps = paragraphs(doc);
    const kinds = ps.map((p) => (isBlank(p) ? 'B' : p.includes('w:val="Heading1"') ? 'H' : 'x'));
    for (let i = 0; i < kinds.length - 1; i++) {
      expect(kinds[i] + kinds[i + 1], `at paragraph ${i}`).not.toBe('BB');
      expect(kinds[i] + kinds[i + 1], `blank right after a heading at ${i}`).not.toBe('HB');
    }
    // chapter 1 has: para, para, para, scene, para, [sub], para, quote, bullets → blanks between the first four items
    const ch1 = ps.findIndex((p) => textOfPara(p).startsWith('First paragraph'));
    expect(isBlank(ps[ch1 + 1])).toBe(true);
    expect(textOfPara(ps[ch1 + 2])).toContain('Second paragraph');
    expect(isBlank(ps[ch1 + 3])).toBe(true);
  });

  it('the blank paragraphs carry no spacing of their own (the gap is the paragraph, not a style)', async () => {
    const { doc } = await parts();
    const blank = paragraphs(doc).find(isBlank)!;
    expect(blank).toMatch(/w:before="0"/);
    expect(blank).toMatch(/w:after="0"/);
  });

  it('blockNoGap and indent styles insert no blank paragraphs; indent adds a first-line indent except after headings/scene breaks', async () => {
    const noGap = await parts((d) => (d.export.docx.paragraphStyle = 'blockNoGap'));
    expect(paragraphs(noGap.doc).some(isBlank)).toBe(false);
    const ind = await parts((d) => (d.export.docx.paragraphStyle = 'indent'));
    expect(paragraphs(ind.doc).some(isBlank)).toBe(false);
    const ps = paragraphs(ind.doc);
    const second = ps.find((p) => textOfPara(p).startsWith('Second paragraph'))!;
    const first = ps.find((p) => textOfPara(p).startsWith('First paragraph'))!;
    expect(second).toMatch(/w:firstLine="432"/);
    expect(first).toMatch(/w:firstLine="0"/);
  });
});

describe('buildDocx — page setup and structure (skill rules)', () => {
  it('sets the explicit trim size (5.5 × 8.5 in = 7920 × 12240 twips) on both sections, not A4', async () => {
    const { doc } = await parts();
    const sizes = [...doc.matchAll(/<w:pgSz [^>]*>/g)].map((m) => m[0]);
    expect(sizes).toHaveLength(2);
    for (const s of sizes) {
      expect(s).toMatch(/w:w="7920"/);
      expect(s).toMatch(/w:h="12240"/);
    }
    const six = await parts((d) => (d.export.docx.trim = '6x9'));
    expect(six.doc).toMatch(/w:w="8640"[^>]*w:h="12960"/);
  });

  it('has two sections: unnumbered front matter, then a body numbered from 1 with a PAGE-field footer', async () => {
    const { doc, files } = await parts();
    expect((doc.match(/<w:sectPr[ >]/g) ?? []).length).toBe(2);
    expect(doc).toMatch(/<w:pgNumType w:start="1"/);
    const footers = Object.keys(files).filter((f) => /word\/footer\d*\.xml/.test(f));
    expect(footers).toHaveLength(1);
    expect(strFromU8(files[footers[0]])).toMatch(/PAGE/);
    expect((doc.match(/<w:footerReference/g) ?? []).length).toBe(1); // only the body section has page numbers
  });

  it('chapter 1 gets no page break before it (the section boundary starts it); later chapters do', async () => {
    const { doc } = await parts();
    const heads = paragraphs(doc).filter((p) => p.includes('w:val="Heading1"') && /Chapter/.test(textOfPara(p)));
    expect(heads).toHaveLength(2);
    expect(heads[0]).not.toContain('pageBreakBefore');
    expect(heads[1]).toContain('pageBreakBefore');
  });

  it('Heading 1 is forced black (no theme blue), Garamond, centred', async () => {
    const { styles, doc } = await parts();
    const h1 = /<w:style [^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/.exec(styles)![0];
    expect(h1).toMatch(/<w:color w:val="000000"/);
    expect(h1).toMatch(/Garamond/);
    const head = paragraphs(doc).find((p) => p.includes('w:val="Heading1"') && /Chapter 1/.test(textOfPara(p)))!;
    expect(head).toMatch(/<w:jc w:val="center"/);
    expect(head).not.toMatch(/themeColor/);
  });

  it('title, subtitle and author are centred explicitly on every paragraph', async () => {
    const { doc } = await parts();
    for (const t of ['The Lost King', 'A Tale', 'A. Writer']) {
      const p = paragraphs(doc).find((x) => textOfPara(x) === t)!;
      expect(p, t).toBeTruthy();
      expect(p).toMatch(/<w:jc w:val="center"/);
    }
  });

  it('body text is Garamond 11pt (22 half-points), justified', async () => {
    const { styles, doc } = await parts();
    expect(styles).toMatch(/w:rFonts[^>]*Garamond/);
    expect(styles).toMatch(/<w:sz w:val="22"/);
    const p = paragraphs(doc).find((x) => textOfPara(x).startsWith('Third paragraph'))!;
    expect(p).toMatch(/<w:jc w:val="both"/);
    expect((await parts((d) => (d.export.docx.fontSize = 12))).styles).toMatch(/<w:sz w:val="24"/);
  });

  it('the contents list is static: linked entries for real content only, anchored to bookmarks, no page numbers', async () => {
    const { doc } = await parts();
    const anchors = [...doc.matchAll(/<w:hyperlink [^>]*w:anchor="([^"]+)"/g)].map((m) => m[1]);
    expect(anchors).toEqual(['chapter1', 'chapter2', 'back-links', 'back-about']);
    const bookmarks = [...doc.matchAll(/<w:bookmarkStart [^>]*w:name="([^"]+)"/g)].map((m) => m[1]);
    for (const a of anchors) expect(bookmarks).toContain(a);
    expect(doc).not.toMatch(/TOC \\o|w:fldSimple[^>]*TOC/); // no dynamic TOC field (renders blank in Google Docs/LibreOffice)
    const contents = paragraphs(doc).map(textOfPara).filter((t) => /^(Chapter \d|CONTINUE|ABOUT)/.test(t));
    expect(contents.join('|')).not.toMatch(/\d+$/m.source === '' ? '' : /(Chapter .*)\.{2,}|\t\d+/);
  });

  it('copyright page keeps the skill’s order; mature notice is bold', async () => {
    const { doc } = await parts();
    const texts = paragraphs(doc).map(textOfPara);
    const order = ['The Lost King', 'Copyright © 2031 by A. Writer', 'All rights reserved.', 'This is a work of fiction', 'No part of this book', 'This book contains mature themes', 'First Edition'].map((t) => texts.findIndex((x, i) => i > 2 && x.startsWith(t)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const mature = paragraphs(doc).find((p) => textOfPara(p).startsWith('This book contains mature'))!;
    expect(mature).toMatch(/<w:b\/>/);
  });

  it('scene breaks are centred glyph paragraphs; inline bold/italic survive', async () => {
    const { doc } = await parts((d) => (d.export.sceneBreak = '***'));
    const scene = paragraphs(doc).find((p) => textOfPara(p) === '***')!;
    expect(scene).toMatch(/<w:jc w:val="center"/);
    const first = paragraphs(doc).find((p) => textOfPara(p).startsWith('First paragraph'))!;
    expect(first).toMatch(/<w:i\/>/);
    expect(first).toMatch(/<w:b\/>/);
  });

  it('hyperlinks: real external links for web URLs, none for unsafe ones; relationship targets are the typed URLs', async () => {
    const { files, doc } = await parts();
    const rels = strFromU8(files['word/_rels/document.xml.rels']);
    expect(rels).toContain('https://example.com/a?x=1&amp;y=2');
    expect(rels).toContain('https://example.com/news');
    expect(rels + doc).not.toMatch(/javascript/);
    expect(doc).not.toContain('Bad');
  });

  it('every XML part is well-formed', async () => {
    const { files } = await parts();
    for (const [name, data] of Object.entries(files)) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const errors: string[] = [];
      new DOMParser({ onError: (_l, m) => errors.push(m) }).parseFromString(strFromU8(data), 'text/xml');
      expect({ name, errors }).toEqual({ name, errors: [] });
    }
  });

  it('metadata: title and creator', async () => {
    const { files } = await parts();
    const core = strFromU8(files['docProps/core.xml']);
    expect(core).toContain('The Lost King');
    expect(core).toContain('A. Writer');
  });
});

// Needs LibreOffice *Writer* (a bare `soffice` install, without libreoffice-writer, can't open documents).
const soffice = spawnSync('soffice', ['--version'], { encoding: 'utf8' });
const hasWriter = soffice.status === 0 && existsSync('/usr/lib/libreoffice/program/libswlo.so');
describe.skipIf(!hasWriter)('buildDocx — opens in LibreOffice', () => {
  it('converts to a PDF with the right page size and the chapters in order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docx-'));
    try {
      writeFileSync(path.join(dir, 'b.docx'), await buildDocx(book()));
      const r = spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'b.docx')], { encoding: 'utf8', timeout: 120_000 });
      // soffice exits 0 even when it can't load the file, so the PDF's existence is the real test
      expect(existsSync(path.join(dir, 'b.pdf')), `LibreOffice could not open the DOCX: ${r.stderr}`).toBe(true);
      const pdf = path.join(dir, 'b.pdf');
      const info = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' });
      if (!info.error) {
        expect(info.status).toBe(0);
        expect(info.stdout).toMatch(/Page size:\s+39[67](\.\d+)? x 612/); // LibreOffice rounds 5.5 in to 14 cm
        const text = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout;
        expect(text.indexOf('CONTENTS')).toBeGreaterThan(-1);
        expect(text.indexOf('Chapter 1: Coming Back')).toBeLessThan(text.indexOf('Chapter 2: Leaving'));
        expect(readFileSync(pdf).length).toBeGreaterThan(1000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
