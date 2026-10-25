import { describe, expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, TextRun, ExternalHyperlink, Table, TableRow, TableCell } from 'docx';
import { docxToMarkdown } from './importDocx';

const toMd = async (children: any[]) => docxToMarkdown(new Uint8Array(await Packer.toBuffer(new Document({ sections: [{ children }] }))));

describe('docxToMarkdown', () => {
  it('keeps headings and inline formatting', async () => {
    const md = await toMd([
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Chapter One')] }),
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Dusk', italics: true })] }),
      new Paragraph({
        children: [new TextRun('Plain '), new TextRun({ text: 'bold ', bold: true }), new TextRun({ text: 'and italic', bold: true, italics: true }), new TextRun(' * star'), new TextRun({ text: ' gone', strike: true })]
      }),
      new Paragraph({ children: [] }),
      new Paragraph({ children: [new ExternalHyperlink({ link: 'https://example.com', children: [new TextRun('site')] })] })
    ]);
    expect(md).toBe('# Chapter One\n\n## *Dusk*\n\nPlain **bold** ***and italic*** \\* star ~~gone~~\n\n[site](https://example.com)\n');
  });

  it('writes lists and tables', async () => {
    const md = await toMd([
      new Paragraph({ text: 'one', bullet: { level: 0 } }),
      new Paragraph({ text: 'two', bullet: { level: 1 } }),
      new Paragraph({ text: 'after' }),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('A')] }), new TableCell({ children: [new Paragraph('B')] })] })] })
    ]);
    expect(md).toBe('- one\n  - two\n\nafter\n\n| A | B |\n| --- | --- |\n');
  });

  it('rejects things that are not a docx', () => {
    expect(() => docxToMarkdown(new Uint8Array([1, 2, 3]))).toThrow(/not a valid/);
  });
});
