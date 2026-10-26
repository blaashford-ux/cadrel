/**
 * The search engine behind Find & Replace. Pure text in, matches out, so the same rules apply in the
 * formatted editor, the source editor and the whole-file replace.
 */

export interface FindOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const emptyFind = (): FindOptions => ({ query: '', caseSensitive: false, wholeWord: false, regex: false });

export interface FoundMatch {
  /** Offset in the searched text. */
  index: number;
  length: number;
  match: RegExpExecArray;
}

export type Compiled = { re: RegExp; error?: undefined } | { re?: undefined; error: string } | null;

const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the RegExp for the options, or null for an empty query, or an error message for a bad pattern. */
export function compileFind(o: FindOptions): Compiled {
  if (o.query === '') return null;
  const source = o.regex ? o.query : escapeRegex(o.query);
  const flags = 'g' + (o.caseSensitive ? '' : 'i');
  // Unicode mode first (so \p{L} and whole-word checks work for accented letters); some perfectly good
  // classic patterns are errors in unicode mode, so fall back to the plain flavour.
  const attempts: { pattern: string; flags: string }[] = [
    { pattern: o.wholeWord ? `${WORD_BEFORE}(?:${source})${WORD_AFTER}` : source, flags: flags + 'u' },
    { pattern: o.wholeWord ? `\\b(?:${source})\\b` : source, flags }
  ];
  let message = 'Invalid pattern';
  for (const a of attempts) {
    try {
      return { re: new RegExp(a.pattern, a.flags) };
    } catch (e) {
      message = e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '').replace(/^\/.*\/[a-z]*: /, '') : message;
    }
  }
  return { error: message };
}

/** Every non-empty match in `text`, in order (at most `limit`). */
export function findInText(text: string, compiled: Compiled, limit = 20000): FoundMatch[] {
  if (!compiled || !compiled.re) return [];
  const re = new RegExp(compiled.re.source, compiled.re.flags);
  const out: FoundMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0].length === 0) {
      re.lastIndex++; // an empty match (e.g. "^") has nothing to select or replace
      continue;
    }
    out.push({ index: m.index, length: m[0].length, match: m });
  }
  return out;
}

/** What a match is replaced with. In regex mode `$&`, `$1`…`$99`, `$<name>` and `$$` work like JavaScript's replace. */
export function expandReplacement(m: RegExpExecArray, replacement: string, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (whole, tok: string) => {
    if (tok === '$') return '$';
    if (tok === '&') return m[0];
    if (tok[0] === '<') return m.groups?.[tok.slice(1, -1)] ?? '';
    const n = Number(tok);
    if (n >= 1 && n < m.length) return m[n] ?? '';
    return whole;
  });
}

/** Replaces every match in `text`; returns the new text and how many were replaced. */
export function replaceAllInText(text: string, o: FindOptions, replacement: string): { text: string; count: number } {
  const found = findInText(text, compileFind(o));
  if (found.length === 0) return { text, count: 0 };
  let out = '';
  let pos = 0;
  for (const f of found) {
    out += text.slice(pos, f.index) + expandReplacement(f.match, replacement, o.regex);
    pos = f.index + f.length;
  }
  return { text: out + text.slice(pos), count: found.length };
}

/** Index of the first match starting at or after `offset`, wrapping to the first; -1 when there are none. */
export function matchAtOrAfter(matches: { index: number }[], offset: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.index >= offset);
  return i === -1 ? 0 : i;
}

/** Index of the last match starting before `offset`, wrapping to the last; -1 when there are none. */
export function matchBefore(matches: { index: number }[], offset: number): number {
  if (matches.length === 0) return -1;
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].index < offset) return i;
  return matches.length - 1;
}

export interface FindStatus {
  count: number;
  /** 1-based index of the highlighted match, 0 when none. */
  current: number;
  /** A bad regular expression, for display. */
  error?: string;
}

/** Match counts per chapter text, for "12 matches in 4 chapters". */
export function countByChapter(texts: readonly string[], o: FindOptions): { counts: number[]; total: number; error?: string } {
  const c = compileFind(o);
  if (c?.error) return { counts: texts.map(() => 0), total: 0, error: c.error };
  const counts = texts.map((t) => findInText(t, c).length);
  return { counts, total: counts.reduce((a, b) => a + b, 0) };
}
