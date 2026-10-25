import { describe, expect, it } from 'vitest';
import { listInstalledFonts, tidyFontNames } from './fonts';

describe('tidyFontNames', () => {
  it('dedupes case-insensitively, strips quotes and hidden fonts, and sorts', () => {
    expect(tidyFontNames(['"Zapf"', 'arial', 'Arial', ' Times  New Roman ', '', '.SF Hidden', "'Georgia'"])).toEqual(['arial', 'Georgia', 'Times New Roman', 'Zapf']);
  });
});

describe('listInstalledFonts', () => {
  it('returns a (possibly empty) list of names and never throws', async () => {
    const l = await listInstalledFonts();
    expect(Array.isArray(l)).toBe(true);
    for (const n of l) expect(typeof n).toBe('string');
  }, 30_000);
});
