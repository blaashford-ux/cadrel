import { DEFAULT_TRIM } from './model';

/** KDP paperback trim sizes (inches), portrait, no bleed. The smallest offered are 5 × 8 and 5.5 × 8.5. */
export interface TrimSize {
  key: string;
  label: string;
  width: number;
  height: number;
}

const t = (width: number, height: number): TrimSize => ({
  key: `${width}x${height}`,
  label: `${width} × ${height} in`,
  width,
  height
});

export const TRIM_SIZES: TrimSize[] = [
  t(5, 8),
  t(5.06, 7.81),
  t(5.25, 8),
  t(5.5, 8.5),
  t(6, 9),
  t(6.14, 9.21),
  t(6.69, 9.61),
  t(7, 10),
  t(7.44, 9.69),
  t(7.5, 9.25),
  t(8, 10),
  t(8.5, 11)
];

export function trimByKey(key: string): TrimSize {
  return TRIM_SIZES.find((s) => s.key === key) ?? TRIM_SIZES.find((s) => s.key === DEFAULT_TRIM)!;
}

export const KDP_MIN_PAGES = 24;
export const KDP_MAX_PAGES = 828;

/** KDP's inside (gutter) margin by total page count. */
export function gutterForPages(pages: number): number {
  if (pages <= 150) return 0.375;
  if (pages <= 300) return 0.5;
  if (pages <= 500) return 0.625;
  if (pages <= 700) return 0.75;
  return 0.875;
}

/** Rough page count for choosing a starting gutter before the real layout pass. */
export function estimatePages(opts: {
  words: number;
  chapters: number;
  trim: TrimSize;
  fontSize: number;
  outerMargin: number;
  topMargin: number;
  bottomMargin: number;
  frontPages?: number;
}): number {
  const textW = opts.trim.width - opts.outerMargin - 0.5;
  const textH = opts.trim.height - opts.topMargin - opts.bottomMargin;
  const wordsPerSqIn = 7.9 * (11 / opts.fontSize) ** 2; // ≈250 words on a 5.5×8.5 page at 11pt
  const bodyPages = opts.words / Math.max(1, textW * textH * wordsPerSqIn);
  // each chapter wastes about a page (partial last page + blank verso before a recto start)
  return Math.ceil(bodyPages + opts.chapters * 0.9 + (opts.frontPages ?? 6));
}
