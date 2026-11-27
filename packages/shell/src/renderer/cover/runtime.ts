/**
 * What the Cover Designer needs from the browser: measuring text, the fonts, the pictures, and drawing the design into a PNG. Kept out of the
 * component so it can be tested apart. In a place with no canvas (a test) measuring falls back to a fixed width per letter.
 */
import type { CoverImageData } from '../../shared/api';
import { type Design, type VaultRef } from '../../shared/cover/doc';
import { fontStack, STARTER_FONTS, SYSTEM_CANDIDATES } from '../../shared/cover/fonts';
import { paletteOf } from '../../shared/cover/hit';
import { renderSvg } from '../../shared/cover/render';
import { fixedMeasure, type Measure } from '../../shared/cover/text';

export const coverApi = () => window.cadrel.cover;

// ---- measuring -----------------------------------------------------------------------------------------------------------------

export function makeMeasure(): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return fixedMeasure;
  const c = ctx;
  return (text, s) => {
    c.font = `${s.italic ? 'italic ' : ''}${s.weight} ${Math.max(1, s.px)}px ${fontStack(s.font)}`;
    (c as unknown as { letterSpacing: string }).letterSpacing = `${s.trackingPx}px`;
    return c.measureText(text).width;
  };
}

/** Which of the usual system fonts this computer has: a font that is not there measures like the fallback, so a different width means it is. */
export function installedFonts(): string[] {
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return [];
    const sample = 'mmmmmmmmmmlliWW@#';
    const width = (font: string) => ((c.font = `72px ${font}`), c.measureText(sample).width);
    const bases = ['monospace', 'serif', 'sans-serif'];
    const base = bases.map((b) => width(b));
    return SYSTEM_CANDIDATES.filter((name) => bases.some((b, i) => width(`'${name}', ${b}`) !== base[i]));
  } catch {
    return [];
  }
}

// ---- fonts ---------------------------------------------------------------------------------------------------------------------

/** The starter fonts loaded into the page, and the same as @font-face text for putting inside an exported picture. */
export class FontBook {
  private have = new Map<string, string>();
  private style: HTMLStyleElement | null = null;
  constructor(private readonly get: (families: string[]) => Promise<{ family: string; weight: 400 | 700; dataUrl: string }[]> = (f) => coverApi().fonts(f)) {}

  async ensure(families: string[]): Promise<void> {
    const wanted = [...new Set(families)].filter((f) => STARTER_FONTS.some((s) => s.family === f) && !this.have.has(`${f}|400`) && !this.have.has(`${f}|700`));
    if (wanted.length === 0) return;
    const got = await this.get(wanted);
    for (const g of got) this.have.set(`${g.family}|${g.weight}`, `@font-face{font-family:'${g.family}';font-weight:${g.weight};font-style:normal;src:url(${g.dataUrl}) format('${g.dataUrl.startsWith('data:font/woff2') ? 'woff2' : 'truetype'}')}`);
    if (typeof document === 'undefined') return;
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.setAttribute('data-cover-fonts', '');
      document.head.appendChild(this.style);
    }
    this.style.textContent = this.css(undefined);
    await Promise.all(got.map((g) => document.fonts?.load(`${g.weight} 32px '${g.family}'`).catch(() => [])));
  }
  /** @font-face rules for these families (all loaded, when none are named). */
  css(families?: string[]): string {
    const only = families ? new Set(families) : null;
    return [...this.have.entries()].filter(([k]) => !only || only.has(k.split('|')[0]!)).map(([, v]) => v).join('');
  }
  has(family: string): boolean {
    return this.have.has(`${family}|400`) || this.have.has(`${family}|700`);
  }
  dispose(): void {
    this.style?.remove();
    this.style = null;
  }
}

// ---- pictures ------------------------------------------------------------------------------------------------------------------

export interface LoadedPicture {
  path: string;
  mime: string;
  width: number;
  height: number;
  version: number;
  hash: string;
  /** A short address for the screen. */
  url: string;
  bytes: Uint8Array;
}

/** A file's bytes. Reads with FileReader, which every browser (and the test one) has. */
export function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error('Could not read that file.'));
    r.readAsArrayBuffer(file);
  });
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the picture.'));
    r.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

/** The pictures a design uses, read from the vault once and shown from blob addresses (the picture's own bytes are sent only for an export). */
export class Pictures {
  private by = new Map<string, LoadedPicture>();
  private data = new Map<string, string>();
  private pending = new Map<string, Promise<LoadedPicture | null>>();
  constructor(private readonly read: (path: string) => Promise<CoverImageData> = (p) => coverApi().image(p)) {}

  get(path: string): LoadedPicture | undefined {
    return this.by.get(path);
  }
  /** Reads a picture (once). A picture that cannot be read is null, and the design draws a stand-in. */
  load(path: string): Promise<LoadedPicture | null> {
    const have = this.by.get(path);
    if (have) return Promise.resolve(have);
    const p = this.pending.get(path) ?? this.read(path).then(
      (d) => {
        const bytes = d.bytes instanceof Uint8Array ? d.bytes : new Uint8Array(d.bytes as ArrayBufferLike);
        const loaded: LoadedPicture = { path, mime: d.mime, width: d.width, height: d.height, version: d.version, hash: d.hash, bytes, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: d.mime })) };
        this.by.set(path, loaded);
        return loaded;
      },
      () => null
    );
    this.pending.set(path, p);
    return p.finally(() => this.pending.delete(path));
  }
  /** A picture already read, as the vault knows it, for pictures just imported. */
  add(p: LoadedPicture): void {
    this.by.set(p.path, p);
  }
  href = (ref: VaultRef): string | null => this.by.get(ref.path)?.url ?? null;
  async dataHref(ref: VaultRef): Promise<string | null> {
    const p = this.by.get(ref.path);
    if (!p) return null;
    let d = this.data.get(p.path);
    if (!d) {
      d = await bytesToDataUrl(p.bytes, p.mime);
      this.data.set(p.path, d);
    }
    return d;
  }
  dispose(): void {
    for (const p of this.by.values()) URL.revokeObjectURL(p.url);
    this.by.clear();
    this.data.clear();
  }
}

// ---- drawing -------------------------------------------------------------------------------------------------------------------

async function dataHrefs(d: Design, pics: Pictures): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const l of d.layers) if (l.type === 'image' && !l.hidden && !m.has(l.src.path)) {
    const h = await pics.dataHref(l.src);
    if (h) m.set(l.src.path, h);
  }
  return m;
}

/** Draws a design into a canvas at `scale` of its own size. The SVG is the one the screen shows, with its pictures and fonts inside it. */
export async function drawDesign(d: Design, pics: Pictures, fonts: FontBook, measure: Measure, scale = 1): Promise<HTMLCanvasElement> {
  const hrefs = await dataHrefs(d, pics);
  const svg = renderSvg(d, { measure, imageHref: (r) => hrefs.get(r.path) ?? null, fontCss: fonts.css() });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(d.canvas.w * scale));
    c.height = Math.max(1, Math.round(d.canvas.h * scale));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('This computer could not draw the cover.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const canvasPng = (c: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('Could not make the picture.'))), 'image/png'));

/** The picture a save sends: the whole canvas, and for a paperback with its regions marked the front cover alone. */
export async function renderPictures(d: Design, pics: Pictures, fonts: FontBook, measure: Measure): Promise<{ image: Uint8Array; front: Uint8Array | null }> {
  const full = await drawDesign(d, pics, fonts, measure, 1);
  const image = await canvasPng(full);
  let front: Uint8Array | null = null;
  if (d.kind === 'paperback' && d.template && d.template.front !== null) {
    const x0 = Math.round(d.template.front * full.width);
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, full.width - x0);
    crop.height = full.height;
    crop.getContext('2d')!.drawImage(full, x0, 0, crop.width, crop.height, 0, 0, crop.width, crop.height);
    front = await canvasPng(crop);
  }
  return { image, front };
}

/** A small picture of the design for the thumbnail strip: drawn once, shown at several sizes. */
export async function thumbnailUrl(d: Design, pics: Pictures, fonts: FontBook, measure: Measure, width = 320): Promise<string> {
  const c = await drawDesign(d, pics, fonts, measure, width / d.canvas.w);
  return c.toDataURL('image/png');
}

/** The colours of a picture, from a small copy of it. */
export async function paletteFromUrl(url: string, n = 6): Promise<string[]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = 48;
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, w, h);
  return paletteOf(ctx.getImageData(0, 0, w, h).data, n);
}

// ---- PDFs ----------------------------------------------------------------------------------------------------------------------

/** The first page of a PDF as a PNG at 300 dpi, longest side kept to `max` pixels (KDP's cover template comes as a PDF). */
export async function rasterisePdf(bytes: Uint8Array, max = 6000): Promise<{ png: Uint8Array; width: number; height: number; pages: number }> {
  const pdfjs: any = await import('pdfjs-dist/build/pdf.mjs');
  // run the reader's worker in this page, so no separate worker file has to be found
  await import('pdfjs-dist/build/pdf.worker.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjs.GlobalWorkerOptions.workerSrc || 'pdf.worker.mjs';
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / 72, max / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('This computer could not draw the PDF.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { png: await canvasPng(c), width: c.width, height: c.height, pages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}
