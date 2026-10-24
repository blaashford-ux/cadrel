/**
 * The saved description of a book: front/back matter entered in the Book Details form, plus the
 * last-used export variables. Stored as JSON beside the manuscript (see sidecar.ts).
 */

import { cleanFamily, DEFAULT_FONT } from './fonts';

export type ParagraphStyle = 'blockGap' | 'blockNoGap' | 'indent';
export type ChapterHeadingStyle = 'verbatim' | 'numberWord';
export type RunningHead = 'none' | 'author' | 'title' | 'authorTitle';
export type SmartQuotes = 'auto' | 'always' | 'never';

export const FICTION_TEXT =
  'This is a work of fiction. Names, characters, businesses, places, events, and incidents are either products of the author’s imagination or used in a fictitious manner. Any resemblance to actual persons, living or dead, or actual events, is purely coincidental.';
export const REPRODUCTION_TEXT =
  'No part of this book may be reproduced, distributed, or transmitted in any form or by any means, including photocopying, recording, or other electronic or mechanical methods, without the prior written permission of the author, except in the case of brief quotations embodied in critical reviews and certain other noncommercial uses permitted by copyright law.';
export const MATURE_TEXT = 'This book contains mature themes and explicit content intended for readers 18 and older.';
export const CONTENT_WARNING_TEXT = 'Add Content Warnings here';
/** The wording this field had before it became the Content Warning; saved books that still hold it are moved to the new default. */
const LEGACY_AI_TEXT = 'This book was created using a Human-in-the-Loop Generative AI system.';

export interface LinkItem {
  label: string;
  url: string;
}
export interface TitleItem {
  title: string;
  url: string;
}

export interface CopyrightDetails {
  year: string;
  edition: string;
  publisher: string;
  isbn: string;
  fictionDisclaimer: boolean;
  fictionText: string;
  reproductionText: string;
  matureNotice: boolean;
  matureText: string;
  contentWarning: boolean;
  contentWarningText: string;
  /** Extra free-text lines, shown after the notices and before the edition line. */
  extraLines: string[];
}

export interface ExportSettings {
  /** Relative to the manuscript's folder, or absolute. */
  outputDir: string;
  outputs: { epub: boolean; pdf: boolean; docx: boolean };
  /** Chapter titles (exactly as written) left out of the export. */
  excludedChapters: string[];
  chapterHeading: ChapterHeadingStyle;
  smartQuotes: SmartQuotes;
  sceneBreak: string;
  epub: {
    language: string;
    description: string;
    /** Absolute path to a cover image to embed (optional). */
    coverImage: string;
    dropCaps: boolean;
    paragraphStyle: ParagraphStyle;
    fontSize: number;
    /** Font family. A bundled family is embedded in the EPUB; any other is only named. */
    font: string;
  };
  pdf: {
    trim: string;
    /** 'auto' picks KDP's gutter from the final page count. */
    gutter: 'auto' | number;
    outerMargin: number;
    topMargin: number;
    bottomMargin: number;
    rectoStarts: boolean;
    pageNumbers: boolean;
    runningHead: RunningHead;
    fontSize: number;
    paragraphStyle: ParagraphStyle;
    /** Font family: bundled, or any font installed on this computer. Embedded in the PDF either way. */
    font: string;
  };
  docx: {
    trim: string;
    paragraphStyle: ParagraphStyle;
    fontSize: number;
  };
}

export interface BookDetails {
  version: 1;
  marked: boolean;
  title: string;
  subtitle: string;
  author: string;
  copyright: CopyrightDetails;
  dedication: { enabled: boolean; text: string };
  epigraph: { enabled: boolean; text: string; attribution: string };
  back: {
    links: { enabled: boolean; heading: string; intro: string; items: LinkItem[] };
    alsoBy: { enabled: boolean; heading: string; items: TitleItem[] };
    about: { enabled: boolean; heading: string; text: string };
    custom: { enabled: boolean; heading: string; text: string };
  };
  export: ExportSettings;
}

export const DEFAULT_TRIM = '5.5x8.5';

export function defaultExportSettings(): ExportSettings {
  return {
    outputDir: 'Exports',
    outputs: { epub: true, pdf: true, docx: false },
    excludedChapters: [],
    chapterHeading: 'verbatim',
    smartQuotes: 'auto',
    sceneBreak: '•  •  •',
    epub: { language: 'en', description: '', coverImage: '', dropCaps: true, paragraphStyle: 'blockGap', fontSize: 11, font: DEFAULT_FONT },
    pdf: {
      trim: DEFAULT_TRIM,
      gutter: 'auto',
      outerMargin: 0.5,
      topMargin: 0.75,
      bottomMargin: 0.75,
      rectoStarts: true,
      pageNumbers: true,
      runningHead: 'none',
      fontSize: 11,
      paragraphStyle: 'blockNoGap',
      font: DEFAULT_FONT
    },
    docx: { trim: DEFAULT_TRIM, paragraphStyle: 'blockGap', fontSize: 11 }
  };
}

export function defaultBookDetails(seed: { title?: string; author?: string; year?: number } = {}): BookDetails {
  return {
    version: 1,
    marked: true,
    title: seed.title ?? '',
    subtitle: '',
    author: seed.author ?? '',
    copyright: {
      year: String(seed.year ?? new Date().getFullYear()),
      edition: 'First Edition',
      publisher: '',
      isbn: '',
      fictionDisclaimer: true,
      fictionText: FICTION_TEXT,
      reproductionText: REPRODUCTION_TEXT,
      matureNotice: false,
      matureText: MATURE_TEXT,
      contentWarning: false,
      contentWarningText: CONTENT_WARNING_TEXT,
      extraLines: []
    },
    dedication: { enabled: false, text: '' },
    epigraph: { enabled: false, text: '', attribution: '' },
    back: {
      links: { enabled: false, heading: 'CONTINUE THE STORY', intro: '', items: [] },
      alsoBy: { enabled: false, heading: '', items: [] },
      about: { enabled: false, heading: 'ABOUT THE AUTHOR', text: '' },
      custom: { enabled: false, heading: '', text: '' }
    },
    export: defaultExportSettings()
  };
}

// ---- defensive parsing -------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const str = (v: unknown, d: string, max = 20000) => (typeof v === 'string' ? v.replace(CONTROL, '').slice(0, max) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const list = <T>(v: unknown, item: (x: Record<string, unknown>) => T, max = 200): T[] =>
  Array.isArray(v) ? v.filter(isObj).slice(0, max).map(item) : [];

const PSTYLES = ['blockGap', 'blockNoGap', 'indent'] as const;

/**
 * Turns whatever was on disk into a valid BookDetails: unknown or wrong-typed fields fall back to
 * their defaults (nothing throws), unknown extra fields are dropped.
 */
export function sanitizeBookDetails(raw: unknown, seed: { title?: string; author?: string } = {}): BookDetails {
  const d = defaultBookDetails(seed);
  if (!isObj(raw)) return d;
  const c = isObj(raw.copyright) ? raw.copyright : {};
  const ded = isObj(raw.dedication) ? raw.dedication : {};
  const epi = isObj(raw.epigraph) ? raw.epigraph : {};
  const back = isObj(raw.back) ? raw.back : {};
  const links = isObj(back.links) ? back.links : {};
  const also = isObj(back.alsoBy) ? back.alsoBy : {};
  const about = isObj(back.about) ? back.about : {};
  const custom = isObj(back.custom) ? back.custom : {};
  const ex = isObj(raw.export) ? raw.export : {};
  const outs = isObj(ex.outputs) ? ex.outputs : {};
  const ep = isObj(ex.epub) ? ex.epub : {};
  const pd = isObj(ex.pdf) ? ex.pdf : {};
  const dx = isObj(ex.docx) ? ex.docx : {};
  const e = d.export;

  return {
    version: 1,
    marked: bool(raw.marked, d.marked),
    title: str(raw.title, d.title, 500),
    subtitle: str(raw.subtitle, d.subtitle, 500),
    author: str(raw.author, d.author, 300),
    copyright: {
      year: str(c.year, d.copyright.year, 20),
      edition: str(c.edition, d.copyright.edition, 200),
      publisher: str(c.publisher, d.copyright.publisher, 300),
      isbn: str(c.isbn, d.copyright.isbn, 40),
      fictionDisclaimer: bool(c.fictionDisclaimer, d.copyright.fictionDisclaimer),
      fictionText: str(c.fictionText, d.copyright.fictionText),
      reproductionText: str(c.reproductionText, d.copyright.reproductionText),
      matureNotice: bool(c.matureNotice, d.copyright.matureNotice),
      matureText: str(c.matureText, d.copyright.matureText),
      // books saved before the rename used aiDisclosure / aiText
      contentWarning: bool(c.contentWarning ?? c.aiDisclosure, d.copyright.contentWarning),
      contentWarningText: ((t) => (t.trim() === LEGACY_AI_TEXT ? CONTENT_WARNING_TEXT : t))(
        str(c.contentWarningText ?? c.aiText, d.copyright.contentWarningText)
      ),
      extraLines: Array.isArray(c.extraLines)
        ? c.extraLines.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => str(x, '', 1000))
        : []
    },
    dedication: { enabled: bool(ded.enabled, false), text: str(ded.text, '') },
    epigraph: { enabled: bool(epi.enabled, false), text: str(epi.text, ''), attribution: str(epi.attribution, '', 300) },
    back: {
      links: {
        enabled: bool(links.enabled, false),
        heading: str(links.heading, d.back.links.heading, 300),
        intro: str(links.intro, ''),
        items: list(links.items, (x) => ({ label: str(x.label, '', 300), url: str(x.url, '', 2000) }))
      },
      alsoBy: {
        enabled: bool(also.enabled, false),
        heading: str(also.heading, '', 300),
        items: list(also.items, (x) => ({ title: str(x.title, '', 300), url: str(x.url, '', 2000) }))
      },
      about: { enabled: bool(about.enabled, false), heading: str(about.heading, d.back.about.heading, 300), text: str(about.text, '') },
      custom: { enabled: bool(custom.enabled, false), heading: str(custom.heading, '', 300), text: str(custom.text, '') }
    },
    export: {
      outputDir: str(ex.outputDir, e.outputDir, 1000) || e.outputDir,
      outputs: { epub: bool(outs.epub, e.outputs.epub), pdf: bool(outs.pdf, e.outputs.pdf), docx: bool(outs.docx, e.outputs.docx) },
      excludedChapters: Array.isArray(ex.excludedChapters)
        ? ex.excludedChapters.filter((x): x is string => typeof x === 'string').slice(0, 1000)
        : [],
      chapterHeading: oneOf(ex.chapterHeading, ['verbatim', 'numberWord'] as const, e.chapterHeading),
      smartQuotes: oneOf(ex.smartQuotes, ['auto', 'always', 'never'] as const, e.smartQuotes),
      sceneBreak: str(ex.sceneBreak, e.sceneBreak, 40) || e.sceneBreak,
      epub: {
        language: str(ep.language, e.epub.language, 35) || e.epub.language,
        description: str(ep.description, e.epub.description, 4000),
        coverImage: str(ep.coverImage, '', 2000),
        dropCaps: bool(ep.dropCaps, e.epub.dropCaps),
        paragraphStyle: oneOf(ep.paragraphStyle, PSTYLES, e.epub.paragraphStyle),
        fontSize: num(ep.fontSize, e.epub.fontSize, 8, 20),
        font: cleanFamily(ep.font, e.epub.font)
      },
      pdf: {
        trim: str(pd.trim, e.pdf.trim, 20) || e.pdf.trim,
        gutter: pd.gutter === 'auto' ? 'auto' : num(pd.gutter, NaN, 0.25, 2) || 'auto',
        outerMargin: num(pd.outerMargin, e.pdf.outerMargin, 0.25, 2),
        topMargin: num(pd.topMargin, e.pdf.topMargin, 0.25, 2),
        bottomMargin: num(pd.bottomMargin, e.pdf.bottomMargin, 0.25, 2),
        rectoStarts: bool(pd.rectoStarts, e.pdf.rectoStarts),
        pageNumbers: bool(pd.pageNumbers, e.pdf.pageNumbers),
        runningHead: oneOf(pd.runningHead, ['none', 'author', 'title', 'authorTitle'] as const, e.pdf.runningHead),
        fontSize: num(pd.fontSize, e.pdf.fontSize, 8, 16),
        paragraphStyle: oneOf(pd.paragraphStyle, PSTYLES, e.pdf.paragraphStyle),
        font: cleanFamily(pd.font, e.pdf.font)
      },
      docx: {
        trim: str(dx.trim, e.docx.trim, 20) || e.docx.trim,
        paragraphStyle: oneOf(dx.paragraphStyle, PSTYLES, e.docx.paragraphStyle),
        fontSize: num(dx.fontSize, e.docx.fontSize, 8, 20)
      }
    }
  };
}
