/**
 * Rows: the lines you see on screen. A paragraph that wraps over five rows is five rows, and a blank line is a row of
 * its own. Rows are what the line numbers count. Only the chapter that is open can be measured exactly (the editor
 * knows where every row sits); for the others the row count is estimated by wrapping their text the same way, which
 * is close enough to number the whole file and to jump to a row in it.
 */

export interface RowEnv {
  /** Width of the text area, in px. */
  width: number;
  /** Width in px of `text` set at `scale` times the body size (headings are bigger). */
  measure(text: string, scale: number): number;
}

const HEADING_SCALE = [0, 2.1, 1.55, 1.25, 1.05, 1.05, 1.05];

/** The words of a line of Markdown as they will look, without the markers. */
function visibleText(line: string): { text: string; scale: number; indent: number } {
  let scale = 1;
  let indent = 0;
  let s = line.replace(/^\s+/, (m) => ((indent = Math.floor(m.replace(/\t/g, '    ').length / 4)), ''));
  const h = /^(#{1,6})\s+/.exec(s);
  if (h) {
    scale = HEADING_SCALE[h[1].length];
    s = s.slice(h[0].length);
  }
  s = s.replace(/^(?:>\s?)+/, () => ((indent += 1), ''));
  s = s.replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, () => ((indent += 1), ''));
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/\s+#+\s*$/, '');
  return { text: s, scale, indent };
}

/** How many rows `text` takes when wrapped greedily to the width. */
function wrap(text: string, scale: number, width: number, env: RowEnv): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const space = env.measure(' ', scale);
  let rows = 1;
  let x = 0;
  for (const w of words) {
    const wl = env.measure(w, scale);
    if (x === 0) x = wl;
    else if (x + space + wl <= width) x += space + wl;
    else {
      rows++;
      x = wl;
    }
    while (x > width) {
      // a word longer than the row breaks across rows
      rows++;
      x -= width;
    }
  }
  return rows;
}

/** Rows taken by one chapter's text: each blank line one row, each line of text as many rows as it wraps to. */
export function estimateRows(raw: string, env: RowEnv): number {
  if (raw === '') return 0;
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop(); // a final newline ends the last line, it does not add one
  let rows = 0;
  let fence = false;
  for (const l of lines) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(l)) {
      fence = !fence;
      rows += 1;
      continue;
    }
    if (l.trim() === '') rows += 1;
    else if (fence) rows += wrap(l.replace(/\t/g, '    '), 1, env.width, env);
    else {
      const v = visibleText(l);
      rows += wrap(v.text, v.scale, Math.max(40, env.width - v.indent * 28), env);
    }
  }
  return rows;
}

/** Where file row `row` is: which chapter, given each chapter's number of rows. Out-of-range rows clamp to the ends. */
export function locateRow(rows: readonly number[], row: number): { chapter: number } {
  const total = rows.reduce((a, b) => a + b, 0);
  const target = Math.min(Math.max(1, Math.floor(row)), Math.max(1, total));
  let start = 1;
  let last = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] > 0) last = i;
    if (target < start + rows[i]) return { chapter: i };
    start += rows[i];
  }
  return { chapter: last };
}
