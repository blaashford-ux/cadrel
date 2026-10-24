import { describe, expect, it } from 'vitest';
import { colorsFor, contrast, DEFAULT_THEMES, isCustomised, mix, normalizeHex, PRESETS, sanitizeThemeCustom, themeCss, themeVars } from './theme';

describe('colour helpers', () => {
  it('normalises typed hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex(' 1f1a38 ')).toBe('#1f1a38');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
  });
  it('mixes and measures contrast', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});

describe('themeVars', () => {
  it('sets every colour variable the app uses from the base colours', () => {
    const v = themeVars(DEFAULT_THEMES.light, 'light');
    for (const k of ['--shell', '--bg', '--panel', '--raised', '--hover', '--fg', '--muted', '--faint', '--accent', '--accent-ink', '--gold', '--selected', '--brand']) expect(v[k], k).toBeTruthy();
    expect(v['--shell']).toBe('#ece9f8');
  });
  it('derives surfaces close to the shipped palette', () => {
    // The shipped light --raised is #e8e4f6; a derived one should be within a few steps of it.
    const raised = themeVars(DEFAULT_THEMES.light, 'light')['--raised'];
    expect(contrast(raised, '#e8e4f6')).toBeLessThan(1.05);
  });
  it('picks readable text for the accent', () => {
    expect(themeVars({ ...DEFAULT_THEMES.light, accent: '#fee567' }, 'light')['--accent-ink']).toBe('#0d1117');
    expect(themeVars({ ...DEFAULT_THEMES.light, accent: '#1b2a6b' }, 'light')['--accent-ink']).toBe('#ffffff');
  });
  it('keeps every preset readable', () => {
    for (const p of PRESETS) expect(contrast(p.colors.fg, p.colors.bg), p.name).toBeGreaterThan(7);
  });
});

describe('themeCss', () => {
  it('is empty until something is changed', () => {
    expect(themeCss(undefined)).toBe('');
    expect(themeCss({})).toBe('');
  });
  it('styles light and dark independently', () => {
    const css = themeCss({ light: { bg: '#ffffff' } });
    expect(css).toContain('--bg: #ffffff');
    expect(css).toMatch(/^@media not \(prefers-color-scheme: dark\)/); // never leaks into dark mode
    expect(css).not.toMatch(/@media \(prefers-color-scheme: dark\)/);
    const both = themeCss({ light: { bg: '#ffffff' }, dark: { bg: '#000000' } });
    expect(both).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*--bg: #000000/);
    expect(both.indexOf('#ffffff')).toBeLessThan(both.indexOf('@media (prefers-color-scheme: dark)'));
  });
  it('fills unchanged colours from the shipped theme', () => {
    expect(colorsFor('dark', { dark: { accent: '#ff0000' } })).toEqual({ ...DEFAULT_THEMES.dark, accent: '#ff0000' });
    expect(isCustomised({ dark: { accent: '#ff0000' } }, 'light')).toBe(false);
  });
});

describe('sanitizeThemeCustom', () => {
  it('keeps valid changes and drops everything else', () => {
    expect(sanitizeThemeCustom({ light: { bg: '#FFFFFF', fg: 'nope', bogus: '#000000' }, dark: 5, extra: 1 })).toEqual({ light: { bg: '#ffffff' } });
  });
  it('drops values equal to the shipped colour, and bad input', () => {
    expect(sanitizeThemeCustom({ light: { bg: DEFAULT_THEMES.light.bg } })).toBeUndefined();
    expect(sanitizeThemeCustom(null)).toBeUndefined();
    expect(sanitizeThemeCustom('x')).toBeUndefined();
  });
});
