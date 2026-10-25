import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, analyzeCovers, coverMetrics, coverStats, latestCoverMetrics } from '../src/index.js';

const solid = (r: number, g: number, b: number, w = 200, h = 300) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();

/** Plain colour with a band of black/white stripes ("lettering") across one third. */
async function withLettering(bg: [number, number, number], band: 'top' | 'bottom') {
  const stripes = Buffer.alloc(200 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) stripes.fill(Math.floor(x / 4) % 2 ? 255 : 0, (y * 200 + x) * 3, (y * 200 + x) * 3 + 3);
  const base = sharp({ create: { width: 200, height: 300, channels: 3, background: { r: bg[0], g: bg[1], b: bg[2] } } });
  return base.composite([{ input: await sharp(stripes, { raw: { width: 200, height: 100, channels: 3 } }).png().toBuffer(), top: band === 'top' ? 0 : 200, left: 0 }]).png().toBuffer();
}

describe('coverMetrics', () => {
  it('reads brightness, hue and size from plain colours', async () => {
    const red = await coverMetrics(await solid(200, 20, 20));
    expect(red).toMatchObject({ width: 200, height: 300, aspect: 0.667, dominantHue: 'red' });
    expect(red.warmth).toBeGreaterThan(0.5);
    expect(red.contrast).toBe(0);
    expect(red.edgeDensity.overall).toBe(0);
    expect(red.hueShare.red).toBe(1);
    const blue = await coverMetrics(await solid(20, 40, 200));
    expect(blue.dominantHue).toBe('blue');
    expect(blue.warmth).toBeLessThan(-0.5);
    const white = await coverMetrics(await solid(255, 255, 255));
    expect(white).toMatchObject({ brightness: 1, dominantHue: 'neutral', saturation: 0 });
    const black = await coverMetrics(await solid(0, 0, 0));
    expect(black.brightness).toBe(0);
  });
  it('orders brightness and finds the dominant palette colour', async () => {
    const dark = await coverMetrics(await solid(20, 20, 60));
    const light = await coverMetrics(await solid(230, 230, 200));
    expect(light.brightness).toBeGreaterThan(dark.brightness);
    expect(dark.palette[0]!.share).toBe(1);
    expect(dark.palette[0]!.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('locates busy lettering by band', async () => {
    const top = await coverMetrics(await withLettering([30, 90, 160], 'top'));
    expect(top.edgeDensity.top).toBeGreaterThan(top.edgeDensity.middle);
    expect(top.edgeDensity.top).toBeGreaterThan(top.edgeDensity.bottom);
    const bottom = await coverMetrics(await withLettering([30, 90, 160], 'bottom'));
    expect(bottom.edgeDensity.bottom).toBeGreaterThan(bottom.edgeDensity.top);
    expect(bottom.contrast).toBeGreaterThan(0.1);
  });
  it('rejects non-images', async () => {
    await expect(coverMetrics(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('library covers', () => {
  const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
  const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
  let root: string;
  let lib: Library;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-cv-'));
    lib = Library.open(root);
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
    for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
  });
  afterEach(() => {
    lib.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('analyses stored covers once, skips bad files, and compares cohorts', async () => {
    lib.saveAsset('B0C1R52V2J', 'cover', await solid(200, 20, 20), 'png');
    lib.saveAsset('B0HKTD6M9Z', 'cover', await solid(20, 40, 200), 'png');
    lib.saveAsset('B0GZNJHYRW', 'cover', Buffer.from('broken'), 'jpg');
    expect(await analyzeCovers(lib.db, root)).toBe(2);
    expect(await analyzeCovers(lib.db, root)).toBe(0); // nothing new; the broken file is retried and fails again
    expect(latestCoverMetrics(lib.db, 'B0C1R52V2J')!.dominantHue).toBe('red');
    const s = coverStats(lib.db, 'amazon.com:kindle:11650864011', 1);
    expect(s.top).toMatchObject({ known: 1, dominantHues: { red: 1 } });
    expect(s.rest).toMatchObject({ known: 1, dominantHues: { blue: 1 } });
    expect(s.rest.warmth!).toBeLessThan(0);
    expect(s.books.map((b) => b.listRank)).toEqual([1, 2]);
  });
});
