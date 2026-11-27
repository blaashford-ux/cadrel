/**
 * A design as one SVG. The editor shows this and the exporter draws this into the picture it saves, so what is on screen is what is exported.
 * The SVG is made from the document alone: pictures come in by a function (a short blob address for the screen, the picture itself for the
 * export), and the measuring of text is given, so the same words wrap in both.
 */
import { clamp, imageBox, type Design, type ImageLayer, type Layer, type ScrimLayer, type ShapeLayer, type TextLayer } from './doc';
import { colour, esc, fillAttrs, filterFor, needsFilter, paintDef, paintColour } from './fx';
import { fontStack } from './fonts';
import { libraryItem } from './library';
import { layoutText, type Measure } from './text';

export interface RenderOptions {
  measure: Measure;
  /** The address of a vault picture, or null when it is not here (it is drawn as a grey stand-in). */
  imageHref: (ref: { path: string; hash: string }) => string | null;
  /** @font-face rules to put inside the picture, so an exported text uses the same font as on screen. */
  fontCss?: string;
  /** The paperback template, drawn over everything at its own opacity. Only the editor asks for it; an export never does. */
  withTemplate?: boolean;
  /** Draw hidden layers' placeholder? Never. Layers with `hidden` are skipped. */
}

const f = (v: number): string => String(Math.round(v * 100) / 100);

function frameBox(l: Layer, d: Design) {
  return { x: l.frame.x * d.canvas.w, y: l.frame.y * d.canvas.h, w: l.frame.w * d.canvas.w, h: l.frame.h * d.canvas.h };
}
const rotate = (l: Layer, b: { x: number; y: number; w: number; h: number }): string => (l.frame.rot ? ` transform="rotate(${f(l.frame.rot)} ${f(b.x + b.w / 2)} ${f(b.y + b.h / 2)})"` : '');

function gradeFilter(id: string, l: ImageLayer): string {
  const g = l.grade;
  if (!g.brightness && !g.contrast && !g.saturation && !g.warmth) return '';
  const slope = 1 + g.contrast;
  const intercept = 0.5 - 0.5 * slope + g.brightness * 0.5;
  const w = g.warmth * 0.18;
  return `<filter id="gr-${id}" color-interpolation-filters="sRGB" x="0" y="0" width="1" height="1"><feColorMatrix type="saturate" values="${f(clamp(1 + g.saturation, 0, 2))}"/><feColorMatrix type="matrix" values="${f(1 + w)} 0 0 0 0  0 1 0 0 0  0 0 ${f(1 - w)} 0 0  0 0 0 1 0"/><feComponentTransfer><feFuncR type="linear" slope="${f(slope)}" intercept="${f(intercept)}"/><feFuncG type="linear" slope="${f(slope)}" intercept="${f(intercept)}"/><feFuncB type="linear" slope="${f(slope)}" intercept="${f(intercept)}"/></feComponentTransfer></filter>`;
}

function imageXml(l: ImageLayer, d: Design, o: RenderOptions, defs: string[]): string {
  const b = frameBox(l, d);
  const href = o.imageHref(l.src);
  defs.push(`<clipPath id="cl-${l.id}"><rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}"/></clipPath>`);
  const gf = gradeFilter(l.id, l);
  if (gf) defs.push(gf);
  if (!href) return `<g clip-path="url(#cl-${l.id})"><rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="#8a8a96"/></g>`;
  const box = imageBox(l, d.canvas);
  const ix = b.x + box.x * b.w;
  const iy = b.y + box.y * b.h;
  const iw = box.w * b.w;
  const ih = box.h * b.h;
  const flip = l.flipX ? ` transform="translate(${f(ix * 2 + iw)} 0) scale(-1 1)"` : '';
  let out = `<g clip-path="url(#cl-${l.id})"><image href="${esc(href)}" x="${f(ix)}" y="${f(iy)}" width="${f(iw)}" height="${f(ih)}" preserveAspectRatio="none"${gf ? ` filter="url(#gr-${l.id})"` : ''}${flip}/>`;
  if (l.grade.tint && l.grade.tint.strength > 0) out += `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="${colour(l.grade.tint.color)}" fill-opacity="${f(l.grade.tint.strength)}"/>`;
  if (l.grade.vignette > 0) {
    defs.push(`<radialGradient id="vg-${l.id}" cx="0.5" cy="0.5" r="0.75"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${f(l.grade.vignette)}"/></radialGradient>`);
    out += `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="url(#vg-${l.id})"/>`;
  }
  return `${out}</g>`;
}

function textXml(l: TextLayer, d: Design, o: RenderOptions, defs: string[]): string {
  const b = frameBox(l, d);
  const laid = layoutText(l, d.canvas, o.measure);
  const def = paintDef(`pt-${l.id}`, l.fill);
  if (def) defs.push(def);
  const track = l.tracking * laid.px;
  const anchor = l.align === 'left' ? 'start' : l.align === 'right' ? 'end' : 'middle';
  // SVG puts the letter spacing after the last letter too, so a centred or right-aligned line is nudged back by it
  const x = l.align === 'left' ? b.x : l.align === 'right' ? b.x + b.w + track : b.x + b.w / 2 + track / 2;
  const stroke = l.fx.outline && l.fx.outline.width > 0 ? ` stroke="${colour(l.fx.outline.color)}" stroke-width="${f(l.fx.outline.width * d.canvas.h)}" stroke-linejoin="round" paint-order="stroke"` : '';
  const spans = laid.lines.map((line, i) => `<tspan x="${f(x)}" y="${f(b.y + laid.px * 0.92 + i * laid.lineH)}">${esc(line) || '&#160;'}</tspan>`).join('');
  return `<text font-family="${esc(fontStack(l.font))}" font-size="${f(laid.px)}" font-weight="${l.weight}" font-style="${l.italic ? 'italic' : 'normal'}" letter-spacing="${f(track)}" text-anchor="${anchor}" ${fillAttrs(`pt-${l.id}`, l.fill)}${stroke} xml:space="preserve">${spans}</text>`;
}

function shapeXml(l: ShapeLayer, d: Design, defs: string[]): string {
  const b = frameBox(l, d);
  const def = paintDef(`pt-${l.id}`, l.fill);
  if (def) defs.push(def);
  const fill = fillAttrs(`pt-${l.id}`, l.fill);
  const o = l.fx.outline && l.fx.outline.width > 0 ? ` stroke="${colour(l.fx.outline.color)}" stroke-width="${f(l.fx.outline.width * d.canvas.h)}" stroke-linejoin="round"` : '';
  const short = Math.min(b.w, b.h);
  switch (l.shape) {
    case 'rect':
    case 'line':
      return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="${f(l.shape === 'rect' ? l.radius * short : 0)}" ${fill}${o}/>`;
    case 'ellipse':
      return `<ellipse cx="${f(b.x + b.w / 2)}" cy="${f(b.y + b.h / 2)}" rx="${f(b.w / 2)}" ry="${f(b.h / 2)}" ${fill}${o}/>`;
    case 'ring': {
      const t = l.thick * short;
      // a ring is an ellipse outline drawn in the fill's colour (or its first stop's, for a gradient)
      return `<ellipse cx="${f(b.x + b.w / 2)}" cy="${f(b.y + b.h / 2)}" rx="${f(Math.max(0.5, b.w / 2 - t / 2))}" ry="${f(Math.max(0.5, b.h / 2 - t / 2))}" fill="none" stroke="${l.fill.type === 'solid' ? colour(l.fill.color) : `url(#pt-${l.id})`}" stroke-width="${f(t)}"/>`;
    }
    case 'symbol': {
      const item = libraryItem(l.symbol ?? '');
      if (!item) return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="none" stroke="#c33" stroke-dasharray="6 4"/>`;
      const s = Math.min(b.w / item.vb.w, b.h / item.vb.h);
      const tx = b.x + (b.w - item.vb.w * s) / 2;
      const ty = b.y + (b.h - item.vb.h * s) / 2;
      return `<path d="${item.d}" transform="translate(${f(tx)} ${f(ty)}) scale(${f(s)})" ${fill}${item.evenodd ? ' fill-rule="evenodd"' : ''}${o ? o.replace(/stroke-width="([\d.]+)"/, (_m, w) => `stroke-width="${f(Number(w) / s)}"`) : ''}/>`;
    }
  }
}

function scrimXml(l: ScrimLayer, d: Design, defs: string[]): string {
  const b = frameBox(l, d);
  const c = colour(l.color);
  const s = clamp(l.strength, 0, 1);
  const id = `pt-${l.id}`;
  if (l.dir === 'around') {
    defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${c}" stop-opacity="${f(s)}"/><stop offset="0.55" stop-color="${c}" stop-opacity="${f(s * 0.85)}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`);
  } else {
    const [y1, y2] = l.dir === 'down' ? [0, 1] : [1, 0];
    defs.push(`<linearGradient id="${id}" x1="0" y1="${y1}" x2="0" y2="${y2}"><stop offset="0" stop-color="${c}" stop-opacity="${f(s)}"/><stop offset="0.6" stop-color="${c}" stop-opacity="${f(s * 0.6)}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`);
  }
  return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="url(#${id})"/>`;
}

export function layerXml(l: Layer, d: Design, o: RenderOptions, defs: string[]): string {
  const b = frameBox(l, d);
  const content = l.type === 'image' ? imageXml(l, d, o, defs) : l.type === 'text' ? textXml(l, d, o, defs) : l.type === 'shape' ? shapeXml(l, d, defs) : scrimXml(l, d, defs);
  const filt = filterFor(l.id, l.fx, d.canvas, b);
  if (filt) defs.push(filt);
  const attrs = [
    `id="layer-${esc(l.id)}"`,
    l.fx.opacity !== undefined && l.fx.opacity < 1 ? `opacity="${f(l.fx.opacity)}"` : '',
    l.fx.blend && l.fx.blend !== 'normal' ? `style="mix-blend-mode:${l.fx.blend}"` : '',
    needsFilter(l.fx) && filt ? `filter="url(#fx-${l.id})"` : ''
  ].filter(Boolean).join(' ');
  const rot = rotate(l, b);
  return rot ? `<g ${attrs}><g${rot}>${content}</g></g>` : `<g ${attrs}>${content}</g>`;
}

/** The whole design as an SVG document, at the canvas's own pixel size. */
export function renderSvg(d: Design, o: RenderOptions): string {
  const defs: string[] = [];
  const bgDef = paintDef('bg', d.background);
  if (bgDef) defs.push(bgDef);
  const body = d.layers.filter((l) => !l.hidden).map((l) => layerXml(l, d, o, defs)).join('');
  let overlay = '';
  if (o.withTemplate && d.template && !d.template.hidden) {
    const href = o.imageHref(d.template.src);
    if (href) overlay = `<image id="template" href="${esc(href)}" x="0" y="0" width="${d.canvas.w}" height="${d.canvas.h}" preserveAspectRatio="none" opacity="${f(d.template.opacity)}" pointer-events="none"/>`;
  }
  const css = o.fontCss ? `<style>${o.fontCss.replace(/<\/style/gi, '')}</style>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${d.canvas.w} ${d.canvas.h}" width="${d.canvas.w}" height="${d.canvas.h}">` +
    `<defs>${css}${defs.join('')}</defs>` +
    `<rect width="${d.canvas.w}" height="${d.canvas.h}" ${fillAttrs('bg', d.background)}/>` +
    body +
    overlay +
    `</svg>`
  );
}

/** What a layer's colour is, for the layer list's little swatch. */
export function swatchOf(l: Layer): string {
  return l.type === 'text' || l.type === 'shape' ? paintColour(l.fill) : l.type === 'scrim' ? l.color : '#8a8a96';
}
