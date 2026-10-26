/**
 * Fonts for the ebook and print outputs. Three open-licence (SIL OFL 1.1) families ship inside the app so
 * they can be embedded in an EPUB or PDF anywhere; any other font installed on the computer can also be
 * used for the print PDF (Chromium embeds it) — but not embedded in an EPUB, whose licence we can't know.
 */

export interface BundledFont {
  family: string;
  /** Folder under assets/fonts. */
  slug: string;
  note: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'EB Garamond', slug: 'eb-garamond', note: 'A faithful Garamond revival: classic, elegant, slightly light. The default.' },
  { family: 'Crimson Pro', slug: 'crimson-pro', note: 'An old-style book face: compact and warm, good for long novels.' },
  { family: 'Libre Baskerville', slug: 'libre-baskerville', note: 'Baskerville: sturdy and open, with a larger x-height; reads well on screens.' }
];

export const DEFAULT_FONT = BUNDLED_FONTS[0].family;

export interface FontFile {
  /** File name inside the family's folder. */
  file: string;
  weight: 400 | 700;
  style: 'normal' | 'italic';
}

export const FONT_FILES: readonly FontFile[] = [
  { file: 'Regular.ttf', weight: 400, style: 'normal' },
  { file: 'Italic.ttf', weight: 400, style: 'italic' },
  { file: 'Bold.ttf', weight: 700, style: 'normal' },
  { file: 'BoldItalic.ttf', weight: 700, style: 'italic' }
];

export const bundledFont = (family: string): BundledFont | undefined => {
  const f = family.trim().toLowerCase();
  return BUNDLED_FONTS.find((b) => b.family.toLowerCase() === f);
};

/**
 * A font family name that is safe to put in CSS, XML and JSON: no control characters, quotes, backslashes
 * or angle brackets; trimmed; at most 100 characters. Falls back when nothing usable is left.
 */
export function cleanFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f"'\\<>{};}]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, 100);
  return v || fallback;
}

/** `"Family", fallbacks` for a font-family declaration. */
export function fontStack(family: string): string {
  const f = cleanFamily(family, DEFAULT_FONT);
  return f.toLowerCase() === 'eb garamond' ? '"EB Garamond", Garamond, serif' : `"${f}", serif`;
}

/** Name of the file for an embedded face, e.g. `crimson-pro-Italic.ttf`. */
export const embeddedFileName = (b: BundledFont, f: FontFile) => `${b.slug}-${f.file}`;

/** @font-face rules for a bundled family; `url` turns a file name into a CSS url() target. */
export function fontFaceCss(b: BundledFont, url: (file: FontFile) => string): string {
  return FONT_FILES.map(
    (f) =>
      `@font-face { font-family: "${b.family}"; font-style: ${f.style}; font-weight: ${f.weight}; font-display: block; src: url("${url(f)}") format("truetype"); }`
  ).join('\n');
}
