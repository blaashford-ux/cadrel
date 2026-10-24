import { describe, expect, it } from 'vitest';
import { applyMap, emptyMarks, marksToMap, mergeMarks, sanitizeMarks } from './editedMarks';

describe('edited marks', () => {
  it('records marks and unmarks with the time of the change', () => {
    const a = applyMap(emptyMarks(), { 'Book.md': ['One', 'Two'] }, 100);
    expect(marksToMap(a)).toEqual({ 'Book.md': ['One', 'Two'] });
    const b = applyMap(a, { 'Book.md': ['Two'] }, 200);
    expect(marksToMap(b)).toEqual({ 'Book.md': ['Two'] });
    expect(b.files['Book.md'].One).toEqual({ edited: false, at: 200 });
    expect(b.files['Book.md'].Two.at).toBe(100); // untouched
    expect(applyMap(b, { 'Book.md': ['Two'] }, 300)).toBe(b);
  });

  it('merges as a union: marks from both devices survive', () => {
    const phone = applyMap(emptyMarks(), { 'Book.md': ['One'] }, 100);
    const pc = applyMap(emptyMarks(), { 'Book.md': ['Two'], 'Other.md': ['X'] }, 150);
    expect(marksToMap(mergeMarks(phone, pc))).toEqual({ 'Book.md': ['One', 'Two'], 'Other.md': ['X'] });
    expect(mergeMarks(phone, pc)).toEqual(mergeMarks(pc, phone));
  });

  it('a newer unmark beats an older mark (and the reverse), so unmarking is not undone by a merge', () => {
    const marked = applyMap(emptyMarks(), { 'B.md': ['One'] }, 100);
    const unmarked = applyMap(marked, {}, 200);
    expect(marksToMap(mergeMarks(marked, unmarked))).toEqual({});
    const remarked = applyMap(unmarked, { 'B.md': ['One'] }, 300);
    expect(marksToMap(mergeMarks(unmarked, remarked))).toEqual({ 'B.md': ['One'] });
  });

  it('is sanitised', () => {
    const m = sanitizeMarks({ files: { 'A.md': { One: { edited: true, at: 5 }, Bad: { edited: 'yes', at: 1 } }, 'B.md': 'no' } });
    expect(m).toEqual({ version: 1, files: { 'A.md': { One: { edited: true, at: 5 } } } });
    expect(sanitizeMarks(null)).toEqual(emptyMarks());
  });
});
