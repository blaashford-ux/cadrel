import { describe, expect, it } from 'vitest';
import { makeAnchor } from '../shared/review/comments';
import { flattenMarkdown } from '../shared/agent/flatten';
import { chapterForNote } from './noteChapter';

const chapters = [
  '# One\n\nShe walked *slowly* to the door.\n\nThe river ran cold.\n',
  '# Two\n\nHe watched the **river** at dusk.\n\nThe river ran cold again.\n',
  '# Three\n\nNothing here.\n',
];
const anchorIn = (chapter: number, quote: string, nth = 0) => {
  const flat = flattenMarkdown(chapters[chapter]);
  let at = -1;
  for (let i = 0; i <= nth; i++) at = flat.indexOf(quote, at + 1);
  return makeAnchor(flat, at, at + quote.length);
};

describe('which chapter a note is in', () => {
  it('finds the chapter that holds the text, through formatting marks', () => {
    expect(chapterForNote(chapters, anchorIn(0, 'walked slowly'), 2)).toBe(0);
    expect(chapterForNote(chapters, anchorIn(1, 'watched the river at dusk'), 0)).toBe(1);
  });

  it('prefers the chapter whose surroundings match when the quote is in several', () => {
    expect(chapterForNote(chapters, anchorIn(0, 'The river ran cold'), 2)).toBe(0);
    expect(chapterForNote(chapters, anchorIn(1, 'The river ran cold'), 0)).toBe(1);
  });

  it('uses the open chapter when nothing tells them apart', () => {
    const bare = { quote: 'river', prefix: '', suffix: '', start: 0 };
    expect(chapterForNote(chapters, bare, 1)).toBe(1);
    expect(chapterForNote(chapters, bare, 0)).toBe(0);
  });

  it('says when the text has gone from every chapter', () => {
    expect(chapterForNote(chapters, { quote: 'a sentence nobody wrote', prefix: '', suffix: '', start: 0 }, 0)).toBeNull();
    expect(chapterForNote([], anchorIn(0, 'river'), 0)).toBeNull();
  });

  it('follows unsaved edits when given the draft of the open chapter', () => {
    const anchor = anchorIn(0, 'walked slowly');
    const moved = [...chapters];
    moved[0] = '# One\n\nThe river ran cold.\n'; // the sentence was cut from chapter 1 ...
    moved[2] = '# Three\n\nShe walked *slowly* to the door.\n'; // ... and pasted into chapter 3, unsaved
    expect(chapterForNote(moved, anchor, 2)).toBe(2);
    expect(chapterForNote(chapters, anchor, 2)).toBe(0); // before the edit it was in chapter 1
  });
});
