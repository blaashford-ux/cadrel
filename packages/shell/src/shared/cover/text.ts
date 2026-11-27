/**
 * Text on a cover: plain words, wrapped to the layer's width. The measuring is given (the page measures with a canvas; tests with a fixed width
 * per letter), so the same words wrap the same way on screen and in the exported picture.
 */
import { type Design, type TextLayer } from './doc';

export interface MeasureSpec {
  font: string;
  weight: number;
  italic: boolean;
  /** Size in canvas pixels. */
  px: number;
  /** Letter spacing in canvas pixels. */
  trackingPx: number;
}
export type Measure = (text: string, spec: MeasureSpec) => number;

export interface Laid {
  lines: string[];
  /** Pixels. */
  px: number;
  lineH: number;
  /** The height all the lines need, as a fraction of the canvas height. */
  height: number;
}

export const shown = (l: Pick<TextLayer, 'text' | 'upper'>): string => (l.upper ? l.text.toUpperCase() : l.text);

export function layoutText(l: TextLayer, canvas: { w: number; h: number }, measure: Measure): Laid {
  const px = l.size * canvas.h;
  const spec: MeasureSpec = { font: l.font, weight: l.weight, italic: l.italic, px, trackingPx: l.tracking * px };
  const max = l.frame.w * canvas.w;
  const lines: string[] = [];
  for (const para of shown(l).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next, spec) > max) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    lines.push(line);
  }
  const lineH = px * l.leading;
  return { lines, px, lineH, height: (lineH * (lines.length - 1) + px * 1.2) / canvas.h };
}

/** Sets every text layer's frame height to what its words need (the width is the person's). Run after a change to words, font or size. */
export function fitTextFrames(d: Design, measure: Measure): Design {
  let changed = false;
  const layers = d.layers.map((l) => {
    if (l.type !== 'text') return l;
    const h = Math.round(layoutText(l, d.canvas, measure).height * 10000) / 10000;
    if (Math.abs(h - l.frame.h) < 0.0001) return l;
    changed = true;
    return { ...l, frame: { ...l.frame, h } };
  });
  return changed ? { ...d, layers } : d;
}

/** A stand-in for tests and for the server side: every letter as wide as 0.55 of the size, plus its spacing. */
export const fixedMeasure: Measure = (text, s) => text.length * (s.px * 0.55 + s.trackingPx);
