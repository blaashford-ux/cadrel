import { fleschReadingEase } from './stats.js';

/** Tropes and genre markers worth counting in blurbs for fantasy; extend freely. */
export const TROPES: Record<string, RegExp> = {
  'found family': /\bfound family\b/i,
  'enemies to lovers': /\benemies[- ]to[- ]lovers\b/i,
  'slow burn': /\bslow[- ]burn\b/i,
  'grumpy/sunshine': /\bgrumpy\b|\bsunshine\b/i,
  'fake relationship': /\bfake (?:dating|relationship|marriage|engagement)\b/i,
  'chosen one': /\bchosen one\b/i,
  'magic school/academy': /\b(?:magic(?:al)? (?:school|academy|university)|academy|university)\b/i,
  dragons: /\bdragons?\b/i,
  'witch/wizard': /\bwitch(?:es)?\b|\bwizards?\b|\bsorcer\w+/i,
  'cozy setting': /\bcozy\b|\bcosy\b|\bcottage\b|\bbakery\b|\bbookshop\b|\bcafe\b|\bcafé\b|\binn\b|\btea\b/i,
  'small town': /\bsmall[- ]town\b|\bvillage\b/i,
  'talking animal/familiar': /\btalking (?:cat|dog|animal)\b|\bfamiliar\b|\bcat\b/i,
  'low stakes': /\blow[- ]stakes?\b/i,
  'closed door / no spice': /\bclosed[- ]door\b|\bno spice\b|\bsweet romance\b|\bclean romance\b/i,
  litrpg: /\blit ?rpg\b|\bgamelit\b|\bprogression\b|\bdungeon\b|\bsystem\b|\bleveling\b|\blevel up\b/i,
  'monster/dungeon': /\bmonsters?\b|\bdungeon\b/i,
  'villain/dark lord POV': /\bdark lord\b|\bvillain(?:ess)?\b|\bovertlord\b/i,
  'portal/isekai': /\bisekai\b|\bportal\b|\btransported\b|\breincarnat\w+/i,
  'humour claim': /\bhilarious\b|\bfunny\b|\bwitty\b|\bhumou?r\w*\b|\bcomedy\b|\blaugh\b|\bsatire\b/i,
};

const CTA = /\b(?:scroll up|grab your copy|get your copy|buy now|one[- ]click|download now|start reading|read now|order now|add to cart|pre-?order)\b/i;
const COMP = /\b(?:fans of|perfect for (?:fans|readers)|readers of|if you (?:like|love|enjoyed)|for fans of|in the vein of|will love|similar to)\b/i;
const CLAIMS = /\b(?:bestsell\w+|#\s?1\b|number one|award[- ]winning|usa today|new york times|amazon charts|million (?:copies|readers))\b/i;
const EMOJI = /[\p{Extended_Pictographic}]/gu;
const BULLET = /^\s*(?:[•·▪●◆★✓✔➤▶►*\-–]|\p{Extended_Pictographic})\s+\S/u;

export interface PackagingMetrics {
  title: {
    chars: number;
    words: number;
    /** A colon or dash splits the title into main and subtitle. */
    hasSubtitle: boolean;
    /** Series marker in the title text, such as "(Shifter Lords Book 12)". */
    seriesInTitle: boolean;
    hasNumber: boolean;
  };
  blurb: {
    chars: number;
    words: number;
    paragraphs: number;
    sentences: number;
    avgSentenceWords: number | null;
    /** Words in the first sentence, the hook. */
    hookWords: number | null;
    questions: number;
    exclamations: number;
    bulletLines: number;
    emoji: number;
    callToAction: boolean;
    compTitles: boolean;
    prestigeClaims: boolean;
    readingEase: number | null;
    tropes: string[];
  };
}

export function packagingOf(title: string | null, blurb: string | null): PackagingMetrics {
  const t = (title ?? '').trim();
  const b = (blurb ?? '').trim();
  const sentences = b.split(/(?<=[.!?…])["'”’)]*\s+/).map((s) => s.trim()).filter(Boolean);
  const words = (s: string) => (s.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
  const lines = b.split(/\n+/);
  return {
    title: {
      chars: t.length,
      words: words(t),
      hasSubtitle: /[:：]|\s[–—-]\s/.test(t),
      seriesInTitle: /\((?:[^)]*\bbook\b[^)]*|[^)]*#\s?\d+[^)]*)\)|\bbook\s+\d+\b/i.test(t),
      hasNumber: /\d/.test(t),
    },
    blurb: {
      chars: b.length,
      words: words(b),
      paragraphs: b ? b.split(/\n\s*\n/).filter((p) => p.trim()).length : 0,
      sentences: sentences.length,
      avgSentenceWords: sentences.length ? Math.round((words(b) / sentences.length) * 10) / 10 : null,
      hookWords: sentences[0] ? words(sentences[0]) : null,
      questions: (b.match(/\?/g) ?? []).length,
      exclamations: (b.match(/!/g) ?? []).length,
      bulletLines: lines.filter((l) => BULLET.test(l)).length,
      emoji: (b.match(EMOJI) ?? []).length,
      callToAction: CTA.test(b),
      compTitles: COMP.test(b),
      prestigeClaims: CLAIMS.test(b),
      readingEase: fleschReadingEase(b),
      tropes: Object.entries(TROPES).filter(([, re]) => re.test(`${t}\n${b}`)).map(([k]) => k),
    },
  };
}
