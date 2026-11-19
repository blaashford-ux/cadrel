import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import { encodePng, imageInfo, psdComposite } from '../src';

const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A small RGB PSD whose composite is a left-to-right red gradient over a fixed green and blue, raw or RLE. */
function psd(w: number, h: number, rle: boolean, flat = false): Uint8Array {
  const planes = [0, 1, 2].map((c) => Array.from({ length: h }, () => Array.from({ length: w }, (_v, x) => (flat ? 120 : c === 0 ? Math.round((x / Math.max(1, w - 1)) * 255) : c === 1 ? 40 : 200))));
  const head = [...text('8BPS'), ...be16(1), 0, 0, 0, 0, 0, 0, ...be16(3), ...be32(h), ...be32(w), ...be16(8), ...be16(3), ...be32(0), ...be32(0), ...be32(0)];
  if (!rle) return Uint8Array.from([...head, ...be16(0), ...planes.flat(2)]);
  const rows = planes.flat().map((r) => [r.length - 1, ...r]); // PackBits: one literal run per row
  return Uint8Array.from([...head, ...be16(1), ...rows.flatMap((r) => be16(r.length)), ...rows.flat()]);
}

describe('previews with no image library', () => {
  it('reads the composite of a PSD, raw or run-length coded, and shrinks it', () => {
    for (const rle of [false, true]) {
      const p = psdComposite(psd(8, 4, rle))!;
      expect(p).toMatchObject({ width: 8, height: 4 });
      expect([...p.rgba.subarray(0, 4)]).toEqual([0, 40, 200, 255]);
      expect([...p.rgba.subarray(7 * 4, 7 * 4 + 4)]).toEqual([255, 40, 200, 255]);
    }
    const big = psdComposite(psd(100, 50, true), 25)!;
    expect(big).toMatchObject({ width: 25, height: 13 });
  });

  it('says there is no composite when the picture is one flat colour, and refuses what it cannot read', () => {
    expect(psdComposite(psd(8, 4, false, true))).toBeNull();
    expect(psdComposite(new Uint8Array(40))).toBeNull();
    expect(psdComposite(psd(8, 4, false).subarray(0, 60))).toBeNull(); // cut short
    const cmyk = psd(8, 4, false);
    cmyk[25] = 4;
    expect(psdComposite(cmyk)).toBeNull();
  });

  it('writes a PNG that reads back: the header says its size, and the pixels survive', () => {
    const rgba = Uint8Array.from({ length: 5 * 3 * 4 }, (_v, i) => (i * 7) % 256);
    const png = encodePng({ width: 5, height: 3, rgba });
    expect(imageInfo(png)).toMatchObject({ format: 'png', width: 5, height: 3 });
    // the IDAT is zlib: rows each begin with filter byte 0
    let o = 8;
    let idat: Uint8Array | null = null;
    while (o < png.length) {
      const len = ((png[o]! << 24) | (png[o + 1]! << 16) | (png[o + 2]! << 8) | png[o + 3]!) >>> 0;
      if (String.fromCharCode(...png.subarray(o + 4, o + 8)) === 'IDAT') idat = png.subarray(o + 8, o + 8 + len);
      o += 12 + len;
    }
    const raw = unzlibSync(idat!);
    expect(raw.length).toBe(3 * (5 * 4 + 1));
    expect([...raw.subarray(1, 21)]).toEqual([...rgba.subarray(0, 20)]);
  });

  it('a large picture is split across stored blocks', () => {
    const png = encodePng({ width: 200, height: 200, rgba: new Uint8Array(200 * 200 * 4).fill(9) });
    expect(imageInfo(png)).toMatchObject({ width: 200, height: 200 });
  });
});
