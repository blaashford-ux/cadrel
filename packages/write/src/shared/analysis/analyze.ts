import {
  IRREGULAR_PARTICIPLES,
  NOT_ADVERBS,
  NOT_NAMES,
  PLAIN_TAGS,
  SPEECH_VERBS,
  STATE_PARTICIPLES,
  STOPWORDS,
  THOUGHT_VERBS,
  TITLES,
  WORD_GROUPS
} from './lexicon';
import { detectSingleQuotes, mean, median, norm, parseChapter, splitSentences, stdev, syllables, wordsOf, type Paragraph, type ParsedChapter } from './text';

export interface ChapterInput {
  title: string;
  raw: string;
  isPreamble?: boolean;
}

export interface AnalyzeOptions {
  /** Called between units of work so the UI stays responsive. */
  yieldNow?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

export interface Example {
  chapter: number;
  text: string;
  /** The part of `text` to emphasise. */
  mark?: string;
}

export interface Counted {
  word: string;
  count: number;
}

export interface Readability {
  words: number;
  sentences: number;
  fleschEase: number;
  fleschKincaid: number;
  gunningFog: number;
  colemanLiau: number;
  ari: number;
  smog: number | null;
  /** The mean of the grade-level formulas. */
  grade: number;
}

export interface ChapterStats {
  title: string;
  words: number;
  paragraphs: number;
  sentences: number;
  dialogueWords: number;
  dialogueParagraphs: number;
  avgSentence: number;
  grade: number;
  adverbs: number;
  passive: number;
  filler: number;
  crutch: number;
  /** Narration pronoun counts (outside quotes and thoughts). */
  pov: { first: number; second: number; third: number };
  person: 'first' | 'second' | 'third' | 'unclear';
  /** Share of "was/were/had/did" vs "is/are/am/has/does" among narration, 0..1 present. */
  presentShare: number;
  tenseMarkers: number;
  scenes: number;
  /** Characters whose thoughts/feelings the narration reports, by count. */
  povCharacters: { name: string; count: number }[];
}

export interface Character {
  name: string;
  aliases: string[];
  mentions: number;
  chapters: number;
  firstChapter: number;
  perChapter: number[];
  /** Lines of dialogue attributed to them ("… ," Mara said). */
  speaks: number;
}

export interface Analysis {
  chapters: ChapterStats[];
  totals: {
    words: number;
    uniqueWords: number;
    letters: number;
    syllables: number;
    paragraphs: number;
    sentences: number;
    scenes: number;
    dialogueWords: number;
    narrationWords: number;
    dialogueParagraphs: number;
    oneLineParagraphs: number;
    longestParagraph: number;
  };
  readability: Readability;
  sentenceLengths: { average: number; median: number; deviation: number; longest: (Example & { words: number })[]; histogram: { label: string; count: number }[] };
  paragraphLengths: { average: number; histogram: { label: string; count: number }[] };
  dialogue: { speechTags: Counted[]; plainShare: number; tagTotal: number; tagAdverbs: Counted[] };
  openers: { top: Counted[]; pronounShare: number; runs: Example[]; runCount: number };
  repeatedWords: { word: string; count: number; per10k: number; chapters: number }[];
  echoes: { word: string; count: number; example: Example }[];
  bigrams: { phrase: string; count: number; chapters: number }[];
  trigrams: { phrase: string; count: number; chapters: number }[];
  adverbs: { total: number; per1000: number; top: Counted[]; distinct: number };
  passive: { count: number; share: number; withAgent: number; examples: Example[] };
  wordGroups: { title: string; hint: string; total: number; per1000: number; items: { label: string; count: number; per1000: number }[] }[];
  that: { total: number; per1000: number; optional: number; examples: Example[] };
  pov: {
    first: number;
    second: number;
    third: number;
    person: 'first' | 'second' | 'third' | 'unclear';
    tense: 'past' | 'present' | 'mixed' | 'unclear';
    presentShare: number;
    personFlags: string[];
    tenseFlags: string[];
    headHopping: string[];
    slips: Example[];
    tenseSlips: Example[];
  };
  characters: Character[];
  punctuation: { label: string; count: number; per1000: number }[];
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const FIRST = new Set(['i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves']);
const SECOND = new Set(['you', 'your', 'yours', 'yourself', 'yourselves']);
const THIRD = new Set(['he', 'she', 'him', 'her', 'his', 'hers', 'himself', 'herself', 'they', 'them', 'their', 'theirs', 'themselves']);

function personOf(token: string): 'first' | 'second' | 'third' | null {
  if (FIRST.has(token) || /^(?:i|we)'/.test(token)) return 'first';
  if (SECOND.has(token) || token.startsWith("you'")) return 'second';
  if (THIRD.has(token) || /^(?:he|she|they)'/.test(token)) return 'third';
  return null;
}

const PAST_MARK = new Set(['was', 'were', 'had', 'did', "wasn't", "weren't", "hadn't", "didn't"]);
const PRESENT_MARK = new Set(['is', 'are', 'am', 'has', 'does', "isn't", "aren't", "hasn't", "doesn't"]);

const PASSIVE_RE = new RegExp(
  `\\b(?:am|is|are|was|were|be|been|being)\\s+(?:(?:not|never|also|still|always|already|often|just|even|now|then|soon|once)\\s+)?(?:[a-z]+ly\\s+)?` +
    `((?:[a-z]{2,}ed)|${IRREGULAR_PARTICIPLES.join('|')})\\b(\\s+(?:by|to)\\b)?`,
  'g'
);

const THAT_OPTIONAL_RE =
  /\b(?:said|says|knew|know|knows|thought|think|felt|feel|realized|realised|noticed|saw|see|hoped|hope|wished|wish|believed|believe|decided|wondered|understood|figured|guessed|suspected|imagined|remembered|forgot|heard|found|saying|wanted)\s+that\s+(?:he|she|they|it|i|we|you|the|a|an|his|her|their|there|this|these|those|my|our)\b/g;

const SPEECH_RE = new RegExp(`\\b(${SPEECH_VERBS.join('|')})\\b`, 'g');
const TAG_ADVERB_RE = new RegExp(`\\b(${SPEECH_VERBS.join('|')})\\s+(?:[a-z]+\\s+)?([a-z]{4,}ly)\\b`, 'g');

const histogram = (values: number[], edges: number[], unit = ''): { label: string; count: number }[] => {
  const out = edges.map((lo, i) => ({
    label: i === edges.length - 1 ? `${lo}+${unit}` : edges[i + 1] - 1 === lo ? `${lo}${unit}` : `${lo}–${edges[i + 1] - 1}${unit}`,
    count: 0
  }));
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i--;
    out[i].count++;
  }
  return out;
};

const top = (map: Map<string, number>, n: number): Counted[] =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));

const evenly = <T>(items: T[], n: number): T[] => {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
};

interface Sent {
  chapter: number;
  scene: number;
  text: string;
  /** Original-case tokens. */
  tokens: string[];
  lower: string[];
  inDialogueOnly: boolean;
}

function readabilityOf(words: number, sentences: number, syl: number, letters: number, complex: number): Readability {
  const W = Math.max(1, words);
  const S = Math.max(1, sentences);
  const fleschEase = 206.835 - 1.015 * (W / S) - 84.6 * (syl / W);
  const fleschKincaid = 0.39 * (W / S) + 11.8 * (syl / W) - 15.59;
  const gunningFog = 0.4 * (W / S + (100 * complex) / W);
  const colemanLiau = 0.0588 * ((letters / W) * 100) - 0.296 * ((S / W) * 100) - 15.8;
  const ari = 4.71 * (letters / W) + 0.5 * (W / S) - 21.43;
  const smog = sentences >= 30 ? 1.043 * Math.sqrt((complex * 30) / S) + 3.1291 : null;
  const grades = [fleschKincaid, gunningFog, colemanLiau, ari, ...(smog === null ? [] : [smog])];
  return { words, sentences, fleschEase, fleschKincaid, gunningFog, colemanLiau, ari, smog, grade: mean(grades) };
}

const snip = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Everything the report needs, worked out from the chapters' Markdown. Async only so the UI can breathe between chapters. */
export async function analyzeManuscript(inputs: ChapterInput[], opts: AnalyzeOptions = {}): Promise<Analysis> {
  const yieldNow = opts.yieldNow ?? defaultYield;
  const single = detectSingleQuotes(inputs);
  const parsed: ParsedChapter[] = [];
  const steps = inputs.length * 2 + 3;
  let done = 0;
  const tick = async () => {
    opts.onProgress?.(++done, steps);
    await yieldNow();
  };

  // ---- pass 1: paragraphs, sentences, tokens ------------------------------------------------
  const sents: Sent[] = [];
  const chapterParas: number[] = [];
  for (let ci = 0; ci < inputs.length; ci++) {
    const ch = parseChapter(inputs[ci].raw, inputs[ci].title, single);
    parsed.push(ch);
    for (const p of ch.paragraphs) {
      for (const text of splitSentences(p.text)) {
        const tokens = wordsOf(text);
        if (!tokens.length) continue;
        sents.push({ chapter: ci, scene: p.scene, text, tokens, lower: tokens.map(norm), inDialogueOnly: false });
      }
    }
    chapterParas.push(ch.paragraphs.length);
    await tick();
  }

  // ---- names ---------------------------------------------------------------------------------
  const capMid = new Map<string, number>();
  const capStart = new Map<string, number>();
  const lowerCount = new Map<string, number>();
  let allTokens = 0;
  for (const s of sents) {
    allTokens += s.tokens.length;
    s.tokens.forEach((t, i) => {
      if (/^\p{Lu}/u.test(t)) {
        if (t.length < 2 || t === t.toUpperCase()) return;
        const key = t.replace(/['’]s$/i, '');
        (i === 0 ? capStart : capMid).set(key, ((i === 0 ? capStart : capMid).get(key) ?? 0) + 1);
      } else lowerCount.set(s.lower[i], (lowerCount.get(s.lower[i]) ?? 0) + 1);
    });
  }
  const minMentions = allTokens < 5000 ? 2 : 3;
  const nameTokens = new Set<string>();
  for (const key of new Set([...capMid.keys(), ...capStart.keys()])) {
    const lk = norm(key);
    if (NOT_NAMES.has(lk) || TITLES.has(lk) || STOPWORDS.has(lk) || key.includes('-')) continue;
    const mid = capMid.get(key) ?? 0;
    const start = capStart.get(key) ?? 0;
    const lc = lowerCount.get(lk) ?? 0;
    const total = mid + start;
    if (total < minMentions) continue;
    if (mid >= 2 && total / (total + lc) >= 0.85) nameTokens.add(key);
    else if (lc === 0 && total >= 5 && !lk.endsWith('ly')) nameTokens.add(key);
  }
  const nameLower = new Set([...nameTokens].map(norm));
  const nameKey = (t: string): string | null => {
    const key = t.replace(/['’]s$/i, '');
    return nameTokens.has(key) ? key : null;
  };

  // Full names ("Mara Voss") tie their parts together.
  const fullCounts = new Map<string, number>();
  for (const s of sents) {
    for (let i = 0; i + 1 < s.tokens.length; i++) {
      const a = nameKey(s.tokens[i]);
      const b = nameKey(s.tokens[i + 1]);
      if (a && b && a !== b) fullCounts.set(`${a} ${b}`, (fullCounts.get(`${a} ${b}`) ?? 0) + 1);
    }
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while ((parent.get(x) ?? x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const [pair, n] of fullCounts) {
    if (n < 2) continue;
    const [a, b] = pair.split(' ');
    parent.set(find(a), find(b));
  }

  // ---- pass 2: per-chapter measures ----------------------------------------------------------
  const nCh = inputs.length;
  const freq = new Map<string, number>();
  const freqChapters = new Map<string, Set<number>>();
  const unique = new Set<string>();
  const nameHits = new Map<string, number[]>(); // token → per chapter
  const pairHits = new Map<string, number[]>(); // "a b" → per chapter
  const bi = new Map<string, [number, number, number]>();
  const tri = new Map<string, [number, number, number]>();
  const openers = new Map<string, number>();
  const adverbs = new Map<string, number>();
  const tagAdverbs = new Map<string, number>();
  const speechTags = new Map<string, number>();
  const thoughtHits = new Map<string, number[]>(); // group root → per chapter
  const sceneThoughts = new Map<string, Map<string, number>>(); // "chapter:scene" → root → n
  const echoes = new Map<string, { count: number; example: Example }>();
  const lastSeen = new Map<string, number>();
  const passiveExamples: Example[] = [];
  const thatExamples: Example[] = [];
  const openerRuns: Example[] = [];
  const slips: Example[] = [];
  const tenseSlips: Example[] = [];
  const longest: (Example & { words: number })[] = [];
  const sentenceLengths: number[] = [];
  const paragraphLengths: number[] = [];
  const attributions: { name: string; chapter: number }[] = [];
  const paraInfo = new Map<Paragraph, { pov: { first: number; second: number; third: number }; past: number; present: number }>();

  const groupRe = WORD_GROUPS.map((g) => g.items.map((it) => new RegExp(it.pattern, 'g')));
  const groupCounts = WORD_GROUPS.map((g) => g.items.map(() => 0));
  const groupPerChapter = WORD_GROUPS.map(() => new Array<number>(nCh).fill(0));
  let thatTotal = 0;
  let thatOptional = 0;
  let passiveCount = 0;
  let passiveByAgent = 0;
  let adverbTotal = 0;
  let totalSyl = 0;
  let totalLetters = 0;
  let totalComplex = 0;
  let totalWords = 0;
  let openerRunCount = 0;
  let pronounOpeners = 0;
  let plainTags = 0;
  let tagTotal = 0;
  let position = 0;
  const punct = { '!': 0, '?': 0, '…': 0, '—': 0, ';': 0, ':': 0, '(': 0 };

  const chapters: ChapterStats[] = [];
  const bySentChapter = new Map<number, Sent[]>();
  for (const s of sents) {
    const arr = bySentChapter.get(s.chapter) ?? [];
    arr.push(s);
    bySentChapter.set(s.chapter, arr);
  }
  const totalsAcc = { paragraphs: 0, scenes: 0, dialogueWords: 0, narrationWords: 0, dialogueParagraphs: 0, oneLine: 0, longestPara: 0 };
  const rootOf = (token: string): string | null => {
    const k = nameKey(token);
    return k ? find(k) : null;
  };

  for (let ci = 0; ci < nCh; ci++) {
    const ch = parsed[ci];
    const list = bySentChapter.get(ci) ?? [];
    let words = 0;
    let syl = 0;
    let letters = 0;
    let complex = 0;
    let advs = 0;
    let passives = 0;
    let fillers = 0;
    let crutches = 0;
    let dialogueWords = 0;
    let narrationWords = 0;
    let dialogueParas = 0;
    const pov = { first: 0, second: 0, third: 0 };
    let past = 0;
    let present = 0;
    const sentLens: number[] = [];

    for (const p of ch.paragraphs) {
      const dw = p.dialogue.reduce((n, t) => n + wordsOf(t).length, 0);
      const nw = p.narration.reduce((n, t) => n + wordsOf(t).length, 0);
      dialogueWords += dw;
      narrationWords += nw;
      if (dw > 0) dialogueParas++;
      const pw = dw + nw;
      paragraphLengths.push(pw);
      if (pw <= 12) totalsAcc.oneLine++;
      totalsAcc.longestPara = Math.max(totalsAcc.longestPara, pw);
      for (const c of p.text) {
        if (c === '!' || c === '?' || c === '…' || c === '—' || c === ';' || c === ':' || c === '(') punct[c]++;
      }
      punct['…'] += (p.text.match(/\.{3}/g) ?? []).length;

      // point of view and tense: narration only
      const pPov = { first: 0, second: 0, third: 0 };
      let pPast = 0;
      let pPresent = 0;
      for (const seg of p.povNarration) {
        for (const t of wordsOf(seg)) {
          const lt = norm(t);
          const who = personOf(lt);
          if (who) pPov[who]++;
          if (PAST_MARK.has(lt)) pPast++;
          else if (PRESENT_MARK.has(lt)) pPresent++;
        }
      }
      pov.first += pPov.first;
      pov.second += pPov.second;
      pov.third += pPov.third;
      past += pPast;
      present += pPresent;
      paraInfo.set(p, { pov: pPov, past: pPast, present: pPresent });

      // speech tags
      if (dw > 0) {
        for (const seg of p.narration) {
          const low = norm(seg);
          SPEECH_RE.lastIndex = 0;
          const verbs = new Set<string>();
          let m: RegExpExecArray | null;
          while ((m = SPEECH_RE.exec(low))) verbs.add(m[1]);
          for (const v of verbs) {
            speechTags.set(v, (speechTags.get(v) ?? 0) + 1);
            tagTotal++;
            if (PLAIN_TAGS.has(v)) plainTags++;
          }
          TAG_ADVERB_RE.lastIndex = 0;
          while ((m = TAG_ADVERB_RE.exec(low))) {
            const key = `${m[1]} ${m[2]}`;
            tagAdverbs.set(key, (tagAdverbs.get(key) ?? 0) + 1);
          }
          const attr =
            /^[^\p{L}]*(\p{Lu}[\p{L}'’-]+)\s+(?:[\p{L}]+ly\s+)?(?:said|asked|replied|whispered|shouted|muttered|murmured|called|answered|added|snapped|cried|growled|hissed|breathed|sighed|laughed|continued|yelled|demanded|offered)\b/u.exec(seg) ??
            /^[^\p{L}]*(?:said|asked|replied|whispered|shouted|muttered|murmured|called|answered|added|snapped|cried|growled|hissed|breathed|continued|yelled|demanded|offered)\s+(\p{Lu}[\p{L}'’-]+)/u.exec(seg);
          if (attr) attributions.push({ name: attr[1], chapter: ci });
        }
      }
    }
    totalsAcc.paragraphs += ch.paragraphs.length;
    totalsAcc.scenes += ch.scenes;
    totalsAcc.dialogueWords += dialogueWords;
    totalsAcc.narrationWords += narrationWords;
    totalsAcc.dialogueParagraphs += dialogueParas;

    let prevOpener = '';
    let run = 0;
    for (const s of list) {
      const n = s.tokens.length;
      words += n;
      sentLens.push(n);
      sentenceLengths.push(n);
      if (n >= 30) longest.push({ chapter: ci, text: snip(s.text), words: n });
      const sentLower = s.lower.join(' ');
      // opener
      const op = s.lower[0];
      openers.set(op, (openers.get(op) ?? 0) + 1);
      if (/^(?:he|she|they|i|we|it|you)$/.test(op)) pronounOpeners++;
      if (op === prevOpener) run++;
      else {
        if (run >= 3) {
          openerRunCount++;
          if (openerRuns.length < 40) openerRuns.push({ chapter: ci, text: `${run + 1} sentences in a row start with "${prevOpener}"` });
        }
        run = 0;
        prevOpener = op;
      }
      // readability counts
      for (const t of s.tokens) {
        const sy = syllables(t);
        syl += sy;
        if (sy >= 3 && !nameKey(t)) complex++;
        letters += (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
      }
      // vocabulary
      for (let i = 0; i < n; i++) {
        const lt = s.lower[i];
        unique.add(lt);
        position++;
        if (lt.length >= 3 && !STOPWORDS.has(lt) && !nameLower.has(lt) && !/^\d/.test(lt) && lt !== 'said') {
          freq.set(lt, (freq.get(lt) ?? 0) + 1);
          let set = freqChapters.get(lt);
          if (!set) freqChapters.set(lt, (set = new Set()));
          set.add(ci);
          if (lt.length >= 5) {
            const prev = lastSeen.get(lt);
            if (prev !== undefined && position - prev <= 25) {
              const e = echoes.get(lt);
              if (e) e.count++;
              else echoes.set(lt, { count: 1, example: { chapter: ci, text: snip(s.text), mark: lt } });
            }
            lastSeen.set(lt, position);
          }
        }
        const nk = nameKey(s.tokens[i]);
        if (nk) {
          const arr = nameHits.get(nk) ?? new Array<number>(nCh).fill(0);
          arr[ci]++;
          nameHits.set(nk, arr);
          const nk2 = i + 1 < n ? nameKey(s.tokens[i + 1]) : null;
          if (nk2 && nk2 !== nk) {
            const pk = `${nk} ${nk2}`;
            const pa = pairHits.get(pk) ?? new Array<number>(nCh).fill(0);
            pa[ci]++;
            pairHits.set(pk, pa);
          }
        }
        // adverbs
        if (lt.endsWith('ly') && lt.length > 4 && !NOT_ADVERBS.has(lt) && !nameLower.has(lt)) {
          advs++;
          adverbs.set(lt, (adverbs.get(lt) ?? 0) + 1);
        }
        // thoughts: whose head are we in?
        if (THOUGHT_VERBS.has(lt) && i > 0) {
          let j = i - 1;
          if (/ly$/.test(s.lower[j]) && j > 0) j--;
          const root = rootOf(s.tokens[j]);
          if (root) {
            const arr = thoughtHits.get(root) ?? new Array<number>(nCh).fill(0);
            arr[ci]++;
            thoughtHits.set(root, arr);
            const sk = `${ci}:${s.scene}`;
            const m = sceneThoughts.get(sk) ?? new Map<string, number>();
            m.set(root, (m.get(root) ?? 0) + 1);
            sceneThoughts.set(sk, m);
          }
        }
      }
      // phrases
      const grams = (size: number, store: Map<string, [number, number, number]>, ok: (g: string[]) => boolean) => {
        for (let i = 0; i + size <= n; i++) {
          const g = s.lower.slice(i, i + size);
          if (!ok(g)) continue;
          const key = g.join(' ');
          const e = store.get(key);
          if (!e) store.set(key, [1, 1, ci]);
          else {
            e[0]++;
            if (e[2] !== ci) {
              e[1]++;
              e[2] = ci;
            }
          }
        }
      };
      grams(2, bi, (g) => !(STOPWORDS.has(g[0]) && STOPWORDS.has(g[1])) && !g.some((x) => nameLower.has(x)) && !g.some((x) => /^\d/.test(x)));
      grams(3, tri, (g) => !(STOPWORDS.has(g[0]) && STOPWORDS.has(g[2])) && g.some((x) => !STOPWORDS.has(x)) && !g.some((x) => nameLower.has(x)) && !g.some((x) => /^\d/.test(x)));
      // word groups
      WORD_GROUPS.forEach((g, gi) => {
        g.items.forEach((_it, ii) => {
          const re = groupRe[gi][ii];
          re.lastIndex = 0;
          const m = sentLower.match(re);
          if (m) {
            groupCounts[gi][ii] += m.length;
            groupPerChapter[gi][ci] += m.length;
            if (gi === 0) fillers += m.length;
            else if (gi === 1) crutches += m.length;
          }
        });
      });
      // that
      const thatN = s.lower.filter((t) => t === 'that').length;
      thatTotal += thatN;
      THAT_OPTIONAL_RE.lastIndex = 0;
      const opt = sentLower.match(THAT_OPTIONAL_RE);
      if (opt) {
        thatOptional += opt.length;
        thatExamples.push({ chapter: ci, text: snip(s.text), mark: opt[0].split(' that ')[0] + ' that' });
      }
      // passive
      PASSIVE_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PASSIVE_RE.exec(sentLower))) {
        const part = pm[1];
        const tail = pm[2]?.trim();
        if (tail === 'to' && (part === 'supposed' || part === 'used' || part === 'determined' || part === 'bound' || part === 'forced' || part === 'allowed' || part === 'meant' || part === 'expected')) continue;
        if (tail === 'to' && STATE_PARTICIPLES.has(part)) continue;
        if (STATE_PARTICIPLES.has(part) && tail !== 'by') continue;
        if (tail === 'to') continue;
        passives++;
        if (tail === 'by') passiveByAgent++;
        passiveExamples.push({ chapter: ci, text: snip(s.text), mark: pm[0].replace(/\s+(?:by|to)$/, '') });
        break;
      }
    }
    if (run >= 3) {
      openerRunCount++;
      if (openerRuns.length < 40) openerRuns.push({ chapter: ci, text: `${run + 1} sentences in a row start with "${prevOpener}"` });
    }

    // overall
    totalWords += words;
    totalSyl += syl;
    totalLetters += letters;
    totalComplex += complex;
    passiveCount += passives;
    adverbTotal += advs;

    const R = readabilityOf(words, list.length, syl, letters, complex);
    const P = pov.first + pov.second + pov.third;
    const person: ChapterStats['person'] =
      P < 8 ? 'unclear' : pov.first / P >= 0.5 ? 'first' : pov.second / P >= 0.5 ? 'second' : 'third';
    const markers = past + present;
    chapters.push({
      title: ch.title || (inputs[ci].isPreamble ? '(front matter)' : `Chapter ${ci + 1}`),
      words: dialogueWords + narrationWords || words,
      paragraphs: ch.paragraphs.length,
      sentences: list.length,
      dialogueWords,
      dialogueParagraphs: dialogueParas,
      avgSentence: list.length ? words / list.length : 0,
      grade: R.grade,
      adverbs: advs,
      passive: passives,
      filler: fillers,
      crutch: crutches,
      pov,
      person,
      presentShare: markers ? present / markers : 0,
      tenseMarkers: markers,
      scenes: ch.scenes,
      povCharacters: []
    });
    await tick();
  }

  // ---- characters ----------------------------------------------------------------------------
  const groups = new Map<string, string[]>();
  for (const t of nameTokens) {
    const r = find(t);
    groups.set(r, [...(groups.get(r) ?? []), t]);
  }
  const characters: Character[] = [];
  for (const members of groups.values()) {
    const per = new Array<number>(nCh).fill(0);
    for (const m of members) (nameHits.get(m) ?? []).forEach((n, i) => (per[i] += n));
    for (const [pk, arr] of pairHits) {
      const [a, b] = pk.split(' ');
      if (members.includes(a) && members.includes(b) && (fullCounts.get(pk) ?? 0) >= 2) arr.forEach((n, i) => (per[i] -= n));
    }
    const mentions = per.reduce((a, b) => a + b, 0);
    if (mentions < minMentions) continue;
    const best = [...fullCounts.entries()].filter(([pk]) => pk.split(' ').every((x) => members.includes(x))).sort((a, b) => b[1] - a[1])[0];
    const byFreq = members.slice().sort((a, b) => (nameHits.get(b)?.reduce((x, y) => x + y, 0) ?? 0) - (nameHits.get(a)?.reduce((x, y) => x + y, 0) ?? 0));
    const name = best && members.length > 1 ? best[0] : byFreq[0];
    const first = per.findIndex((n) => n > 0);
    characters.push({
      name,
      aliases: members.filter((m) => !name.split(' ').includes(m)),
      mentions,
      chapters: per.filter((n) => n > 0).length,
      firstChapter: first,
      perChapter: per,
      speaks: 0
    });
  }
  characters.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
  const charOf = (token: string): Character | undefined => {
    const k = token.replace(/['’]s$/i, '');
    return characters.find((c) => c.name.split(' ').includes(k) || c.aliases.includes(k));
  };
  for (const a of attributions) {
    const c = charOf(a.name);
    if (c) c.speaks++;
  }

  // ---- point of view ----------------------------------------------------------------------------
  const rootName = (root: string): string => characters.find((c) => c.name.split(' ').includes(root) || c.aliases.includes(root))?.name ?? root;
  chapters.forEach((c, ci) => {
    c.povCharacters = [...thoughtHits.entries()]
      .map(([root, arr]) => ({ name: rootName(root), count: arr[ci] }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  });
  const sum = (f: (c: ChapterStats) => number) => chapters.reduce((a, c) => a + f(c), 0);
  const first = sum((c) => c.pov.first);
  const second = sum((c) => c.pov.second);
  const third = sum((c) => c.pov.third);
  const P = first + second + third;
  const person: Analysis['pov']['person'] = P < 20 ? 'unclear' : first / P >= 0.5 ? 'first' : second / P >= 0.5 ? 'second' : 'third';
  const markers = sum((c) => c.tenseMarkers);
  const presentShare = markers ? sum((c) => c.presentShare * c.tenseMarkers) / markers : 0;
  const tense: Analysis['pov']['tense'] = markers < 20 ? 'unclear' : presentShare >= 0.7 ? 'present' : presentShare <= 0.3 ? 'past' : 'mixed';

  const personFlags: string[] = [];
  const tenseFlags: string[] = [];
  chapters.forEach((c, ci) => {
    const Pc = c.pov.first + c.pov.second + c.pov.third;
    if (c.person !== 'unclear' && person !== 'unclear' && c.person !== person) personFlags.push(`${ci + 1}|${c.title}|reads as ${c.person} person, the book is mostly ${person}`);
    else if (Pc >= 20 && c.pov.first / Pc >= 0.15 && c.pov.first / Pc < 0.5 && person === 'third') personFlags.push(`${ci + 1}|${c.title}|${Math.round((100 * c.pov.first) / Pc)}% of its narration pronouns are first person ("I", "my")`);
    if (c.tenseMarkers >= 15) {
      const base = tense === 'present' ? 1 : 0;
      const off = base ? 1 - c.presentShare : c.presentShare;
      if (tense !== 'mixed' && tense !== 'unclear' && off > 0.2) tenseFlags.push(`${ci + 1}|${c.title}|${Math.round(off * 100)}% of its tense markers are ${base ? 'past' : 'present'} (the book is mostly ${tense})`);
    }
  });
  // paragraph-level slips
  if (person === 'third' || person === 'first') {
    parsed.forEach((ch, ci) => {
      const cp = chapters[ci];
      for (const p of ch.paragraphs) {
        const info = paraInfo.get(p)!;
        const pp = info.pov;
        if (person === 'third' && cp.person === 'third' && pp.first >= 3 && slips.length < 12) slips.push({ chapter: ci, text: snip(p.text) });
        if (person === 'first' && pp.third >= 6 && pp.first === 0 && cp.person === 'first' && slips.length < 12) slips.push({ chapter: ci, text: snip(p.text) });
        const pa = info.past;
        const pr = info.present;
        if (tense === 'past' && pr >= 3 && pr > 2 * pa && tenseSlips.length < 12) tenseSlips.push({ chapter: ci, text: snip(p.text) });
        if (tense === 'present' && pa >= 3 && pa > 2 * pr && tenseSlips.length < 12) tenseSlips.push({ chapter: ci, text: snip(p.text) });
      }
    });
  }
  const headHopping: string[] = [];
  if (person === 'third') {
    for (const [sk, m] of sceneThoughts) {
      const strong = [...m.entries()].filter(([, n]) => n >= 2);
      if (strong.length >= 2) {
        const [c, s] = sk.split(':').map(Number);
        headHopping.push(`${c + 1}|${chapters[c].title}|scene ${s + 1}: ${strong.map(([r, n]) => `${rootName(r)} (${n})`).join(' and ')} both have their thoughts or feelings reported`);
      }
    }
  }

  // ---- phrases, words -------------------------------------------------------------------------
  const minBi = Math.max(3, Math.round(totalWords / 10000));
  const minTri = totalWords < 10000 ? 2 : 3;
  const rank = (m: Map<string, [number, number, number]>, min: number, n: number) =>
    [...m.entries()]
      .filter(([, v]) => v[0] >= min)
      .sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([phrase, v]) => ({ phrase, count: v[0], chapters: v[1] }));
  const bigrams = rank(bi, minBi, 25);
  const trigrams = rank(tri, minTri, 25);
  const repeatedWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([word, count]) => ({ word, count, per10k: (count / Math.max(1, totalWords)) * 10000, chapters: freqChapters.get(word)?.size ?? 0 }));
  const echoList = [...echoes.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([word, v]) => ({ word, count: v.count, example: v.example }));

  const dialogueTop = top(speechTags, 20);
  const totalSentences = sentenceLengths.length;
  const per1000 = (n: number) => (n / Math.max(1, totalWords)) * 1000;
  const wordGroups = WORD_GROUPS.map((g, gi) => {
    const items = g.items
      .map((it, ii) => ({ label: it.label, count: groupCounts[gi][ii], per1000: per1000(groupCounts[gi][ii]) }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    return { title: g.title, hint: g.hint, total: items.reduce((a, b) => a + b.count, 0), per1000: per1000(items.reduce((a, b) => a + b.count, 0)), items };
  });
  const dialogueWordsTotal = totalsAcc.dialogueWords;
  const openerList = top(openers, 10);
  longest.sort((a, b) => b.words - a.words);
  await tick();

  const all = readabilityOf(totalWords, totalSentences, totalSyl, totalLetters, totalComplex);
  const result: Analysis = {
    chapters,
    totals: {
      words: totalWords,
      uniqueWords: unique.size,
      letters: totalLetters,
      syllables: totalSyl,
      paragraphs: totalsAcc.paragraphs,
      sentences: totalSentences,
      scenes: totalsAcc.scenes,
      dialogueWords: dialogueWordsTotal,
      narrationWords: totalsAcc.narrationWords,
      dialogueParagraphs: totalsAcc.dialogueParagraphs,
      oneLineParagraphs: totalsAcc.oneLine,
      longestParagraph: totalsAcc.longestPara
    },
    readability: all,
    sentenceLengths: {
      average: totalSentences ? totalWords / totalSentences : 0,
      median: median(sentenceLengths),
      deviation: stdev(sentenceLengths),
      longest: longest.slice(0, 5),
      histogram: histogram(sentenceLengths, [1, 6, 11, 16, 21, 26, 31, 41])
    },
    paragraphLengths: { average: mean(paragraphLengths), histogram: histogram(paragraphLengths, [1, 11, 26, 51, 101, 201]) },
    dialogue: {
      speechTags: dialogueTop,
      plainShare: tagTotal ? plainTags / tagTotal : 0,
      tagTotal,
      tagAdverbs: top(tagAdverbs, 10)
    },
    openers: { top: openerList, pronounShare: totalSentences ? pronounOpeners / totalSentences : 0, runs: openerRuns.slice(0, 8), runCount: openerRunCount },
    repeatedWords,
    echoes: echoList,
    bigrams,
    trigrams,
    adverbs: { total: adverbTotal, per1000: per1000(adverbTotal), top: top(adverbs, 20), distinct: adverbs.size },
    passive: { count: passiveCount, share: totalSentences ? passiveCount / totalSentences : 0, withAgent: passiveByAgent, examples: evenly(passiveExamples, 12) },
    wordGroups,
    that: { total: thatTotal, per1000: per1000(thatTotal), optional: thatOptional, examples: evenly(thatExamples, 8) },
    pov: { first, second, third, person, tense, presentShare, personFlags, tenseFlags, headHopping, slips, tenseSlips },
    characters: characters.slice(0, 40),
    punctuation: [
      { label: 'Exclamation marks (!)', count: punct['!'], per1000: per1000(punct['!']) },
      { label: 'Question marks (?)', count: punct['?'], per1000: per1000(punct['?']) },
      { label: 'Ellipses (…)', count: punct['…'], per1000: per1000(punct['…']) },
      { label: 'Em dashes (—)', count: punct['—'], per1000: per1000(punct['—']) },
      { label: 'Semicolons (;)', count: punct[';'], per1000: per1000(punct[';']) },
      { label: 'Colons (:)', count: punct[':'], per1000: per1000(punct[':']) },
      { label: 'Parentheses ( )', count: punct['('], per1000: per1000(punct['(']) }
    ]
  };
  await tick();
  return result;
}
