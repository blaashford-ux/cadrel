import { describe, expect, it } from 'vitest';
import { bandCounts, fleschReadingEase, mean, median, mergeVoices, packagingOf, percentileRank, readerVoiceOf, spearman, stdev, syllables } from '../src/index.js';

describe('stats', () => {
  it('median, mean, stdev', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdev([1])).toBeNull();
  });
  it('spearman handles ties, direction and degenerate input', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
    expect(spearman([1, 2, 3, 4, 5], [1, 3, 2, 5, 4])).toBe(0.8);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });
  it('percentile rank and bands', () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(0.875);
    expect(percentileRank([], 1)).toBe(0);
    expect(bandCounts([1, 3, 5, 12], [{ label: 'low', from: 0, to: 4 }, { label: 'high', from: 4, to: Infinity }])).toEqual([{ label: 'low', count: 2 }, { label: 'high', count: 2 }]);
  });
  it('reading ease and syllables', () => {
    expect(syllables('the')).toBe(1);
    expect(syllables('beautiful')).toBeGreaterThanOrEqual(3);
    const easy = fleschReadingEase('The cat sat. The dog ran. We had fun. It was a good day.')!;
    const hard = fleschReadingEase('Notwithstanding considerable administrative complications, institutional representatives deliberated extensively regarding contemporary organizational transformation.')!;
    expect(easy).toBeGreaterThan(hard);
    expect(fleschReadingEase('hi')).toBeNull();
  });
});

describe('packagingOf', () => {
  const blurb = `What if the dark lord just wants a quiet life?

Fans of Terry Pratchett will love this cozy, hilarious romp!

✓ Found family
✓ Slow burn romance

Scroll up and grab your copy today. A USA Today bestseller.`;
  it('reads title shape', () => {
    expect(packagingOf('Mr. Whiskers: Lord of the Void', null).title).toMatchObject({ hasSubtitle: true, seriesInTitle: false, words: 6 });
    expect(packagingOf('Shift of Shadows (Shifter Lords Book 12)', null).title).toMatchObject({ seriesInTitle: true, hasNumber: true });
    expect(packagingOf('Plain Title', null).title.hasSubtitle).toBe(false);
  });
  it('reads blurb structure and tropes', () => {
    const m = packagingOf('Dark Lord Dating Guide', blurb).blurb;
    expect(m.paragraphs).toBe(4);
    expect(m.questions).toBe(1);
    expect(m.exclamations).toBe(1);
    expect(m.bulletLines).toBe(2);
    expect(m.callToAction).toBe(true);
    expect(m.compTitles).toBe(true);
    expect(m.prestigeClaims).toBe(true);
    expect(m.hookWords).toBe(10);
    expect(m.tropes).toEqual(expect.arrayContaining(['found family', 'slow burn', 'villain/dark lord POV', 'cozy setting', 'humour claim']));
  });
  it('copes with nothing', () => {
    const m = packagingOf(null, null);
    expect(m.blurb).toMatchObject({ chars: 0, paragraphs: 0, hookWords: null, tropes: [], readingEase: null });
  });
});

describe('readerVoiceOf', () => {
  const reviews = [
    { stars: 5, title: 'Hilarious', body: 'So funny, the pacing is great and I love the characters. Cozy vibes.' },
    { stars: 5, title: null, body: 'Funny and heartwarming. The characters are wonderful. Cozy vibes too.' },
    { stars: 2, title: 'Slow', body: 'The pacing dragged and there were typos everywhere.' },
    { stars: null, title: null, body: '' },
  ];
  it('counts theme mentions by review sentiment', () => {
    const v = readerVoiceOf(reviews);
    expect(v).toMatchObject({ reviews: 4, withText: 3, stars: { positive: 2, negative: 1, mixed: 0, unknown: 0 } });
    expect(v.themes.humor).toMatchObject({ mentions: 2, inPositive: 2, inNegative: 0, rate: 0.667 });
    expect(v.themes.pacing).toMatchObject({ mentions: 2, inPositive: 1, inNegative: 1 });
    expect(v.themes['writing/editing']!.inNegative).toBe(1);
    expect(v.topPhrases).toEqual([{ phrase: 'cozy vibes', count: 2 }]);
  });
  it('merges books', () => {
    const m = mergeVoices([readerVoiceOf(reviews), readerVoiceOf(reviews)]);
    expect(m.withText).toBe(6);
    expect(m.themes.humor!.mentions).toBe(4);
    expect(m.themes.humor!.rate).toBe(0.667);
  });
  it('handles no reviews', () => {
    expect(readerVoiceOf([])).toMatchObject({ reviews: 0, withText: 0, topPhrases: [] });
  });
});

import { contentMetrics, detectChapters, dialogueWords, openingProfile, splitSentences } from '../src/index.js';

describe('content metrics', () => {
  const book = `Chapter 1

"Not again," said the dragon. "It is Tuesday."

The baker, Mrs. Pell, sighed. She had never liked Tuesdays, and the dragon knew it. Was that fair? It was not!

Chapter 2

Nothing happened for a very long time, and then the oven went out and everyone in the whole village of Underhill pretended not to notice at all.`;

  it('measures dialogue, including quotes split across paragraphs', () => {
    expect(dialogueWords('"Hello there," she said.')).toBe(2);
    expect(dialogueWords('He said, “Come in.” Then “Sit down.”')).toBe(4);
    expect(dialogueWords('"First paragraph here.\n\n"Second paragraph," she said.')).toBe(5);
    expect(dialogueWords('No speech at all.')).toBe(0);
  });
  it('splits sentences on terminal punctuation followed by a capital', () => {
    expect(splitSentences('One. Two! Three? "Four." Five')).toHaveLength(5);
    expect(splitSentences('Mr. smith went. Then left.').length).toBeGreaterThan(0);
  });
  it('finds chapters', () => {
    const c = detectChapters(book);
    expect(c.map((x) => x.title)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(c[0]!.end).toBe(c[1]!.start);
    expect(detectChapters('PROLOGUE\n\nText\n\n7\n\nMore')).toHaveLength(2);
  });
  it('profiles the opening', () => {
    const o = openingProfile(book);
    expect(o.startsWithDialogue).toBe(true); // the "Chapter 1" heading is skipped
    expect(openingProfile('"Run," she said. "Now."').startsWithDialogue).toBe(true);
    expect(o.questions).toBe(1);
    expect(o.exclamations).toBe(1);
    expect(o.properNounsPer100).toBeGreaterThan(0);
    expect(o.firstSentence).toBe('"Not again," said the dragon.');
    expect(openingProfile('I think I know. You do not.').firstPersonPer100).toBeGreaterThan(40);
  });
  it('summarises a whole text', () => {
    const m = contentMetrics(book);
    expect(m.chapters.count).toBe(2);
    expect(m.words).toBeGreaterThan(50);
    expect(m.dialogueShare).toBeGreaterThan(0.05);
    expect(m.dialogueShare).toBeLessThan(0.4);
    expect(m.sentenceLength.shortShare).toBeGreaterThan(0);
    expect(m.readingEase).toBeGreaterThan(30);
    expect(m.basis).toBe('manuscript');
    expect(contentMetrics('Hi.', { basis: 'sample' })).toMatchObject({ basis: 'sample', readingEase: null });
    expect(contentMetrics('')).toMatchObject({ words: 0, sentences: 0 });
  });
});
