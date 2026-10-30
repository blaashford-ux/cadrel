import type { Db } from '../schema.js';
import { ELEMENTS, phrasesOf, stem } from '../analysis/communityInsights.js';
import { lexiconHits, looksLikeSearchTerm } from './lexicon.js';

/**
 * A book's outline, as keyword suggestions use it. The outline is the one thing that says what *this* book is about, so phrases it
 * supports are suggested ahead of what is merely common in the category, and category phrases the outline does not support are held back.
 *
 * Where outlines live is the host's business (Cadrel finds them in the person's projects), so this only describes how to ask for them.
 */
export interface OutlineRef {
  project: string;
  /** Path inside the project. */
  file: string;
  title: string;
  words: number;
}

export interface OutlineSource {
  /** The files that look like outlines, best guess first. */
  list(): Promise<OutlineRef[]>;
  /** The Markdown of one, or null when it is gone. */
  read(ref: { project: string; file: string }): Promise<string | null>;
}

/** The outline chosen for a category's keyword suggestions, remembered in the library. */
const choiceKey = (categoryKey: string) => `keyword_outline:${categoryKey}`;

export function getOutlineChoice(db: Db, categoryKey: string): { project: string; file: string } | null {
  const v = db.scalar<string>('SELECT value FROM kv WHERE key = ?', choiceKey(categoryKey));
  if (!v) return null;
  try {
    const o = JSON.parse(v) as { project?: unknown; file?: unknown };
    return typeof o.project === 'string' && typeof o.file === 'string' ? { project: o.project, file: o.file } : null;
  } catch {
    return null;
  }
}

export function setOutlineChoice(db: Db, categoryKey: string, ref: { project: string; file: string } | null): void {
  if (!ref) db.prepare('DELETE FROM kv WHERE key = ?').run(choiceKey(categoryKey));
  else db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(choiceKey(categoryKey), JSON.stringify({ project: String(ref.project), file: String(ref.file) }));
}

/** What an outline carries that a reader could search for. */
export interface OutlineProfile {
  /** Tropes and character types, by ELEMENTS name, with how many times the outline mentions them. */
  elements: Map<string, number>;
  /** Genre vocabulary (creatures, settings, jobs, moods), with mentions. */
  terms: Map<string, number>;
  /** Two-word phrases the outline repeats: a book's own recurring things ("lantern keeper"). Weaker evidence than the other two. */
  phrases: Map<string, number>;
  words: number;
}

const countMatches = (re: RegExp, text: string): number => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

export function outlineProfile(text: string, taken: Set<string> = new Set()): OutlineProfile {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`>#|]+/g, ' ');
  const elements = new Map<string, number>();
  for (const [name, re] of Object.entries(ELEMENTS)) {
    const n = countMatches(re, clean);
    if (n) elements.set(name, n);
  }
  const terms = new Map<string, number>();
  // lexiconHits answers per text; the outline is split into paragraphs so that "mentions" means paragraphs that carry the term
  const paras = clean.split(/\n{2,}|\n(?=\s*(?:[-*+]|\d+[.)])\s)/).map((p) => p.trim()).filter(Boolean);
  for (const [term, hit] of lexiconHits(paras)) terms.set(term, hit.size);
  // repeated two-word phrases made of content words
  const seen = new Map<string, number>();
  for (const p of paras) for (const ph of phrasesOf(p, taken)) if (ph.includes(' ') && looksLikeSearchTerm(ph)) seen.set(ph, (seen.get(ph) ?? 0) + 1);
  const phrases = new Map([...seen].filter(([, n]) => n >= 3));
  return { elements, terms, phrases, words: (clean.match(/\S+/g) ?? []).length };
}

/** True when the outline supports a phrase: it says the same words, in any order, plural or not, or carries the trope it names. */
export function outlineSupports(profile: OutlineProfile, phrase: string, element?: string): number {
  if (element && profile.elements.has(element)) return profile.elements.get(element)!;
  const want = phrase.toLowerCase().split(/\s+/).map(stem);
  for (const [term, n] of profile.terms) if (want.join(' ') === term.toLowerCase().split(/\s+/).map(stem).join(' ')) return n;
  for (const [ph, n] of profile.phrases) {
    const have = new Set(ph.split(' '));
    if (want.every((w) => have.has(w))) return n;
  }
  return 0;
}
