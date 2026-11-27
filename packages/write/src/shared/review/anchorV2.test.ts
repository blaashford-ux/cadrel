import { describe, expect, it } from 'vitest';
import { flattenMarkdownBlocks } from '../agent/flatten';
import { chapterKeys, splitChapters } from '../chapters';
import { makeAnchor, mergeReviewFiles, newReviewFile, type Anchor, type ReviewItem } from './comments';
import { hashText, makeAnchorV2, placeAnchor, upgradeAnchor, type ChapterText } from './anchorV2';

const flat = (md: string) => flattenMarkdownBlocks(md);
const quoteAt = (md: string, quote: string, nth = 0, chapter = 'One') => {
  const f = flat(md);
  let at = -1;
  for (let i = 0; i <= nth; i++) at = f.text.indexOf(quote, at + 1);
  return makeAnchorV2(f.text, f.blocks, at, at + quote.length, chapter);
};
const place = (md: string, a: Anchor, chapter = 'One') => {
  const f = flat(md);
  return placeAnchor(f.text, f.blocks, a, chapter);
};
const shown = (md: string, a: Anchor) => {
  const p = place(md, a);
  return p.kind === 'at' ? flat(md).text.slice(p.start, p.end) : p;
};

const CH = '# One\n\nShe said nothing.\n\nHe said no. Then he said yes.\n\nThe door said goodbye.\n';

describe('anchor v2: a note is where it is', () => {
  it('records the chapter, the paragraph, the offset in it, and the paragraph hash', () => {
    const a = quoteAt(CH, 'said no.');
    expect(a).toMatchObject({ v: 2, chapter: 'One', quote: 'said no.', block: { i: 2, off: 3 } });
    expect(a.block!.h).toBe(hashText('He said no. Then he said yes.'));
  });

  it('puts a quote that runs over paragraphs in a start and an end block', () => {
    const f = flat(CH);
    const start = f.text.indexOf('nothing');
    const end = f.text.indexOf('He said') + 7;
    const a = makeAnchorV2(f.text, f.blocks, start, end, 'One');
    expect(a.block!.i).toBe(1);
    expect(a.endBlock).toEqual({ i: 2, off: 7 });
    expect(shown(CH, a)).toBe(f.text.slice(start, end));
  });

  it('finds the one it was made on among the same word many times in the chapter', () => {
    for (let n = 0; n < 4; n++) {
      const a = quoteAt(CH, 'said', n);
      const p = place(CH, a);
      expect(p).toMatchObject({ kind: 'at', how: 'exact' });
      expect((p as { start: number }).start).toBe(a.start);
    }
  });

  it('is not drawn in another chapter, whatever words that chapter has', () => {
    const a = quoteAt(CH, 'said', 0, 'One');
    const other = '# Two\n\nShe said it again. And said so.\n';
    expect(placeAnchor(flat(other).text, flat(other).blocks, a, 'Two')).toEqual({ kind: 'elsewhere' });
  });

  it('says an old (v1) note has no place yet, and never searches for it', () => {
    const f = flat(CH);
    const old = makeAnchor(f.text, f.text.indexOf('said'), f.text.indexOf('said') + 4);
    expect(placeAnchor(f.text, f.blocks, old, 'One')).toEqual({ kind: 'unplaced' });
  });
});

describe('anchor v2: when the text moves', () => {
  it('follows its paragraph when paragraphs are added above it', () => {
    const a = quoteAt(CH, 'said', 2); // "He said no. Then he said yes." second "said"... 3rd overall
    const grown = CH.replace('# One\n\n', '# One\n\nNew first paragraph said so.\n\nAnd another said that.\n\n');
    const p = place(grown, a);
    expect(p).toMatchObject({ kind: 'at', how: 'moved' });
    const f = flat(grown);
    const at = (p as { start: number }).start;
    expect(f.text.slice(at - 8, at + 9)).toBe('Then he said yes.');
    expect(f.text.slice(at, at + 4)).toBe('said');
  });

  it('follows its paragraph when paragraphs are removed above it', () => {
    const a = quoteAt(CH, 'said goodbye');
    const shrunk = CH.replace('She said nothing.\n\n', '');
    expect(shown(shrunk, a)).toBe('said goodbye');
  });

  it('stays on its own word when the same paragraph is edited before it', () => {
    const a = quoteAt(CH, 'said yes');
    const edited = CH.replace('He said no. Then he', 'Then he sighed, said no, and then he');
    expect(place(edited, a)).toMatchObject({ kind: 'at', how: 'edited' });
    expect(shown(edited, a)).toBe('said yes');
  });

  it('keeps the note on the repeat nearest its offset when the paragraph is edited and the context is lost', () => {
    const md = '# One\n\nsaid the one and said the two.\n';
    const a = quoteAt(md, 'said', 1);
    const edited = '# One\n\nsaid the one, and said the two!!\n';
    // both sides of the context changed; a lone near repeat is taken, a far one is not
    expect(place(edited, a)).toMatchObject({ kind: 'at', how: 'edited' });
  });

  it('pins to the start of its paragraph, flagged, when its text is gone', () => {
    const a = quoteAt(CH, 'said yes');
    const gone = CH.replace('Then he said yes.', 'Then he left.');
    expect(place(gone, a)).toMatchObject({ kind: 'pinned', why: 'changed', block: 2 });
    expect((place(gone, a) as { at: number }).at).toBe(flat(gone).blocks[2]!.offset);
  });

  it('never jumps to the same word in another paragraph when its own text is gone', () => {
    const a = quoteAt(CH, 'said yes');
    const gone = CH.replace('said yes', 'nodded');
    const p = place(gone, a);
    expect(p.kind).toBe('pinned');
  });

  it('does not take a repeat that is far away and has none of its context', () => {
    const md = '# One\n\nA lone word here.\n\nThe word said.\n\nFiller filler filler filler.\n\nAnd said again.\n';
    const a = quoteAt(md, 'said', 1);
    const edited = md.replace('And said again.', 'Totally rewritten.').replace('The word said.', 'The said word, said twice.');
    expect(place(edited, a).kind).toBe('pinned');
  });

  it('follows the right twin when its paragraph is repeated and only one is in reach', () => {
    const twin = '# One\n\nX.\n\nY.\n\nSame line said.\n\nSame line said.\n';
    const a = quoteAt(twin, 'said', 0); // the first twin, block 3
    const moved = twin.replace('# One\n\n', '# One\n\nA.\n\nB.\n\nC.\n\n'); // the twins are now at 6 and 7: only 6 is within 3 of block 3
    expect(place(moved, a)).toMatchObject({ kind: 'at', how: 'moved', start: flat(moved).blocks[6]!.offset + a.block!.off });
  });

  it('pins, and does not guess, when its paragraph is repeated within reach and its number is no help', () => {
    const twin = '# One\n\nX.\n\nY.\n\nSame line said.\n\nSame line said.\n';
    const a = quoteAt(twin, 'said', 0); // block 3
    const moved = twin.replace('# One\n\n', '# One\n\nA.\n\n'); // the twins are now at 4 and 5, both in reach of block 3
    expect(place(moved, a)).toMatchObject({ kind: 'pinned', why: 'ambiguous', block: 3 });
  });

  it('keeps a note whose text was deleted, at its paragraph, and says why', () => {
    const f = flat(CH);
    const i = 2;
    const at = f.blocks[i]!.offset + 3;
    const a: Anchor = { ...makeAnchorV2(f.text, f.blocks, at, at, 'One'), quote: 'said no.', gone: true };
    expect(place(CH, a)).toMatchObject({ kind: 'pinned', why: 'gone', block: 2 });
  });
});

describe('upgrading old notes', () => {
  const doc = splitChapters('# One\n\nShe said nothing.\n\nThe river ran.\n\n# Two\n\nHe said yes.\n\nThe river ran again.\n\n# Three\n\nThe door slammed.\n', 1);
  const keys = chapterKeys(doc);
  const chapters: ChapterText[] = doc.chapters.map((c, i) => ({ key: keys[i]!.key, ...flat(c.raw) }));
  const v1 = (ci: number, quote: string): Anchor => {
    const t = chapters[ci]!.text;
    const at = t.indexOf(quote);
    return makeAnchor(t, at, at + quote.length);
  };

  it('places a note in the one chapter whose text has all of its context', () => {
    const a = upgradeAnchor(chapters, v1(1, 'said yes'))!;
    expect(a).toMatchObject({ v: 2, chapter: 'Two', quote: 'said yes' });
    expect(a.approx).toBeUndefined();
    expect(a.block!.i).toBe(1);
  });

  it('is told nothing to do for a note that already has its place in a chapter that is there', () => {
    const a = upgradeAnchor(chapters, v1(1, 'said yes'))!;
    expect(upgradeAnchor(chapters, a)).toBeNull();
  });

  it('places a v2 note whose chapter has been renamed', () => {
    const a = { ...upgradeAnchor(chapters, v1(1, 'said yes'))!, chapter: 'Old title' };
    expect(upgradeAnchor(chapters, a)).toMatchObject({ chapter: 'Two' });
  });

  it('marks a guess as one, and puts it at the start of a paragraph', () => {
    // "river ran" is in chapters 1 and 2 with the same surroundings changed: only the quote matches
    const base = v1(0, 'river ran');
    const a = upgradeAnchor(chapters, { ...base, prefix: 'xx', suffix: 'yy' })!;
    expect(a).toBeNull(); // quote in two chapters, no context to tell them apart: not guessed
    const b = upgradeAnchor(chapters, { ...base, suffix: 'yy' })!;
    expect(b).toMatchObject({ v: 2, approx: true });
    expect(place(doc.chapters[b.chapter === 'One' ? 0 : 1]!.raw, b, b.chapter)).toMatchObject({ kind: 'pinned', why: 'approx' });
  });

  it('leaves a note whose text is in no chapter alone', () => {
    expect(upgradeAnchor(chapters, { quote: 'nobody wrote this', prefix: '', suffix: '', start: 0 })).toBeNull();
  });

  it('places a note whose text was deleted by what was either side of it', () => {
    const t = chapters[1]!.text;
    const at = t.indexOf('said yes');
    const gone: Anchor = { quote: '', prefix: t.slice(0, at), suffix: t.slice(at + 8, at + 48), start: at, gone: true };
    const edited: ChapterText[] = chapters.map((c, i) => (i === 1 ? { ...c, ...flat('# Two\n\nHe .\n\nThe river ran again.\n') } : c));
    const a = upgradeAnchor(edited, gone)!;
    expect(a).toMatchObject({ v: 2, chapter: 'Two', gone: true });
    expect(place('# Two\n\nHe .\n\nThe river ran again.\n', a, 'Two')).toMatchObject({ kind: 'pinned', why: 'gone', block: 1 });
  });
});

describe('the reported bug: notes from old files, in a manuscript that has not changed', () => {
  // A beta reader's file of two chapters that use the same words. Old notes anchored as before (v1) on every "said".
  const md = '# One\n\nShe said nothing.\n\nHe said no. Then he said yes.\n\n# Two\n\nNobody said a word.\n\nHe said goodbye, said hello.\n';
  const doc = splitChapters(md, 1);
  const keys = chapterKeys(doc).map((k) => k.key);
  const chapters: ChapterText[] = doc.chapters.map((c, i) => ({ key: keys[i]!, ...flat(c.raw) }));
  const old = chapters.flatMap((c) => {
    const out: Anchor[] = [];
    for (let k = c.text.indexOf('said'); k !== -1; k = c.text.indexOf('said', k + 1)) out.push(makeAnchor(c.text, k, k + 4));
    return out;
  });

  it('puts every old note on the word it was made on, in its own chapter, and nowhere else', () => {
    expect(old).toHaveLength(6);
    const upgraded = old.map((a) => upgradeAnchor(chapters, a)!);
    upgraded.forEach((a, n) => {
      expect(a).not.toBeNull();
      expect(a.approx).toBeUndefined();
      const ci = n < 3 ? 0 : 1;
      expect(a.chapter).toBe(keys[ci]);
      chapters.forEach((c, cj) => {
        const p = placeAnchor(c.text, c.blocks, a, keys[cj]);
        if (cj !== ci) return expect(p).toEqual({ kind: 'elsewhere' });
        expect(p).toMatchObject({ kind: 'at', how: 'exact', start: old[n]!.start });
      });
    });
  });
});

describe('merging copies of a note where one was only upgraded', () => {
  const base = (anchor: Anchor, updatedAt: string): ReviewItem => ({ id: 'n', kind: 'comment', file: 'a.md', anchor, body: 'b', status: 'open', author: 'x', createdAt: '1', updatedAt, replies: [] });
  const v1 = makeAnchor('hello world', 0, 5);
  const v2 = makeAnchorV2('hello world', [{ offset: 0, length: 11 }], 0, 5, 'One');
  const file = (item: ReviewItem) => ({ ...newReviewFile('p', { id: 'r', name: 'R' }), items: [item] });

  it('keeps the place from the copy that has it, and the text and status from the newer copy', () => {
    const upgraded = base(v2, '2026-01-01T00:00:00Z');
    const answered = { ...base(v1, '2026-01-02T00:00:00Z'), status: 'resolved' as const };
    const merged = mergeReviewFiles(file(upgraded), file(answered)).items[0]!;
    expect(merged.status).toBe('resolved');
    expect(merged.anchor.v).toBe(2);
    expect(mergeReviewFiles(file(answered), file(upgraded)).items[0]!.anchor.v).toBe(2);
  });

  it('does not bring a place back onto a note whose quote was edited', () => {
    const edited = { ...v1, quote: 'hullo' };
    const merged = mergeReviewFiles(file(base(v2, '1')), file(base(edited, '2'))).items[0]!;
    expect(merged.anchor.quote).toBe('hullo');
    expect(merged.anchor.v).toBeUndefined();
  });
});
