import { describe, expect, it } from 'vitest';
import { locateAnchor, makeAnchor } from '../src/index';

const TEXT = 'The river ran cold.\n\nShe walked slowly to the river and stopped. The river was loud.';

describe('text anchors', () => {
  it('makes an anchor with the text either side and finds it where it was', () => {
    const start = TEXT.indexOf('walked slowly');
    const a = makeAnchor(TEXT, start, start + 'walked slowly'.length);
    expect(a).toMatchObject({ quote: 'walked slowly', start, prefix: 'The river ran cold.\n\nShe ' });
    expect(locateAnchor(TEXT, a)).toEqual({ start, end: start + 13, how: 'same-place' });
  });

  it('follows the passage when text is added before it', () => {
    const start = TEXT.indexOf('walked slowly');
    const a = makeAnchor(TEXT, start, start + 13);
    const later = 'A new first paragraph.\n\n' + TEXT;
    const at = locateAnchor(later, a)!;
    expect(later.slice(at.start, at.end)).toBe('walked slowly');
    expect(at.how).toBe('moved');
  });

  it('picks the right one of several identical quotes by the text around it', () => {
    const second = TEXT.indexOf('river', TEXT.indexOf('walked'));
    const a = makeAnchor(TEXT, second, second + 5);
    const later = 'Intro. ' + TEXT;
    const at = locateAnchor(later, a)!;
    expect(at.start).toBe(second + 'Intro. '.length);
  });

  it('prefers the nearest of equally good matches', () => {
    const t = 'cat. dog. cat. dog. cat.';
    const a = { quote: 'cat', prefix: '', suffix: '', start: 18 };
    expect(locateAnchor(t, a)!.start).toBe(20);
  });

  it('finds a passage that was re-wrapped, mapping back to the real positions', () => {
    const a = { quote: 'She walked slowly to the river', prefix: '', suffix: '', start: 21 };
    const wrapped = 'The river ran cold.\n\nShe walked\nslowly   to the\nriver and stopped.';
    const at = locateAnchor(wrapped, a)!;
    expect(at.how).toBe('reflowed');
    expect(wrapped.slice(at.start, at.end)).toBe('She walked\nslowly   to the\nriver');
  });

  it('says so when the passage is gone', () => {
    const a = makeAnchor(TEXT, 21, 34);
    expect(locateAnchor('Completely rewritten.', a)).toBeNull();
    expect(locateAnchor(TEXT, { quote: '', prefix: '', suffix: '', start: 0 })).toBeNull();
    expect(locateAnchor(TEXT, { quote: '   ', prefix: '', suffix: '', start: 0 })).toBeNull();
  });
});
