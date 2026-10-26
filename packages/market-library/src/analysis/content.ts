import type { ContentMetrics } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, summarize, type CategoryBook, type Summary } from '../category.js';
import { contentMetricsOf, type TextSource } from '../manuscripts.js';

type Pick = (m: ContentMetrics) => number | null;

const NUMERIC: Record<string, Pick> = {
  words: (m) => m.words,
  dialogue_share: (m) => m.dialogueShare,
  avg_sentence_words: (m) => m.avgSentenceWords,
  short_sentence_share: (m) => m.sentenceLength.shortShare,
  reading_ease: (m) => m.readingEase,
  grade_level: (m) => m.gradeLevel,
  chapter_count: (m) => m.chapters.count,
  avg_chapter_words: (m) => m.chapters.avgWords,
  opening_first_sentence_words: (m) => m.opening.firstSentenceWords,
  opening_dialogue_share: (m) => m.opening.dialogueShare,
  opening_avg_sentence_words: (m) => m.opening.avgSentenceWords,
  opening_proper_nouns_per_100: (m) => m.opening.properNounsPer100,
  opening_first_person_per_100: (m) => m.opening.firstPersonPer100,
};

export interface ContentGroup {
  /** Books with text of any kind. */
  known: number;
  /** Of those, books where the text is a whole manuscript rather than a sample. */
  fullManuscripts: number;
  metrics: Record<string, Summary>;
  startsWithDialogue: { known: number; share: number | null };
}

export interface ContentStats {
  topN: number;
  top: ContentGroup;
  rest: ContentGroup;
  books: { asin: string; listRank: number; title: string | null; source: TextSource; metrics: ContentMetrics }[];
  caveats: string[];
}

export function contentStats(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey)): ContentStats {
  const rows = books
    .map((b) => ({ b, c: contentMetricsOf(db, b.asin) }))
    .filter((x): x is { b: CategoryBook; c: NonNullable<ReturnType<typeof contentMetricsOf>> } => x.c !== null);
  const group = (rs: typeof rows): ContentGroup => {
    const starts = rs.filter((x) => x.c.metrics.opening.words >= 20);
    return {
      known: rs.length,
      fullManuscripts: rs.filter((x) => x.c.source === 'upload').length,
      metrics: Object.fromEntries(Object.entries(NUMERIC).map(([k, f]) => [k, summarize(rs.map((x) => f(x.c.metrics)))])),
      startsWithDialogue: { known: starts.length, share: starts.length ? Math.round((starts.filter((x) => x.c.metrics.opening.startsWithDialogue).length / starts.length) * 1000) / 1000 : null },
    };
  };
  const caveats: string[] = [];
  const samples = rows.filter((x) => x.c.source === 'sample').length;
  if (samples) caveats.push(`${samples} of the ${rows.length} books with text have only the free sample (about the first 10%), so whole-book figures such as length and chapter count are unreliable for them; opening-page figures are fine.`);
  if (!rows.length) caveats.push('No book in this category has text yet. Drop a PDF/EPUB onto a book, or capture its free sample with the extension.');
  return {
    topN,
    top: group(rows.filter((x) => x.b.listRank <= topN)),
    rest: group(rows.filter((x) => x.b.listRank > topN)),
    books: rows.map((x) => ({ asin: x.b.asin, listRank: x.b.listRank, title: x.b.title, source: x.c.source, metrics: x.c.metrics })),
    caveats,
  };
}
