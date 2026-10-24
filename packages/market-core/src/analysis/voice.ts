export interface ReviewText {
  stars: number | null;
  title: string | null;
  body: string | null;
}

/** What readers talk about. A review "mentions" a theme if any pattern matches. */
export const THEMES: Record<string, RegExp> = {
  humor: /\b(?:funny|hilarious|humou?r\w*|laugh\w*|witty|comedic|chuckle\w*|snort\w*|lol)\b/i,
  pacing: /\b(?:pac(?:e|ing)|slow|fast[- ]paced|drag\w*|page[- ]turner|couldn'?t put (?:it )?down|boring)\b/i,
  characters: /\b(?:characters?|protagonist|\bmc\b|main character|cast|relationships?)\b/i,
  worldbuilding: /\b(?:world[- ]?building|magic system|the world|setting|lore)\b/i,
  romance: /\b(?:romance|romantic|love interest|spice|steamy|slow burn|ship)\b/i,
  plot: /\b(?:plot|story ?line|twists?|storytelling)\b/i,
  ending: /\b(?:ending|cliffhanger|finale|conclusion)\b/i,
  'writing/editing': /\b(?:typos?|grammar|editing|proofread\w*|writing style|prose|well[- ]written|poorly written)\b/i,
  series: /\b(?:series|sequel|next book|book (?:two|2|three|3|one|1)|can'?t wait for)\b/i,
  'cozy/comfort': /\b(?:cozy|cosy|comfort\w*|wholesome|heartwarming|feel[- ]good|warm|sweet)\b/i,
  length: /\b(?:too short|too long|novella|short read|long read|length)\b/i,
  value: /\b(?:price|worth|free|money|overpriced|bargain)\b/i,
};

const STOP = new Set(
  'a an and are as at be but by for from had has have he her him his i if in into is it its me my no not of on or our she so that the their them then there they this to was we were what when which who will with you your would could just very really also than too can all one book books read reading story'.split(' '),
);

export interface ThemeStat {
  mentions: number;
  /** Share of reviews that mention it. */
  rate: number;
  /** Of the mentions, those in 4-5 star reviews, in 1-2 star reviews. */
  inPositive: number;
  inNegative: number;
}

export interface ReaderVoice {
  reviews: number;
  withText: number;
  stars: { positive: number; mixed: number; negative: number; unknown: number };
  themes: Record<string, ThemeStat>;
  topPhrases: { phrase: string; count: number }[];
}

export function readerVoiceOf(reviews: ReviewText[]): ReaderVoice {
  const texts = reviews.map((r) => ({ stars: r.stars, text: [r.title, r.body].filter(Boolean).join('. ') })).filter((r) => r.text.trim());
  const stars = { positive: 0, mixed: 0, negative: 0, unknown: 0 };
  const themes: Record<string, ThemeStat> = Object.fromEntries(Object.keys(THEMES).map((k) => [k, { mentions: 0, rate: 0, inPositive: 0, inNegative: 0 }]));
  const grams = new Map<string, number>();
  for (const r of texts) {
    if (r.stars == null) stars.unknown++;
    else if (r.stars >= 4) stars.positive++;
    else if (r.stars <= 2) stars.negative++;
    else stars.mixed++;
    for (const [name, re] of Object.entries(THEMES)) {
      if (!re.test(r.text)) continue;
      const t = themes[name]!;
      t.mentions++;
      if (r.stars != null && r.stars >= 4) t.inPositive++;
      if (r.stars != null && r.stars <= 2) t.inNegative++;
    }
    // each phrase counts once per review so one gushing reviewer cannot dominate
    const w = (r.text.toLowerCase().match(/[a-z']+/g) ?? []);
    const seen = new Set<string>();
    for (let i = 0; i + 1 < w.length; i++) {
      if (STOP.has(w[i]!) || STOP.has(w[i + 1]!) || w[i]!.length < 3 || w[i + 1]!.length < 3) continue;
      seen.add(`${w[i]} ${w[i + 1]}`);
    }
    for (const g of seen) grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  for (const t of Object.values(themes)) t.rate = texts.length ? Math.round((t.mentions / texts.length) * 1000) / 1000 : 0;
  return {
    reviews: reviews.length,
    withText: texts.length,
    stars,
    themes,
    topPhrases: [...grams.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([phrase, count]) => ({ phrase, count })),
  };
}

/** Pool several books' voices into one (counts add; rates are recomputed). */
export function mergeVoices(vs: ReaderVoice[]): ReaderVoice {
  const out: ReaderVoice = {
    reviews: 0, withText: 0, stars: { positive: 0, mixed: 0, negative: 0, unknown: 0 },
    themes: Object.fromEntries(Object.keys(THEMES).map((k) => [k, { mentions: 0, rate: 0, inPositive: 0, inNegative: 0 }])), topPhrases: [],
  };
  const phr = new Map<string, number>();
  for (const v of vs) {
    out.reviews += v.reviews;
    out.withText += v.withText;
    for (const k of Object.keys(out.stars) as (keyof typeof out.stars)[]) out.stars[k] += v.stars[k];
    for (const [k, t] of Object.entries(v.themes)) {
      const o = out.themes[k]!;
      o.mentions += t.mentions; o.inPositive += t.inPositive; o.inNegative += t.inNegative;
    }
    for (const p of v.topPhrases) phr.set(p.phrase, (phr.get(p.phrase) ?? 0) + p.count);
  }
  for (const t of Object.values(out.themes)) t.rate = out.withText ? Math.round((t.mentions / out.withText) * 1000) / 1000 : 0;
  out.topPhrases = [...phr.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([phrase, count]) => ({ phrase, count }));
  return out;
}
