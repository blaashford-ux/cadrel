/**
 * The Cover Designer's document (docs/COVER-DESIGNER-PLAN.md): one JSON file per design. Pure and Electron-free, so everything here is tested without a screen.
 *
 * Positions and sizes are **fractions of the canvas** (x and width of its width, y and height of its height), never pixels, so a design does not
 * care what size it is drawn or exported at. Nothing in a design is embedded: a picture is a vault file named by path and hash.
 */

export const COVER_FORMAT = 1;
export const DESIGN_SUFFIX = '.cadrel-cover.json';

export type CoverKind = 'ebook' | 'paperback';
export type Blend = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light';
export const BLENDS: readonly Blend[] = ['normal', 'multiply', 'screen', 'overlay', 'soft-light'];

/** Where a layer is: x, w are fractions of the canvas width, y, h of its height; rot is in degrees about the centre. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export interface Stop {
  at: number;
  color: string;
  opacity?: number;
}
export type Paint =
  | { type: 'solid'; color: string; opacity?: number }
  | { type: 'linear'; angle: number; stops: Stop[] }
  | { type: 'radial'; stops: Stop[] };

export interface Effects {
  opacity?: number;
  blend?: Blend;
  glow?: { color: string; size: number; strength: number };
  shadow?: { color: string; dx: number; dy: number; blur: number; opacity: number };
  outline?: { color: string; width: number };
  blur?: number;
  texture?: { id: string; strength: number; scale: number };
}

export interface VaultRef {
  path: string;
  hash: string;
}
export interface Grade {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  tint?: { color: string; strength: number };
  vignette: number;
}

interface Base {
  id: string;
  name: string;
  locked: boolean;
  hidden: boolean;
  frame: Frame;
  fx: Effects;
}
export interface ImageLayer extends Base {
  type: 'image';
  src: VaultRef;
  /** The picture's own size in pixels, so it keeps its proportions. */
  natural: { w: number; h: number };
  fit: 'cover' | 'contain';
  /** Which part of the picture shows when it is cropped to fit: 0..1 each way, 0.5 is the middle. */
  focus: { x: number; y: number };
  zoom: number;
  flipX: boolean;
  grade: Grade;
}
export interface TextLayer extends Base {
  type: 'text';
  text: string;
  font: string;
  /** Size as a fraction of the canvas height. */
  size: number;
  weight: 400 | 700;
  italic: boolean;
  upper: boolean;
  /** Letter spacing in em. */
  tracking: number;
  /** Line height as a multiple of the size. */
  leading: number;
  align: 'left' | 'center' | 'right';
  fill: Paint;
}
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'ring' | 'symbol';
export interface ShapeLayer extends Base {
  type: 'shape';
  shape: ShapeKind;
  /** The library piece, for `symbol`. */
  symbol?: string;
  fill: Paint;
  /** Corner rounding for a rectangle, as a fraction of its shorter side (0..0.5). */
  radius: number;
  /** A ring's thickness as a fraction of its shorter side. */
  thick: number;
}
export type ScrimDir = 'down' | 'up' | 'around';
/** A soft dark band behind a text layer; while `boundTo` is set it follows that layer. */
export interface ScrimLayer extends Base {
  type: 'scrim';
  boundTo: string | null;
  dir: ScrimDir;
  color: string;
  strength: number;
  pad: number;
}
export type Layer = ImageLayer | TextLayer | ShapeLayer | ScrimLayer;
export type LayerType = Layer['type'];

export interface Guide {
  axis: 'x' | 'y';
  at: number;
}
export interface TemplateRef {
  src: VaultRef;
  opacity: number;
  hidden: boolean;
  /** Where the back cover ends and the front cover starts, as fractions of the width; the spine is between. Null until marked. */
  back: number | null;
  front: number | null;
}
export interface Design {
  format: typeof COVER_FORMAT;
  kind: CoverKind;
  /** The size it is drawn at when exported, in pixels. */
  canvas: { w: number; h: number };
  background: Paint;
  layers: Layer[];
  guides: Guide[];
  template: TemplateRef | null;
  /** The fonts the design uses, so a missing one can be named. Kept by `fontsUsed`. */
  fonts: string[];
  /** The picture last saved from this design: where it is and its hash, so the picture is known to be the render of exactly this design. */
  render: { path: string; hash: string } | null;
}

export const EBOOK_SIZE = { w: 1600, h: 2560 } as const;
export const MAX_SIDE = 8000;
export const MIN_SIDE = 200;

export const uid = (prefix = 'l'): string => `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
export const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

export const solid = (color: string, opacity?: number): Paint => (opacity === undefined ? { type: 'solid', color } : { type: 'solid', color, opacity });
export const NO_GRADE: Grade = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0 };

export function newDesign(kind: CoverKind, canvas: { w: number; h: number } = EBOOK_SIZE): Design {
  return { format: COVER_FORMAT, kind, canvas: { ...canvas }, background: solid('#1b1b2a'), layers: [], guides: [], template: null, fonts: [], render: null };
}

// ---- reading and writing --------------------------------------------------------------------------------------------------------

export class DesignError extends Error {}

/** One design as the text of its file. */
export function serialize(d: Design): string {
  return JSON.stringify({ ...d, fonts: fontsUsed(d) }, null, 1);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function paintOf(v: unknown, fallback: Paint): Paint {
  const p = rec(v);
  if (p.type === 'solid' && isStr(p.color)) return { type: 'solid', color: p.color, ...(isNum(p.opacity) ? { opacity: clamp(p.opacity, 0, 1) } : {}) };
  const stops = (Array.isArray(p.stops) ? p.stops : []).map((s) => rec(s)).filter((s) => isNum(s.at) && isStr(s.color)).map((s) => ({ at: clamp(s.at as number, 0, 1), color: s.color as string, ...(isNum(s.opacity) ? { opacity: clamp(s.opacity, 0, 1) } : {}) }));
  if (stops.length >= 2) {
    if (p.type === 'linear') return { type: 'linear', angle: isNum(p.angle) ? p.angle : 180, stops };
    if (p.type === 'radial') return { type: 'radial', stops };
  }
  return fallback;
}
function frameOf(v: unknown): Frame {
  const f = rec(v);
  return { x: isNum(f.x) ? f.x : 0, y: isNum(f.y) ? f.y : 0, w: isNum(f.w) ? Math.max(0.005, f.w) : 0.2, h: isNum(f.h) ? Math.max(0.005, f.h) : 0.1, rot: isNum(f.rot) ? f.rot : 0 };
}
function fxOf(v: unknown): Effects {
  const e = rec(v);
  const out: Effects = {};
  if (isNum(e.opacity)) out.opacity = clamp(e.opacity, 0, 1);
  if (isStr(e.blend) && (BLENDS as readonly string[]).includes(e.blend)) out.blend = e.blend as Blend;
  const g = rec(e.glow);
  if (isStr(g.color) && isNum(g.size) && isNum(g.strength)) out.glow = { color: g.color, size: Math.max(0, g.size), strength: clamp(g.strength, 0, 1) };
  const s = rec(e.shadow);
  if (isStr(s.color) && isNum(s.dx) && isNum(s.dy) && isNum(s.blur) && isNum(s.opacity)) out.shadow = { color: s.color, dx: s.dx, dy: s.dy, blur: Math.max(0, s.blur), opacity: clamp(s.opacity, 0, 1) };
  const o = rec(e.outline);
  if (isStr(o.color) && isNum(o.width)) out.outline = { color: o.color, width: Math.max(0, o.width) };
  if (isNum(e.blur) && e.blur > 0) out.blur = e.blur;
  const t = rec(e.texture);
  if (isStr(t.id) && isNum(t.strength) && isNum(t.scale)) out.texture = { id: t.id, strength: clamp(t.strength, 0, 1), scale: clamp(t.scale, 0.2, 5) };
  return out;
}
function gradeOf(v: unknown): Grade {
  const g = rec(v);
  const n = (k: string) => (isNum(g[k]) ? clamp(g[k] as number, -1, 1) : 0);
  const t = rec(g.tint);
  return { brightness: n('brightness'), contrast: n('contrast'), saturation: n('saturation'), warmth: n('warmth'), vignette: isNum(g.vignette) ? clamp(g.vignette, 0, 1) : 0, ...(isStr(t.color) && isNum(t.strength) ? { tint: { color: t.color, strength: clamp(t.strength, 0, 1) } } : {}) };
}
function refOf(v: unknown): VaultRef | null {
  const r = rec(v);
  return isStr(r.path) && r.path !== '' ? { path: r.path, hash: isStr(r.hash) ? r.hash : '' } : null;
}

/** A design from the text of its file. Anything it cannot make sense of is refused with a reason; anything merely missing is given its default. */
export function parse(text: string): Design {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DesignError('This is not a Cover Designer file.');
  }
  const d = rec(raw);
  if (d.format !== COVER_FORMAT) throw new DesignError(isNum(d.format) && d.format > COVER_FORMAT ? 'This design was made by a newer Cadrel. Update Cadrel to open it.' : 'This is not a Cover Designer file.');
  const kind: CoverKind = d.kind === 'paperback' ? 'paperback' : 'ebook';
  const c = rec(d.canvas);
  const canvas = isNum(c.w) && isNum(c.h) ? { w: clamp(Math.round(c.w), MIN_SIDE, MAX_SIDE), h: clamp(Math.round(c.h), MIN_SIDE, MAX_SIDE) } : { ...EBOOK_SIZE };
  const seen = new Set<string>();
  const layers: Layer[] = [];
  for (const item of Array.isArray(d.layers) ? d.layers : []) {
    const l = rec(item);
    if (!isStr(l.id) || !/^[A-Za-z0-9_-]{1,40}$/.test(l.id) || seen.has(l.id)) continue;
    const base = { id: l.id, name: isStr(l.name) ? l.name : 'Layer', locked: l.locked === true, hidden: l.hidden === true, frame: frameOf(l.frame), fx: fxOf(l.fx) };
    if (l.type === 'image') {
      const src = refOf(l.src);
      if (!src) continue;
      const nat = rec(l.natural);
      const f = rec(l.focus);
      layers.push({ ...base, type: 'image', src, natural: { w: isNum(nat.w) && nat.w > 0 ? nat.w : 1, h: isNum(nat.h) && nat.h > 0 ? nat.h : 1 }, fit: l.fit === 'contain' ? 'contain' : 'cover', focus: { x: isNum(f.x) ? clamp(f.x, 0, 1) : 0.5, y: isNum(f.y) ? clamp(f.y, 0, 1) : 0.5 }, zoom: isNum(l.zoom) ? clamp(l.zoom, 1, 8) : 1, flipX: l.flipX === true, grade: gradeOf(l.grade) });
    } else if (l.type === 'text') {
      layers.push({ ...base, type: 'text', text: isStr(l.text) ? l.text : '', font: isStr(l.font) ? l.font : 'Cinzel', size: isNum(l.size) ? clamp(l.size, 0.005, 0.5) : 0.06, weight: l.weight === 700 ? 700 : 400, italic: l.italic === true, upper: l.upper === true, tracking: isNum(l.tracking) ? clamp(l.tracking, -0.2, 1) : 0, leading: isNum(l.leading) ? clamp(l.leading, 0.7, 3) : 1.1, align: l.align === 'left' || l.align === 'right' ? l.align : 'center', fill: paintOf(l.fill, solid('#ffffff')) });
    } else if (l.type === 'shape') {
      const shape: ShapeKind = (['rect', 'ellipse', 'line', 'ring', 'symbol'] as const).find((s) => s === l.shape) ?? 'rect';
      layers.push({ ...base, type: 'shape', shape, ...(isStr(l.symbol) ? { symbol: l.symbol } : {}), fill: paintOf(l.fill, solid('#c9a24a')), radius: isNum(l.radius) ? clamp(l.radius, 0, 0.5) : 0, thick: isNum(l.thick) ? clamp(l.thick, 0.01, 0.5) : 0.08 });
    } else if (l.type === 'scrim') {
      layers.push({ ...base, type: 'scrim', boundTo: isStr(l.boundTo) ? l.boundTo : null, dir: l.dir === 'up' || l.dir === 'around' ? l.dir : 'down', color: isStr(l.color) ? l.color : '#000000', strength: isNum(l.strength) ? clamp(l.strength, 0, 1) : 0.6, pad: isNum(l.pad) ? clamp(l.pad, 0, 1) : 0.03 });
    } else continue;
    seen.add(l.id);
  }
  const guides = (Array.isArray(d.guides) ? d.guides : []).map((g) => rec(g)).filter((g) => (g.axis === 'x' || g.axis === 'y') && isNum(g.at)).map((g) => ({ axis: g.axis as 'x' | 'y', at: clamp(g.at as number, 0, 1) }));
  const t = rec(d.template);
  const tsrc = refOf(t.src);
  const template: TemplateRef | null = tsrc ? { src: tsrc, opacity: isNum(t.opacity) ? clamp(t.opacity, 0, 1) : 0.35, hidden: t.hidden === true, back: isNum(t.back) ? clamp(t.back, 0, 1) : null, front: isNum(t.front) ? clamp(t.front, 0, 1) : null } : null;
  const design: Design = { format: COVER_FORMAT, kind, canvas, background: paintOf(d.background, solid('#1b1b2a')), layers, guides, template: kind === 'paperback' ? template : null, fonts: [], render: refOf(d.render) };
  design.fonts = fontsUsed(design);
  return syncScrims(design);
}

export function fontsUsed(d: Design): string[] {
  return [...new Set(d.layers.filter((l): l is TextLayer => l.type === 'text').map((l) => l.font))].sort();
}

// ---- layers ---------------------------------------------------------------------------------------------------------------------

export const layerOf = (d: Design, id: string): Layer | undefined => d.layers.find((l) => l.id === id);

export function addLayer(d: Design, layer: Layer, above?: string): Design {
  const i = above ? d.layers.findIndex((l) => l.id === above) : -1;
  const layers = i < 0 ? [...d.layers, layer] : [...d.layers.slice(0, i + 1), layer, ...d.layers.slice(i + 1)];
  return syncScrims({ ...d, layers });
}
export function removeLayers(d: Design, ids: readonly string[]): Design {
  const gone = new Set(ids);
  return { ...d, layers: d.layers.filter((l) => !gone.has(l.id)).map((l) => (l.type === 'scrim' && l.boundTo && gone.has(l.boundTo) ? { ...l, boundTo: null } : l)) };
}
/** Replaces fields of one layer. The type of a layer never changes. */
export function patchLayer<T extends Layer>(d: Design, id: string, patch: Partial<Omit<T, 'id' | 'type'>>): Design {
  return syncScrims({ ...d, layers: d.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) });
}
export function patchFx(d: Design, id: string, fx: Partial<Effects> | ((cur: Effects) => Effects)): Design {
  return { ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, fx: typeof fx === 'function' ? fx(l.fx) : { ...l.fx, ...fx } } : l)) };
}
export function setFrame(d: Design, id: string, frame: Partial<Frame>): Design {
  return syncScrims({ ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, frame: { ...l.frame, ...frame } } : l)) });
}
/** Moves layers by a number of fractions (not past the canvas edges by more than their own size). */
export function moveBy(d: Design, ids: readonly string[], dx: number, dy: number): Design {
  const set = new Set(ids);
  return syncScrims({ ...d, layers: d.layers.map((l) => (set.has(l.id) && !l.locked ? { ...l, frame: { ...l.frame, x: round(l.frame.x + dx), y: round(l.frame.y + dy) } } : l)) });
}
/** One step up (towards the front) or down in the stack. */
export function reorder(d: Design, id: string, step: 1 | -1 | 'front' | 'back'): Design {
  const i = d.layers.findIndex((l) => l.id === id);
  if (i < 0) return d;
  const to = step === 'front' ? d.layers.length - 1 : step === 'back' ? 0 : clamp(i + step, 0, d.layers.length - 1);
  if (to === i) return d;
  const layers = [...d.layers];
  const [x] = layers.splice(i, 1);
  layers.splice(to, 0, x!);
  return { ...d, layers };
}
export function duplicate(d: Design, id: string): { design: Design; id: string | null } {
  const l = layerOf(d, id);
  if (!l) return { design: d, id: null };
  const copy = { ...structuredClone(l), id: uid(), name: `${l.name} copy`, frame: { ...l.frame, x: round(l.frame.x + 0.03), y: round(l.frame.y + 0.02) } } as Layer;
  if (copy.type === 'scrim') copy.boundTo = null;
  return { design: addLayer(d, copy, id), id: copy.id };
}

// ---- the band behind text ----------------------------------------------------------------------------------------------------

/** A scrim that follows its text: its frame is the text's, widened by its padding. Run after any change to a frame. */
export function syncScrims(d: Design): Design {
  let changed = false;
  const layers = d.layers.map((l) => {
    if (l.type !== 'scrim' || !l.boundTo) return l;
    const t = d.layers.find((x) => x.id === l.boundTo);
    if (!t) {
      changed = true;
      return { ...l, boundTo: null };
    }
    const padX = l.pad * (d.canvas.h / d.canvas.w);
    const frame: Frame = { x: round(t.frame.x - padX), y: round(t.frame.y - l.pad), w: round(t.frame.w + 2 * padX), h: round(t.frame.h + 2 * l.pad), rot: 0 };
    if (frame.x === l.frame.x && frame.y === l.frame.y && frame.w === l.frame.w && frame.h === l.frame.h) return l;
    changed = true;
    return { ...l, frame };
  });
  return changed ? { ...d, layers } : d;
}

/** One click: a dark band behind a text layer, directly beneath it in the stack, following it until it is detached. */
export function addScrim(d: Design, textId: string, o: { dir?: ScrimDir; strength?: number; pad?: number; color?: string } = {}): { design: Design; id: string | null } {
  const t = layerOf(d, textId);
  if (!t || t.type !== 'text') return { design: d, id: null };
  const existing = d.layers.find((l): l is ScrimLayer => l.type === 'scrim' && l.boundTo === textId);
  if (existing) return { design: patchLayer<ScrimLayer>(d, existing.id, { ...o }), id: existing.id };
  const scrim: ScrimLayer = { id: uid('s'), type: 'scrim', name: `Darken behind ${t.name}`, locked: false, hidden: false, frame: { ...t.frame, rot: 0 }, fx: {}, boundTo: textId, dir: o.dir ?? 'around', color: o.color ?? '#000000', strength: o.strength ?? 0.6, pad: o.pad ?? 0.04 };
  const i = d.layers.findIndex((l) => l.id === textId);
  const layers = [...d.layers.slice(0, i), scrim, ...d.layers.slice(i)];
  return { design: syncScrims({ ...d, layers }), id: scrim.id };
}
export function detachScrim(d: Design, id: string): Design {
  return patchLayer<ScrimLayer>(d, id, { boundTo: null });
}

// ---- new layers -------------------------------------------------------------------------------------------------------------

export function newText(text: string, o: Partial<Omit<TextLayer, 'id' | 'type'>> = {}): TextLayer {
  return { id: uid('t'), type: 'text', name: text.split('\n')[0]!.slice(0, 28) || 'Text', locked: false, hidden: false, frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.1, rot: 0 }, fx: {}, text, font: 'Cinzel', size: 0.06, weight: 700, italic: false, upper: false, tracking: 0.02, leading: 1.1, align: 'center', fill: solid('#f4ead2'), ...o };
}
export function newShape(shape: ShapeKind, o: Partial<Omit<ShapeLayer, 'id' | 'type'>> = {}): ShapeLayer {
  const names: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', ring: 'Ring', symbol: 'Symbol' };
  const frame = shape === 'line' ? { x: 0.2, y: 0.5, w: 0.6, h: 0.004, rot: 0 } : { x: 0.3, y: 0.4, w: 0.4, h: 0.4 * 0.625, rot: 0 };
  return { id: uid('p'), type: 'shape', name: names[shape], locked: false, hidden: false, frame, fx: {}, shape, fill: solid('#c9a24a'), radius: 0, thick: 0.08, ...o };
}
export function newImage(src: VaultRef, natural: { w: number; h: number }, canvas: { w: number; h: number }, name = 'Picture'): ImageLayer {
  // a new picture covers the whole cover, cropped to fit; the person resizes it from there
  void canvas;
  return { id: uid('i'), type: 'image', name, locked: false, hidden: false, frame: { x: 0, y: 0, w: 1, h: 1, rot: 0 }, fx: {}, src, natural, fit: 'cover', focus: { x: 0.5, y: 0.5 }, zoom: 1, flipX: false, grade: { ...NO_GRADE } };
}

// ---- fitting ----------------------------------------------------------------------------------------------------------------

/** The rectangle of a picture inside its frame, in fractions of the frame, once `fit`, `zoom` and `focus` are applied. */
export function imageBox(l: ImageLayer, canvas: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const fw = l.frame.w * canvas.w;
  const fh = l.frame.h * canvas.h;
  const ratio = l.natural.w / l.natural.h;
  let w: number;
  let h: number;
  if ((fw / fh > ratio) === (l.fit === 'cover')) {
    w = fw;
    h = fw / ratio;
  } else {
    h = fh;
    w = fh * ratio;
  }
  w *= l.zoom;
  h *= l.zoom;
  const x = (fw - w) * (l.fit === 'cover' ? l.focus.x : 0.5);
  const y = (fh - h) * (l.fit === 'cover' ? l.focus.y : 0.5);
  return { x: x / fw, y: y / fh, w: w / fw, h: h / fh };
}
