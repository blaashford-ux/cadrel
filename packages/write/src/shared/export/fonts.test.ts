import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, bundledFont, cleanFamily, DEFAULT_FONT, embeddedFileName, FONT_FILES, fontFaceCss, fontStack } from './fonts';

describe('fonts', () => {
  it('ships three families and defaults to EB Garamond', () => {
    expect(BUNDLED_FONTS.map((b) => b.family)).toEqual(['EB Garamond', 'Crimson Pro', 'Libre Baskerville']);
    expect(DEFAULT_FONT).toBe('EB Garamond');
  });

  it('finds bundled families regardless of case and spacing', () => {
    expect(bundledFont(' crimson pro ')?.slug).toBe('crimson-pro');
    expect(bundledFont('Garamond')).toBeUndefined();
  });

  it('cleans names so they cannot break out of CSS, XML or JSON', () => {
    expect(cleanFamily('Evil"; } body { x: y', 'F')).toBe('Evil body x: y');
    expect(cleanFamily('</style><script>', 'F')).toBe('/stylescript');
    expect(cleanFamily('  Times   New\nRoman ', 'F')).toBe('Times New Roman');
    expect(cleanFamily('', 'F')).toBe('F');
    expect(cleanFamily(42, 'F')).toBe('F');
    expect(cleanFamily('x'.repeat(500), 'F')).toHaveLength(100);
  });

  it('builds a stack with a serif fallback', () => {
    expect(fontStack('EB Garamond')).toBe('"EB Garamond", Garamond, serif');
    expect(fontStack('Palatino Linotype')).toBe('"Palatino Linotype", serif');
    expect(fontStack('a"b')).toBe('"ab", serif');
  });

  it('emits one @font-face per style (regular, italic, bold, bold italic)', () => {
    const b = bundledFont('Crimson Pro')!;
    const css = fontFaceCss(b, (f) => `fonts/${embeddedFileName(b, f)}`);
    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).toContain('url("fonts/crimson-pro-BoldItalic.ttf")');
    expect(css).toContain('font-weight: 700; ');
    expect(FONT_FILES).toHaveLength(4);
  });
});
