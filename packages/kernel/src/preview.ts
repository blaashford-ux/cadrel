/**
 * Previews that need no image library: the flattened picture a Photoshop file carries inside it, shrunk, and a PNG written from raw pixels so
 * the app can show it. The picture is the "composite" a PSD stores when Photoshop's Maximize Compatibility is on; without it the file's own data
 * is blank and `psdComposite` says so by returning null (the Art page then asks for a linked preview image instead). Pure and dependency-free.
 */
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits each, row by row. */
  rgba: Uint8Array;
}

/** One PackBits-coded row into `out` (length `n`); returns false if the row is cut short. */
function unpackRow(src: Uint8Array, from: number, to: number, out: Uint8Array, n: number): boolean {
  let i = from;
  let o = 0;
  while (o < n && i < to) {
    const c = (src[i++]! << 24) >> 24;
    if (c >= 0) {
      for (let k = 0; k <= c && o < n; k++) out[o++] = src[i++] ?? 0;
    } else if (c !== -128) {
      const v = src[i++] ?? 0;
      for (let k = 0; k < 1 - c && o < n; k++) out[o++] = v;
    }
  }
  return o === n;
}

/**
 * The composite image of a PSD, shrunk so its longest side is at most `maxSide`. 8-bit RGB and grey only. Null for anything else, for a file that
 * is cut short, or when the composite is absent (every pixel the same flat colour as a file saved without the compatibility picture).
 */
export function psdComposite(b: Uint8Array, maxSide = 800): Pixels | null {
  if (b.length < 30 || String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) !== '8BPS' || u16(b, 4) !== 1) return null;
  const channels = u16(b, 12);
  const height = u32(b, 14);
  const width = u32(b, 18);
  const depth = u16(b, 22);
  const mode = u16(b, 24);
  if (depth !== 8 || (mode !== 3 && mode !== 1) || channels < (mode === 3 ? 3 : 1) || !width || !height) return null;
  let o = 26;
  for (let i = 0; i < 3; i++) {
    if (o + 4 > b.length) return null;
    o += 4 + u32(b, o); // colour mode data, image resources, layer and mask information
  }
  if (o + 2 > b.length) return null;
  const compression = u16(b, o);
  o += 2;
  if (compression !== 0 && compression !== 1) return null;
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const ow = Math.ceil(width / scale);
  const oh = Math.ceil(height / scale);
  const rgba = new Uint8Array(ow * oh * 4);
  // where each channel's row starts
  const rowStart = (ch: number, y: number): [number, number] | null => (compression === 0 ? [o + (ch * height + y) * width, o + (ch * height + y + 1) * width] : null);
  const table = o;
  const dataStart = o + channels * height * 2;
  const rleStarts: number[] | null = compression === 1 ? [] : null;
  if (rleStarts) {
    if (dataStart > b.length) return null;
    let at = dataStart;
    for (let i = 0; i < channels * height; i++) {
      rleStarts.push(at);
      at += u16(b, table + i * 2);
    }
    rleStarts.push(at);
  }
  const need = mode === 3 ? 3 : 1;
  const row = new Uint8Array(width);
  let flat = true;
  for (let oy = 0; oy < oh; oy++) {
    const y = Math.min(oy * scale, height - 1);
    for (let ch = 0; ch < need; ch++) {
      if (rleStarts) {
        const k = ch * height + y;
        if (!unpackRow(b, rleStarts[k]!, rleStarts[k + 1]!, row, width)) return null;
      } else {
        const r = rowStart(ch, y)!;
        if (r[1] > b.length) return null;
        row.set(b.subarray(r[0], r[1]));
      }
      for (let ox = 0; ox < ow; ox++) {
        const v = row[Math.min(ox * scale, width - 1)]!;
        const p = (oy * ow + ox) * 4;
        if (mode === 1) (rgba[p] = v), (rgba[p + 1] = v), (rgba[p + 2] = v);
        else rgba[p + ch] = v;
      }
    }
    for (let ox = 0; ox < ow; ox++) rgba[(oy * ow + ox) * 4 + 3] = 255;
  }
  for (let i = 4; i < rgba.length && flat; i += 4) if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2]) flat = false;
  return flat ? null : { width: ow, height: oh, rgba };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A PNG of raw RGBA pixels, using uncompressed deflate blocks (large, but it needs nothing and previews are small). */
export function encodePng(p: Pixels): Uint8Array {
  const stride = p.width * 4 + 1;
  const raw = new Uint8Array(stride * p.height);
  for (let y = 0; y < p.height; y++) raw.set(p.rgba.subarray(y * p.width * 4, (y + 1) * p.width * 4), y * stride + 1);
  // zlib: header, stored blocks of up to 65535 bytes, adler32
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let zo = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
    z[zo++] = i === blocks - 1 ? 1 : 0;
    z[zo++] = part.length & 255;
    z[zo++] = part.length >> 8;
    z[zo++] = ~part.length & 255;
    z[zo++] = (~part.length >> 8) & 255;
    z.set(part, zo);
    zo += part.length;
  }
  let a = 1;
  let bsum = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65521;
    bsum = (bsum + a) % 65521;
  }
  z.set(be32(((bsum << 16) | a) >>> 0), zo);
  const chunk = (type: string, data: Uint8Array): number[] => {
    const body = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(data, 4);
    return [...be32(data.length), ...body, ...be32(crc32(body))];
  };
  const ihdr = Uint8Array.from([...be32(p.width), ...be32(p.height), 8, 6, 0, 0, 0]);
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', ihdr), ...chunk('IDAT', z), ...chunk('IEND', new Uint8Array(0))]);
}
