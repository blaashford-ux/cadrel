import type { ChapterHeadingStyle } from './model';

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 1 → "One", 21 → "Twenty-One", 100 → "One Hundred", up to 999. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} Hundred${rest ? ` ${numberToWords(rest)}` : ''}`;
}

export interface ChapterHeading {
  /** The part before the colon ("Chapter Twelve"), or the whole title. */
  prefix: string;
  /** The italic subtitle after the colon, if the title has one. */
  rest: string | null;
  /** The heading as one plain string (TOC, nav, bookmarks). */
  plain: string;
}

const NUMBERED = /^\s*(chapter|part|book)\s+(\d{1,3})\s*(?:[:.–—-]\s*(.*))?$/i;

/**
 * 'verbatim' uses the heading exactly as written. 'numberWord' turns "Chapter 12: Coming Back"
 * into "Chapter Twelve" + italic "Coming Back"; headings that don't match stay verbatim.
 */
export function formatChapterHeading(title: string, style: ChapterHeadingStyle): ChapterHeading {
  const plainTitle = title.trim();
  if (style === 'numberWord') {
    const m = NUMBERED.exec(plainTitle);
    if (m) {
      const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const prefix = `${word} ${numberToWords(parseInt(m[2], 10))}`;
      const rest = m[3]?.trim() ? m[3].trim() : null;
      return { prefix, rest, plain: rest ? `${prefix}: ${rest}` : prefix };
    }
  }
  return { prefix: plainTitle, rest: null, plain: plainTitle };
}
