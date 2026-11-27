/**
 * Effects as SVG filters, and paints as SVG gradients. Strings only; the same text is drawn on screen and drawn into the exported picture.
 * Sizes in an effect (glow size, shadow offset and blur, outline width, blur) are **fractions of the canvas height**.
 */
import type { Effects, Paint, Stop } from './doc';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Only colours that are colours reach the picture. */
export function colour(c: string, fallback = '#000000'): string {
  const t = String(c).trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(t) || /^rgba?\([\d\s.,%/]+\)$/.test(t) || /^[a-zA-Z]{3,20}$/.test(t) ? t : fallback;
}
const n = (v: number): string => String(Math.round(v * 1000) / 1000);

export interface TextureInfo {
  id: string;
  name: string;
  /** What it looks like, in a few words. */
  note: string;
}
export const TEXTURES: readonly TextureInfo[] = [
  { id: 'grain', name: 'Film grain', note: 'Fine speckle' },
  { id: 'paper', name: 'Paper', note: 'Soft, uneven fibre' },
  { id: 'brushed', name: 'Brushed metal', note: 'Fine horizontal streaks' },
  { id: 'foil', name: 'Foil', note: 'Light and dark bands, as if stamped' },
  { id: 'stone', name: 'Stone', note: 'Rough, mottled' },
  { id: 'cloth', name: 'Cloth', note: 'A woven grid' },
  { id: 'distress', name: 'Worn and scratched', note: 'Paint worn away in patches' }
];

/** How far past a layer's frame its effects reach, as a fraction of the canvas height. */
export function reach(fx: Effects): number {
  const g = fx.glow ? fx.glow.size * 3 : 0;
  const s = fx.shadow ? fx.shadow.blur * 3 + Math.max(Math.abs(fx.shadow.dx), Math.abs(fx.shadow.dy)) : 0;
  const b = fx.blur ? fx.blur * 3 : 0;
  const o = fx.outline ? fx.outline.width : 0;
  return Math.max(g, s, b, o, 0.01);
}
export const needsFilter = (fx: Effects): boolean => !!(fx.glow || fx.shadow || fx.blur || fx.texture);

function textureBlock(t: NonNullable<Effects['texture']>, scale: number): { svg: string; out: string } | null {
  const k = Math.max(0.2, t.scale);
  const s = Math.min(1, Math.max(0, t.strength));
  const f = (v: number) => n((v / k) / scale);
  const gray = '<feColorMatrix in="noise" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" result="gray"/>';
  const curve = (slope: number, mid: number) => {
    const a = s * slope;
    return `<feComponentTransfer in="gray" result="curve"><feFuncR type="linear" slope="${n(a)}" intercept="${n(mid - a * 0.5)}"/><feFuncG type="linear" slope="${n(a)}" intercept="${n(mid - a * 0.5)}"/><feFuncB type="linear" slope="${n(a)}" intercept="${n(mid - a * 0.5)}"/></feComponentTransfer>`;
  };
  const multiply = (noise: string, slope: number) => ({
    svg: `${noise}${gray}${curve(slope, 1 - s * 0.4)}<feComposite in="curve" in2="SourceAlpha" operator="in" result="texmask"/><feBlend in="texmask" in2="SourceGraphic" mode="multiply" result="textured"/>`,
    out: 'textured'
  });
  switch (t.id) {
    case 'grain': return multiply(`<feTurbulence type="fractalNoise" baseFrequency="${f(0.9)}" numOctaves="2" seed="3" result="noise"/>`, 2.6);
    case 'paper': return multiply(`<feTurbulence type="fractalNoise" baseFrequency="${f(0.35)}" numOctaves="4" seed="7" result="noise"/>`, 2.2);
    case 'brushed': return multiply(`<feTurbulence type="fractalNoise" baseFrequency="${f(0.004)} ${f(0.9)}" numOctaves="3" seed="11" result="noise"/>`, 3);
    case 'stone': return multiply(`<feTurbulence type="turbulence" baseFrequency="${f(0.03)}" numOctaves="4" seed="5" result="noise"/>`, 3.4);
    case 'cloth':
      return {
        svg: `<feTurbulence type="fractalNoise" baseFrequency="${f(0.004)} ${f(0.8)}" numOctaves="2" seed="2" result="noiseA"/><feTurbulence type="fractalNoise" baseFrequency="${f(0.8)} ${f(0.004)}" numOctaves="2" seed="9" result="noiseB"/><feBlend in="noiseA" in2="noiseB" mode="multiply" result="noise"/>${gray}${curve(3.2, 1 - s * 0.35)}<feComposite in="curve" in2="SourceAlpha" operator="in" result="texmask"/><feBlend in="texmask" in2="SourceGraphic" mode="multiply" result="textured"/>`,
        out: 'textured'
      };
    case 'foil': {
      const a = s * 3;
      return {
        svg: `<feTurbulence type="fractalNoise" baseFrequency="${f(0.012)} ${f(0.02)}" numOctaves="3" seed="4" result="noise"/>${gray}<feComponentTransfer in="gray" result="curve"><feFuncR type="linear" slope="${n(a)}" intercept="${n(0.5 - a * 0.5)}"/><feFuncG type="linear" slope="${n(a)}" intercept="${n(0.5 - a * 0.5)}"/><feFuncB type="linear" slope="${n(a)}" intercept="${n(0.5 - a * 0.5)}"/></feComponentTransfer><feComposite in="curve" in2="SourceAlpha" operator="in" result="texmask"/><feBlend in="texmask" in2="SourceGraphic" mode="overlay" result="textured"/>`,
        out: 'textured'
      };
    }
    case 'distress': {
      const thresh = 0.8 - 0.28 * s;
      return {
        svg: `<feTurbulence type="fractalNoise" baseFrequency="${f(0.02)} ${f(0.03)}" numOctaves="4" seed="13" result="noise"/><feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -14 0 0 0 ${n(14 * thresh)}" result="keep"/><feComposite in="SourceGraphic" in2="keep" operator="in" result="textured"/>`,
        out: 'textured'
      };
    }
    default: return null;
  }
}

/**
 * The filter for one layer, or '' when it needs none. `scale` is canvas pixels per unit (1: the canvas is drawn at its own size);
 * `box` is the layer's frame in canvas pixels, and the filter reaches past it by what its effects need.
 */
export function filterFor(id: string, fx: Effects, canvas: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }): string {
  if (!needsFilter(fx)) return '';
  const H = canvas.h;
  const r = reach(fx) * H;
  const parts: string[] = [];
  let main = 'SourceGraphic';
  if (fx.texture) {
    const t = textureBlock(fx.texture, 1);
    if (t) {
      parts.push(t.svg);
      main = t.out;
    }
  }
  const under: string[] = [];
  if (fx.shadow) {
    const s = fx.shadow;
    parts.push(
      `<feGaussianBlur in="${main}" stdDeviation="${n(s.blur * H)}" result="shBlur"/><feOffset in="shBlur" dx="${n(s.dx * H)}" dy="${n(s.dy * H)}" result="shOff"/><feFlood flood-color="${colour(s.color)}" flood-opacity="${n(s.opacity)}" result="shCol"/><feComposite in="shCol" in2="shOff" operator="in" result="shadow"/>`
    );
    under.push('shadow');
  }
  if (fx.glow) {
    const g = fx.glow;
    // a glow is a blurred copy of the shape's own outline in the glow colour; strength above 0.5 stacks it for a brighter halo
    parts.push(
      `<feGaussianBlur in="${main}" stdDeviation="${n(g.size * H)}" result="glBlur"/><feFlood flood-color="${colour(g.color)}" result="glCol"/><feComposite in="glCol" in2="glBlur" operator="in" result="glSoft"/><feComponentTransfer in="glSoft" result="glow"><feFuncA type="linear" slope="${n(0.4 + g.strength * 2.6)}" intercept="0"/></feComponentTransfer>`
    );
    under.push('glow');
  }
  const merge = [...under, main].map((x) => `<feMergeNode in="${x}"/>`).join('');
  parts.push(`<feMerge result="merged">${merge}</feMerge>`);
  if (fx.blur) parts.push(`<feGaussianBlur in="merged" stdDeviation="${n(fx.blur * H)}"/>`);
  return `<filter id="fx-${id}" filterUnits="userSpaceOnUse" x="${n(box.x - r)}" y="${n(box.y - r)}" width="${n(box.w + 2 * r)}" height="${n(box.h + 2 * r)}" color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
}

// ---- paints --------------------------------------------------------------------------------------------------------------------

const stopXml = (s: Stop): string => `<stop offset="${n(s.at)}" stop-color="${colour(s.color)}"${s.opacity !== undefined && s.opacity < 1 ? ` stop-opacity="${n(s.opacity)}"` : ''}/>`;

/** The gradient a paint needs (or ''), and how to point at it from a fill. */
export function paintDef(id: string, p: Paint): string {
  if (p.type === 'solid') return '';
  if (p.type === 'radial') return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${p.stops.map(stopXml).join('')}</radialGradient>`;
  // CSS-style angle: 180 is top to bottom, 90 left to right
  const a = ((p.angle - 90) * Math.PI) / 180;
  const dx = Math.cos(a) / 2;
  const dy = Math.sin(a) / 2;
  return `<linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${p.stops.map(stopXml).join('')}</linearGradient>`;
}
export function fillAttrs(id: string, p: Paint): string {
  if (p.type === 'solid') return `fill="${colour(p.color)}"${p.opacity !== undefined && p.opacity < 1 ? ` fill-opacity="${n(p.opacity)}"` : ''}`;
  return `fill="url(#${id})"`;
}
/** A flat colour that stands for a paint (its first stop), for places that need one. */
export const paintColour = (p: Paint): string => (p.type === 'solid' ? p.color : p.stops[0]?.color ?? '#000000');
