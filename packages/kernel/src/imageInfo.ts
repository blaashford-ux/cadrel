/**
 * What an image file says about itself, read from its header with no decoding: its format, size in pixels, colour model and (for JPEG and PNG)
 * the resolution it declares. Pure and small on purpose: Preflight and the Art page need the numbers, never the pixels. Returns null for a file
 * that is not a recognised image or whose header is cut short.
 */
export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'tiff' | 'psd' | 'svg';
export type ColourModel = 'rgb' | 'cmyk' | 'grey' | 'indexed' | 'lab' | 'unknown';
export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  colour: ColourModel;
  /** Pixels per inch as declared in the file, or null when it says nothing. */
  dpi: number | null;
  bytes: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function imageInfo(b: Uint8Array): ImageInfo | null {
  const bytes = b.length;
  if (bytes >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return png(b);
  if (bytes >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (bytes >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8), colour: 'indexed', dpi: null, bytes };
  if (bytes >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (bytes >= 26 && ascii(b, 0, 4) === '8BPS') return psd(b);
  if (bytes >= 8 && ((ascii(b, 0, 2) === 'II' && b[2] === 42) || (ascii(b, 0, 2) === 'MM' && b[3] === 42))) return tiff(b);
  const head = new TextDecoder().decode(b.subarray(0, 512));
  if (/<svg[\s>]/i.test(head)) return svg(b);
  return null;
}

function png(b: Uint8Array): ImageInfo | null {
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  const type = b[25]!;
  const colour: ColourModel = type === 0 || type === 4 ? 'grey' : type === 3 ? 'indexed' : 'rgb';
  let dpi: number | null = null;
  for (let o = 8; o + 12 <= b.length; ) {
    const len = u32be(b, o);
    const name = ascii(b, o + 4, 4);
    if (name === 'pHYs' && len >= 9 && b[o + 16] === 1) dpi = Math.round(u32be(b, o + 8) * 0.0254);
    if (name === 'IDAT' || name === 'IEND') break;
    o += 12 + len;
  }
  return { format: 'png', width: u32be(b, 16), height: u32be(b, 20), colour, dpi, bytes: b.length };
}

function jpeg(b: Uint8Array): ImageInfo | null {
  let dpi: number | null = null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    const len = u16be(b, o + 2);
    if (marker === 0xe0 && ascii(b, o + 4, 4) === 'JFIF' && len >= 14) {
      const unit = b[o + 11]!;
      const x = u16be(b, o + 12);
      if (unit === 1 && x > 0) dpi = x;
      else if (unit === 2 && x > 0) dpi = Math.round(x * 2.54);
    }
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 10 > b.length) return null;
      const height = u16be(b, o + 5);
      const width = u16be(b, o + 7);
      const n = b[o + 9]!;
      return { format: 'jpeg', width, height, colour: n === 1 ? 'grey' : n === 4 ? 'cmyk' : 'rgb', dpi, bytes: b.length };
    }
    o += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  const kind = ascii(b, 12, 4);
  const bytes = b.length;
  if (kind === 'VP8 ' && bytes >= 30) return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, colour: 'rgb', dpi: null, bytes };
  if (kind === 'VP8L' && bytes >= 25) {
    const v = u32le(b, 21);
    return { format: 'webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, colour: 'rgb', dpi: null, bytes };
  }
  if (kind === 'VP8X' && bytes >= 30) return { format: 'webp', width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1, colour: 'rgb', dpi: null, bytes };
  return null;
}

const PSD_MODE: Record<number, ColourModel> = { 0: 'grey', 1: 'grey', 2: 'indexed', 3: 'rgb', 4: 'cmyk', 7: 'unknown', 8: 'grey', 9: 'lab' };
function psd(b: Uint8Array): ImageInfo {
  return { format: 'psd', width: u32be(b, 18), height: u32be(b, 14), colour: PSD_MODE[u16be(b, 24)] ?? 'unknown', dpi: null, bytes: b.length };
}

function tiff(b: Uint8Array): ImageInfo | null {
  const le = ascii(b, 0, 2) === 'II';
  const r16 = (o: number) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number) => (le ? u32le(b, o) : u32be(b, o));
  const ifd = r32(4);
  if (ifd + 2 > b.length) return null;
  const n = r16(ifd);
  let width = 0;
  let height = 0;
  let photometric = 2;
  let dpi: number | null = null;
  let unit = 2;
  let xres: number | null = null;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = r16(e);
    const type = r16(e + 2);
    const val = type === 3 ? r16(e + 8) : r32(e + 8);
    if (tag === 256) width = val;
    else if (tag === 257) height = val;
    else if (tag === 262) photometric = val;
    else if (tag === 296) unit = val;
    else if (tag === 282 && val + 8 <= b.length) xres = r32(val) / Math.max(1, r32(val + 4));
  }
  if (xres) dpi = Math.round(unit === 3 ? xres * 2.54 : xres);
  if (!width || !height) return null;
  return { format: 'tiff', width, height, colour: photometric === 5 ? 'cmyk' : photometric <= 1 ? 'grey' : photometric === 3 ? 'indexed' : photometric === 8 ? 'lab' : 'rgb', dpi, bytes: b.length };
}

function svg(b: Uint8Array): ImageInfo {
  const head = new TextDecoder().decode(b.subarray(0, 2048));
  const num = (name: string) => {
    const m = new RegExp(`\\b${name}="([\\d.]+)`).exec(head);
    return m ? Math.round(Number(m[1])) : 0;
  };
  let w = num('width');
  let h = num('height');
  if (!w || !h) {
    const vb = /viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(head);
    if (vb) (w = Math.round(Number(vb[1]))), (h = Math.round(Number(vb[2])));
  }
  return { format: 'svg', width: w, height: h, colour: 'rgb', dpi: null, bytes: b.length };
}
