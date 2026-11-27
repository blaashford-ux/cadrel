/** Picking and handles for the editor: which layer is under a point, where the handles are, and the palette of a picture. Pure. */
import type { Design, Frame, Layer } from './doc';
import type { Handle } from './snap';

/** A point (fractions of the canvas) expressed in a frame's own, unrotated space; inside the frame it is within 0..1 on each axis. */
export function toLocal(f: Frame, canvas: { w: number; h: number }, x: number, y: number): { u: number; v: number } {
  const cx = (f.x + f.w / 2) * canvas.w;
  const cy = (f.y + f.h / 2) * canvas.h;
  const a = (-f.rot * Math.PI) / 180;
  const dx = x * canvas.w - cx;
  const dy = y * canvas.h - cy;
  const rx = dx * Math.cos(a) - dy * Math.sin(a);
  const ry = dx * Math.sin(a) + dy * Math.cos(a);
  return { u: rx / (f.w * canvas.w) + 0.5, v: ry / (f.h * canvas.h) + 0.5 };
}

/** The topmost layer you can pick at a point: visible, not locked, and not a darkening band (those are picked only when nothing else is there). */
export function hitTest(d: Design, x: number, y: number, slack = 0): Layer | null {
  const pick = (l: Layer) => {
    if (l.hidden || l.locked) return false;
    const { u, v } = toLocal(l.frame, d.canvas, x, y);
    const sx = slack / (l.frame.w * d.canvas.w);
    const sy = slack / (l.frame.h * d.canvas.h);
    return u >= -sx && u <= 1 + sx && v >= -sy && v <= 1 + sy;
  };
  const stack = [...d.layers].reverse();
  return stack.find((l) => l.type !== 'scrim' && pick(l)) ?? stack.find((l) => l.type === 'scrim' && pick(l)) ?? null;
}

/** The layers wholly or partly inside a rectangle (fractions), for marquee selection. */
export function inRect(d: Design, r: { x: number; y: number; w: number; h: number }): Layer[] {
  return d.layers.filter((l) => !l.hidden && !l.locked && l.type !== 'scrim' && l.frame.x < r.x + r.w && l.frame.x + l.frame.w > r.x && l.frame.y < r.y + r.h && l.frame.y + l.frame.h > r.y);
}

export const HANDLES: readonly { id: Handle; u: number; v: number }[] = [
  { id: 'nw', u: 0, v: 0 }, { id: 'n', u: 0.5, v: 0 }, { id: 'ne', u: 1, v: 0 },
  { id: 'e', u: 1, v: 0.5 }, { id: 'se', u: 1, v: 1 }, { id: 's', u: 0.5, v: 1 },
  { id: 'sw', u: 0, v: 1 }, { id: 'w', u: 0, v: 0.5 }
];

/** Which handle (or the rotation knob) a point is on, within `reach` canvas pixels, or null. */
export function handleAt(f: Frame, canvas: { w: number; h: number }, x: number, y: number, reach: number): Handle | 'rotate' | null {
  const { u, v } = toLocal(f, canvas, x, y);
  const px = (du: number, dv: number) => Math.hypot(du * f.w * canvas.w, dv * f.h * canvas.h);
  if (px(u - 0.5, v + reach * 3.2 / (f.h * canvas.h)) <= reach * 1.1) return 'rotate';
  for (const h of HANDLES) if (px(u - h.u, v - h.v) <= reach) return h.id;
  return null;
}

/** Rotation that clings to multiples of 15 degrees when within 4 of one. */
export function snapAngle(deg: number): number {
  const n = ((deg % 360) + 360) % 360;
  const near = Math.round(n / 15) * 15;
  return Math.abs(n - near) <= 4 ? (near === 360 ? 0 : near) : Math.round(n * 10) / 10;
}

/** The union of layers' frames. */
export function unionFrame(ls: Layer[]): Frame | null {
  if (ls.length === 0) return null;
  const x0 = Math.min(...ls.map((l) => l.frame.x));
  const y0 = Math.min(...ls.map((l) => l.frame.y));
  const x1 = Math.max(...ls.map((l) => l.frame.x + l.frame.w));
  const y1 = Math.max(...ls.map((l) => l.frame.y + l.frame.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot: 0 };
}

// ---- the palette of a picture --------------------------------------------------------------------------------------------------

const hex = (n: number) => n.toString(16).padStart(2, '0');
/**
 * Up to `n` colours that stand for a picture, from its pixels (RGBA, any size; sample a small copy): pixels are grouped into coarse colour
 * cells and the busiest cells that are not too near each other win. Greys that are nearly black or white come last so colour leads.
 */
export function paletteOf(rgba: Uint8ClampedArray | Uint8Array, n = 6): string[] {
  const cells = new Map<number, { r: number; g: number; b: number; c: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const c = cells.get(key) ?? { r: 0, g: 0, b: 0, c: 0 };
    c.r += r; c.g += g; c.b += b; c.c++;
    cells.set(key, c);
  }
  const score = (c: { r: number; g: number; b: number; c: number }) => {
    const r = c.r / c.c, g = c.g / c.c, b = c.b / c.c;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    return c.c * (0.5 + sat / 255);
  };
  const ranked = [...cells.values()].sort((a, b) => score(b) - score(a));
  const out: { r: number; g: number; b: number }[] = [];
  for (const c of ranked) {
    const col = { r: c.r / c.c, g: c.g / c.c, b: c.b / c.c };
    if (out.every((o) => Math.hypot(o.r - col.r, o.g - col.g, o.b - col.b) > 48)) out.push(col);
    if (out.length === n) break;
  }
  return out.map((c) => `#${hex(Math.round(c.r))}${hex(Math.round(c.g))}${hex(Math.round(c.b))}`);
}
