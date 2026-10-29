import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, addInjectedSuggestions, dismissInjectedSuggestion, getOutlineChoice, listInjectedSuggestions, outlineProfile, setOutlineChoice, suggestKeywordStrings, suggestKeywords } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-ol-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const OUTLINE = `# Outline

## Act one
A retired dragon keeper opens a bookshop in a small town. Her grumpy neighbour, a mapmaker, resents the noise.

## Act two
The dragon keeper and the mapmaker are forced proximity roommates after a flood. A slow burn begins. The dragon keeper hides a talking cat familiar.

## Act three
A heist at the lighthouse tower. The dragon keeper and the mapmaker finally say it.
`;

describe('outline profile', () => {
  it('finds the tropes and vocabulary a book carries, with how often', () => {
    const p = outlineProfile(OUTLINE);
    expect([...p.terms.keys()]).toEqual(expect.arrayContaining(['small town', 'heist', 'slow burn', 'familiar']));
    expect(p.words).toBeGreaterThan(50);
  });
});

describe('suggestions from an outline', () => {
  it('puts what the outline says first, and says so', () => {
    const ideas = suggestKeywords(lib.db, KEY, 5, { outline: OUTLINE });
    expect(ideas[0]!.outlineMentions).toBeGreaterThan(0);
    expect(ideas[0]!.reason).toMatch(/outline/);
    const text = ideas.map((i) => i.keyword).join(' | ');
    expect(text).toMatch(/small town|heist|slow burn|familiar|forced proximity|grumpy/);
  });

  it('holds back category phrases the outline does not support', () => {
    const plain = suggestKeywords(lib.db, KEY, 20);
    const withOutline = suggestKeywords(lib.db, KEY, 20, { outline: 'A quiet story about two accountants.' });
    for (const i of withOutline.filter((x) => x.source !== 'outline')) expect(i.outlineMentions).toBe(0);
    expect(plain.length).toBeGreaterThan(0);
    expect(withOutline.map((i) => i.keyword)).not.toEqual(plain.map((i) => i.keyword).slice(0, withOutline.length).reverse());
  });

  it('is unchanged without an outline, and keeps category words out of outline phrases', () => {
    expect(suggestKeywords(lib.db, KEY, 5, { outline: '  ' })).toEqual(suggestKeywords(lib.db, KEY, 5));
    for (const i of suggestKeywords(lib.db, KEY, 20, { outline: OUTLINE })) expect(i.keyword.split(' ')).not.toContain('fantasy');
    const strings = suggestKeywordStrings(lib.db, KEY, { outline: OUTLINE });
    expect(strings.every((s) => s.chars <= 50)).toBe(true);
  });

  it('remembers the outline chosen for a category', () => {
    expect(getOutlineChoice(lib.db, KEY)).toBeNull();
    setOutlineChoice(lib.db, KEY, { project: 'Novel', file: 'Outline.md' });
    expect(getOutlineChoice(lib.db, KEY)).toEqual({ project: 'Novel', file: 'Outline.md' });
    setOutlineChoice(lib.db, KEY, null);
    expect(getOutlineChoice(lib.db, KEY)).toBeNull();
  });
});

describe('suggestions sent in by an AI tool', () => {
  it('stores keywords and boxes with warnings, rejects what cannot fit, and replaces its own earlier set', () => {
    const r = addInjectedSuggestions(lib.db, KEY, {
      client: 'Claude',
      keywords: [{ keyword: 'Dragon  Keeper bookshop', reason: 'the heroine' }, { keyword: 'x'.repeat(90) }, { keyword: 'dragon keeper bookshop' }],
      strings: [{ keyword: 'dragon keeper bookshop cat' }, { keyword: 'best fantasy dragon keeper' }, { keyword: 'a'.repeat(51) }],
    });
    expect(r.saved.map((s) => s.keyword)).toEqual(['dragon keeper bookshop', 'dragon keeper bookshop cat', 'best fantasy dragon keeper']);
    expect(r.rejected.map((x) => x.error)).toEqual([expect.stringMatching(/80/), 'sent twice', expect.stringMatching(/50/)]);
    expect(r.saved[2]!.warnings.join(' ')).toMatch(/fantasy.*already read by Amazon/);
    expect(r.saved[2]!.warnings.join(' ')).toMatch(/best.*KDP does not allow/);
    expect(r.saved[2]!.warnings.join(' ')).toMatch(/dragon, keeper.*another box/);
    expect(listInjectedSuggestions(lib.db, KEY)).toHaveLength(3);

    addInjectedSuggestions(lib.db, KEY, { client: 'Claude', keywords: [{ keyword: 'lighthouse heist' }] });
    expect(listInjectedSuggestions(lib.db, KEY).filter((s) => s.kind === 'keyword').map((s) => s.keyword)).toEqual(['lighthouse heist']);
    expect(listInjectedSuggestions(lib.db, KEY).filter((s) => s.kind === 'string')).toHaveLength(2); // strings were not resent
  });

  it('keeps what the person dismissed dismissed', () => {
    addInjectedSuggestions(lib.db, KEY, { client: 'Claude', keywords: [{ keyword: 'lighthouse heist' }] });
    dismissInjectedSuggestion(lib.db, listInjectedSuggestions(lib.db, KEY)[0]!.id);
    expect(listInjectedSuggestions(lib.db, KEY)).toEqual([]);
    const again = addInjectedSuggestions(lib.db, KEY, { client: 'Claude', keywords: [{ keyword: 'lighthouse heist' }, { keyword: 'cat familiar' }] });
    expect(again.rejected).toEqual([{ keyword: 'lighthouse heist', error: 'the person dismissed this earlier' }]);
    expect(listInjectedSuggestions(lib.db, KEY).map((s) => s.keyword)).toEqual(['cat familiar']);
  });
});
