import type { Db } from '../schema.js';
import { categoryBooks } from '../category.js';
import { ELEMENTS, communityInsights, phrasesOf, stem } from '../analysis/communityInsights.js';
import { listCommunitySources } from '../community.js';
import { normalizeKeyword } from './suggest.js';
import { lexiconHits, looksLikeSearchTerm } from './lexicon.js';

/**
 * Phrases worth searching on the Keywords tab for a captured category, from what is already in the library: the tropes the listed
 * books' blurbs carry, words that recur in their titles and, where Reddit text is synced, the tropes readers ask for. No request is made.
 *
 * A keyword that repeats a word Amazon already indexes from the book's other metadata earns nothing, so a suggestion never contains a
 * word of the category (name and path) or, when a book is chosen, of that book's title, subtitle and blurb: those words are cut out of
 * the phrase, and a phrase with nothing left is dropped. Some tropes are also tied to one readership (reverse harem / why choose is
 * women's romance), and are not suggested for a category whose name or subreddits say it is aimed at men.
 */
export interface KeywordIdea {
  keyword: string;
  /** Why it is suggested, in words. */
  reason: string;
  source: 'readers' | 'blurbs' | 'titles';
  /**
   * What the stored autocomplete answers say about the phrase, without asking anyone: 'listed' when a source has suggested it,
   * 'empty' when every source asked answered with no suggestions (too specific for autocomplete), 'unknown' when it has not been looked up.
   */
  autocomplete: 'listed' | 'empty' | 'unknown';
  /** Day (YYYY-MM-DD) of the newest stored answer behind 'empty'; null otherwise. */
  checkedAt: string | null;
}

/** What is already stored about a phrase in the autocomplete cache. Makes no request. */
export function autocompleteStatus(db: Db, keyword: string): Pick<KeywordIdea, 'autocomplete' | 'checkedAt'> {
  if (db.prepare('SELECT 1 FROM keyword_signal WHERE keyword = ? LIMIT 1').get(keyword)) return { autocomplete: 'listed', checkedAt: null };
  const asked = db.prepare('SELECT MAX(fetched_at) AS at FROM keyword_lookup WHERE seed = ? AND stopped IS NULL').get(keyword) as { at: string | null };
  return asked.at ? { autocomplete: 'empty', checkedAt: asked.at.slice(0, 10) } : { autocomplete: 'unknown', checkedAt: null };
}

/** What to type for an element: its first alternative, in the words a reader would search with. */
const PHRASE: Record<string, string> = {
  'grumpy / sunshine': 'grumpy sunshine',
  'LGBTQ+': 'lgbtq',
  'happy ending (HEA/HFN)': 'happy ending',
  'food / cooking': 'cooking',
  'humour claim': 'humor',
  'talking animal/familiar': 'talking animal',
  'magic school/academy': 'magic academy',
  'witch/wizard': 'witch',
  'monster/dungeon': 'dungeon',
  'portal/isekai': 'isekai',
  'villain/dark lord POV': 'villain pov',
  'closed door / sweet': 'closed door',
  'spicy / steamy': 'spicy',
  'first-person POV': 'first person',
  'worldbuilding / magic system': 'magic system',
  'reverse harem / why choose': 'why choose',
  'grimdark / dark fantasy': 'grimdark',
  'cozy setting': '',
  'Kindle Unlimited': '',
  audiobook: '',
};
export const searchPhraseOf = (element: string): string => (element in PHRASE ? PHRASE[element]! : element.split(/\s*\/\s*|\s*\(/)[0]!.toLowerCase().trim());

const SKIP_PARENT = /^(?:any department|kindle store|kindle ebooks|ebooks|books|kindle|science fiction & fantasy)$/i;

/** The category as a reader would search it: "Cozy" under Fantasy is "cozy fantasy". */
export function categoryPhrase(name: string | null, path: { name: string }[]): string {
  const clean = (s: string) => s.replace(/&/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const n = clean(name ?? '');
  if (!n) return '';
  const parent = [...path].reverse().find((p) => p.name && !SKIP_PARENT.test(p.name.trim()));
  return n.split(' ').length === 1 && parent && !clean(parent.name).includes(n) ? `${n} ${clean(parent.name)}` : n;
}

/** Elements that belong to women's romance, so they are not suggested to a category aimed at men. */
const WOMENS_ROMANCE = new Set(['reverse harem / why choose']);
const MALE_AUDIENCE = /\bmen'?s\b|\bfor men\b|\bmale\b|\blit ?rpg\b|\bprogression\b|harem|\bmilitary\b|\bwesterns?\b/;

const wordsOf = (text: string): string[] => (text.toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) ?? []).map(stem).filter((w) => w.length >= 3);

/** What the category (and, if given, the user's book) already says to Amazon: the stems a keyword should not repeat. */
function metadataWords(db: Db, catName: string | null, path: { name: string }[], asin?: string): Set<string> {
  const out = new Set(wordsOf([catName ?? '', ...path.map((p) => p.name)].join(' ')));
  if (asin) {
    const snap = db.prepare('SELECT s.title, s.description, (SELECT t.body FROM text_block t WHERE t.snapshot_id = s.id AND t.kind = \'blurb\' LIMIT 1) AS blurb FROM snapshot s WHERE s.asin = ? ORDER BY s.captured_at DESC LIMIT 1').get(asin) as { title: string | null; description: string | null; blurb: string | null } | undefined;
    // Amazon's title field carries the subtitle
    if (snap) for (const w of wordsOf(`${snap.title ?? ''} ${snap.blurb ?? snap.description ?? ''}`)) out.add(w);
  }
  return out;
}

/** The category's readership as far as its name and linked subreddits say: 'men', or null when nothing says. */
function audienceOf(db: Db, categoryKey: string, name: string | null, path: { name: string }[]): 'men' | null {
  const text = [name ?? '', ...path.map((p) => p.name), ...listCommunitySources(db, categoryKey).map((s) => s.subreddit)].join(' ').toLowerCase().replace(/[_-]+/g, ' ');
  return MALE_AUDIENCE.test(text) ? 'men' : null;
}

/** The phrase without the words already in the metadata, or '' when too little is left to search. */
function distinctive(phrase: string, taken: Set<string>): string {
  const kept = phrase.split(/\s+/).filter((w) => !taken.has(stem(w.toLowerCase())));
  const out = kept.join(' ');
  return kept.length === 0 || (kept.length === 1 && out.length < 4) ? '' : out;
}

/** A phrase the library gives a reason to search for, with the listed books (by index) whose text carries it. */
export interface Candidate {
  phrase: string;
  score: number;
  reason: string;
  source: KeywordIdea['source'];
  books: Set<number>;
}

/** Everything suggestions are built from: the candidate phrases, best first, and the words Amazon already reads. */
export interface CandidatePool {
  candidates: Candidate[];
  taken: Set<string>;
  bookCount: number;
}

export function candidatePool(db: Db, categoryKey: string, o: { asin?: string } = {}): CandidatePool {
  const cat = db.prepare('SELECT name, path FROM category WHERE key = ?').get(categoryKey) as { name: string | null; path: string | null } | undefined;
  if (!cat) throw new Error('unknown category');
  let path: { name: string }[] = [];
  try { path = JSON.parse(cat.path ?? '[]'); } catch { /* no path */ }
  const taken = metadataWords(db, cat.name, path, o.asin);
  const audience = audienceOf(db, categoryKey, cat.name, path);
  const books = categoryBooks(db, categoryKey);
  const blurbOf = db.prepare(`SELECT t.body FROM text_block t JOIN snapshot s ON s.id = t.snapshot_id WHERE s.asin = ? AND t.kind = 'blurb' ORDER BY s.captured_at DESC LIMIT 1`);
  const texts = books.map((b) => `${b.title ?? ''}\n${(blurbOf.get(b.asin) as { body: string } | undefined)?.body ?? ''}`);
  const stems = texts.map((t) => new Set(wordsOf(t)));
  const withElement = (element: string) => new Set(texts.flatMap((t, i) => (ELEMENTS[element]?.test(t) ? [i] : [])));
  const candidates: Candidate[] = [];

  // what readers ask for, where Reddit text is synced
  const community = communityInsights(db, categoryKey);
  for (const e of community.elements.filter((x) => x.asked > 0)) {
    const phrase = distinctive(searchPhraseOf(e.element), taken);
    if (phrase && !(audience === 'men' && WOMENS_ROMANCE.has(e.element))) candidates.push({ phrase, score: 100 + e.asked * 3 + (e.signal === 'underserved' ? 20 : 0), reason: `named in ${e.asked} reader request${e.asked === 1 ? '' : 's'}${e.signal === 'underserved' ? ', and few listed books carry it' : ''}`, source: 'readers', books: withElement(e.element) });
  }
  // what the listed books carry
  for (const [element, re] of Object.entries(ELEMENTS)) {
    const n = texts.filter((t) => re.test(t)).length;
    const phrase = distinctive(searchPhraseOf(element), taken);
    if (n >= 3 && phrase && !(audience === 'men' && WOMENS_ROMANCE.has(element))) candidates.push({ phrase, score: n, reason: `in ${n} of the ${books.length} listed books' titles and blurbs`, source: 'blurbs', books: withElement(element) });
  }
  // words that recur in the listed titles
  const df = new Map<string, number>();
  for (const b of books) for (const ph of phrasesOf(b.title ?? '', taken)) if (ph.includes(' ')) df.set(ph, (df.get(ph) ?? 0) + 1);
  for (const [ph, n] of df) {
    const phrase = distinctive(ph, taken);
    if (n >= 3 && phrase && looksLikeSearchTerm(phrase)) candidates.push({ phrase, score: n, reason: `in ${n} listed titles`, source: 'titles', books: new Set(stems.flatMap((st, i) => (ph.split(' ').every((w) => st.has(w)) ? [i] : []))) });
  }
  // search terms from the vocabulary of the genre that the listed books' titles and blurbs carry (creatures, settings, jobs, moods)
  const covered = new Set(candidates.map((c) => c.phrase));
  for (const [term, hit] of lexiconHits(texts)) {
    const phrase = distinctive(term, taken);
    if (hit.size < 2 || !phrase || covered.has(phrase) || (audience === 'men' && /\bwhy choose\b/.test(phrase))) continue;
    covered.add(phrase);
    candidates.push({ phrase, score: hit.size, reason: `in ${hit.size} of the ${books.length} listed books' titles and blurbs`, source: 'blurbs', books: hit });
  }
  candidates.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
  return { candidates, taken, bookCount: books.length };
}

export function suggestKeywords(db: Db, categoryKey: string, count = 5, o: { asin?: string } = {}): KeywordIdea[] {
  const { candidates } = candidatePool(db, categoryKey, o);
  const out: KeywordIdea[] = [];
  const have = new Set<string>();
  for (const c of candidates) {
    if (out.length >= count) break;
    const k = normalizeKeyword(c.phrase);
    if (!k || k.length > 80 || have.has(k)) continue;
    have.add(k);
    out.push({ keyword: k, reason: c.reason, source: c.source, ...autocompleteStatus(db, k) });
  }
  return out;
}
