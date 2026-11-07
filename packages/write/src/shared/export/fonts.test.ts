import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, bundledFont, bundledFontsFor, cleanFamily, DEFAULT_FONT, embeddedFileName, FONT_FILES, fontFaceCss, fontFiles, fontStack, headingFamily, LICENCE_FILE } from './fonts';

const FONTS_DIR = path.resolve(__dirname, '../../../assets/fonts');

describe('fonts', () => {
  it('defaults to EB Garamond and offers the agreed heading and body lists', () => {
    expect(DEFAULT_FONT).toBe('EB Garamond');
    expect(bundledFontsFor('heading').map((b) => b.family).sort()).toEqual(
      ['Alegreya', 'Bodoni Moda', 'Cormorant Garamond', 'Crimson Pro', 'Fraunces', 'Marcellus', 'Playfair Display', 'Spectral'].sort()
    );
    const body = bundledFontsFor('body').map((b) => b.family);
    for (const f of ['Literata', 'Source Serif 4', 'Crimson Pro', 'Alegreya', 'EB Garamond', 'Spectral', 'Merriweather', 'Lora', 'Gelasio']) expect(body).toContain(f);
  });

  it('every bundled family ships its files and its original OFL licence, and nothing else is licensed', () => {
    const slugs = new Set<string>();
    for (const b of BUNDLED_FONTS) {
      expect(slugs.has(b.slug), `${b.family} slug is unique`).toBe(false);
      slugs.add(b.slug);
      for (const f of fontFiles(b)) expect(existsSync(path.join(FONTS_DIR, b.slug, f.file)), `${b.family} ${f.file}`).toBe(true);
      const ofl = path.join(FONTS_DIR, b.slug, LICENCE_FILE);
      expect(existsSync(ofl), `${b.family} has ${LICENCE_FILE}`).toBe(true);
      const text = readFileSync(ofl, 'utf8');
      expect(text, `${b.family} is under the SIL OFL 1.1`).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
      expect(text.split('\n')[0], `${b.family} keeps its copyright notice`).toMatch(/^Copyright/i);
    }
  });

  it('a family whose licence names a Reserved Font Name is shipped unmodified (variable or single upstream file)', () => {
    for (const b of BUNDLED_FONTS) {
      const first = readFileSync(path.join(FONTS_DIR, b.slug, LICENCE_FILE), 'utf8').split('\n')[0];
      if (/Reserved Font Names?\s+"/.test(first)) expect(b.files, `${b.family} must not be a static instance`).toMatch(/variable|regular/);
    }
  });

  it('the heading font falls back to the body font when empty', () => {
    expect(headingFamily({ font: 'Lora', headingFont: '' })).toBe('Lora');
    expect(headingFamily({ font: 'Lora', headingFont: 'Marcellus' })).toBe('Marcellus');
    expect(headingFamily({ font: 'Lora' })).toBe('Lora');
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
