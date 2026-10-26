import { describe, expect, it } from 'vitest';
import { defaultBookDetails, sanitizeBookDetails } from './model';

describe('sanitizeBookDetails', () => {
  it('returns defaults for junk input and never throws', () => {
    for (const junk of [null, undefined, 3, 'x', [], { copyright: 5, export: 'no', back: [] }]) {
      const d = sanitizeBookDetails(junk, { title: 'T', author: 'A' });
      expect(d.title).toBe(junk && typeof junk === 'object' && !Array.isArray(junk) ? 'T' : 'T');
      expect(d.export.pdf.trim).toBe('5.5x8.5');
      expect(d.copyright.fictionDisclaimer).toBe(true);
    }
  });

  it('round-trips a full valid object', () => {
    const d = defaultBookDetails({ title: 'Book', author: 'Me', year: 2030 });
    d.subtitle = 'Sub';
    d.back.links = { enabled: true, heading: 'MORE', intro: 'hi', items: [{ label: 'Site', url: 'https://x.com' }] };
    d.export.pdf.gutter = 0.6;
    d.export.excludedChapters = ['Scratch'];
    expect(sanitizeBookDetails(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('keeps the title and author verbatim (no trimming, casing or splitting)', () => {
    const d = sanitizeBookDetails({ title: '  the lost KING: a tale  ', author: 'a. nonymous' });
    expect(d.title).toBe('  the lost KING: a tale  ');
    expect(d.subtitle).toBe('');
  });

  it('clamps numbers, rejects unknown enum values, and drops wrong types field by field', () => {
    const d = sanitizeBookDetails({
      marked: 'yes',
      copyright: { year: 2025, matureNotice: true, extraLines: ['ok', 5, 'also'] },
      export: {
        chapterHeading: 'weird',
        sceneBreak: '',
        epub: { fontSize: 99, paragraphStyle: 'nope', dropCaps: 'x' },
        pdf: { outerMargin: -5, gutter: 'huge', runningHead: 'title', fontSize: 2 }
      }
    });
    expect(d.marked).toBe(true); // wrong type → default
    expect(d.copyright.year).toBe(String(new Date().getFullYear()));
    expect(d.copyright.matureNotice).toBe(true);
    expect(d.copyright.extraLines).toEqual(['ok', 'also']);
    expect(d.export.chapterHeading).toBe('verbatim');
    expect(d.export.sceneBreak).toBe('•  •  •');
    expect(d.export.epub.fontSize).toBe(20);
    expect(d.export.epub.paragraphStyle).toBe('blockGap');
    expect(d.export.epub.dropCaps).toBe(true);
    expect(d.export.pdf.outerMargin).toBe(0.25);
    expect(d.export.pdf.gutter).toBe('auto');
    expect(d.export.pdf.runningHead).toBe('title');
    expect(d.export.pdf.fontSize).toBe(8);
  });

  it('strips control characters and caps list sizes', () => {
    const d = sanitizeBookDetails({
      title: 'A\u0000B\u0007C',
      back: { links: { items: Array.from({ length: 500 }, (_, i) => ({ label: `l${i}`, url: '' })) } }
    });
    expect(d.title).toBe('ABC');
    expect(d.back.links.items).toHaveLength(200);
  });

  it('accepts a numeric gutter', () => {
    expect(sanitizeBookDetails({ export: { pdf: { gutter: 0.625 } } }).export.pdf.gutter).toBe(0.625);
  });
});

describe('font settings', () => {
  it('default to EB Garamond for the ebook and the print PDF', () => {
    const d = defaultBookDetails({ title: 'x', author: 'y' });
    expect(d.export.epub.font).toBe('EB Garamond');
    expect(d.export.pdf.font).toBe('EB Garamond');
  });
  it('are kept when valid, cleaned when hostile, defaulted when missing', () => {
    const d = sanitizeBookDetails({ export: { epub: { font: 'Crimson Pro' }, pdf: { font: 'Evil"</style>' } } });
    expect(d.export.epub.font).toBe('Crimson Pro');
    expect(d.export.pdf.font).toBe('Evil/style');
    expect(sanitizeBookDetails({ export: { pdf: { font: 7 } } }).export.pdf.font).toBe('EB Garamond');
    expect(sanitizeBookDetails({}).export.epub.font).toBe('EB Garamond');
  });
});

describe('content warning', () => {
  it('defaults to “Add Content Warnings here”, off', () => {
    const d = defaultBookDetails({ title: 'x', author: 'y' });
    expect(d.copyright.contentWarningText).toBe('Add Content Warnings here');
    expect(d.copyright.contentWarning).toBe(false);
  });
  it('a saved book still holding the old AI wording is moved to the new default; edited wording is kept', () => {
    const old = 'This book was created using a Human-in-the-Loop Generative AI system.';
    expect(sanitizeBookDetails({ copyright: { contentWarning: true, contentWarningText: old } }).copyright).toMatchObject({ contentWarning: true, contentWarningText: 'Add Content Warnings here' });
    expect(sanitizeBookDetails({ copyright: { contentWarningText: 'Contains violence.' } }).copyright.contentWarningText).toBe('Contains violence.');
  });
  it('reads books saved under the old key names (aiDisclosure / aiText) and never writes them back', () => {
    const d = sanitizeBookDetails({ copyright: { aiDisclosure: true, aiText: 'Edited wording' } });
    expect(d.copyright).toMatchObject({ contentWarning: true, contentWarningText: 'Edited wording' });
    expect(JSON.stringify(d)).not.toMatch(/aiDisclosure|aiText/);
  });
  it('new keys win over old ones', () => {
    const d = sanitizeBookDetails({ copyright: { contentWarning: false, aiDisclosure: true, contentWarningText: 'New', aiText: 'Old' } });
    expect(d.copyright).toMatchObject({ contentWarning: false, contentWarningText: 'New' });
  });
});
