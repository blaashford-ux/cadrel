import { describe, expect, it } from 'vitest';
import { estimatePages, gutterForPages, TRIM_SIZES, trimByKey } from './trim';

describe('trim sizes', () => {
  it('starts at 5 × 8 and 5.5 × 8.5 and nothing is smaller', () => {
    expect(TRIM_SIZES[0].key).toBe('5x8');
    expect(TRIM_SIZES.some((t) => t.key === '5.5x8.5')).toBe(true);
    expect(TRIM_SIZES.every((t) => t.width >= 5 && t.height >= 7.81)).toBe(true);
  });
  it('has unique keys and falls back to 5.5 × 8.5', () => {
    expect(new Set(TRIM_SIZES.map((t) => t.key)).size).toBe(TRIM_SIZES.length);
    expect(trimByKey('nope')).toMatchObject({ width: 5.5, height: 8.5 });
    expect(trimByKey('6x9')).toMatchObject({ width: 6, height: 9 });
  });
});

describe('gutterForPages (KDP table)', () => {
  it.each([
    [24, 0.375], [150, 0.375], [151, 0.5], [300, 0.5], [301, 0.625], [500, 0.625], [501, 0.75], [700, 0.75], [701, 0.875], [828, 0.875]
  ])('%i pages → %f in', (pages, gutter) => expect(gutterForPages(pages)).toBe(gutter));
});

describe('estimatePages', () => {
  const base = { chapters: 30, trim: trimByKey('5.5x8.5'), fontSize: 11, outerMargin: 0.5, topMargin: 0.75, bottomMargin: 0.75 };
  it('is in the right ballpark for a novel (80k words ≈ 300–380 pages at 5.5×8.5)', () => {
    const p = estimatePages({ ...base, words: 80000 });
    expect(p).toBeGreaterThan(280);
    expect(p).toBeLessThan(420);
  });
  it('grows with words and shrinks with a bigger trim', () => {
    expect(estimatePages({ ...base, words: 120000 })).toBeGreaterThan(estimatePages({ ...base, words: 80000 }));
    expect(estimatePages({ ...base, words: 80000, trim: trimByKey('6x9') })).toBeLessThan(estimatePages({ ...base, words: 80000 }));
  });
});
