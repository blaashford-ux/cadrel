import { describe, expect, it } from 'vitest';
import { CATEGORY_MAX, normalizeCategory, STANDARD_TOPICS } from './comments';

describe('normalizeCategory', () => {
  it('trims, lower-cases and collapses whitespace', () => {
    expect(normalizeCategory('  Pacing \n Issues ')).toBe('pacing issues');
  });
  it('caps the length', () => {
    expect(normalizeCategory('x'.repeat(100))).toHaveLength(CATEGORY_MAX);
  });
  it('is undefined for empty or non-text input', () => {
    expect(normalizeCategory('   ')).toBeUndefined();
    expect(normalizeCategory(undefined)).toBeUndefined();
    expect(normalizeCategory(42)).toBeUndefined();
  });
  it('leaves the standard topics unchanged', () => {
    for (const t of STANDARD_TOPICS) expect(normalizeCategory(t)).toBe(t);
  });
});
