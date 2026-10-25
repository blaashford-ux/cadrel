/**
 * Straight → typographic quotes, deciding open/close from the surrounding characters. The result
 * has exactly the same length as the input, so callers can map it back onto text runs.
 */

const OPENING_CONTEXT = /[\s([{—–‘“-]/;
const ELISIONS = /^(em|til|tis|twas|twere|cause|bout|round|n|nother|kay|sup|s|ere|neath)(?![a-z])/i;

const isLetter = (c: string) => /[\p{L}\p{N}]/u.test(c);

export function smartenString(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '"' && ch !== "'") {
      out.push(ch);
      continue;
    }
    const prev = i > 0 ? out[i - 1] : '';
    const next = s[i + 1] ?? '';
    const afterOpener = prev === '' || OPENING_CONTEXT.test(prev);
    const nextStartsWord = next !== '' && !/\s/.test(next) && !/[.,;:!?)\]}—–]/.test(next);

    if (ch === '"') {
      out.push(afterOpener && nextStartsWord ? '“' : '”');
      continue;
    }
    // single quote / apostrophe
    if (prev !== '' && isLetter(prev) && next !== '' && isLetter(next)) {
      out.push('’'); // don't, o'clock
    } else if (afterOpener && next !== '' && (isLetter(next) || next === '"' || next === '“')) {
      const word = s.slice(i + 1, i + 12);
      const elided = ELISIONS.test(word) || /^\d\d(s|\b)/.test(word);
      out.push(elided ? '’' : '‘');
    } else {
      out.push('’'); // closing quote, possessive plural, dropped letters (talkin')
    }
  }
  return out.join('');
}

export const hasTypographicQuotes = (text: string) => /[‘’“”]/.test(text);
