import { mergeVoices, packagingOf, readerVoiceOf, type PackagingMetrics, type ReaderVoice } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, summarize, type CategoryBook, type Summary } from '../category.js';

export interface BookPackaging {
  asin: string;
  listRank: number;
  title: string | null;
  /** False when only the list-row title was available, so blurb metrics are empty. */
  hasBlurb: boolean;
  metrics: PackagingMetrics;
}

function blurbOf(db: Db, asin: string): string | null {
  return (
    db.scalar<string>(
      `SELECT t.body FROM text_block t JOIN snapshot s ON s.id = t.snapshot_id
       WHERE s.asin = ? AND t.kind = 'blurb' ORDER BY s.captured_at DESC LIMIT 1`,
      asin,
    ) ?? null
  );
}

export function bookPackaging(db: Db, books: CategoryBook[]): BookPackaging[] {
  return books.map((b) => {
    const blurb = b.captured ? blurbOf(db, b.asin) : null;
    return { asin: b.asin, listRank: b.listRank, title: b.title, hasBlurb: !!blurb, metrics: packagingOf(b.title, blurb) };
  });
}

type Num = (m: PackagingMetrics) => number | null;
const NUMERIC: Record<string, Num> = {
  title_chars: (m) => m.title.chars,
  title_words: (m) => m.title.words,
  blurb_words: (m) => m.blurb.words,
  blurb_paragraphs: (m) => m.blurb.paragraphs,
  hook_words: (m) => m.blurb.hookWords,
  avg_sentence_words: (m) => m.blurb.avgSentenceWords,
  reading_ease: (m) => m.blurb.readingEase,
  bullet_lines: (m) => m.blurb.bulletLines,
  emoji: (m) => m.blurb.emoji,
};
type Flag = (m: PackagingMetrics) => boolean;
const FLAGS: Record<string, { f: Flag; needsBlurb: boolean }> = {
  has_subtitle: { f: (m) => m.title.hasSubtitle, needsBlurb: false },
  series_in_title: { f: (m) => m.title.seriesInTitle, needsBlurb: false },
  has_question_hook: { f: (m) => m.blurb.questions > 0, needsBlurb: true },
  has_bullets: { f: (m) => m.blurb.bulletLines > 0, needsBlurb: true },
  call_to_action: { f: (m) => m.blurb.callToAction, needsBlurb: true },
  comp_titles: { f: (m) => m.blurb.compTitles, needsBlurb: true },
  prestige_claims: { f: (m) => m.blurb.prestigeClaims, needsBlurb: true },
};

export interface PackagingStats {
  topN: number;
  books: { top: number; rest: number; withBlurb: { top: number; rest: number } };
  numeric: Record<string, { top: Summary; rest: Summary }>;
  /** Share of books with the trait, among those where it could be measured. */
  flags: Record<string, { top: { known: number; share: number | null }; rest: { known: number; share: number | null } }>;
  tropes: { trope: string; top: number; rest: number; topShare: number | null; restShare: number | null }[];
}

export function packagingStats(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey)): PackagingStats {
  const all = bookPackaging(db, books);
  const top = all.filter((b) => b.listRank <= topN);
  const rest = all.filter((b) => b.listRank > topN);
  const blurbNumeric = new Set(['blurb_words', 'blurb_paragraphs', 'hook_words', 'avg_sentence_words', 'reading_ease', 'bullet_lines', 'emoji']);
  const pick = (rows: BookPackaging[], name: string) => rows.filter((r) => r.hasBlurb || !blurbNumeric.has(name)).map((r) => NUMERIC[name]!(r.metrics));
  const share = (rows: BookPackaging[], f: Flag, needsBlurb: boolean) => {
    const known = rows.filter((r) => r.hasBlurb || !needsBlurb);
    return { known: known.length, share: known.length ? Math.round((known.filter((r) => f(r.metrics)).length / known.length) * 1000) / 1000 : null };
  };
  const tropeNames = new Set(all.flatMap((r) => r.metrics.blurb.tropes));
  const withBlurb = (rows: BookPackaging[]) => rows.filter((r) => r.hasBlurb);
  return {
    topN,
    books: { top: top.length, rest: rest.length, withBlurb: { top: withBlurb(top).length, rest: withBlurb(rest).length } },
    numeric: Object.fromEntries(Object.keys(NUMERIC).map((k) => [k, { top: summarize(pick(top, k)), rest: summarize(pick(rest, k)) }])),
    flags: Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, { top: share(top, v.f, v.needsBlurb), rest: share(rest, v.f, v.needsBlurb) }])),
    tropes: [...tropeNames]
      .map((t) => {
        const a = withBlurb(top).filter((r) => r.metrics.blurb.tropes.includes(t)).length;
        const b = withBlurb(rest).filter((r) => r.metrics.blurb.tropes.includes(t)).length;
        const nt = withBlurb(top).length, nr = withBlurb(rest).length;
        return { trope: t, top: a, rest: b, topShare: nt ? Math.round((a / nt) * 1000) / 1000 : null, restShare: nr ? Math.round((b / nr) * 1000) / 1000 : null };
      })
      .sort((x, y) => y.top + y.rest - (x.top + x.rest) || x.trope.localeCompare(y.trope)),
  };
}

/** Reader voice from the on-page reviews of the category's captured books, top N against the rest. */
export function readerVoice(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey)): { topN: number; top: ReaderVoice; rest: ReaderVoice; all: ReaderVoice; caveat: string } {
  const voiceOf = (b: CategoryBook): ReaderVoice => {
    const rows = db
      .prepare(
        `SELECT t.body, t.meta FROM text_block t JOIN snapshot s ON s.id = t.snapshot_id
         WHERE s.asin = ? AND t.kind = 'review' AND s.captured_at = (SELECT max(captured_at) FROM snapshot y WHERE y.asin = s.asin)`,
      )
      .all(b.asin) as unknown as { body: string; meta: string | null }[];
    return readerVoiceOf(rows.map((r) => ({ stars: (r.meta ? (JSON.parse(r.meta) as { stars: number | null }).stars : null), title: null, body: r.body })));
  };
  const voices = books.filter((b) => b.captured).map((b) => ({ b, v: voiceOf(b) }));
  const top = mergeVoices(voices.filter((x) => x.b.listRank <= topN).map((x) => x.v));
  const rest = mergeVoices(voices.filter((x) => x.b.listRank > topN).map((x) => x.v));
  return {
    topN, top, rest, all: mergeVoices(voices.map((x) => x.v)),
    caveat: 'Based on the handful of reviews shown on each book page (usually the most helpful), not on every review.',
  };
}
