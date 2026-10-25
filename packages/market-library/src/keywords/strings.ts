import type { Db } from '../schema.js';
import { stem } from '../analysis/communityInsights.js';
import { categoryKeywords } from './links.js';
import { autocompleteStatus, candidatePool, type KeywordIdea } from './ideas.js';
import { SUGGEST_SOURCES } from './suggest.js';
import { isFiller } from './lexicon.js';

/**
 * Seven keyword strings for a captured category, one for each of the boxes in KDP's Keywords section. Built from what the library
 * already holds (no request is made), following what KDP and the authors who test it agree on:
 *
 *  - Seven boxes of up to 50 characters. A box is a short phrase a reader would type, not a single word: Amazon matches each word in
 *    it, and the words together, against what a reader searches, so two or three related terms in one box cover several searches.
 *  - A word never needs to appear twice. Amazon already reads the title, subtitle, series, categories and blurb, and a word repeated
 *    in a second box adds nothing, so every word of the category (and of the chosen book's title and blurb) is left out, and no word
 *    is used in more than one string. That leaves room for more distinct terms.
 *  - Terms that belong together share a box: a trope with the tropes, characters or settings that appear in the same listed books
 *    ("found family cozy mystery" rather than three unrelated words), so each box is a believable search.
 *  - Filler is wasted space: stop words ("to", "and", "the") and generic words ("book", "novel", "ebook", "kindle") are dropped, and so
 *    are words KDP does not allow in keywords, which are claims and sales terms ("best", "bestselling", "free", "new", "award").
 *  - Terms readers ask for come first, then what the best-selling books of the category carry, then the phrases autocomplete
 *    already offers for the category's research. Author names and other brands are never suggested: the terms come from tropes and titles.
 */
export const KEYWORD_STRING_LIMIT = 50;
export const KEYWORD_STRING_COUNT = 7;
/** Longest string in words: past this a box stops reading as one search. */
const MAX_WORDS = 4;

export interface KeywordStringPart {
  phrase: string;
  /** Why this term is in the string, in words. */
  reason: string;
  source: KeywordIdea['source'] | 'autocomplete';
}

export interface KeywordString {
  keyword: string;
  /** Length in characters, against the 50 a KDP box takes. */
  chars: number;
  parts: KeywordStringPart[];
}

const FILLER = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'by', 'or', 'but', 'is', 'it', 'as', 'from', 'into', 'about']);
/** Generic words, and the ones KDP's guidelines do not allow in keywords (claims about quality or sales, price, newness, the store itself). */
const UNUSABLE = new Set([
  'book', 'novel', 'ebook', 'story', 'read', 'reading', 'series', 'volume', 'kindle', 'unlimited', 'amazon', 'kdp', 'paperback', 'audiobook',
  'everything', 'anything', 'something', 'nothing', 'finally', 'forever', 'always', 'never', 'again', 'still', 'only', 'just', 'every', 'first', 'last', 'one', 'two', 'life', 'world', 'tale', 'guide', 'mean', 'living',
  'best', 'bestseller', 'bestselling', 'top', 'popular', 'award', 'winning', 'free', 'new', 'sale', 'discount', 'cheap', 'deal', 'review',
]);

interface Item {
  words: string[];
  stems: string[];
  score: number;
  books: Set<number>;
  part: KeywordStringPart;
}

const wordsOfPhrase = (phrase: string): string[] => phrase.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u).filter((w) => w && !FILLER.has(w) && !UNUSABLE.has(w) && !UNUSABLE.has(stem(w)));

/** Phrases the autocomplete answers saved for this category's keyword research offer, as longer terms readers type. */
function autocompleteItems(db: Db, categoryKey: string, taken: Set<string>): Item[] {
  const seeds = categoryKeywords(db, categoryKey);
  if (!seeds.length) return [];
  const rows = db.prepare(`SELECT keyword, COUNT(DISTINCT source) AS sources, MIN(position) AS position FROM keyword_signal WHERE seed IN (${seeds.map(() => '?').join(',')}) GROUP BY keyword`).all(...seeds) as unknown as { keyword: string; sources: number; position: number }[];
  const out: Item[] = [];
  for (const r of rows) {
    const words = wordsOfPhrase(r.keyword).filter((w) => !taken.has(stem(w)));
    if (words.length < 2 || words.length > 4 || !words.every((w) => !isFiller(w))) continue;
    out.push({
      words, stems: words.map(stem), books: new Set(),
      score: r.sources * 6 + Math.max(0, 12 - r.position),
      part: { phrase: words.join(' '), reason: `offered by ${r.sources} of ${SUGGEST_SOURCES.length} autocomplete sources for your category's research`, source: 'autocomplete' },
    });
  }
  return out;
}

/** How alike two terms' listed books are, 0 to 1: terms that show up in the same books belong in the same box. */
function together(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const i of a) if (b.has(i)) both++;
  return both / (a.size + b.size - both);
}

/** Up to seven strings of at most 50 characters (fewer when the library has too few distinct terms), strongest first. */
export function suggestKeywordStrings(db: Db, categoryKey: string, o: { asin?: string; count?: number; maxChars?: number } = {}): KeywordString[] {
  const count = Math.max(1, Math.min(o.count ?? KEYWORD_STRING_COUNT, 20));
  const maxChars = Math.max(10, Math.min(o.maxChars ?? KEYWORD_STRING_LIMIT, 200));
  const pool = candidatePool(db, categoryKey, { asin: o.asin });

  const items: Item[] = [];
  const seen = new Set<string>();
  for (const c of pool.candidates) {
    const words = wordsOfPhrase(c.phrase);
    const key = words.map(stem).join(' ');
    if (!words.length || seen.has(key)) continue;
    seen.add(key);
    // a term autocomplete lists is one people type; one it answered empty is rarer than it looks
    const known = autocompleteStatus(db, c.phrase).autocomplete;
    items.push({ words, stems: words.map(stem), books: c.books, score: c.score * (known === 'listed' ? 1.25 : known === 'empty' ? 0.8 : 1), part: { phrase: words.join(' '), reason: c.reason, source: c.source } });
  }
  for (const it of autocompleteItems(db, categoryKey, pool.taken)) {
    const key = it.stems.join(' ');
    if (!seen.has(key)) { seen.add(key); items.push(it); }
  }
  items.sort((a, b) => b.score - a.score || a.part.phrase.localeCompare(b.part.phrase));

  const used = new Set<string>();
  const free = (it: Item) => it.stems.every((s) => !used.has(s));
  const out: KeywordString[] = [];
  while (out.length < count) {
    const anchor = items.find((it) => free(it) && it.words.join(' ').length <= maxChars);
    if (!anchor) break;
    const parts = [anchor];
    const words = [...anchor.words];
    for (const s of anchor.stems) used.add(s);
    for (;;) {
      // two or three words read as a search; more is a list
      if (words.length >= 3) break;
      const length = (extra: string[]) => [...words, ...extra].join(' ').length;
      const fits = items.filter((it) => free(it) && !parts.includes(it) && words.length + it.words.length <= MAX_WORDS && length(it.words) <= maxChars);
      if (!fits.length) break;
      // a partner that shares listed books with the string so far; unrelated terms are glued on only to avoid a one-word box
      const mates = parts.reduce((acc, p) => { for (const b of p.books) acc.add(b); return acc; }, new Set<number>());
      let best = fits[0]!;
      let bestTie = -1;
      for (const it of fits) {
        const t = together(mates, it.books);
        if (t > bestTie) { best = it; bestTie = t; }
      }
      if (bestTie <= 0 && words.length >= 2) break;
      parts.push(best);
      words.push(...best.words);
      for (const s of best.stems) used.add(s);
    }
    // a lone one-word term has no partner left: it is still a fair box, but the weakest
    const keyword = words.join(' ');
    out.push({ keyword, chars: keyword.length, parts: parts.map((p) => p.part) });
  }
  // one-word boxes last, so the strongest strings are the fullest
  return out.sort((a, b) => Number(a.keyword.includes(' ') === false) - Number(b.keyword.includes(' ') === false));
}
