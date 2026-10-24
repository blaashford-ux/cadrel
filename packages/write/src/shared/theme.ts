/**
 * Custom colours for the light and dark themes. The user picks five base colours per theme; everything else the app
 * paints (panels, buttons, hover, muted text, soft accent tints…) is worked out from them, so a theme stays coherent
 * whichever colours are chosen. Light and dark are stored separately and apply by the system / app colour scheme.
 */

export type Scheme = 'light' | 'dark';

export const THEME_KEYS = ['shell', 'bg', 'fg', 'accent', 'gold'] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];
export type ThemeColors = Record<ThemeKey, string>;
/** Only the colours the user changed; the rest stay as the app ships them. */
export type ThemeCustom = { light?: Partial<ThemeColors>; dark?: Partial<ThemeColors> };

export const THEME_LABELS: Record<ThemeKey, { label: string; hint: string }> = {
  shell: { label: 'Window', hint: 'Behind the editor: the sidebar and the title bar.' },
  bg: { label: 'Page', hint: 'The editor card and the dialogs.' },
  fg: { label: 'Text', hint: 'The main text. Muted and faint text are shades between this and the page.' },
  accent: { label: 'Accent', hint: 'Buttons, links, the cursor, selected items.' },
  gold: { label: 'Highlight', hint: 'Warnings, unsaved marks, inline code.' }
};

/** How the app ships. */
export const DEFAULT_THEMES: Record<Scheme, ThemeColors> = {
  light: { shell: '#ece9f8', bg: '#fcfbff', fg: '#1f1a38', accent: '#0e7490', gold: '#b7791f' },
  dark: { shell: '#1a1430', bg: '#221b3e', fg: '#ece9f9', accent: '#51c6e0', gold: '#f2c14e' }
};

export const PRESETS: { id: string; name: string; scheme: Scheme; colors: ThemeColors }[] = [
  { id: 'paper', name: 'Paper', scheme: 'light', colors: { shell: '#e9e4d8', bg: '#fbf8f0', fg: '#2b2620', accent: '#8a4b2a', gold: '#a86b00' } },
  { id: 'mist', name: 'Mist', scheme: 'light', colors: { shell: '#e3e9ee', bg: '#f8fafc', fg: '#1d2a35', accent: '#1f6f9f', gold: '#a8741a' } },
  { id: 'sage', name: 'Sage', scheme: 'light', colors: { shell: '#e2eadf', bg: '#f7faf5', fg: '#1e2b22', accent: '#2f7a4f', gold: '#9a6b12' } },
  { id: 'midnight', name: 'Midnight', scheme: 'dark', colors: { shell: '#0d1117', bg: '#161b22', fg: '#e6edf3', accent: '#58a6ff', gold: '#e3b341' } },
  { id: 'ember', name: 'Ember', scheme: 'dark', colors: { shell: '#1b1512', bg: '#262019', fg: '#f0e6d8', accent: '#e8935a', gold: '#f2c14e' } },
  { id: 'forest', name: 'Forest', scheme: 'dark', colors: { shell: '#101a15', bg: '#18251d', fg: '#e3efe6', accent: '#5fcf92', gold: '#e5c15d' } },
  { id: 'black', name: 'Black', scheme: 'dark', colors: { shell: '#000000', bg: '#0b0b0d', fg: '#e8e8ec', accent: '#6ab7ff', gold: '#f2c14e' } }
];

// ---- colour maths ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/** "#abc" and "abc" are accepted as typed; anything else is null. Always returns lower-case "#rrggbb". */
export function normalizeHex(v: string): string | null {
  const t = v.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) return '#' + [...t].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(t) ? '#' + t : null;
}

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) => '#' + c.map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('');

/** `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = toRgb(a), y = toRgb(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

const rgba = (hex: string, alpha: number) => `rgba(${toRgb(hex).join(', ')}, ${alpha})`;

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (none) to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white text, whichever reads better on `hex`. */
const inkOn = (hex: string) => (contrast(hex, '#ffffff') >= contrast(hex, '#0d1117') ? '#ffffff' : '#0d1117');

// ---- the theme ------------------------------------------------------------------------------

/** Every CSS variable the theme sets, worked out from the five base colours. */
export function themeVars(c: ThemeColors, scheme: Scheme): Record<string, string> {
  const dark = scheme === 'dark';
  return {
    '--shell': c.shell,
    '--bg': c.bg,
    '--panel': mix(c.bg, c.fg, 0.04),
    '--raised': mix(c.bg, c.fg, 0.09),
    '--hover': mix(c.bg, c.fg, 0.14),
    '--selected': rgba(c.accent, dark ? 0.17 : 0.13),
    '--fg': c.fg,
    '--muted': mix(c.bg, c.fg, 0.64),
    '--faint': mix(c.bg, c.fg, 0.4),
    '--accent': c.accent,
    '--accent-ink': inkOn(c.accent),
    '--accent-soft': rgba(c.accent, dark ? 0.14 : 0.12),
    '--gold': c.gold,
    '--gold-soft': rgba(c.gold, dark ? 0.15 : 0.14),
    '--focus': c.accent,
    '--warn-bg': rgba(c.gold, 0.14),
    '--info-bg': rgba(c.accent, dark ? 0.13 : 0.11),
    '--dirty': c.gold,
    '--brand': `linear-gradient(100deg, ${c.accent} 0%, ${c.gold} 100%)`
  };
}

const effective = (scheme: Scheme, custom: ThemeCustom): ThemeColors => ({ ...DEFAULT_THEMES[scheme], ...(custom[scheme] ?? {}) });

/** True when the user changed anything in this scheme. */
export const isCustomised = (custom: ThemeCustom | undefined, scheme: Scheme): boolean => Object.keys(custom?.[scheme] ?? {}).length > 0;

/** The stylesheet that applies the custom themes; empty when nothing was changed, so the shipped look is untouched. */
export function themeCss(custom: ThemeCustom | undefined): string {
  if (!custom) return '';
  const block = (scheme: Scheme, indent: string) =>
    isCustomised(custom, scheme)
      ? `${indent}:root {\n${Object.entries(themeVars(effective(scheme, custom), scheme))
          .map(([k, v]) => `${indent}  ${k}: ${v};`)
          .join('\n')}\n${indent}}\n`
      : '';
  // Each block is limited to its own scheme: an unwrapped light block would also win in dark mode (it comes later in the cascade).
  const light = block('light', '  ');
  const dark = block('dark', '  ');
  return (light ? `@media not (prefers-color-scheme: dark) {\n${light}}\n` : '') + (dark ? `@media (prefers-color-scheme: dark) {\n${dark}}\n` : '');
}

/** The colours of one scheme as they are now (shipped values with the user's changes on top). */
export const colorsFor = (scheme: Scheme, custom: ThemeCustom | undefined): ThemeColors => effective(scheme, custom ?? {});

/** Defensive parse of stored settings: only known keys with valid colours survive, and unchanged values are dropped. */
export function sanitizeThemeCustom(v: unknown): ThemeCustom | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: ThemeCustom = {};
  for (const scheme of ['light', 'dark'] as const) {
    const raw = (v as Record<string, unknown>)[scheme];
    if (!raw || typeof raw !== 'object') continue;
    const part: Partial<ThemeColors> = {};
    for (const k of THEME_KEYS) {
      const val = (raw as Record<string, unknown>)[k];
      if (isHex(val) && val.toLowerCase() !== DEFAULT_THEMES[scheme][k]) part[k] = val.toLowerCase();
    }
    if (Object.keys(part).length) out[scheme] = part;
  }
  return out.light || out.dark ? out : undefined;
}
