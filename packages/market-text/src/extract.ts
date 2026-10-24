import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import * as cheerio from 'cheerio';
import { detectChapters, type Chapter } from '@cadrel/market-core';
import { normalizeText } from './normalize.js';

export type SourceKind = 'pdf' | 'epub' | 'docx' | 'txt' | 'md';

export interface Extracted {
  kind: SourceKind;
  text: string;
  chapters: Chapter[];
  /** PDF page count, when known. */
  pages: number | null;
  title: string | null;
  /** Things the user should know, e.g. a PDF with no text layer. */
  warnings: string[];
}

export const MAX_BYTES = 120 * 1024 * 1024;
export const SUPPORTED = ['.pdf', '.epub', '.docx', '.txt', '.md', '.markdown'];

export function kindOf(name: string): SourceKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt') return 'txt';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return null;
}

export async function extractFile(file: string): Promise<Extracted> {
  const kind = kindOf(file);
  if (!kind) throw new Error(`unsupported file type; use ${SUPPORTED.join(', ')}`);
  const size = fs.statSync(file).size;
  if (size > MAX_BYTES) throw new Error('file is larger than 120 MB');
  return extractBuffer(fs.readFileSync(file), kind);
}

export async function extractBuffer(buf: Buffer, kind: SourceKind): Promise<Extracted> {
  switch (kind) {
    case 'txt': return fromText(buf.toString('utf8'), 'txt');
    case 'md': return fromText(buf.toString('utf8'), 'md');
    case 'docx': return fromDocx(buf);
    case 'epub': return fromEpub(buf);
    case 'pdf': return fromPdf(buf);
  }
}

function build(kind: SourceKind, parts: { title: string | null; text: string }[], base: Partial<Extracted> = {}): Extracted {
  // chapters are the parts that start with a heading; stitching keeps offsets exact
  let text = '';
  const chapters: Chapter[] = [];
  for (const p of parts) {
    const t = normalizeText(p.text);
    if (!t) continue;
    if (text) text += '\n\n';
    if (p.title) chapters.push({ title: p.title, start: text.length, end: text.length + t.length });
    text += t;
  }
  return { kind, text, chapters, pages: null, title: null, warnings: [], ...base };
}

function fromText(raw: string, kind: 'txt' | 'md'): Extracted {
  let text = normalizeText(raw);
  if (kind === 'md') {
    const chapters: Chapter[] = [];
    const out: string[] = [];
    let pos = 0;
    for (const line of text.split('\n')) {
      const h = /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
      const clean = h ? h[1]! : line.replace(/^\s*>\s?/, '').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '');
      if (h) chapters.push({ title: clean, start: pos, end: pos });
      out.push(clean);
      pos += clean.length + 1;
    }
    text = out.join('\n');
    chapters.forEach((c, i) => (c.end = i + 1 < chapters.length ? chapters[i + 1]!.start : text.length));
    return { kind, text, chapters, pages: null, title: chapters[0]?.title ?? null, warnings: [] };
  }
  return { kind, text, chapters: detectChapters(text), pages: null, title: null, warnings: [] };
}

function fromDocx(buf: Buffer): Extracted {
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('not a Word document (word/document.xml missing)');
  const $ = cheerio.load(strFromU8(xml), { xmlMode: true });
  const parts: { title: string | null; text: string }[] = [];
  $('w\\:body > w\\:p, w\\:body > w\\:tbl w\\:p').each((_, p) => {
    const style = $(p).find('w\\:pStyle').attr('w:val') ?? '';
    const text = $(p)
      .find('w\\:t, w\\:tab, w\\:br')
      .map((__, n) => (n.tagName === 'w:t' ? $(n).text() : n.tagName === 'w:tab' ? '\t' : '\n'))
      .get()
      .join('');
    if (!text.trim()) { parts.push({ title: null, text: '' }); return; }
    parts.push({ title: /^(Heading1|Heading2|Title)$/i.test(style) ? text.trim() : null, text });
  });
  // paragraphs are separated by blank lines; headings start a chapter
  const joined: { title: string | null; text: string }[] = [];
  for (const p of parts) {
    if (p.title) joined.push({ title: p.title, text: p.text });
    else if (p.text) {
      const last = joined[joined.length - 1];
      if (last && !last.title) last.text += '\n\n' + p.text;
      else if (last) last.text += '\n\n' + p.text;
      else joined.push({ title: null, text: p.text });
    }
  }
  const r = build('docx', joined);
  return r.chapters.length ? r : { ...r, chapters: detectChapters(r.text) };
}

function fromEpub(buf: Buffer): Extracted {
  const files = unzipSync(new Uint8Array(buf));
  const get = (p: string) => files[decodeURIComponent(p)] ?? files[p];
  const container = get('META-INF/container.xml');
  if (!container) throw new Error('not an EPUB (META-INF/container.xml missing)');
  const opfPath = cheerio.load(strFromU8(container), { xmlMode: true })('rootfile').attr('full-path');
  const opfBytes = opfPath && get(opfPath);
  if (!opfPath || !opfBytes) throw new Error('EPUB package file not found');
  const opf = cheerio.load(strFromU8(opfBytes), { xmlMode: true });
  const base = path.posix.dirname(opfPath);
  const manifest = new Map<string, { href: string; props: string }>();
  opf('manifest > item').each((_, i) => void manifest.set(opf(i).attr('id') ?? '', { href: opf(i).attr('href') ?? '', props: opf(i).attr('properties') ?? '' }));
  const title = opf('metadata > dc\\:title, metadata > title').first().text().trim() || null;
  const parts: { title: string | null; text: string }[] = [];
  const warnings: string[] = [];
  opf('spine > itemref').each((_, ref) => {
    if (opf(ref).attr('linear') === 'no') return;
    const item = manifest.get(opf(ref).attr('idref') ?? '');
    if (!item || /\bnav\b/.test(item.props)) return;
    const bytes = get(path.posix.normalize(path.posix.join(base, item.href)));
    if (!bytes) return;
    const $ = cheerio.load(strFromU8(bytes));
    $('script, style, nav, svg, head').remove();
    $('br').replaceWith('\n');
    const heading = $('h1, h2, h3').first().text().replace(/\s+/g, ' ').trim() || null;
    const blocks: string[] = [];
    $('h1, h2, h3, h4, h5, h6, p, li, blockquote, div, pre').each((__, el) => {
      // only leaf-ish blocks, so nested divs do not duplicate text
      if ($(el).children('p, div, li, blockquote, h1, h2, h3, h4, h5, h6').length) return;
      const t = $(el).text().replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
      if (t) blocks.push(t);
    });
    const text = blocks.join('\n\n') || $('body').text();
    if (text.trim()) parts.push({ title: heading, text });
  });
  if (!parts.length) warnings.push('no readable text found in the EPUB');
  // a spine file without a heading continues the previous chapter
  const merged: { title: string | null; text: string }[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (!p.title && last) last.text += '\n\n' + p.text;
    else merged.push({ ...p });
  }
  return build('epub', merged, { title, warnings });
}

async function fromPdf(buf: Buffer): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines: { y: number; h: number; text: string }[] = [];
      for (const it of content.items as { str: string; transform: number[]; height: number; hasEOL?: boolean }[]) {
        if (!('str' in it)) continue;
        const y = it.transform[5]!;
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - y) < Math.max(2, last.h * 0.4)) last.text += it.str;
        else lines.push({ y, h: it.height || 10, text: it.str });
      }
      // paragraph break where the vertical gap is clearly larger than normal leading
      let out = '';
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (!l.text.trim()) continue;
        const prev = lines[i - 1];
        const gap = prev ? prev.y - l.y : 0;
        out += !prev ? '' : gap > l.h * 1.9 ? '\n\n' : out.endsWith('-') ? '' : ' ';
        out += l.text.trim();
      }
      pages.push(out);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  const text = normalizeText(pages.join('\n\n'));
  const warnings: string[] = [];
  if (text.length < 30 * Math.max(1, pages.length)) warnings.push('this PDF has little or no text layer (it may be scanned images); the text is incomplete');
  return { kind: 'pdf', text, chapters: detectChapters(text), pages: pages.length, title: null, warnings };
}
