import { memo, useEffect, useState, type RefObject } from 'react';
import type { BlockLines } from '../shared/lines';

/** One numbered row of the file, and where it sits in the editor. */
export interface LineMark {
  /** The row number (1-based, counted over the whole file). */
  line: number;
  /** Vertical position in the editor's content (px) and the height of one text row, for alignment. */
  top: number;
  lineHeight: number;
  /** What it belongs to: the block (formatted editor) or the file line (source editor), so Go To can place the caret. */
  block: number;
}

/** A block of the formatted editor: the file lines it covers and where it is drawn. */
export interface PlacedBlock extends BlockLines {
  top: number;
  height: number;
  lineHeight: number;
}

/**
 * A number for every row the formatted editor shows, blank lines included. A block is as many rows as its text wraps
 * to; the blank lines of the file between two blocks are a row each, spread through the space between them.
 * `firstRow` is the number of the first row. `trailing` is how many blank lines follow the last block in the file.
 */
export function lineMarksFromBlocks(blocks: PlacedBlock[], firstRow: number, trailing = 0): { marks: LineMark[]; rows: number } {
  const out: LineMark[] = [];
  let n = firstRow;
  blocks.forEach((b, i) => {
    const rows = Math.max(1, Math.round(b.height / b.lineHeight));
    for (let k = 0; k < rows; k++) out.push({ line: n++, top: b.top + (b.height / rows) * k, lineHeight: b.lineHeight, block: i });
    const next = blocks[i + 1];
    if (!next) return;
    const blanks = next.start - b.end - 1;
    if (blanks <= 0) return;
    const bottom = b.top + b.height;
    const share = (next.top - bottom) / blanks;
    for (let k = 0; k < blanks; k++) out.push({ line: n++, top: bottom + share * k + (share - b.lineHeight) / 2, lineHeight: b.lineHeight, block: i + 1 });
  });
  return { marks: out, rows: n - firstRow + trailing };
}

/** Index of the line at vertical position `y` (the last one starting at or above it), or -1. */
export function markAt(marks: LineMark[], y: number): number {
  let lo = 0;
  let hi = marks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].top <= y) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found >= 0 && found === marks.length - 1 && y > marks[found].top + marks[found].lineHeight * 2) return -1; // well below the last line
  return found;
}

interface Props {
  marks: LineMark[];
  /** How far the content is scrolled inside `host` (0 when the page itself scrolls). */
  scroll: number;
  /** The element whose pointer movement picks the hovered line. */
  host: RefObject<HTMLElement>;
}

/** Every line's number, drawn once. Multiples of 10 are always visible; the rest fade in while the pointer is over the editor. */
const Numbers = memo(function Numbers({ marks }: { marks: LineMark[] }) {
  return (
    <>
      {marks.map((m) => (
        <span key={m.line} className={`line-no${m.line % 10 === 0 ? ' ten' : ''}`} style={{ top: m.top, height: m.lineHeight, lineHeight: `${m.lineHeight}px` }}>
          {m.line}
        </span>
      ))}
    </>
  );
});

/**
 * Line numbers in the right-hand margin, outside the text. Every line has its number; every tenth is always shown,
 * the others appear while the pointer is over the editor, and the line under the pointer is picked out. Purely
 * visual: it never takes pointer events.
 */
export function LineGutter({ marks, scroll, host }: Props) {
  const [hover, setHover] = useState(-1);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const move = (e: MouseEvent) => {
      setOver(true);
      setHover(markAt(marks, e.clientY - el.getBoundingClientRect().top + scroll));
    };
    const leave = () => {
      setOver(false);
      setHover(-1);
    };
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mousemove', move);
      el.removeEventListener('mouseleave', leave);
    };
  }, [host, marks, scroll]);

  const hovered = hover >= 0 ? marks[hover] : undefined;
  return (
    <div className={`line-gutter${over ? ' all' : ''}`} aria-hidden="true">
      <div style={{ transform: `translateY(${-scroll}px)` }}>
        <Numbers marks={marks} />
        {hovered && (
          <span className="line-no one" style={{ top: hovered.top, height: hovered.lineHeight, lineHeight: `${hovered.lineHeight}px` }}>
            {hovered.line}
          </span>
        )}
      </div>
    </div>
  );
}
