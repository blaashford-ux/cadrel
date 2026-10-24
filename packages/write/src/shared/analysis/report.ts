import type { Analysis, Example } from './analyze';

export interface ReportOptions {
  /** Name of the analysed file, shown at the top. */
  source: string;
  /** Local date, YYYY-MM-DD. */
  generated: string;
  /** Heading level that starts a chapter in this project; sections use it so each shows in the chapter list. */
  level?: number;
}

const BAR = 24;
const FULL = '█';
const PARTS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARK = '▁▂▃▄▅▆▇█';
const SHADE = ' ░▒▓█';

/** A horizontal bar for `value` out of `max`. */
export function bar(value: number, max: number, width = BAR): string {
  if (!(max > 0) || !(value > 0)) return '';
  const eighths = Math.max(1, Math.round((Math.min(value, max) / max) * width * 8));
  return FULL.repeat(Math.floor(eighths / 8)) + PARTS[eighths % 8];
}

export function sparkline(values: number[]): string {
  const max = Math.max(...values, 0);
  if (!(max > 0)) return SPARK[0].repeat(values.length);
  return values.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('');
}

const num = (n: number, d = 0): string => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const pct = (n: number, d = 1): string => `${num(n * 100, d)}%`;
const cell = (s: string | number): string => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const esc = (s: string): string => s.replace(/([\\`*_[\]<>|~])/g, '\\$1');

function table(head: string[], rows: (string | number)[][], align: ('l' | 'r')[] = []): string {
  if (!rows.length) return '';
  const line = (cols: (string | number)[]) => `| ${cols.map(cell).join(' | ')} |`;
  const rule = head.map((_h, i) => (align[i] === 'r' ? '---:' : '---'));
  return [line(head), `| ${rule.join(' | ')} |`, ...rows.map(line)].join('\n');
}

const fence = (lines: string[]): string => '```\n' + lines.join('\n') + '\n```';

/** Left-pads / truncates a label to a fixed width for chart columns. */
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const padL = (s: string, n: number): string => s.padStart(n);

function chart(rows: { label: string; value: number; text?: string }[], opts: { labelWidth?: number; max?: number } = {}): string {
  const lw = Math.min(opts.labelWidth ?? 22, Math.max(...rows.map((r) => r.label.length), 4));
  const max = opts.max ?? Math.max(...rows.map((r) => r.value), 0);
  const tw = Math.max(...rows.map((r) => (r.text ?? num(r.value)).length), 1);
  return fence(rows.map((r) => `${pad(r.label, lw)} ${padL(r.text ?? num(r.value), tw)} ${bar(r.value, max)}`));
}

function excerpt(text: string, mark?: string, width = 170): string {
  let t = text.replace(/\s+/g, ' ').trim();
  let from = 0;
  let to = t.length;
  let lead = '';
  let tail = '';
  const at = mark ? t.toLowerCase().indexOf(mark.toLowerCase()) : -1;
  if (t.length > width) {
    const centre = at >= 0 ? at + mark!.length / 2 : width / 2;
    from = Math.max(0, Math.round(centre - width / 2));
    to = Math.min(t.length, from + width);
    from = Math.max(0, to - width);
    if (from > 0) lead = '…';
    if (to < t.length) tail = '…';
    t = t.slice(from, to);
  }
  const idx = mark ? t.toLowerCase().indexOf(mark.toLowerCase()) : -1;
  if (idx < 0 || !mark) return lead + esc(t) + tail;
  return lead + esc(t.slice(0, idx)) + '**' + esc(t.slice(idx, idx + mark.length)) + '**' + esc(t.slice(idx + mark.length)) + tail;
}

const examples = (list: Example[], titles: string[]): string =>
  list.map((e) => `- *${esc(titles[e.chapter] ?? `Chapter ${e.chapter + 1}`)}:* ${excerpt(e.text, e.mark)}`).join('\n');

function gradeLabel(g: number): string {
  const grade = Math.max(0, Math.round(g));
  if (grade <= 0) return 'kindergarten level';
  if (grade >= 13) return 'college level';
  return `grade ${grade} (ages ${grade + 5}–${grade + 6})`;
}

function easeLabel(e: number): string {
  if (e >= 90) return 'very easy';
  if (e >= 80) return 'easy';
  if (e >= 70) return 'fairly easy';
  if (e >= 60) return 'plain English';
  if (e >= 50) return 'fairly difficult';
  if (e >= 30) return 'difficult';
  return 'very difficult';
}

/** Splits "n|title|message" flags. */
const flagLine = (f: string): string => {
  const [n, title, ...rest] = f.split('|');
  return `- **${n}. ${esc(title || `Chapter ${n}`)}:** ${esc(rest.join('|'))}`;
};

/** Short text on reading speed. */
function readingTime(words: number): string {
  const min = Math.round(words / 250);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export interface Finding {
  level: 'look' | 'note';
  text: string;
}

/** The headline observations, with the rule of thumb behind each. They are guidance, not rules. */
export function findings(a: Analysis): Finding[] {
  const out: Finding[] = [];
  const t = a.totals;
  if (!t.words) return out;
  const dlg = t.dialogueWords / t.words;
  if (dlg < 0.15) out.push({ level: 'note', text: `Only ${pct(dlg, 0)} of the text is dialogue. Fine for slow, interior or descriptive books; fast-paced fiction usually runs higher.` });
  else if (dlg > 0.6) out.push({ level: 'note', text: `${pct(dlg, 0)} of the text is dialogue. Check that there is enough action and setting between the lines.` });
  const avg = a.sentenceLengths.average;
  if (avg > 22) out.push({ level: 'look', text: `Sentences average ${num(avg, 1)} words, which is long for fiction (14–18 is typical).` });
  else if (avg < 9) out.push({ level: 'look', text: `Sentences average only ${num(avg, 1)} words. Very short sentences throughout can read as choppy.` });
  if (a.sentenceLengths.deviation < 7 && t.sentences > 100) out.push({ level: 'note', text: `Sentence lengths vary little (spread of ${num(a.sentenceLengths.deviation, 1)} words). Mixing short and long sentences gives the prose rhythm.` });
  if (a.readability.grade > 10) out.push({ level: 'look', text: `The reading level is ${gradeLabel(a.readability.grade)}. Most commercial fiction sits between grades 4 and 8.` });
  if (a.adverbs.per1000 > 12) out.push({ level: 'look', text: `${num(a.adverbs.per1000, 1)} adverbs per 1,000 words (about ${num(a.adverbs.total)} in all). Stronger verbs can often replace them.` });
  if (a.passive.share > 0.15) out.push({ level: 'look', text: `${pct(a.passive.share, 0)} of sentences look passive. Under 10% is common in fiction.` });
  const filler = a.wordGroups[0]?.per1000 ?? 0;
  if (filler > 25) out.push({ level: 'look', text: `Filler and hedge words run at ${num(filler, 1)} per 1,000 words.` });
  const crutch = a.wordGroups[1]?.per1000 ?? 0;
  if (crutch > 25) out.push({ level: 'look', text: `Filter words ("felt", "saw", "seemed", "began to"…) run at ${num(crutch, 1)} per 1,000 words.` });
  if (a.that.optional > Math.max(5, t.words / 2000)) out.push({ level: 'look', text: `${num(a.that.optional)} places where "that" can probably be dropped ("knew that she…").` });
  if (a.dialogue.tagTotal >= 20 && a.dialogue.plainShare < 0.5) out.push({ level: 'look', text: `Only ${pct(a.dialogue.plainShare, 0)} of dialogue tags are plain "said/asked"; the rest are more showy verbs, which can pull attention from the speech.` });
  if (a.pov.personFlags.length) out.push({ level: 'look', text: `${a.pov.personFlags.length} chapter${a.pov.personFlags.length === 1 ? '' : 's'} may mix or break the point of view (see Point of view).` });
  if (a.pov.tenseFlags.length) out.push({ level: 'look', text: `${a.pov.tenseFlags.length} chapter${a.pov.tenseFlags.length === 1 ? '' : 's'} drift from the book's usual tense.` });
  if (a.pov.headHopping.length) out.push({ level: 'look', text: `${a.pov.headHopping.length} scene${a.pov.headHopping.length === 1 ? '' : 's'} may head-hop between characters.` });
  if (a.openers.runCount) out.push({ level: 'look', text: `${a.openers.runCount} run${a.openers.runCount === 1 ? '' : 's'} of four or more sentences starting with the same word.` });
  const topWord = a.repeatedWords[0];
  if (topWord && topWord.per10k > 40) out.push({ level: 'note', text: `"${topWord.word}" appears ${num(topWord.per10k, 0)} times per 10,000 words, more than any other content word.` });
  return out;
}

/** Renders the analysis as a Markdown report. Each major section is a chapter-level heading so it appears in the chapter list. */
export function renderReport(a: Analysis, opts: ReportOptions): string {
  const lv = Math.min(6, Math.max(1, opts.level ?? 1));
  const H = (text: string) => `${'#'.repeat(lv)} ${text}`;
  const S = (text: string) => `${'#'.repeat(Math.min(6, lv + 1))} ${text}`;
  const titles = a.chapters.map((c) => c.title);
  const t = a.totals;
  const out: string[] = [];
  const add = (...parts: (string | false | undefined)[]) => out.push(parts.filter((p): p is string => !!p).join('\n\n'));

  if (!t.words) {
    return `${H('Text analysis')}\n\nThere is no prose to analyse in **${esc(opts.source)}**.\n`;
  }

  // ---- summary -------------------------------------------------------------------------------
  const dlg = t.dialogueWords / t.words;
  const fs = findings(a);
  add(
    H(`Text analysis: ${esc(opts.source)}`),
    `Generated ${opts.generated} by MDEdit. In MDEdit this file opens as a formatted report with charts; choose *Edit as Markdown* to see this text. Guidance, not rules: the checks are automatic and will sometimes be wrong (a passive sentence may be deliberate, a "name" may not be one). Use them to know where to look.`,
    table(
      ['Measure', 'Value'],
      [
        ['Words', num(t.words)],
        ['Chapters', num(a.chapters.length)],
        ['Scenes', num(t.scenes)],
        ['Reading time (250 wpm)', readingTime(t.words)],
        ['Dialogue', `${pct(dlg)} of words`],
        ['Average sentence', `${num(a.sentenceLengths.average, 1)} words`],
        ['Reading level', gradeLabel(a.readability.grade)],
        ['Adverbs', `${num(a.adverbs.per1000, 1)} per 1,000 words`],
        ['Passive sentences', pct(a.passive.share)],
        ['Point of view', `${a.pov.person === 'unclear' ? 'unclear' : a.pov.person + ' person'}, ${a.pov.tense === 'unclear' ? 'tense unclear' : a.pov.tense + ' tense'}`]
      ],
      ['l', 'r']
    ),
    S('Worth a look'),
    fs.filter((f) => f.level === 'look').length ? fs.filter((f) => f.level === 'look').map((f) => `- ${f.text}`).join('\n') : 'Nothing stands out against the usual rules of thumb.',
    fs.some((f) => f.level === 'note') && S('Also noted'),
    fs.some((f) => f.level === 'note') && fs.filter((f) => f.level === 'note').map((f) => `- ${f.text}`).join('\n')
  );

  // ---- overview -----------------------------------------------------------------------------
  const maxWords = Math.max(...a.chapters.map((c) => c.words));
  add(
    H('Overview'),
    table(
      ['Measure', 'Value'],
      [
        ['Words', num(t.words)],
        ['Unique words', `${num(t.uniqueWords)} (${pct(t.uniqueWords / t.words)} of all words)`],
        ['Sentences', num(t.sentences)],
        ['Paragraphs', `${num(t.paragraphs)} (${num(a.paragraphLengths.average, 1)} words on average)`],
        ['Short paragraphs (12 words or fewer)', `${num(t.oneLineParagraphs)} (${pct(t.oneLineParagraphs / Math.max(1, t.paragraphs), 0)})`],
        ['Longest paragraph', `${num(t.longestParagraph)} words`],
        ['Average chapter', `${num(t.words / a.chapters.length)} words`]
      ],
      ['l', 'r']
    ),
    S('Chapter length'),
    chart(a.chapters.map((c, i) => ({ label: `${i + 1}. ${c.title}`, value: c.words })), { max: maxWords, labelWidth: 26 }),
    S('By chapter'),
    table(
      ['#', 'Chapter', 'Words', 'Dialogue', 'Avg sentence', 'Grade', 'Adverbs /1k', 'Passive', 'Filler /1k', 'Filter /1k'],
      a.chapters.map((c, i) => [
        i + 1,
        esc(c.title),
        num(c.words),
        pct(c.words ? c.dialogueWords / c.words : 0, 0),
        num(c.avgSentence, 1),
        num(c.grade, 1),
        num((c.adverbs / Math.max(1, c.words)) * 1000, 1),
        pct(c.sentences ? c.passive / c.sentences : 0, 0),
        num((c.filler / Math.max(1, c.words)) * 1000, 1),
        num((c.crutch / Math.max(1, c.words)) * 1000, 1)
      ]),
      ['r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']
    ),
    a.chapters.length > 1 && 'Pacing at a glance (one character per chapter, tallest = highest):',
    a.chapters.length > 1 &&
      fence([
        `Words              ${sparkline(a.chapters.map((c) => c.words))}`,
        `Dialogue           ${sparkline(a.chapters.map((c) => (c.words ? c.dialogueWords / c.words : 0)))}`,
        `Sentence length    ${sparkline(a.chapters.map((c) => c.avgSentence))}`,
        `Reading grade      ${sparkline(a.chapters.map((c) => Math.max(0, c.grade)))}`,
        `Adverbs            ${sparkline(a.chapters.map((c) => c.adverbs / Math.max(1, c.words)))}`,
        `Passive voice      ${sparkline(a.chapters.map((c) => (c.sentences ? c.passive / c.sentences : 0)))}`,
        `Filler words       ${sparkline(a.chapters.map((c) => c.filler / Math.max(1, c.words)))}`
      ])
  );

  // ---- dialogue -----------------------------------------------------------------------------
  const nar = t.narrationWords;
  const tagsRows = a.dialogue.speechTags.map((x) => ({ label: x.word, value: x.count }));
  add(
    H('Dialogue'),
    `**${pct(dlg)}** of the words are spoken; **${pct(nar / t.words)}** are narration. **${pct(t.dialogueParagraphs / Math.max(1, t.paragraphs), 0)}** of paragraphs contain dialogue.`,
    fence([
      `Dialogue   ${bar(t.dialogueWords, t.words, 40).padEnd(40)} ${pct(dlg)}`,
      `Narration  ${bar(nar, t.words, 40).padEnd(40)} ${pct(nar / t.words)}`
    ]),
    S('Dialogue by chapter'),
    chart(a.chapters.map((c, i) => ({ label: `${i + 1}. ${c.title}`, value: c.words ? c.dialogueWords / c.words : 0, text: pct(c.words ? c.dialogueWords / c.words : 0, 0) })), { max: Math.max(0.01, ...a.chapters.map((c) => (c.words ? c.dialogueWords / c.words : 0))), labelWidth: 26 }),
    tagsRows.length > 0 &&
      [
        S('Dialogue tags'),
        `Speech verbs used in the narration of dialogue paragraphs. Plain "said/asked/replied" make up **${pct(a.dialogue.plainShare, 0)}** of ${num(a.dialogue.tagTotal)} tags; the rest are more noticeable verbs.`,
        chart(tagsRows, { labelWidth: 14 }),
        a.dialogue.tagAdverbs.length > 0 && 'Tags with adverbs attached:',
        a.dialogue.tagAdverbs.length > 0 && a.dialogue.tagAdverbs.map((x) => `- ${esc(x.word)} (${x.count})`).join('\n')
      ]
        .filter(Boolean)
        .join('\n\n')
  );

  // ---- sentences -------------------------------------------------------------------------------
  const sh = a.sentenceLengths.histogram;
  const ph = a.paragraphLengths.histogram;
  add(
    H('Sentences and rhythm'),
    table(
      ['Measure', 'Value'],
      [
        ['Average sentence length', `${num(a.sentenceLengths.average, 1)} words`],
        ['Median', `${num(a.sentenceLengths.median, 0)} words`],
        ['Spread (standard deviation)', `${num(a.sentenceLengths.deviation, 1)} words`],
        ['Sentences', num(t.sentences)]
      ],
      ['l', 'r']
    ),
    S('How long are the sentences?'),
    chart(sh.map((b) => ({ label: `${b.label} words`, value: b.count, text: `${num(b.count)} (${pct(b.count / Math.max(1, t.sentences), 0)})` })), { labelWidth: 14 }),
    S('How long are the paragraphs?'),
    chart(ph.map((b) => ({ label: `${b.label} words`, value: b.count })), { labelWidth: 14 }),
    a.sentenceLengths.longest.length > 0 && S('Longest sentences'),
    a.sentenceLengths.longest.length > 0 && a.sentenceLengths.longest.map((e) => `- *${esc(titles[e.chapter])}* (${e.words} words): ${excerpt(e.text, undefined, 260)}`).join('\n'),
    S('How sentences begin'),
    `${pct(a.openers.pronounShare, 0)} of sentences start with a pronoun (he, she, they, I, we, it, you).`,
    table(['Opening word', 'Sentences', 'Share'], a.openers.top.map((o) => [esc(o.word), num(o.count), pct(o.count / Math.max(1, t.sentences))]), ['l', 'r', 'r']),
    a.openers.runs.length > 0 && 'Runs of four or more sentences with the same opening word:',
    a.openers.runs.length > 0 && examples(a.openers.runs, titles)
  );

  // ---- readability ------------------------------------------------------------------------
  const r = a.readability;
  add(
    H('Reading level'),
    `Overall about **${gradeLabel(r.grade)}**. Fiction is usually written between grade 4 and 8; dialogue-heavy, plain prose scores low and that is normal.`,
    table(
      ['Formula', 'Score', 'Meaning'],
      [
        ['Flesch Reading Ease', num(r.fleschEase, 1), easeLabel(r.fleschEase) + ' (higher is easier)'],
        ['Flesch–Kincaid grade', num(r.fleschKincaid, 1), gradeLabel(r.fleschKincaid)],
        ['Gunning Fog', num(r.gunningFog, 1), gradeLabel(r.gunningFog)],
        ['Coleman–Liau', num(r.colemanLiau, 1), gradeLabel(r.colemanLiau)],
        ['Automated Readability Index', num(r.ari, 1), gradeLabel(r.ari)],
        ...(r.smog === null ? [] : [['SMOG', num(r.smog, 1), gradeLabel(r.smog)]]),
        ['**Average grade**', `**${num(r.grade, 1)}**`, gradeLabel(r.grade)]
      ],
      ['l', 'r', 'l']
    ),
    a.chapters.length > 1 && S('Grade level by chapter'),
    a.chapters.length > 1 &&
      chart(a.chapters.map((c, i) => ({ label: `${i + 1}. ${c.title}`, value: Math.max(0, c.grade), text: num(c.grade, 1) })), { labelWidth: 26, max: Math.max(12, ...a.chapters.map((c) => c.grade)) })
  );

  // ---- repeated words ---------------------------------------------------------------------
  add(
    H('Repeated words'),
    'The most-used words once common words (the, and, was…) and character names are set aside. Look for words that are not part of your story\'s vocabulary but show up a lot.',
    chart(a.repeatedWords.slice(0, 25).map((w) => ({ label: w.word, value: w.count, text: `${num(w.count)}` })), { labelWidth: 16 }),
    table(
      ['Word', 'Times', 'Per 10,000 words', 'In chapters'],
      a.repeatedWords.map((w) => [esc(w.word), num(w.count), num(w.per10k, 1), `${w.chapters} of ${a.chapters.length}`]),
      ['l', 'r', 'r', 'r']
    ),
    a.echoes.length > 0 && S('Echoes'),
    a.echoes.length > 0 && 'Words repeated within about 25 words of themselves, a common source of "I just used that" moments.',
    a.echoes.length > 0 && table(['Word', 'Close repeats'], a.echoes.map((e) => [esc(e.word), num(e.count)]), ['l', 'r']),
    a.echoes.length > 0 && 'Examples:',
    a.echoes.length > 0 && examples(a.echoes.slice(0, 6).map((e) => e.example), titles)
  );

  // ---- phrases ------------------------------------------------------------------------
  add(
    H('Repeated phrases'),
    'Two- and three-word phrases that come back often, ignoring ones made only of small words. A few are natural; a favourite phrase repeated dozens of times is a tic.',
    a.bigrams.length ? S('Two-word phrases') : 'No two-word phrase repeats often enough to list.',
    a.bigrams.length > 0 && chart(a.bigrams.slice(0, 20).map((g) => ({ label: g.phrase, value: g.count })), { labelWidth: 22 }),
    a.trigrams.length ? S('Three-word phrases') : 'No three-word phrase repeats often enough to list.',
    a.trigrams.length > 0 && table(['Phrase', 'Times', 'In chapters'], a.trigrams.map((g) => [esc(g.phrase), num(g.count), `${g.chapters} of ${a.chapters.length}`]), ['l', 'r', 'r'])
  );

  // ---- adverbs -------------------------------------------------------------------------------
  add(
    H('Adverbs'),
    `**${num(a.adverbs.total)}** adverbs ending in "-ly" (${num(a.adverbs.per1000, 1)} per 1,000 words, ${num(a.adverbs.distinct)} different ones). Many writers aim for under about 10 per 1,000.`,
    a.adverbs.top.length > 0 && chart(a.adverbs.top.map((x) => ({ label: x.word, value: x.count })), { labelWidth: 16 }),
    a.chapters.length > 1 && S('Adverbs per 1,000 words, by chapter'),
    a.chapters.length > 1 &&
      chart(a.chapters.map((c, i) => ({ label: `${i + 1}. ${c.title}`, value: (c.adverbs / Math.max(1, c.words)) * 1000, text: num((c.adverbs / Math.max(1, c.words)) * 1000, 1) })), { labelWidth: 26 })
  );

  // ---- passive -----------------------------------------------------------------------------
  add(
    H('Passive voice'),
    `**${num(a.passive.count)}** sentences (${pct(a.passive.share)}) look passive; ${num(a.passive.withAgent)} of them name who did it ("by…"). This is a pattern match ("was" + a past participle), so it catches some false positives and misses some real ones. Passive voice is not wrong: it suits moments where the doer is unknown or unimportant.`,
    a.chapters.length > 1 && S('Passive sentences by chapter'),
    a.chapters.length > 1 &&
      chart(a.chapters.map((c, i) => ({ label: `${i + 1}. ${c.title}`, value: c.sentences ? c.passive / c.sentences : 0, text: pct(c.sentences ? c.passive / c.sentences : 0, 1) })), { labelWidth: 26 }),
    a.passive.examples.length > 0 && S('Examples'),
    a.passive.examples.length > 0 && examples(a.passive.examples, titles)
  );

  // ---- filler / filter words ---------------------------------------------------------------
  const groupSections = a.wordGroups.map((g) =>
    [
      S(g.title),
      `${g.hint} **${num(g.total)}** in all (${num(g.per1000, 1)} per 1,000 words).`,
      g.items.length > 0 ? chart(g.items.slice(0, 20).map((x) => ({ label: x.label, value: x.count, text: `${num(x.count)}  ${num(x.per1000, 1)}/1k` })), { labelWidth: 20 }) : 'None found.'
    ].join('\n\n')
  );
  add(
    H('Filler, filter and crutch words'),
    'Counted wherever they appear, in narration and dialogue. Characters can say "just" and "really" naturally; narration is where they weaken the prose.',
    ...groupSections,
    S('The word "that"'),
    `"That" appears **${num(a.that.total)}** times (${num(a.that.per1000, 1)} per 1,000 words). About **${num(a.that.optional)}** of them follow a verb like "knew", "said" or "felt" and could probably be cut ("She knew that he was lying" → "She knew he was lying").`,
    a.that.examples.length > 0 && examples(a.that.examples, titles),
    a.chapters.length > 1 && S('Filler and filter words by chapter'),
    a.chapters.length > 1 &&
      fence([
        `${pad('Chapter', 26)} ${padL('Filler/1k', 9)} ${pad('', 12)} ${padL('Filter/1k', 9)}`,
        ...a.chapters.map((c, i) => {
          const f = (c.filler / Math.max(1, c.words)) * 1000;
          const k = (c.crutch / Math.max(1, c.words)) * 1000;
          return `${pad(`${i + 1}. ${c.title}`, 26)} ${padL(num(f, 1), 9)} ${pad(bar(f, 60, 12), 12)} ${padL(num(k, 1), 9)} ${bar(k, 60, 12)}`;
        })
      ])
  );

  // ---- POV ---------------------------------------------------------------------------------
  const P = a.pov.first + a.pov.second + a.pov.third;
  add(
    H('Point of view and tense'),
    P < 20
      ? 'There is too little narration to judge the point of view.'
      : `The narration reads as **${a.pov.person} person**, **${a.pov.tense} tense**. Pronouns in narration (outside quotes and italic thoughts):`,
    P >= 20 &&
      chart(
        [
          { label: 'First (I, we, my)', value: a.pov.first },
          { label: 'Second (you, your)', value: a.pov.second },
          { label: 'Third (he, she, they)', value: a.pov.third }
        ].map((x) => ({ ...x, text: `${num(x.value)} (${pct(x.value / Math.max(1, P), 0)})` })),
        { labelWidth: 22 }
      ),
    S('Chapter by chapter'),
    table(
      ['#', 'Chapter', 'Person', 'Tense', 'Whose thoughts are reported', 'Scenes'],
      a.chapters.map((c, i) => [
        i + 1,
        esc(c.title),
        c.person === 'unclear' ? '–' : c.person,
        c.tenseMarkers < 8 ? '–' : c.presentShare > 0.7 ? 'present' : c.presentShare < 0.3 ? 'past' : 'mixed',
        c.povCharacters.length ? c.povCharacters.map((x) => `${esc(x.name)} (${x.count})`).join(', ') : '–',
        c.scenes
      ]),
      ['r', 'l', 'l', 'l', 'l', 'r']
    ),
    S('Consistency checks'),
    a.pov.personFlags.length ? ['Person:', ...a.pov.personFlags.map(flagLine)].join('\n') : 'No chapter breaks the book\'s point of view.',
    a.pov.tenseFlags.length ? ['Tense:', ...a.pov.tenseFlags.map(flagLine)].join('\n') : 'No chapter drifts from the book\'s main tense.',
    a.pov.person === 'third'
      ? a.pov.headHopping.length
        ? ['Possible head-hopping (more than one character\'s thoughts or feelings reported in a single scene):', ...a.pov.headHopping.map(flagLine)].join('\n')
        : 'No scene shows more than one character\'s thoughts or feelings.'
      : false,
    a.pov.slips.length > 0 && 'Paragraphs whose narration uses the wrong person:',
    a.pov.slips.length > 0 && examples(a.pov.slips, titles),
    a.pov.tenseSlips.length > 0 && 'Paragraphs that look like they slip into another tense:',
    a.pov.tenseSlips.length > 0 && examples(a.pov.tenseSlips, titles)
  );

  // ---- characters -------------------------------------------------------------------------
  if (a.characters.length) {
    const maxM = a.characters[0].mentions;
    const shown = a.characters.slice(0, 15);
    // chapters are squeezed into at most 60 columns
    const cols = Math.min(60, a.chapters.length);
    const binOf = (ci: number) => Math.min(cols - 1, Math.floor((ci * cols) / a.chapters.length));
    const heat = shown.map((c) => {
      const bins = new Array<number>(cols).fill(0);
      c.perChapter.forEach((n, ci) => (bins[binOf(ci)] += n));
      const top = Math.max(...bins, 1);
      return `${pad(c.name, 16)} ${bins.map((n) => (n === 0 ? '·' : ' ░▒▓█'[Math.max(1, Math.min(4, Math.ceil((n / top) * 4)))])).join('')}`;
    });
    add(
      H('Characters'),
      'Names are found automatically (capitalised words that are not ordinary sentence starters), so check the list: a place or an object can appear here, and a character who is only ever called by a title may not.',
      chart(shown.map((c) => ({ label: c.name, value: c.mentions, text: num(c.mentions) })), { labelWidth: 18, max: maxM }),
      table(
        ['Character', 'Mentions', 'Per 1,000 words', 'Chapters', 'First appears', 'Dialogue lines tagged', 'Also called'],
        shown.map((c) => [
          esc(c.name),
          num(c.mentions),
          num((c.mentions / t.words) * 1000, 1),
          `${c.chapters} of ${a.chapters.length}`,
          c.firstChapter >= 0 ? `${c.firstChapter + 1}. ${esc(titles[c.firstChapter])}` : '–',
          num(c.speaks),
          c.aliases.length ? esc(c.aliases.join(', ')) : ''
        ]),
        ['l', 'r', 'r', 'r', 'l', 'r', 'l']
      ),
      a.chapters.length > 1 && S('Who appears where'),
      a.chapters.length > 1 &&
        `Each column is a chapter${cols < a.chapters.length ? ` (grouped to ${cols} columns)` : ''}; darker means more mentions, a dot means none.`,
      a.chapters.length > 1 && fence(heat)
    );
  } else {
    add(H('Characters'), 'No recurring character names were found.');
  }

  // ---- punctuation -----------------------------------------------------------------------------
  add(
    H('Punctuation habits'),
    table(
      ['Mark', 'Count', 'Per 1,000 words'],
      a.punctuation.map((p) => [p.label, num(p.count), num(p.per1000, 1)]),
      ['l', 'r', 'r']
    ),
    chart(a.punctuation.map((p) => ({ label: p.label, value: p.per1000, text: num(p.per1000, 1) })), { labelWidth: 24 })
  );

  // ---- method ---------------------------------------------------------------------------------
  add(
    H('How this was measured'),
    [
      '- **Words, sentences and paragraphs** come from the prose only: headings, scene breaks, comments and code are left out. Sentences end at . ! ? or … (not after "Mr." and similar).',
      '- **Dialogue** is whatever sits inside quotation marks. A quote that runs on into the next paragraph is followed across the break.',
      '- **Reading level** averages the Flesch–Kincaid, Gunning Fog, Coleman–Liau and ARI grade formulas (and SMOG when there are enough sentences). Syllables are estimated.',
      '- **Passive voice** is a form of "to be" followed by a past participle. States like "was tired" are not counted.',
      '- **Point of view** counts first, second and third person pronouns in narration only; speech and long italic runs (usually thoughts) are skipped. **Tense** compares was/were/had/did with is/are/am/has/does.',
      '- **Head-hopping** looks for thinking and feeling verbs (thought, felt, knew, wondered…) whose subject is a named character, and flags scenes where two characters each have several.',
      '- **Characters** are capitalised words that are rarely seen in lower case. Two names that appear together as a full name are merged.',
      '- Run the analysis again after editing: each run makes a new report beside the original.'
    ].join('\n')
  );

  return out.join('\n\n') + '\n';
}
