import {
  AlignmentType,
  Bookmark,
  convertInchesToTwip,
  Document,
  ExternalHyperlink,
  Footer,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
  type ISectionOptions
} from 'docx';
import type { BookBuild, BuiltChapter } from './assemble';
import type { Block, Inline } from './manuscript';
import type { MatterPage, PageBlock } from './matter';
import { safeUrl } from './matter';
import { trimByKey } from './trim';

/** The non-breaking space the skill requires for the blank paragraph between body paragraphs. */
export const NBSP = String.fromCharCode(160);

const FONT = 'Garamond';

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
}

/**
 * Builds the ebook-import DOCX (Reedsy / Kindle Create). Rules from the format-for-kdp skill:
 * Garamond, justified, no first-line indent by default, a *non-breaking-space* paragraph between
 * body paragraphs (a truly empty one gets stripped by importers), explicit page size, two sections
 * (unnumbered front matter, numbered body), explicit centring, black Heading 1.
 * The contents list is static and linked but has no page numbers: pages can't be measured without Word.
 */
export async function buildDocx(book: BookBuild): Promise<Uint8Array> {
  const s = book.settings.docx;
  const trim = trimByKey(s.trim);
  const size = Math.round(s.fontSize * 2); // half-points
  const gap = s.paragraphStyle === 'blockGap';
  const indent = s.paragraphStyle === 'indent';
  const sceneBreak = book.settings.sceneBreak;
  const margin = convertInchesToTwip(0.75);

  const run = (text: string, st: RunStyle = {}, extra: Record<string, unknown> = {}) =>
    new TextRun({ text, font: st.code ? 'Courier New' : FONT, size, bold: st.bold, italics: st.italics, ...extra });

  const runsFor = (inlines: Inline[], st: RunStyle = {}): (TextRun | ExternalHyperlink)[] =>
    inlines.flatMap((i): (TextRun | ExternalHyperlink)[] => {
      switch (i.t) {
        case 'text':
          return [run(i.text, st)];
        case 'em':
          return runsFor(i.children, { ...st, italics: true });
        case 'strong':
          return runsFor(i.children, { ...st, bold: true });
        case 'code':
          return [run(i.text, { ...st, code: true })];
        case 'br':
          return [new TextRun({ break: 1 })];
        case 'link': {
          const url = safeUrl(i.url);
          return url
            ? [new ExternalHyperlink({ link: url, children: [new TextRun({ text: textOf(i.children), font: FONT, size, color: '0563C1', underline: {} })] })]
            : runsFor(i.children, st);
        }
      }
    });
  const textOf = (inl: Inline[]): string => inl.map((x) => (x.t === 'text' || x.t === 'code' ? x.text : x.t === 'br' ? ' ' : textOf(x.children))).join('');

  const body = (children: (TextRun | ExternalHyperlink)[], opts: { first?: boolean; quote?: boolean } = {}) =>
    new Paragraph({
      children,
      alignment: AlignmentType.JUSTIFIED,
      spacing: { before: 0, after: 0 },
      indent: {
        firstLine: indent && !opts.first && !opts.quote ? Math.round(0.3 * 1440) : 0,
        ...(opts.quote ? { left: convertInchesToTwip(0.4), right: convertInchesToTwip(0.4) } : {})
      }
    });
  const blank = () => new Paragraph({ children: [new TextRun({ text: NBSP, font: FONT, size })], spacing: { before: 0, after: 0 } });
  const centered = (children: TextRun[], after = 0) => new Paragraph({ children, alignment: AlignmentType.CENTER, spacing: { before: 0, after } });

  /** Body blocks → paragraphs, with the blank (nbsp) paragraph between consecutive items when the style asks for it. */
  const blocksToParagraphs = (blocks: Block[], quote = false): Paragraph[] => {
    const items: { p: Paragraph[]; kind: Block['t'] }[] = [];
    let prev: Block['t'] | null = null;
    for (const b of blocks) {
      const first = prev === null || prev === 'scene' || prev === 'sub';
      switch (b.t) {
        case 'para':
          items.push({ kind: 'para', p: [body(runsFor(b.inlines), { first, quote })] });
          break;
        case 'scene':
          items.push({ kind: 'scene', p: [centered([run(sceneBreak)])] });
          break;
        case 'sub':
          items.push({
            kind: 'sub',
            p: [new Paragraph({ children: runsFor(b.inlines, { bold: true }), alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 } })]
          });
          break;
        case 'quote':
          items.push({ kind: 'quote', p: blocksToParagraphs(b.blocks, true) });
          break;
        case 'list':
          items.push({
            kind: 'list',
            p: b.items.flatMap((it, idx) =>
              it.flatMap((blk) =>
                blk.t === 'para'
                  ? [
                      new Paragraph({
                        children: runsFor(blk.inlines),
                        alignment: AlignmentType.LEFT,
                        spacing: { before: 0, after: 0 },
                        ...(b.ordered ? { numbering: { reference: 'ordered', level: 0, instance: idx } } : { bullet: { level: 0 } })
                      })
                    ]
                  : []
              )
            )
          });
          break;
        case 'code':
          items.push({ kind: 'code', p: b.text.split('\n').map((l) => new Paragraph({ children: [run(l, { code: true })], spacing: { before: 0, after: 0 } })) });
          break;
      }
      prev = b.t;
    }
    const out: Paragraph[] = [];
    items.forEach((it, i) => {
      if (gap && i > 0 && items[i - 1].kind !== 'sub') out.push(blank()); // never right after a heading, never doubled
      out.push(...it.p);
    });
    return out;
  };

  // ---- front matter -----------------------------------------------------------------------
  const pageBlock = (b: PageBlock, pageBreakBefore = false): Paragraph => {
    const pb = pageBreakBefore ? { pageBreakBefore: true } : {};
    switch (b.t) {
      case 'title':
        return new Paragraph({ children: [new TextRun({ text: b.text, font: FONT, size: Math.round(size * 2.4), bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 }, ...pb });
      case 'subtitle':
        return new Paragraph({ children: [new TextRun({ text: b.text, font: FONT, size: Math.round(size * 1.3), italics: true })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 600 }, ...pb });
      case 'author':
        return new Paragraph({ children: [new TextRun({ text: b.text, font: FONT, size: Math.round(size * 1.3), bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 }, ...pb });
      case 'heading':
        return new Paragraph({ children: [new TextRun({ text: b.text, font: FONT, size: Math.round(size * 1.4), bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 360 }, ...pb });
      case 'line':
        return new Paragraph({ children: [run(b.text, { bold: b.bold })], alignment: AlignmentType.LEFT, spacing: { before: 0, after: 120 }, ...pb });
      case 'para': {
        const align = b.align === 'center' ? AlignmentType.CENTER : b.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
        return new Paragraph({ children: [run(b.text, { bold: b.bold, italics: b.italic })], alignment: align, spacing: { before: 0, after: 180 }, ...pb });
      }
      case 'link':
        return new Paragraph({
          children: [new ExternalHyperlink({ link: safeUrl(b.url), children: [new TextRun({ text: b.label, font: FONT, size, color: '0563C1', underline: {} })] })],
          spacing: { before: 0, after: 120 },
          ...pb
        });
    }
  };
  const matterParagraphs = (p: MatterPage, startsNewPage: boolean): Paragraph[] =>
    p.blocks.map((b, i) => pageBlock(b, startsNewPage && i === 0));

  const frontChildren: Paragraph[] = [];
  book.front.forEach((p, i) => {
    const ps = matterParagraphs(p, i > 0);
    if (p.id === 'title') frontChildren.push(new Paragraph({ children: [], spacing: { before: convertInchesToTwip(1.8), after: 0 } }));
    frontChildren.push(...ps);
  });
  // Contents (static: linked entries, no page numbers)
  frontChildren.push(
    new Paragraph({
      children: [new TextRun({ text: 'CONTENTS', font: FONT, size: Math.round(size * 1.4), bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 360 },
      pageBreakBefore: true
    })
  );
  for (const t of book.toc) {
    frontChildren.push(
      new Paragraph({
        children: [new InternalHyperlink({ anchor: t.id, children: [new TextRun({ text: t.label, font: FONT, size })] })],
        alignment: AlignmentType.LEFT,
        spacing: { before: 0, after: 160 }
      })
    );
  }

  // ---- body: chapters + back matter ---------------------------------------------------------
  const headingText = (c: BuiltChapter) =>
    c.heading.rest
      ? [new TextRun({ text: `${c.heading.prefix}: `, font: FONT, size: Math.round(size * 1.6), bold: true, color: '000000' }), new TextRun({ text: c.heading.rest, font: FONT, size: Math.round(size * 1.6), bold: true, italics: true, color: '000000' })]
      : [new TextRun({ text: c.heading.prefix, font: FONT, size: Math.round(size * 1.6), bold: true, color: '000000' })];

  const bodyChildren: Paragraph[] = [];
  book.chapters.forEach((c, idx) => {
    bodyChildren.push(
      new Paragraph({
        heading: 'Heading1',
        children: [new Bookmark({ id: c.id, children: headingText(c) })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 480 },
        // no page break before chapter 1: the section boundary already starts it fresh
        ...(idx > 0 ? { pageBreakBefore: true } : {})
      }),
      ...blocksToParagraphs(c.blocks)
    );
  });
  for (const p of book.back) {
    p.blocks.forEach((b, i) => {
      if (i === 0 && b.t === 'heading') {
        bodyChildren.push(
          new Paragraph({
            heading: 'Heading1',
            children: [new Bookmark({ id: `back-${p.id}`, children: [new TextRun({ text: b.text, font: FONT, size: Math.round(size * 1.4), bold: true, color: '000000' })] })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 360 },
            pageBreakBefore: true
          })
        );
      } else bodyChildren.push(pageBlock(b, i === 0));
    });
  }

  const pageProps = { size: { width: convertInchesToTwip(trim.width), height: convertInchesToTwip(trim.height) }, margin: { top: margin, bottom: margin, left: margin, right: margin } };
  const sections: ISectionOptions[] = [
    { properties: { page: pageProps }, children: frontChildren },
    {
      properties: { page: { ...pageProps, pageNumbers: { start: 1 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })] })]
        })
      },
      children: bodyChildren
    }
  ];

  const doc = new Document({
    creator: book.meta.author,
    title: book.meta.title,
    description: book.meta.subtitle || undefined,
    styles: {
      default: { document: { run: { font: FONT, size } } },
      paragraphStyles: [
        // Heading 1 would otherwise pull in Word's blue theme colour
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: FONT, size: Math.round(size * 1.6), bold: true, color: '000000' },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 480 } }
        }
      ]
    },
    numbering: {
      config: [{ reference: 'ordered', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }]
    },
    sections
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
