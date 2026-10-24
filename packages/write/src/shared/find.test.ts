import { describe, expect, it } from 'vitest';
import { compileFind, countByChapter, emptyFind, expandReplacement, findInText, matchAtOrAfter, matchBefore, replaceAllInText, type FindOptions } from './find';

const opts = (o: Partial<FindOptions>): FindOptions => ({ ...emptyFind(), ...o });
const idx = (text: string, o: Partial<FindOptions>) => findInText(text, compileFind(opts(o))).map((m) => m.index);

describe('compileFind / findInText', () => {
  it('an empty query matches nothing', () => {
    expect(compileFind(opts({}))).toBeNull();
    expect(idx('abc', { query: '' })).toEqual([]);
  });
  it('plain text is literal, case-insensitive by default', () => {
    expect(idx('Cat cat CAT c.t', { query: 'cat' })).toEqual([0, 4, 8]);
    expect(idx('a.b axb', { query: 'a.b' })).toEqual([0]);
    expect(idx('(x) [y] $z', { query: '(x)' })).toEqual([0]);
  });
  it('match case', () => {
    expect(idx('Cat cat CAT', { query: 'cat', caseSensitive: true })).toEqual([4]);
  });
  it('whole word, including accented letters and punctuation next to the word', () => {
    expect(idx('cat concat cat, cat. cats', { query: 'cat', wholeWord: true })).toEqual([0, 11, 16]);
    expect(idx('café cafés', { query: 'café', wholeWord: true })).toEqual([0]);
    expect(idx('don\'t', { query: 'don', wholeWord: true })).toEqual([0]);
  });
  it('regular expressions, with groups', () => {
    expect(idx('a1 b22 c333', { query: '[a-z]\\d+', regex: true })).toEqual([0, 3, 7]);
    expect(idx('Chapter 3, chapter 12', { query: 'chapter \\d+', regex: true })).toEqual([0, 11]);
  });
  it('regex + whole word wraps the whole pattern', () => {
    expect(idx('cat concatdog catdog', { query: 'cat|dog', regex: true, wholeWord: true })).toEqual([0]);
  });
  it('a bad regular expression reports an error and finds nothing', () => {
    const c = compileFind(opts({ query: '(', regex: true }));
    expect(c?.error).toBeTruthy();
    expect(findInText('(', c)).toEqual([]);
  });
  it('classic patterns that unicode mode rejects still work', () => {
    expect(idx('a-b', { query: 'a\\-b', regex: true })).toEqual([0]);
  });
  it('ignores empty matches instead of looping forever', () => {
    expect(idx('abc', { query: '^', regex: true })).toEqual([]);
    expect(idx('abc', { query: 'x*', regex: true })).toEqual([]);
  });
  it('is not stateful across calls', () => {
    const c = compileFind(opts({ query: 'a' }));
    expect(findInText('aaa', c)).toHaveLength(3);
    expect(findInText('aaa', c)).toHaveLength(3);
  });
});

describe('replacement', () => {
  it('literal replacement in plain mode ($ is just a dollar)', () => {
    expect(replaceAllInText('Dave met dave', opts({ query: 'dave' }), 'Mark $1')).toEqual({ text: 'Mark $1 met Mark $1', count: 2 });
  });
  it('regex replacement expands $1, $&, $<name>, $$', () => {
    const o = opts({ query: '(?<first>\\w+) (\\w+)', regex: true });
    expect(replaceAllInText('ada lovelace', o, '$2, $1 [$&] $<first> $$').text).toBe('lovelace, ada [ada lovelace] ada $');
  });
  it('unknown group references are left alone', () => {
    const m = /(a)/.exec('a')!;
    expect(expandReplacement(m, '$5 $1', true)).toBe('$5 a');
  });
  it('no matches → unchanged text and zero', () => {
    expect(replaceAllInText('abc', opts({ query: 'z' }), 'y')).toEqual({ text: 'abc', count: 0 });
  });
  it('replaces with an empty string (delete) and handles adjacent matches', () => {
    expect(replaceAllInText('aaaa', opts({ query: 'a' }), '').text).toBe('');
    expect(replaceAllInText('abab', opts({ query: 'ab' }), 'X').text).toBe('XX');
  });
  it('the replacement may contain the query without recursing', () => {
    expect(replaceAllInText('cat', opts({ query: 'cat' }), 'catcat').text).toBe('catcat');
  });
});

describe('navigation helpers', () => {
  const m = [{ index: 5 }, { index: 20 }, { index: 40 }];
  it('next wraps', () => {
    expect(matchAtOrAfter(m, 0)).toBe(0);
    expect(matchAtOrAfter(m, 20)).toBe(1);
    expect(matchAtOrAfter(m, 21)).toBe(2);
    expect(matchAtOrAfter(m, 41)).toBe(0);
    expect(matchAtOrAfter([], 3)).toBe(-1);
  });
  it('previous wraps', () => {
    expect(matchBefore(m, 40)).toBe(1);
    expect(matchBefore(m, 5)).toBe(2);
    expect(matchBefore(m, 100)).toBe(2);
    expect(matchBefore([], 3)).toBe(-1);
  });
});

describe('countByChapter', () => {
  it('counts per chapter and in total', () => {
    expect(countByChapter(['a a', 'b', 'a'], opts({ query: 'a' }))).toEqual({ counts: [2, 0, 1], total: 3 });
  });
  it('reports a bad pattern', () => {
    expect(countByChapter(['a'], opts({ query: '(', regex: true })).error).toBeTruthy();
  });
});
