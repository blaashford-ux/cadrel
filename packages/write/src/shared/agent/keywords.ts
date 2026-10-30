/**
 * Checks a set of KDP backend keyword phrases against the platform's rules: 7 slots of at most 50 characters, no punctuation,
 * no word used twice across the slots, no word from the title, subtitle or categories, no claims or time-sensitive terms, and
 * (for male-targeted HaremLit, the default) no opposite-market terms.
 */
export const KEYWORD_LIMITS = { slots: 7, chars: 50 } as const;

/** Words KDP's keyword rules rule out: claims, prices and time-sensitive terms. Compared whole-word, case-insensitively. */
const BANNED = ['bestseller', 'bestsellers', 'bestselling', 'best', 'free', 'new', 'newest', 'award', 'awardwinning', 'sale', 'discount', 'cheap', 'deal', 'bargain', 'kindle', 'amazon', 'unlimited'];
/** Phrases that target the opposite market for male-targeted HaremLit. */
const OFF_MARKET = ['reverse harem', 'why choose', 'poly romance', 'strong heroine'];

export interface KeywordProblem {
  slot: number | null;
  problem: string;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);

export function checkKeywords(
  slots: string[],
  opts: { title?: string; subtitle?: string; categories?: string[]; maleTargeted?: boolean } = {}
): { ok: boolean; problems: KeywordProblem[]; slots: { slot: number; phrase: string; characters: number; bytes: number }[]; words_used: string[] } {
  const problems: KeywordProblem[] = [];
  const add = (slot: number | null, problem: string) => problems.push({ slot, problem });
  if (slots.length !== KEYWORD_LIMITS.slots) add(null, `There must be exactly ${KEYWORD_LIMITS.slots} phrases; there are ${slots.length}.`);
  const blocked = new Map<string, string>();
  for (const [from, text] of [['title', opts.title], ['subtitle', opts.subtitle], ...(opts.categories ?? []).map((c) => ['category', c] as const)] as [string, string | undefined][]) {
    for (const w of words(text ?? '')) if (!blocked.has(w)) blocked.set(w, from);
  }
  const seen = new Map<string, number>();
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const report = slots.map((phrase, i) => ({ slot: i + 1, phrase, characters: [...phrase].length, bytes: encoder ? encoder.encode(phrase).length : phrase.length }));
  slots.forEach((phrase, i) => {
    const slot = i + 1;
    if (!phrase.trim()) return add(slot, 'The slot is empty. A slightly longer, more specific phrase beats leaving it blank.');
    if (phrase !== phrase.trim() || /\s{2,}/.test(phrase)) add(slot, 'Has extra spaces; every character counts.');
    if (report[i].bytes > KEYWORD_LIMITS.chars) add(slot, `Is ${report[i].bytes} bytes (${report[i].characters} characters); the limit is ${KEYWORD_LIMITS.chars}.`);
    else if (report[i].characters > KEYWORD_LIMITS.chars) add(slot, `Is ${report[i].characters} characters; the limit is ${KEYWORD_LIMITS.chars}.`);
    if (/[,;:"“”‘’.!?()[\]{}|\\/]/.test(phrase)) add(slot, 'Has punctuation. Separate words with spaces only; punctuation wastes the character budget and indexes nothing.');
    const ws = words(phrase);
    if (ws.length < 2) add(slot, 'Is a single word. Use a 2 to 5 word phrase that names a specific search.');
    for (const w of ws) {
      if (seen.has(w) && seen.get(w) !== slot) add(slot, `The word "${w}" is already used in slot ${seen.get(w)}. A word counts once across all seven slots; reusing it wastes space.`);
      else if (!seen.has(w)) seen.set(w, slot);
      if (blocked.has(w)) add(slot, `The word "${w}" is already in the ${blocked.get(w)}, which Amazon indexes separately. Use the space for a different word.`);
      if (BANNED.includes(w)) add(slot, `The word "${w}" is a claim, price or time-sensitive term, which KDP's keyword rules don't allow.`);
    }
    if (opts.maleTargeted !== false) for (const p of OFF_MARKET) if (phrase.toLowerCase().includes(p)) add(slot, `"${p}" targets the opposite market from male-targeted HaremLit and would waste the slot.`);
    if (/[^\x00-\x7f]/.test(phrase)) add(slot, 'Has non-ASCII characters, which cost more than one byte each; the byte count above is the one that matters.');
  });
  return { ok: problems.length === 0, problems, slots: report, words_used: [...seen.keys()].sort() };
}
