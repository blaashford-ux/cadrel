import { describe, expect, it } from 'vitest';
import { analyzeManuscript } from './analyze';
import { renderReport, bar, sparkline } from './report';
import { parseChapter, splitSentences, syllables } from './text';

const noYield = () => Promise.resolve();
const run = (chapters: { title: string; raw: string }[]) => analyzeManuscript(chapters, { yieldNow: noYield });

describe('text parsing', () => {
  it('splits sentences without breaking on abbreviations or dialogue tags', () => {
    expect(splitSentences('Mr. Hale left. "Stop!" she cried. He ran... and ran. J. R. Smith waved.')).toEqual([
      'Mr. Hale left.',
      '"Stop!" she cried.',
      'He ran... and ran.',
      'J. R. Smith waved.'
    ]);
  });

  it('separates dialogue from narration and follows a quote across paragraphs', () => {
    const ch = parseChapter('# One\n\n"Hello there," she said. He nodded.\n\n"This goes on\n\n"and on," she said.\n\n* * *\n\nNext scene.', 'One', false);
    expect(ch.scenes).toBe(2);
    expect(ch.paragraphs[0].dialogue).toEqual(['Hello there,']);
    expect(ch.paragraphs[0].narration.join('')).toContain('she said');
    expect(ch.paragraphs[1].dialogue.join(' ')).toContain('This goes on');
    expect(ch.paragraphs[2].dialogue.join(' ')).toContain('and on,');
    expect(ch.paragraphs[2].narration.join('')).toContain('she said');
    expect(ch.paragraphs[3].scene).toBe(1);
  });

  it('ignores headings, comments, code and front matter', () => {
    const ch = parseChapter('---\ntitle: x\n---\n# T\n\n<!-- hidden note -->\n\n```\ncode here\n```\n\nReal prose.', 'T', false);
    expect(ch.paragraphs.map((p) => p.text)).toEqual(['Real prose.']);
  });

  it('counts syllables roughly', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('happy')).toBe(2);
  });
});

const rep = (s: string, n: number) => Array.from({ length: n }, () => s).join('\n\n');
const BASE = [
  {
    title: 'The Door',
    raw: `# The Door

Mara Voss felt the cold seep through her coat. She really just wanted to go home. The door was opened by a stranger. She walked slowly up the stairs, and quietly closed it behind her.

"Are you coming?" Tomas asked quietly. "It was supposed to be easy."

"It never is," Mara said. She knew that he was right. Tomas Reed laughed. "Tell me about it," he said.

* * *

Mara thought about the letter. Tomas wondered whether she had read it. The letter was written by her mother, and the letter was long.
`
  },
  {
    title: 'The Stair',
    raw: `# The Stair

Tomas walked down the stair. He felt tired. Mara followed him, and she saw that the stair was dark. The stair was long. The stair creaked.

"Careful," Mara whispered softly. "The stair is old."

"I know," Tomas said. "I really know."

I looked at them, and I wondered what I was doing here. Mara watched. Tomas watched. The house is silent now.
`
  }
];

const SAMPLE = BASE.map((c, i) => ({ title: c.title, raw: i === 0 ? rep(c.raw, 4) : rep(c.raw.replace(/^# .*\n/, ''), 4).replace(/^/, '# The Stair\n') }));

describe('analyzeManuscript', () => {
  it('measures dialogue, sentences and chapters', async () => {
    const a = await run(SAMPLE);
    expect(a.chapters).toHaveLength(2);
    expect(a.totals.words).toBeGreaterThan(100);
    expect(a.totals.dialogueWords).toBeGreaterThan(10);
    expect(a.totals.dialogueWords / a.totals.words).toBeLessThan(0.6);
    expect(a.totals.scenes).toBe(6);
    expect(a.sentenceLengths.average).toBeGreaterThan(3);
    expect(a.readability.fleschKincaid).toBeLessThan(10);
  });

  it('finds adverbs, passives, filler and filter words', async () => {
    const a = await run(SAMPLE);
    expect(a.adverbs.top.map((x) => x.word)).toEqual(expect.arrayContaining(['slowly', 'quietly', 'softly']));
    expect(a.dialogue.tagAdverbs.map((x) => x.word)).toEqual(expect.arrayContaining(['asked quietly', 'whispered softly']));
    expect(a.passive.examples.map((e) => e.mark)).toEqual(expect.arrayContaining(['was opened', 'was written']));
    expect(a.passive.examples.map((e) => e.mark)).not.toContain('was tired');
    const filler = a.wordGroups[0].items.map((x) => x.label);
    expect(filler).toEqual(expect.arrayContaining(['really', 'just']));
    const filter = a.wordGroups[1].items.map((x) => x.label);
    expect(filter).toEqual(expect.arrayContaining(['felt', 'knew', 'wondered']));
    expect(a.that.optional).toBeGreaterThanOrEqual(2);
  });

  it('finds characters and merges full names', async () => {
    const a = await run(SAMPLE);
    const names = a.characters.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Mara Voss', 'Tomas Reed']));
    const mara = a.characters.find((c) => c.name === 'Mara Voss')!;
    expect(mara.mentions).toBeGreaterThanOrEqual(7);
    expect(mara.chapters).toBe(2);
    expect(mara.speaks).toBeGreaterThanOrEqual(2);
  });

  it('detects point-of-view and tense slips', async () => {
    const a = await run(SAMPLE);
    expect(a.pov.person).toBe('third');
    expect(a.pov.tense).toBe('past');
    expect(a.chapters[1].pov.first).toBeGreaterThan(0);
    expect(a.pov.slips.length).toBeGreaterThan(0);
  });

  it('finds repeated words and phrases', async () => {
    const text = Array.from({ length: 12 }, () => 'The old lantern swayed in the wind and the lantern light fell on the stone floor.').join(' ');
    const a = await run([{ title: 'Loop', raw: `# Loop\n\n${text}\n` }]);
    expect(a.repeatedWords[0].word).toBe('lantern');
    expect(a.bigrams.map((b) => b.phrase)).toContain('old lantern');
    expect(a.trigrams.length).toBeGreaterThan(0);
    expect(a.echoes.length).toBeGreaterThan(0);
  });

  it('handles an empty file', async () => {
    const a = await run([{ title: '', raw: '' }]);
    expect(a.totals.words).toBe(0);
    expect(renderReport(a, { source: 'x.md', generated: '2026-01-01' })).toContain('no prose');
  });
});

describe('renderReport', () => {
  it('writes a Markdown report with tables, charts and every section', async () => {
    const a = await run(SAMPLE);
    const md = renderReport(a, { source: 'draft.md', generated: '2026-10-11' });
    for (const h of ['Text analysis: draft.md', 'Overview', 'Dialogue', 'Sentences and rhythm', 'Reading level', 'Repeated words', 'Repeated phrases', 'Adverbs', 'Passive voice', 'Filler, filter and crutch words', 'Point of view and tense', 'Characters', 'Punctuation habits']) {
      expect(md).toMatch(new RegExp(`^# ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    }
    expect(md).toContain('| --- |');
    expect(md).toContain('```');
    expect(md).toContain('█');
  });

  it('uses the chapter heading level so sections are chapters in the editor', async () => {
    const a = await run(SAMPLE);
    const md = renderReport(a, { source: 'd.md', generated: '2026-10-11', level: 2 });
    expect(md).toMatch(/^## Overview/m);
    expect(md).not.toMatch(/^# /m);
  });

  it('draws bars and sparklines', () => {
    expect(bar(5, 10, 10)).toBe('█████');
    expect(bar(0, 10)).toBe('');
    expect(sparkline([0, 5, 10])).toBe('▁▄█');
  });
});

describe('report page', () => {
  it('survives the round trip through the Markdown comment', async () => {
    const { embedAnalysis, extractAnalysis } = await import('./embed');
    const a = await run([{ title: 'A -- B', raw: '# A -- B\n\n"Hi --> there," Mara said -- slowly. <b>Mara</b> left.\n' }]);
    const md = renderReport(a, { source: 'x.md', generated: '2026-10-11' }) + embedAnalysis(a, { source: 'x.md', generated: '2026-10-11' });
    expect(md.trimEnd().split('\n').pop()).toMatch(/^<!-- mdedit-analysis v1 \{.*\} -->$/);
    expect(md.match(/-->/g)).toHaveLength(1); // only the comment's own end
    const back = extractAnalysis(md);
    expect(back?.meta.source).toBe('x.md');
    expect(back?.analysis.chapters[0].title).toBe('A -- B');
    expect(back?.analysis.totals.words).toBe(a.totals.words);
    expect(extractAnalysis('# Just a chapter\n\ntext')).toBeNull();
    expect(extractAnalysis('<!-- mdedit-analysis v1 {"nope":1} -->')).toBeNull();
  });

  it('does not count the embedded data as words', async () => {
    const { embedAnalysis } = await import('./embed');
    const { countWords } = await import('../words');
    const a = await run(SAMPLE);
    const md = renderReport(a, { source: 'x.md', generated: '2026-10-11' });
    expect(countWords(md + embedAnalysis(a, { source: 'x.md', generated: '2026-10-11' }))).toBe(countWords(md));
  });

  it('draws every section as a self-contained page, and escapes manuscript text', async () => {
    const { renderReportHtml } = await import('./html');
    const a = await run([
      { title: '<img src=x onerror=alert(1)>', raw: SAMPLE[0].raw.replace(/^# .*/, '# x') },
      SAMPLE[1]
    ]);
    const html = renderReportHtml(a, { source: '<script>alert(1)</script>.md', generated: '2026-10-11' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const id of ['summary', 'overview', 'dialogue', 'sentences', 'reading', 'words', 'adverbs', 'passive', 'filler', 'pov', 'characters', 'punctuation']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<svg');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('copes with an empty analysis', async () => {
    const { renderReportHtml } = await import('./html');
    const a = await run([{ title: '', raw: '' }]);
    expect(renderReportHtml(a, { source: 'e.md', generated: '2026-10-11' })).toContain('no prose');
  });
});

describe('alignment fences', () => {
  it('are not prose', async () => {
    const a = await run([{ title: 'A', raw: '# A\n\n::: center\nOne two three.\n:::\n' }]);
    expect(a.totals.words).toBe(3);
  });
});
