import { describe, expect, it } from 'vitest';
import { compareTexts, paragraphsOf, wordDiff } from '../src/index';

describe('paragraphs', () => {
  it('splits on blank lines and keeps where each one sits in the text', () => {
    const t = 'One two.\nStill one.\n\n\nThree.\n \nFour.\n';
    const ps = paragraphsOf(t);
    expect(ps.map((p) => p.text)).toEqual(['One two.\nStill one.', 'Three.', 'Four.']);
    for (const p of ps) expect(t.slice(p.start, p.end)).toBe(p.text);
    expect(paragraphsOf('')).toEqual([]);
    expect(paragraphsOf('  \n\n \n')).toEqual([]);
  });
});

describe('word differences', () => {
  it('shows what stayed, what was taken out and what was put in', () => {
    expect(wordDiff('She walked slowly home.', 'She crept home.')).toEqual([
      { op: 'same', text: 'She ' },
      { op: 'del', text: 'walked slowly' },
      { op: 'ins', text: 'crept' },
      { op: 'same', text: ' home.' }
    ]);
    expect(wordDiff('same', 'same')).toEqual([{ op: 'same', text: 'same' }]);
  });
});

describe('comparing two versions', () => {
  const A = 'Chapter One\n\nThe river ran cold.\n\nShe walked slowly to the river and stopped.\n\nIt was loud.\n\nThe end.';
  const B = 'Chapter One\n\nThe river ran cold.\n\nShe crept to the river and stopped.\n\nA new paragraph appears here, with nothing in common.\n\nIt was loud.\n\nThe end.';

  it('pairs a reworded paragraph as one changed row, and finds the added one', () => {
    const { rows, stats } = compareTexts(A, B);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'changed', 'added', 'same', 'same']);
    const changed = rows[2] as Extract<(typeof rows)[number], { kind: 'changed' }>;
    expect(changed.words.filter((w) => w.op !== 'same').map((w) => [w.op, w.text])).toEqual([['del', 'walked slowly'], ['ins', 'crept']]);
    expect(stats).toMatchObject({ same: 4, changed: 1, added: 1, removed: 0, wordsAdded: 10, wordsRemoved: 2 });
  });

  it('is the same text twice: every row the same', () => {
    const { rows, stats } = compareTexts(A, A);
    expect(rows.every((r) => r.kind === 'same')).toBe(true);
    expect(stats.changed + stats.added + stats.removed).toBe(0);
  });

  it('does not count a re-wrapped paragraph as a change', () => {
    const { stats } = compareTexts('One two three.\n\nFour.', 'One two\nthree.\n\nFour.');
    expect(stats).toMatchObject({ same: 2, changed: 0 });
  });

  it('shows a removed paragraph, and a moved one as removed and added', () => {
    expect(compareTexts('A.\n\nB.\n\nC.', 'A.\n\nC.').rows.map((r) => r.kind)).toEqual(['same', 'removed', 'same']);
    const moved = compareTexts('Alpha one.\n\nBeta two.\n\nGamma three.', 'Beta two.\n\nGamma three.\n\nAlpha one.');
    expect(moved.stats).toMatchObject({ same: 2, added: 1, removed: 1 });
  });

  it('handles empty sides', () => {
    expect(compareTexts('', 'Hello.\n\nWorld.').rows.map((r) => r.kind)).toEqual(['added', 'added']);
    expect(compareTexts('Hello.', '').rows.map((r) => r.kind)).toEqual(['removed']);
    expect(compareTexts('', '').rows).toEqual([]);
  });

  it('keeps the rows in order, with positions that point back into each text', () => {
    const { rows } = compareTexts(A, B);
    for (const r of rows) {
      if ('a' in r) expect(A.slice(r.a.start, r.a.end)).toBe(r.a.text);
      if ('b' in r) expect(B.slice(r.b.start, r.b.end)).toBe(r.b.text);
    }
  });

  it('works on a long manuscript quickly', () => {
    const para = (i: number) => `Paragraph ${i} has some words in it so that it is not tiny, and goes on a while.`;
    const a = Array.from({ length: 3000 }, (_, i) => para(i)).join('\n\n');
    const b = Array.from({ length: 3000 }, (_, i) => (i % 100 === 50 ? para(i) + ' Extra words.' : para(i))).join('\n\n');
    const t = Date.now();
    const { stats } = compareTexts(a, b);
    expect(stats).toMatchObject({ changed: 30, same: 2970, added: 0, removed: 0 });
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
