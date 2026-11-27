/**
 * The Cover Designer's fonts: a short bundled starter set (all SIL Open Font License; see docs/PROVENANCE.md) with ready pairings, and a list of
 * common system fonts that are offered when the computer has them. A design names a font by family; a missing one is shown with a stand-in.
 */
export interface StarterFont {
  family: string;
  /** What it suits, in a few words. */
  feel: string;
  group: 'display' | 'serif' | 'sans' | 'script';
  /** Files under the app's assets folder, by weight. */
  files: { 400: string; 700?: string };
}

export const STARTER_FONTS: readonly StarterFont[] = [
  { family: 'Cinzel', feel: 'Classical capitals: fantasy, historical', group: 'display', files: { 400: 'cover-fonts/cinzel/latin-400-normal.woff2', 700: 'cover-fonts/cinzel/latin-700-normal.woff2' } },
  { family: 'Bebas Neue', feel: 'Tall and bold: thriller, sci-fi', group: 'display', files: { 400: 'cover-fonts/bebas-neue/latin-400-normal.woff2' } },
  { family: 'Anton', feel: 'Heavy and tight: action, crime', group: 'display', files: { 400: 'cover-fonts/anton/latin-400-normal.woff2' } },
  { family: 'Abril Fatface', feel: 'Fat, high contrast: romance, drama', group: 'display', files: { 400: 'cover-fonts/abril-fatface/latin-400-normal.woff2' } },
  { family: 'Oswald', feel: 'Condensed and plain: bylines, taglines', group: 'sans', files: { 400: 'cover-fonts/oswald/latin-400-normal.woff2', 700: 'cover-fonts/oswald/latin-700-normal.woff2' } },
  { family: 'Montserrat', feel: 'Clean and modern: contemporary, series lines', group: 'sans', files: { 400: 'cover-fonts/montserrat/latin-400-normal.woff2', 700: 'cover-fonts/montserrat/latin-700-normal.woff2' } },
  { family: 'Great Vibes', feel: 'Flowing script: romance', group: 'script', files: { 400: 'cover-fonts/great-vibes/latin-400-normal.woff2' } },
  { family: 'Marcellus', feel: 'Elegant and light: myth, literary', group: 'serif', files: { 400: 'fonts/marcellus/Regular.ttf' } },
  { family: 'Bodoni Moda', feel: 'Sharp high-contrast serif: fashion, romance', group: 'serif', files: { 400: 'fonts/bodoni-moda/Regular.ttf', 700: 'fonts/bodoni-moda/Bold.ttf' } }
];

/** Fonts that are likely to be on a computer; offered only when the computer reports having them. */
export const SYSTEM_CANDIDATES: readonly string[] = [
  'Georgia', 'Garamond', 'Palatino Linotype', 'Book Antiqua', 'Times New Roman', 'Baskerville', 'Didot', 'Cambria', 'Constantia',
  'Arial', 'Arial Narrow', 'Helvetica Neue', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Segoe UI', 'Century Gothic', 'Gill Sans', 'Futura',
  'Impact', 'Rockwell', 'Copperplate', 'Papyrus', 'Brush Script MT', 'Lucida Handwriting', 'Courier New', 'Consolas'
];

/** A title with the line that goes under it, ready to use together. */
export interface Pairing {
  id: string;
  name: string;
  title: { font: string; weight: 400 | 700; upper: boolean; tracking: number };
  byline: { font: string; weight: 400 | 700; upper: boolean; tracking: number };
}
export const PAIRINGS: readonly Pairing[] = [
  { id: 'epic', name: 'Epic fantasy', title: { font: 'Cinzel', weight: 700, upper: true, tracking: 0.04 }, byline: { font: 'Cinzel', weight: 400, upper: true, tracking: 0.3 } },
  { id: 'thriller', name: 'Thriller', title: { font: 'Bebas Neue', weight: 400, upper: true, tracking: 0.06 }, byline: { font: 'Oswald', weight: 400, upper: true, tracking: 0.35 } },
  { id: 'action', name: 'Action', title: { font: 'Anton', weight: 400, upper: true, tracking: 0.02 }, byline: { font: 'Montserrat', weight: 700, upper: true, tracking: 0.25 } },
  { id: 'romance', name: 'Romance', title: { font: 'Abril Fatface', weight: 400, upper: false, tracking: 0 }, byline: { font: 'Montserrat', weight: 400, upper: true, tracking: 0.3 } },
  { id: 'script', name: 'Script and serif', title: { font: 'Great Vibes', weight: 400, upper: false, tracking: 0 }, byline: { font: 'Marcellus', weight: 400, upper: true, tracking: 0.3 } },
  { id: 'literary', name: 'Literary', title: { font: 'Bodoni Moda', weight: 700, upper: false, tracking: 0 }, byline: { font: 'Marcellus', weight: 400, upper: true, tracking: 0.25 } },
  { id: 'modern', name: 'Modern', title: { font: 'Montserrat', weight: 700, upper: true, tracking: 0.08 }, byline: { font: 'Montserrat', weight: 400, upper: true, tracking: 0.4 } }
];

export const starterOf = (family: string): StarterFont | undefined => STARTER_FONTS.find((f) => f.family === family);
export const isStarter = (family: string): boolean => !!starterOf(family);
/** The CSS font stack for a family: the family itself, then a stand-in of the same sort. */
export function fontStack(family: string): string {
  const s = starterOf(family);
  const fallback = s ? (s.group === 'serif' ? 'Georgia, serif' : s.group === 'script' ? 'cursive' : 'Arial, sans-serif') : /mono|courier|consolas/i.test(family) ? 'monospace' : /times|georgia|garamond|palat|book|didot|bask|camb|const|rockw/i.test(family) ? 'Georgia, serif' : 'Arial, sans-serif';
  return `'${family.replace(/'/g, '')}', ${fallback}`;
}
