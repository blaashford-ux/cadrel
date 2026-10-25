/**
 * Scene-break navigation for the source editor. A scene break is a Markdown thematic break
 * (`* * *`, `---`, `___`) on its own line. A "scene start" is where the text after a break begins.
 */

const BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Offsets where each scene begins (the first non-blank line after a scene break), in order. */
export function sceneStarts(text: string): number[] {
  const starts: number[] = [];
  const re = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  const lines: { text: string; offset: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0] !== '') lines.push({ text: m[0].replace(/[\r\n]+$/, ''), offset: m.index });

  let fence: string | null = null;
  let afterBreak = false;
  for (let i = 0; i < lines.length; i++) {
    const { text: line, offset } = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      if (afterBreak) starts.push(offset);
      afterBreak = false;
      continue;
    }
    if (BREAK.test(line)) {
      // `---` straight under a paragraph line is a Setext heading underline, not a scene break
      const prev = i > 0 ? lines[i - 1].text : '';
      if (/^-+[ \t]*$/.test(line.trim()) && prev.trim() !== '' && !BREAK.test(prev)) continue;
      afterBreak = true;
      continue;
    }
    if (line.trim() === '') continue;
    if (afterBreak) starts.push(offset);
    afterBreak = false;
  }
  return starts;
}

/** Start of the line containing `offset`. */
function lineStart(text: string, offset: number): number {
  const i = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1));
  return i + 1;
}

/**
 * Where the caret should go to reach the next (`1`) or previous (`-1`) scene, or null if there is
 * nowhere to go. "Previous" from the middle of a scene goes to the start of that scene; from the
 * start of a scene, to the one before it; from the first scene, to the top of the text.
 */
export function sceneTarget(text: string, caret: number, dir: 1 | -1): number | null {
  const starts = sceneStarts(text);
  if (dir === 1) return starts.find((s) => s > caret) ?? null;
  const here = lineStart(text, caret);
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < here) return starts[i];
  return here > 0 ? 0 : null;
}

/** The same rule for positions that are already scene starts (the visual editor's document). */
export function pickScene(starts: number[], blockStart: number, dir: 1 | -1, docStart = 0): number | null {
  if (dir === 1) return starts.find((s) => s > blockStart) ?? null;
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < blockStart) return starts[i];
  return blockStart > docStart ? docStart : null;
}
