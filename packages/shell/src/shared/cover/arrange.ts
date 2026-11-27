/**
 * Arranging: align, distribute, stack, match, and the ready title blocks. All of it acts on the document and takes no numbers from the person.
 */
import { addLayer, clamp, layerOf, newText, round, setFrame, syncScrims, type Design, type Frame, type Layer, type TextLayer } from './doc';
import { PAIRINGS, type Pairing } from './fonts';
import { layoutText, type Measure } from './text';

export type AlignHow = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

const bounds = (ls: Layer[]) => {
  const x0 = Math.min(...ls.map((l) => l.frame.x));
  const y0 = Math.min(...ls.map((l) => l.frame.y));
  const x1 = Math.max(...ls.map((l) => l.frame.x + l.frame.w));
  const y1 = Math.max(...ls.map((l) => l.frame.y + l.frame.h));
  return { x0, y0, x1, y1 };
};
const pick = (d: Design, ids: readonly string[]) => ids.map((id) => layerOf(d, id)).filter((l): l is Layer => !!l && !l.locked);
const apply = (d: Design, patch: Map<string, Partial<Frame>>): Design =>
  syncScrims({ ...d, layers: d.layers.map((l) => (patch.has(l.id) ? { ...l, frame: { ...l.frame, ...Object.fromEntries(Object.entries(patch.get(l.id)!).map(([k, v]) => [k, round(v as number)])) } } : l)) });

/** Aligns layers to the canvas, or (with two or more) to each other. */
export function align(d: Design, ids: readonly string[], how: AlignHow, to: 'canvas' | 'selection' = 'canvas'): Design {
  const ls = pick(d, ids);
  if (ls.length === 0) return d;
  const box = to === 'selection' && ls.length > 1 ? bounds(ls) : { x0: 0, y0: 0, x1: 1, y1: 1 };
  const patch = new Map<string, Partial<Frame>>();
  for (const l of ls) {
    const f = l.frame;
    patch.set(
      l.id,
      how === 'left' ? { x: box.x0 } : how === 'right' ? { x: box.x1 - f.w } : how === 'centre' ? { x: (box.x0 + box.x1) / 2 - f.w / 2 } : how === 'top' ? { y: box.y0 } : how === 'bottom' ? { y: box.y1 - f.h } : { y: (box.y0 + box.y1) / 2 - f.h / 2 }
    );
  }
  return apply(d, patch);
}

/** Spreads three or more layers so the gaps between them are equal, keeping the first and last where they are. */
export function distribute(d: Design, ids: readonly string[], axis: 'x' | 'y'): Design {
  const ls = pick(d, ids);
  if (ls.length < 3) return d;
  const key = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = [...ls].sort((a, b) => a.frame[key] - b.frame[key]);
  const first = sorted[0]!.frame;
  const last = sorted[sorted.length - 1]!.frame;
  const total = last[key] + last[size] - first[key];
  const used = sorted.reduce((s, l) => s + l.frame[size], 0);
  const gap = (total - used) / (sorted.length - 1);
  const patch = new Map<string, Partial<Frame>>();
  let at = first[key];
  for (const l of sorted) {
    patch.set(l.id, { [key]: at });
    at += l.frame[size] + gap;
  }
  return apply(d, patch);
}

/** Stacks layers top to bottom in the order they sit on the cover, one gap apart, centred on the first. */
export function stack(d: Design, ids: readonly string[], gap = 0.02): Design {
  const ls = pick(d, ids).sort((a, b) => a.frame.y - b.frame.y);
  if (ls.length < 2) return d;
  const mid = ls[0]!.frame.x + ls[0]!.frame.w / 2;
  const patch = new Map<string, Partial<Frame>>();
  let y = ls[0]!.frame.y;
  for (const l of ls) {
    patch.set(l.id, { x: mid - l.frame.w / 2, y });
    y += l.frame.h + gap;
  }
  return apply(d, patch);
}

/** Makes layers the same width or height (or both) as the first one picked. */
export function matchSize(d: Design, ids: readonly string[], what: 'width' | 'height' | 'both'): Design {
  const ls = pick(d, ids);
  if (ls.length < 2) return d;
  const ref = ls[0]!.frame;
  const patch = new Map<string, Partial<Frame>>();
  for (const l of ls.slice(1)) patch.set(l.id, { ...(what !== 'height' ? { w: ref.w } : {}), ...(what !== 'width' ? { h: ref.h } : {}) });
  return apply(d, patch);
}

// ---- title blocks --------------------------------------------------------------------------------------------------------------

export type BlockLayout = 'high' | 'centre' | 'low';
export const LAYOUTS: readonly { id: BlockLayout; name: string }[] = [
  { id: 'high', name: 'Title high' },
  { id: 'centre', name: 'Title centred' },
  { id: 'low', name: 'Title low' }
];
export interface BlockFields {
  title: string;
  subtitle?: string;
  series?: string;
  author: string;
}

/** The biggest size on the scale at which the longest word still fits the width. */
function fitSize(layer: TextLayer, canvas: { w: number; h: number }, measure: Measure, widest: number): number {
  const probe = { ...layer };
  for (let size = layer.size; size > 0.02; size -= 0.004) {
    probe.size = size;
    const longest = Math.max(...layoutText(probe, canvas, measure).lines.map((line) => measure(line, { font: probe.font, weight: probe.weight, italic: probe.italic, px: size * canvas.h, trackingPx: probe.tracking * size * canvas.h })), 0);
    if (longest <= widest * canvas.w) return round(size);
  }
  return 0.02;
}

/**
 * Lays out a title, a line under it, a series line above it and the author's name, in a pair of fonts, as real text layers the person edits.
 * Earlier layers made by a title block (named "Title", "Subtitle", "Series line", "Author") are replaced rather than doubled.
 */
export function titleBlock(d: Design, layout: BlockLayout, pairingId: string, fields: BlockFields, measure: Measure): { design: Design; ids: string[] } {
  const pairing: Pairing = PAIRINGS.find((p) => p.id === pairingId) ?? PAIRINGS[0]!;
  const names = new Set(['Title', 'Subtitle', 'Series line', 'Author']);
  let out: Design = { ...d, layers: d.layers.filter((l) => !(l.type === 'text' && names.has(l.name))) };
  const margin = 0.08;
  const width = 1 - 2 * margin;
  const mk = (name: string, text: string, p: Pairing['title'], size: number, y: number, leading = 1.05, weight?: 400 | 700): TextLayer => {
    const base = newText(text, { name, font: p.font, weight: weight ?? p.weight, upper: p.upper, tracking: p.tracking, size, leading, frame: { x: margin, y, w: width, h: 0.1, rot: 0 } });
    return base;
  };
  const ids: string[] = [];
  const add = (l: TextLayer) => {
    const size = l.name === 'Title' ? fitSize(l, out.canvas, measure, width) : l.size;
    const fixed: TextLayer = { ...l, size, frame: { ...l.frame, h: round(layoutText({ ...l, size }, out.canvas, measure).height) } };
    out = addLayer(out, fixed);
    ids.push(fixed.id);
    return fixed;
  };
  const sizeOf = (len: number) => (len <= 12 ? 0.11 : len <= 24 ? 0.095 : 0.08);
  // measure the pieces first, then place them as one block
  const title = mk('Title', fields.title, pairing.title, sizeOf(fields.title.length), 0, 1.0);
  const tSize = fitSize(title, out.canvas, measure, width);
  const tH = layoutText({ ...title, size: tSize }, out.canvas, measure).height;
  const sub = fields.subtitle?.trim() ? mk('Subtitle', fields.subtitle.trim(), pairing.byline, 0.026, 0, 1.2) : null;
  const subH = sub ? layoutText(sub, out.canvas, measure).height : 0;
  const series = fields.series?.trim() ? mk('Series line', fields.series.trim(), pairing.byline, 0.024, 0, 1.2) : null;
  const seriesH = series ? layoutText(series, out.canvas, measure).height : 0;
  const gap = 0.018;
  const blockH = seriesH + (series ? gap : 0) + tH + (sub ? gap : 0) + subH;
  const top = layout === 'high' ? 0.07 : layout === 'centre' ? clamp(0.5 - blockH / 2, 0.05, 0.9) : clamp(0.9 - 0.12 - blockH, 0.05, 0.9);
  let y = top;
  if (series) {
    add({ ...series, frame: { ...series.frame, y: round(y) } });
    y += seriesH + gap;
  }
  add({ ...title, frame: { ...title.frame, y: round(y) } });
  y += tH + gap;
  if (sub) add({ ...sub, frame: { ...sub.frame, y: round(y) } });
  const author = mk('Author', fields.author, pairing.byline, 0.04, 0, 1.1, 700);
  const aH = layoutText(author, out.canvas, measure).height;
  add({ ...author, frame: { ...author.frame, y: round(0.95 - aH) } });
  return { design: out, ids };
}

/** Moves a layer so its centre sits on the spine of a paperback (once the regions are marked), or on the canvas centre. */
export function centreOnSpine(d: Design, id: string): Design {
  const t = d.template;
  const spine = t && t.back !== null && t.front !== null ? (t.back + t.front) / 2 : 0.5;
  const l = layerOf(d, id);
  return l ? setFrame(d, id, { x: round(spine - l.frame.w / 2) }) : d;
}
