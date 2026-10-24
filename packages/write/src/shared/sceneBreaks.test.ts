import { describe, expect, it } from 'vitest';
import { pickScene, sceneStarts, sceneTarget } from './sceneBreaks';

const text = ['# Ch', '', 'one a', 'one b', '', '* * *', '', 'two', '', '---', 'three', '', '___', '', '```', '* * *', '```', 'four', ''].join('\n');
const at = (needle: string) => text.indexOf(needle);

describe('sceneStarts', () => {
  it('finds the first line after each break, in order', () => {
    expect(sceneStarts(text)).toEqual([at('two'), at('three'), at('```')]);
  });
  it('ignores breaks inside code fences and Setext underlines', () => {
    expect(sceneStarts('para\n---\nnext\n')).toEqual([]);
    expect(sceneStarts('a\n\n```\n---\n\n```\nb\n')).toEqual([]);
  });
  it('handles CRLF and a break with nothing after it', () => {
    expect(sceneStarts('a\r\n\r\n***\r\n\r\nb\r\n')).toEqual([12]);
    expect(sceneStarts('a\n\n***\n')).toEqual([]);
  });
  it('accepts spaced and long breaks', () => {
    expect(sceneStarts('a\n\n- - -\n\nb\n\n*****\n\nc')).toEqual([10, 20]);
  });
});

describe('sceneTarget', () => {
  it('moves forward scene by scene and stops at the last one', () => {
    const a = sceneTarget(text, at('one a'), 1)!;
    expect(a).toBe(at('two'));
    const b = sceneTarget(text, a, 1)!;
    expect(b).toBe(at('three'));
    const c = sceneTarget(text, b, 1)!;
    expect(c).toBe(at('```'));
    expect(sceneTarget(text, c, 1)).toBeNull();
  });
  it('goes back to the start of the current scene first, then the previous one', () => {
    const lines = 'x\n\n***\n\nfirst\nsecond\n';
    expect(sceneTarget(lines, lines.indexOf('second') + 2, -1)).toBe(lines.indexOf('first'));
    expect(sceneTarget(text, at('three') + 2, -1)).toBe(at('two'));
    expect(sceneTarget(text, at('three'), -1)).toBe(at('two'));
    expect(sceneTarget(text, at('two'), -1)).toBe(0);
    expect(sceneTarget(text, 0, -1)).toBeNull();
  });
  it('from the break line itself, next is the scene below it', () => {
    expect(sceneTarget(text, at('* * *'), 1)).toBe(at('two'));
  });
});

describe('pickScene', () => {
  it('works on block positions', () => {
    expect(pickScene([10, 20], 0, 1)).toBe(10);
    expect(pickScene([10, 20], 10, 1)).toBe(20);
    expect(pickScene([10, 20], 20, 1)).toBeNull();
    expect(pickScene([10, 20], 20, -1)).toBe(10);
    expect(pickScene([10, 20], 10, -1)).toBe(0);
    expect(pickScene([10, 20], 0, -1)).toBeNull();
  });
});
