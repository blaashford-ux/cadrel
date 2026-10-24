/**
 * Cadrel's look, from one place. MDEdit's theme model (five colours per scheme, everything else worked out from them) is
 * the model, with Cadrel's own slate-and-stone defaults (set in Write's theme.ts). The shell paints its own page from it
 * and hands the same colours to Write (which already speaks this model) and Market (which has its own variable names).
 */
import { colorsFor, contrast, mix, themeVars, type Scheme, type ThemeColors, type ThemeCustom } from '@cadrel/write/src/shared/theme';

export type ThemeSource = 'system' | 'light' | 'dark';
export const isThemeSource = (v: unknown): v is ThemeSource => v === 'system' || v === 'light' || v === 'dark';

/** Wrapped so the light block never applies in dark mode (an unwrapped one comes later in the cascade and would win). */
const forScheme = (scheme: Scheme, css: string) => (scheme === 'dark' ? `@media (prefers-color-scheme: dark) {\n${css}}\n` : `@media not (prefers-color-scheme: dark) {\n${css}}\n`);

/** Declarations on `:root:root`, which beats the page's own `:root` whatever order the sheets arrive in. */
const block = (vars: Record<string, string>) => `  :root:root {\n${Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`).join('\n')}\n  }\n`;

/** The shell's own page: the full variable set for both schemes, the user's colours on top of the shipped ones. */
export function shellCss(custom: ThemeCustom | undefined): string {
  return (['light', 'dark'] as const).map((s) => forScheme(s, block(themeVars(colorsFor(s, custom), s)))).join('');
}

/** Market names its colours differently (and has no card-on-window layering of its own); this maps the same five colours onto its names. */
export function marketVars(c: ThemeColors): Record<string, string> {
  return {
    '--bg': c.shell,
    '--panel': c.bg,
    '--surface': c.bg,
    '--ink': c.fg,
    '--muted': mix(c.bg, c.fg, 0.64),
    '--line': mix(c.bg, c.fg, 0.16),
    '--grid': mix(c.bg, c.fg, 0.12),
    '--accent': c.accent
  };
}

export function marketCss(custom: ThemeCustom | undefined): string {
  return (['light', 'dark'] as const).map((s) => forScheme(s, block(marketVars(colorsFor(s, custom))))).join('');
}

/** For tests and the settings page: is this pair of colours readable? */
export const readable = (fg: string, bg: string) => contrast(fg, bg) >= 4.5;
