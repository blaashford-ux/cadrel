import { stripFences } from '../align';
import { ABBREVIATIONS } from './lexicon';

/** A word, the way the rest of the app counts them (see shared/words.ts). */
export const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

const OPEN_ITALIC = '\u0001';
const CLOSE_ITALIC = '\u0002';

/** Lowercase, with curly apostrophes straightened. */
export const norm = (w: string): string => w.toLowerCase().replace(/’/g, "'");

export const wordsOf = (s: string): string[] => s.match(WORD_RE) ?? [];

export interface Paragraph {
  /** Index of the scene (a run of paragraphs between scene breaks) within its chapter. */
  scene: number;
  /** The whole paragraph, with its quote marks. */
  text: string;
  /** Spoken parts (without the quote marks). */
  dialogue: string[];
  /** Everything outside quotes. */
  narration: string[];
  /** Narration minus italic runs of three or more words (those are usually direct thought). */
  povNarration: string[];
}

export interface ParsedChapter {
  title: string;
  paragraphs: Paragraph[];
  scenes: number;
}

const SCENE_BREAK = /^\s*(?:[*_\-–—~#=]\s*){3,}$|^\s*#\s*$|^\s*(?:\*\s*){3,}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

/** Markdown inline syntax → plain text, with long italic runs wrapped in sentinels. */
function plainInline(s: string): string {
  let t = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_m, c: string) => (c === '*' || c === '_' ? `\u0003${c === '*' ? 'a' : 'u'}` : c));
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2').replace(/~~([^~]+)~~/g, '$1');
  const wrap = (_m: string, inner: string) => (wordsOf(inner).length >= 3 ? `${OPEN_ITALIC}${inner}${CLOSE_ITALIC}` : inner);
  t = t.replace(/(?<![*\w])\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)/g, wrap).replace(/(?<![_\w])_(?=\S)([^_]+?)(?<=\S)_(?![_\w])/g, wrap);
  return t.replace(/\u0003a/g, '*').replace(/\u0003u/g, '_');
}

interface Cut {
  parts: { dialogue: boolean; text: string }[];
  endsOpen: boolean;
}

const isOpener = (c: string) => c === '"' || c === '“';

/** Splits a paragraph into spoken and unspoken parts. `single` = ‘single quotes’ are the speech marks. */
function cutQuotes(text: string, carry: boolean, single: boolean): Cut {
  const parts: Cut['parts'] = [];
  let inQ = carry;
  let buf = '';
  const flush = () => {
    if (buf) parts.push({ dialogue: inQ, text: buf });
    buf = '';
  };
  let i = 0;
  if (carry && text.length > 0 && (isOpener(text[0]) || (single && text[0] === '‘'))) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : ' ';
    const next = i + 1 < text.length ? text[i + 1] : ' ';
    if (c === '“') {
      flush();
      inQ = true;
    } else if (c === '”') {
      flush();
      inQ = false;
    } else if (c === '"') {
      flush();
      inQ = !inQ;
    } else if (single && c === '‘' && /[\s(\u0001—–-]/.test(prev)) {
      flush();
      inQ = true;
    } else if (single && c === '’' && inQ && !/[\p{L}\p{N}]/u.test(next)) {
      flush();
      inQ = false;
    } else buf += c;
  }
  flush();
  return { parts, endsOpen: inQ };
}

const stripSentinels = (s: string) => s.replace(/[\u0001\u0002]/g, '');
const dropItalicRuns = (s: string) => s.replace(/\u0001[^\u0002]*\u0002/g, ' ');

/** Which quote marks does this text use for speech? */
function usesSingleQuotes(text: string): boolean {
  const doubles = (text.match(/["“]/g) ?? []).length;
  const singles = (text.match(/(?:^|[\s(—–-])‘(?=[\p{L}\p{N}])/gmu) ?? []).length;
  return doubles < 5 && singles >= 10;
}

/** Turns one chapter's Markdown into paragraphs of plain text (front matter, headings, code and scene breaks dropped). */
export function parseChapter(raw: string, title: string, singleQuotes: boolean): ParsedChapter {
  const lines = stripFences(raw.replace(/^﻿/, '')).split(/\r\n|\n|\r/);
  const blocks: ({ text: string } | 'break')[] = [];
  let buf: string[] = [];
  const endBlock = () => {
    if (buf.length) blocks.push({ text: buf.join(' ').replace(/\s+/g, ' ').trim() });
    buf = [];
  };
  let fence: string | null = null;
  let i = 0;
  if (lines[0] && /^---\s*$/.test(lines[0])) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)\s*$/.test(lines[j])) {
        i = j + 1;
        break;
      }
    }
  }
  let inComment = false;
  for (; i < lines.length; i++) {
    let line = lines[i];
    if (inComment) {
      if (line.includes('-->')) {
        inComment = false;
        line = line.slice(line.indexOf('-->') + 3);
      } else continue;
    }
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      endBlock();
      fence = f[1];
      continue;
    }
    if (line.includes('<!--')) {
      const before = line.slice(0, line.indexOf('<!--'));
      const rest = line.slice(line.indexOf('<!--'));
      if (rest.includes('-->')) line = before + rest.slice(rest.indexOf('-->') + 3);
      else {
        line = before;
        inComment = true;
      }
    }
    if (line.trim() === '') {
      endBlock();
      continue;
    }
    if (SCENE_BREAK.test(line)) {
      endBlock();
      blocks.push('break');
      continue;
    }
    if (ATX_HEADING.test(line)) {
      endBlock();
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endBlock();
      continue;
    }
    buf.push(line.replace(/^\s*(?:>\s?)+/, '').replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, ''));
  }
  endBlock();

  const paragraphs: Paragraph[] = [];
  let scene = 0;
  let carry = false;
  const marked = blocks.map((b) => (b === 'break' ? null : plainInline(b.text)));
  for (let b = 0; b < marked.length; b++) {
    const t = marked[b];
    if (t === null) {
      scene++;
      carry = false;
      continue;
    }
    const clean = stripSentinels(t);
    if (!/[\p{L}\p{N}]/u.test(clean)) continue;
    const startsWithQuote = /^[\u0001]?["“‘]/.test(t);
    const cut = cutQuotes(clean, carry && startsWithQuote, singleQuotes);
    const cutPov = cutQuotes(dropItalicRuns(t).replace(/\u0002/g, ''), carry && startsWithQuote, singleQuotes);
    carry = cut.endsOpen;
    paragraphs.push({
      scene,
      text: clean,
      dialogue: cut.parts.filter((p) => p.dialogue).map((p) => p.text),
      narration: cut.parts.filter((p) => !p.dialogue).map((p) => p.text),
      povNarration: cutPov.parts.filter((p) => !p.dialogue).map((p) => p.text)
    });
  }
  return { title, paragraphs, scenes: scene + 1 };
}

export function detectSingleQuotes(chapters: { raw: string }[]): boolean {
  let sample = '';
  for (const c of chapters) {
    sample += c.raw;
    if (sample.length > 400_000) break;
  }
  return usesSingleQuotes(sample);
}

const TERMINATOR = /[.!?…]+["”’')\]]*(?=\s|$)/g;

/** Splits a paragraph into sentences. Abbreviations ("Mr.") and initials do not end one; a lowercase letter after the full stop does not either. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  TERMINATOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINATOR.exec(text))) {
    const end = m.index + m[0].length;
    const rest = text.slice(end).replace(/^\s+/, '');
    if (rest) {
      if (/^[a-z]/.test(rest)) continue;
      if (m[0] === '.') {
        const before = text.slice(start, m.index);
        const word = /([\p{L}.]+)$/u.exec(before)?.[1] ?? '';
        if (ABBREVIATIONS.has(word.toLowerCase().replace(/\.$/, ''))) continue;
        if (/^[A-Z]$/.test(word) && word !== 'I' && word !== 'A') continue;
      }
    }
    const s = text.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const SYLLABLES = new Map<string, number>();

/** A rough syllable count; good enough for readability formulas. */
export function syllables(word: string): number {
  const hit = SYLLABLES.get(word);
  if (hit !== undefined) return hit;
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  let n: number;
  if (!w) n = 1;
  else if (w.length <= 3) n = 1;
  else {
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    n = Math.max(1, (w.match(/[aeiouy]{1,2}/g) ?? []).length);
  }
  if (SYLLABLES.size < 50_000) SYLLABLES.set(word, n);
  return n;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
