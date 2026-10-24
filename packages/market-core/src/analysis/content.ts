import { median, syllables } from './stats.js';

export interface Chapter {
  title: string;
  /** Character offsets into the text, [start, end). */
  start: number;
  end: number;
}

export interface OpeningProfile {
  /** The first ~300 words, about one screen of an ebook. */
  words: number;
  firstSentence: string | null;
  firstSentenceWords: number | null;
  dialogueShare: number;
  startsWithDialogue: boolean;
  avgSentenceWords: number | null;
  questions: number;
  exclamations: number;
  /** Capitalised words that are not sentence starters, per 100 words: a rough count of names and places introduced. */
  properNounsPer100: number;
  /** Words from a small first-person/second-person pronoun list per 100 words: a rough narrative-voice signal. */
  firstPersonPer100: number;
}

export interface ContentMetrics {
  words: number;
  sentences: number;
  paragraphs: number;
  avgSentenceWords: number | null;
  sentenceLength: { p25: number | null; median: number | null; p75: number | null; max: number; shortShare: number; longShare: number };
  /** Share of words inside quotation marks. */
  dialogueShare: number;
  /** Flesch reading ease and Flesch-Kincaid grade. */
  readingEase: number | null;
  gradeLevel: number | null;
  chapters: { count: number; avgWords: number | null; firstWords: number | null };
  opening: OpeningProfile;
  /** Whether the text is a whole book or an excerpt, so figures are read accordingly. */
  basis: 'manuscript' | 'sample';
}

const OPEN_QUOTES = /["“]/;
const WORD = /[\p{L}\p{N}'’]+/gu;
const countWords = (s: string) => (s.match(WORD) ?? []).length;

/** Words inside straight or curly double quotes, counting quotes that span a paragraph as dialogue to the paragraph's end. */
export function dialogueWords(text: string): number {
  let n = 0;
  for (const para of text.split(/\n+/)) {
    let inside = false;
    let buf = '';
    for (const ch of para) {
      if (ch === '"' || ch === '“' || ch === '”') {
        if (ch === '"') inside = !inside;
        else inside = ch === '“';
        if (!inside) { n += countWords(buf); buf = ''; }
        continue;
      }
      if (inside) buf += ch;
    }
    if (inside) n += countWords(buf); // unclosed quote (dialogue continues in the next paragraph)
  }
  return n;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…]["'”’)]*)\s+(?=["“'‘(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const FIRST_PERSON = new Set(['i', 'me', 'my', 'mine', 'myself', "i'm", "i've", "i'd", "i'll", 'we', 'our', 'us', 'you', 'your']);

/** Leading "Chapter 1" / "Prologue" lines are headings, not prose. */
const LEADING_HEADING = /^(?:\s*(?:(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b[^\n]{0,60}|prologue|epilogue|interlude|\d{1,3}\.?)[ \t]*(?:\n|$))+/i;

export function openingProfile(text: string, wordLimit = 300): OpeningProfile {
  text = text.replace(LEADING_HEADING, '');
  const all = [...text.matchAll(WORD)];
  const cut = all.length > wordLimit ? all[wordLimit]!.index! : text.length;
  const head = text.slice(0, cut).trim();
  const sentences = splitSentences(head);
  const words = countWords(head);
  let proper = 0;
  for (const s of sentences) {
    const w = s.match(WORD) ?? [];
    for (let i = 1; i < w.length; i++) if (/^\p{Lu}/u.test(w[i]!) && w[i] !== 'I' && !/^I['’]/.test(w[i]!)) proper++;
  }
  const lower = (head.toLowerCase().match(WORD) ?? []);
  return {
    words,
    firstSentence: sentences[0] ?? null,
    firstSentenceWords: sentences[0] ? countWords(sentences[0]) : null,
    dialogueShare: words ? Math.round((dialogueWords(head) / words) * 1000) / 1000 : 0,
    startsWithDialogue: OPEN_QUOTES.test(head.slice(0, 3)),
    avgSentenceWords: sentences.length ? Math.round((words / sentences.length) * 10) / 10 : null,
    questions: (head.match(/\?/g) ?? []).length,
    exclamations: (head.match(/!/g) ?? []).length,
    properNounsPer100: words ? Math.round((proper / words) * 1000) / 10 : 0,
    firstPersonPer100: words ? Math.round((lower.filter((w) => FIRST_PERSON.has(w)).length / words) * 1000) / 10 : 0,
  };
}

/** Chapter headings found in plain text ("Chapter 3", "PROLOGUE", "Part Two", a line that is only a number). */
export function detectChapters(text: string): Chapter[] {
  const re = /^[ \t]*((?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b[^\n]{0,60}|prologue|epilogue|interlude|\d{1,3}\.?)[ \t]*$/gim;
  const marks: { title: string; start: number }[] = [];
  for (const m of text.matchAll(re)) marks.push({ title: m[1]!.trim(), start: m.index! });
  return marks.map((m, i) => ({ title: m.title, start: m.start, end: i + 1 < marks.length ? marks[i + 1]!.start : text.length }));
}

export function contentMetrics(text: string, opts: { chapters?: Chapter[]; basis?: 'manuscript' | 'sample' } = {}): ContentMetrics {
  const sentences = splitSentences(text);
  const lens = sentences.map(countWords);
  const words = countWords(text);
  const sorted = [...lens].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
  const syll = (text.match(WORD) ?? []).reduce((n, w) => n + syllables(w), 0);
  const asl = sentences.length ? words / sentences.length : null;
  const spw = words ? syll / words : null;
  const chapters = opts.chapters ?? detectChapters(text);
  const chapWords = chapters.map((c) => countWords(text.slice(c.start, c.end)));
  return {
    words,
    sentences: sentences.length,
    paragraphs: text.split(/\n\s*\n/).filter((p) => p.trim()).length,
    avgSentenceWords: asl == null ? null : Math.round(asl * 10) / 10,
    sentenceLength: {
      p25: q(0.25), median: median(lens), p75: q(0.75), max: sorted.length ? sorted[sorted.length - 1]! : 0,
      shortShare: lens.length ? Math.round((lens.filter((l) => l <= 6).length / lens.length) * 1000) / 1000 : 0,
      longShare: lens.length ? Math.round((lens.filter((l) => l >= 30).length / lens.length) * 1000) / 1000 : 0,
    },
    dialogueShare: words ? Math.round((dialogueWords(text) / words) * 1000) / 1000 : 0,
    readingEase: asl != null && spw != null && words >= 5 ? Math.round((206.835 - 1.015 * asl - 84.6 * spw) * 10) / 10 : null,
    gradeLevel: asl != null && spw != null && words >= 5 ? Math.round((0.39 * asl + 11.8 * spw - 15.59) * 10) / 10 : null,
    chapters: { count: chapters.length, avgWords: chapWords.length ? Math.round(chapWords.reduce((a, b) => a + b, 0) / chapWords.length) : null, firstWords: chapWords[0] ?? null },
    opening: openingProfile(text),
    basis: opts.basis ?? 'manuscript',
  };
}
