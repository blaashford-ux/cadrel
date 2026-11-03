/**
 * Fonts for the ebook and print outputs. Open-licence (SIL OFL 1.1) families ship inside the app, each with
 * its own licence file, so they can be embedded in an EPUB or PDF anywhere. A book has a body font and a
 * chapter-heading font (empty = same as the body); any other font installed on the computer can also be
 * used for the print PDF (Chromium embeds it) — but not embedded in an EPUB, whose licence we can't know.
 */

export type FontRole = 'heading' | 'body';

export interface BundledFont {
  family: string;
  /** Folder under assets/fonts. */
  slug: string;
  note: string;
  /** Where the family is offered in the export settings. */
  roles: readonly FontRole[];
  /**
   * How the files are laid out in the folder. `static` (the default): Regular, Italic, Bold, BoldItalic.
   * `variable`: the upstream variable fonts, unmodified (Variable.ttf, VariableItalic.ttf) — used where the
   * licence names a Reserved Font Name, because cutting static instances would be a modification.
   * `regular`: one upstream file (Regular.ttf); bold and italic are synthesised by the renderer.
   */
  files?: 'static' | 'variable' | 'regular';
}

const BOTH: readonly FontRole[] = ['heading', 'body'];
const HEAD: readonly FontRole[] = ['heading'];
const BODY: readonly FontRole[] = ['body'];

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'EB Garamond', slug: 'eb-garamond', note: 'A faithful Garamond revival: classic, elegant, slightly light. The default.', roles: BODY },
  { family: 'Crimson Pro', slug: 'crimson-pro', note: 'An old-style book face: compact and warm, good for long novels.', roles: BOTH },
  { family: 'Libre Baskerville', slug: 'libre-baskerville', note: 'Baskerville: sturdy and open, with a larger x-height; reads well on screens.', roles: BODY },
  { family: 'Literata', slug: 'literata', note: 'Made for long reading on screens: sturdy, even colour.', roles: BODY },
  { family: 'Source Serif 4', slug: 'source-serif-4', note: 'A clear transitional serif with a large, friendly x-height.', roles: BODY },
  { family: 'Alegreya', slug: 'alegreya', note: 'A calligraphic serif with a lively rhythm; good for fiction.', roles: BOTH },
  { family: 'Spectral', slug: 'spectral', note: 'A sharp, refined serif designed for screens and print.', roles: BOTH },
  { family: 'Merriweather', slug: 'merriweather', note: 'A sturdy, open serif; very readable at small sizes.', roles: BODY, files: 'variable' },
  { family: 'Lora', slug: 'lora', note: 'A well-balanced contemporary serif with calligraphic roots.', roles: BODY, files: 'variable' },
  { family: 'Gelasio', slug: 'gelasio', note: 'A metric match for Georgia: familiar, sturdy.', roles: BODY },
  { family: 'Cormorant Garamond', slug: 'cormorant-garamond', note: 'A delicate display Garamond: elegant at large sizes.', roles: HEAD },
  { family: 'Playfair Display', slug: 'playfair-display', note: 'High-contrast display serif: dramatic headings.', roles: HEAD, files: 'variable' },
  { family: 'Marcellus', slug: 'marcellus', note: 'A flared Roman-inscription face: classical headings (one weight).', roles: HEAD, files: 'regular' },
  { family: 'Fraunces', slug: 'fraunces', note: 'A soft, old-style display serif with character.', roles: HEAD },
  { family: 'Bodoni Moda', slug: 'bodoni-moda', note: 'A fashion-magazine Bodoni: very high contrast.', roles: HEAD }
];

/** Body default, and the base of a book's look. */
export const DEFAULT_FONT = BUNDLED_FONTS[0].family;

export const bundledFontsFor = (role: FontRole): readonly BundledFont[] => BUNDLED_FONTS.filter((b) => b.roles.includes(role));

export interface FontFile {
  /** File name inside the family's folder. */
  file: string;
  /** A number, or a range for a variable font (or a single face standing in for the weights it lacks). */
  weight: number | string;
  style: 'normal' | 'italic';
}

export const FONT_FILES: readonly FontFile[] = [
  { file: 'Regular.ttf', weight: 400, style: 'normal' },
  { file: 'Italic.ttf', weight: 400, style: 'italic' },
  { file: 'Bold.ttf', weight: 700, style: 'normal' },
  { file: 'BoldItalic.ttf', weight: 700, style: 'italic' }
];

const VARIABLE_FILES: readonly FontFile[] = [
  { file: 'Variable.ttf', weight: '300 900', style: 'normal' },
  { file: 'VariableItalic.ttf', weight: '300 900', style: 'italic' }
];

const REGULAR_ONLY: readonly FontFile[] = [{ file: 'Regular.ttf', weight: '400 900', style: 'normal' }];

/** The font files a family ships, in the order they are embedded. */
export const fontFiles = (b: BundledFont): readonly FontFile[] =>
  b.files === 'variable' ? VARIABLE_FILES : b.files === 'regular' ? REGULAR_ONLY : FONT_FILES;

/** The file used for the preview line in the settings. */
export const previewFile = (b: BundledFont): string => fontFiles(b)[0].file;

/** The licence file every family folder carries. It travels with the fonts into the app and every EPUB. */
export const LICENCE_FILE = 'OFL.txt';

/** Where the licence sits inside an EPUB, next to the fonts. */
export const embeddedLicenceName = (b: BundledFont) => `${b.slug}-${LICENCE_FILE}`;

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
  return fontFiles(b)
    .map(
      (f) =>
        `@font-face { font-family: "${b.family}"; font-style: ${f.style}; font-weight: ${f.weight}; font-display: block; src: url("${url(f)}") format("truetype"); }`
    )
    .join('\n');
}

/** The family used for chapter headings: the heading font if one is set, otherwise the body font. */
export const headingFamily = (s: { font: string; headingFont?: string }): string => s.headingFont?.trim() || s.font;
