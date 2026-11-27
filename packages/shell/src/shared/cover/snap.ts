/**
 * Smart layout: what a layer snaps to while it is moved or resized, as guide lines, and the short scale type sizes are chosen from.
 * Everything is in fractions of the canvas; nobody types a number. Rotation is ignored (a layer snaps by its unrotated frame).
 */
import type { Design, Frame, Layer } from './doc';

export type SnapKind = 'edge' | 'centre' | 'third' | 'golden' | 'margin' | 'layer' | 'guide' | 'gap' | 'region';
export interface SnapLine {
  axis: 'x' | 'y';
  at: number;
  kind: SnapKind;
}

/** How close, in fractions of the canvas, counts as "on" a line. */
export const SNAP_AT = 0.012;
/** The inset retailers may crop and titles should stay inside. */
export const SAFE_MARGIN = 0.06;

const GOLD = 0.381966;

/** The lines a layer can snap to: the canvas's edges, centre, thirds, golden lines and margin; the person's own guides; the template's regions; other layers. */
export function linesFor(d: Design, exclude: readonly string[] = [], margin = SAFE_MARGIN): SnapLine[] {
  const out: SnapLine[] = [];
  const both = (at: number, kind: SnapKind) => out.push({ axis: 'x', at, kind }, { axis: 'y', at, kind });
  both(0, 'edge');
  both(1, 'edge');
  both(0.5, 'centre');
  both(1 / 3, 'third');
  both(2 / 3, 'third');
  both(GOLD, 'golden');
  both(1 - GOLD, 'golden');
  both(margin, 'margin');
  both(1 - margin, 'margin');
  for (const g of d.guides) out.push({ axis: g.axis, at: g.at, kind: 'guide' });
  const t = d.template;
  if (t && !t.hidden) {
    for (const at of [t.back, t.front]) if (at !== null) out.push({ axis: 'x', at, kind: 'region' });
    if (t.back !== null && t.front !== null) out.push({ axis: 'x', at: (t.back + t.front) / 2, kind: 'region' });
  }
  const skip = new Set(exclude);
  for (const l of d.layers) {
    if (skip.has(l.id) || l.hidden || l.type === 'scrim') continue;
    out.push({ axis: 'x', at: l.frame.x, kind: 'layer' }, { axis: 'x', at: l.frame.x + l.frame.w / 2, kind: 'layer' }, { axis: 'x', at: l.frame.x + l.frame.w, kind: 'layer' });
    out.push({ axis: 'y', at: l.frame.y, kind: 'layer' }, { axis: 'y', at: l.frame.y + l.frame.h / 2, kind: 'layer' }, { axis: 'y', at: l.frame.y + l.frame.h, kind: 'layer' });
  }
  return out;
}

const PRIORITY: Record<SnapKind, number> = { guide: 0, region: 0, centre: 1, margin: 2, edge: 2, layer: 3, third: 4, golden: 5, gap: 1 };

function best(candidates: number[], lines: SnapLine[], axis: 'x' | 'y', threshold: number): { shift: number; line: SnapLine } | null {
  let pick: { shift: number; line: SnapLine; d: number } | null = null;
  for (const c of candidates) {
    for (const ln of lines) {
      if (ln.axis !== axis) continue;
      const diff = ln.at - c;
      const d = Math.abs(diff);
      if (d > threshold) continue;
      // nearest wins; on a tie the more meaningful line does
      if (!pick || d < pick.d - 1e-9 || (Math.abs(d - pick.d) <= 1e-9 && PRIORITY[ln.kind] < PRIORITY[pick.line.kind])) pick = { shift: diff, line: ln, d };
    }
  }
  return pick ? { shift: pick.shift, line: pick.line } : null;
}

export interface Snapped {
  frame: Frame;
  /** The lines it is now on, to draw. */
  hits: SnapLine[];
}

/** Where a moved frame ends up: its left, middle and right (top, middle and bottom) are tried against every line. */
export function snapMove(frame: Frame, lines: SnapLine[], threshold = SNAP_AT): Snapped {
  const hits: SnapLine[] = [];
  let { x, y } = frame;
  const sx = best([frame.x, frame.x + frame.w / 2, frame.x + frame.w], lines, 'x', threshold);
  if (sx) {
    x += sx.shift;
    hits.push(sx.line);
  }
  const sy = best([frame.y, frame.y + frame.h / 2, frame.y + frame.h], lines, 'y', threshold);
  if (sy) {
    y += sy.shift;
    hits.push(sy.line);
  }
  return { frame: { ...frame, x, y }, hits };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const MIN = 0.01;

/**
 * Where a resized frame ends up. The edges the handle moves snap to lines; with `ratio` (width over height, in canvas fractions) the other
 * dimension follows, so a picture or symbol keeps its proportions.
 */
export function snapResize(frame: Frame, handle: Handle, lines: SnapLine[], threshold = SNAP_AT, ratio?: number): Snapped {
  const hits: SnapLine[] = [];
  let { x, y, w, h } = frame;
  let right = x + w;
  let bottom = y + h;
  if (handle.includes('w')) {
    const s = best([x], lines, 'x', threshold);
    if (s) (x += s.shift), hits.push(s.line);
    w = right - x;
  }
  if (handle.includes('e')) {
    const s = best([right], lines, 'x', threshold);
    if (s) (right += s.shift), hits.push(s.line);
    w = right - x;
  }
  if (handle.includes('n')) {
    const s = best([y], lines, 'y', threshold);
    if (s) (y += s.shift), hits.push(s.line);
    h = bottom - y;
  }
  if (handle.includes('s')) {
    const s = best([bottom], lines, 'y', threshold);
    if (s) (bottom += s.shift), hits.push(s.line);
    h = bottom - y;
  }
  w = Math.max(MIN, w);
  h = Math.max(MIN, h);
  if (ratio && handle.length === 2) {
    // a corner: follow the dimension that moved most
    const byW = Math.abs(w - frame.w) / frame.w >= Math.abs(h - frame.h) / frame.h;
    if (byW) h = w / ratio;
    else w = h * ratio;
    if (handle.includes('w')) x = frame.x + frame.w - w;
    if (handle.includes('n')) y = frame.y + frame.h - h;
  } else if (ratio) {
    if (handle === 'e' || handle === 'w') {
      h = w / ratio;
      y = frame.y + (frame.h - h) / 2;
      if (handle === 'w') x = frame.x + frame.w - w;
    } else {
      w = h * ratio;
      x = frame.x + (frame.w - w) / 2;
      if (handle === 'n') y = frame.y + frame.h - h;
    }
  } else {
    if (handle.includes('w')) x = frame.x + frame.w - w;
    if (handle.includes('n')) y = frame.y + frame.h - h;
  }
  return { frame: { ...frame, x, y, w, h }, hits };
}

/**
 * Equal gaps: if a moved frame sits between two others (left and right, or above and below), it snaps to the middle of the gap; and if
 * two other layers are a gap apart, it snaps to be that same gap from them. Applied after `snapMove` and only where no line was hit.
 */
export function snapGaps(frame: Frame, others: Layer[], threshold = SNAP_AT): Snapped {
  const hits: SnapLine[] = [];
  let { x, y } = frame;
  const overlapY = (o: Frame) => o.y < frame.y + frame.h && o.y + o.h > frame.y;
  const overlapX = (o: Frame) => o.x < frame.x + frame.w && o.x + o.w > frame.x;
  const row = others.map((l) => l.frame).filter(overlapY).sort((a, b) => a.x - b.x);
  const left = [...row].reverse().find((o) => o.x + o.w <= frame.x + 1e-9);
  const right = row.find((o) => o.x >= frame.x + frame.w - 1e-9);
  if (left && right) {
    const gap = (right.x - (left.x + left.w) - frame.w) / 2;
    const want = left.x + left.w + gap;
    if (gap >= 0 && Math.abs(want - frame.x) <= threshold) (x = want), hits.push({ axis: 'x', at: want + frame.w / 2, kind: 'gap' });
  } else if (left && row.length >= 2) {
    // the gap between the two layers nearest on that side, kept
    const i = row.indexOf(left);
    const before = row[i - 1];
    if (before) {
      const g = left.x - (before.x + before.w);
      const want = left.x + left.w + g;
      if (g > 0 && Math.abs(want - frame.x) <= threshold) (x = want), hits.push({ axis: 'x', at: want, kind: 'gap' });
    }
  }
  const col = others.map((l) => l.frame).filter(overlapX).sort((a, b) => a.y - b.y);
  const above = [...col].reverse().find((o) => o.y + o.h <= frame.y + 1e-9);
  const below = col.find((o) => o.y >= frame.y + frame.h - 1e-9);
  if (above && below) {
    const gap = (below.y - (above.y + above.h) - frame.h) / 2;
    const want = above.y + above.h + gap;
    if (gap >= 0 && Math.abs(want - frame.y) <= threshold) (y = want), hits.push({ axis: 'y', at: want + frame.h / 2, kind: 'gap' });
  } else if (above && col.length >= 2) {
    const i = col.indexOf(above);
    const before = col[i - 1];
    if (before) {
      const g = above.y - (before.y + before.h);
      const want = above.y + above.h + g;
      if (g > 0 && Math.abs(want - frame.y) <= threshold) (y = want), hits.push({ axis: 'y', at: want, kind: 'gap' });
    }
  }
  return { frame: { ...frame, x, y }, hits };
}

/** Move with every kind of snap: lines first, then equal gaps for whichever axis found no line. */
export function snapAll(frame: Frame, d: Design, exclude: readonly string[], opts: { margin?: number; threshold?: number } = {}): Snapped {
  const t = opts.threshold ?? SNAP_AT;
  const lines = linesFor(d, exclude, opts.margin);
  const first = snapMove(frame, lines, t);
  const onX = first.hits.some((h) => h.axis === 'x');
  const onY = first.hits.some((h) => h.axis === 'y');
  if (onX && onY) return first;
  const skip = new Set(exclude);
  const gaps = snapGaps(first.frame, d.layers.filter((l) => !skip.has(l.id) && !l.hidden && l.type !== 'scrim'), t);
  const f = { ...first.frame, x: onX ? first.frame.x : gaps.frame.x, y: onY ? first.frame.y : gaps.frame.y };
  return { frame: f, hits: [...first.hits, ...gaps.hits.filter((h) => (h.axis === 'x' ? !onX : !onY))] };
}

// ---- type sizes ----------------------------------------------------------------------------------------------------------------

/** Sizes of type as fractions of the cover's height. People choose from these; they do not type a number. */
export const SCALES = [
  { id: 'xs', name: 'Tiny', size: 0.016 },
  { id: 's', name: 'Small', size: 0.026 },
  { id: 'm', name: 'Medium', size: 0.04 },
  { id: 'l', name: 'Large', size: 0.06 },
  { id: 'xl', name: 'Big', size: 0.085 },
  { id: 'xxl', name: 'Huge', size: 0.12 },
  { id: 'hero', name: 'Title-sized', size: 0.17 }
] as const;
export type ScaleId = (typeof SCALES)[number]['id'];
export const nearestScale = (size: number): (typeof SCALES)[number] => SCALES.reduce((a, b) => (Math.abs(b.size - size) < Math.abs(a.size - size) ? b : a));
/** A step up or down the scale from a size. */
export function stepScale(size: number, step: 1 | -1): number {
  const i = SCALES.findIndex((s) => s.id === nearestScale(size).id);
  return SCALES[Math.min(SCALES.length - 1, Math.max(0, i + step))]!.size;
}
