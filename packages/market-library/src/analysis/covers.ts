import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { mean } from '@cadrel/market-core';
import type { Db } from '../schema.js';
import { categoryBooks, type CategoryBook } from '../category.js';

export const HUE_FAMILIES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type HueFamily = (typeof HUE_FAMILIES)[number] | 'neutral';

export interface CoverMetrics {
  width: number;
  height: number;
  aspect: number;
  /** Mean luma, 0 (black) to 1 (white). */
  brightness: number;
  /** Standard deviation of luma: how much light/dark contrast the cover has. */
  contrast: number;
  /** Mean HSV saturation, 0 to 1. */
  saturation: number;
  /** Positive = warm (red/orange), negative = cool (blue). Range -1 to 1. */
  warmth: number;
  dominantHue: HueFamily;
  /** Share of colourful pixels in each hue family. */
  hueShare: Record<string, number>;
  /** Up to five dominant colours, as hex with their share of pixels. */
  palette: { hex: string; share: number }[];
  /**
   * Share of strong edges overall and per band. A proxy for how busy the cover is and where lettering sits;
   * it does not read text.
   */
  edgeDensity: { overall: number; top: number; middle: number; bottom: number };
}

const SIZE = 96;

function hueFamily(h: number): (typeof HUE_FAMILIES)[number] {
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 295) return 'purple';
  return 'pink';
}

const r2 = (x: number) => Math.round(x * 1000) / 1000;

export async function coverMetrics(image: Buffer): Promise<CoverMetrics> {
  const meta = await sharp(image).metadata();
  const { data, info } = await sharp(image).removeAlpha().resize({ width: SIZE, height: Math.round(SIZE * 1.5), fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, n = W * H;
  const luma = new Float32Array(n);
  let sumL = 0, sumS = 0, warm = 0;
  const hueW: Record<string, number> = {};
  let colourful = 0;
  const bins = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = data[i * 3]!, g = data[i * 3 + 1]!, b = data[i * 3 + 2]!;
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    luma[i] = l;
    sumL += l;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const s = max === 0 ? 0 : d / max;
    sumS += s;
    warm += (r - b) / 255;
    if (s > 0.25 && max > 40) {
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const f = hueFamily(h);
      hueW[f] = (hueW[f] ?? 0) + s;
      colourful++;
    }
    const q = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
    bins.set(q, (bins.get(q) ?? 0) + 1);
  }
  const mL = sumL / n;
  let varL = 0;
  for (const l of luma) varL += (l - mL) ** 2;
  const mS = sumS / n;

  const hueTotal = Object.values(hueW).reduce((a, b) => a + b, 0);
  const hueShare = Object.fromEntries(HUE_FAMILIES.map((f) => [f, hueTotal ? r2((hueW[f] ?? 0) / hueTotal) : 0]));
  const top = HUE_FAMILIES.reduce((best, f) => ((hueW[f] ?? 0) > (hueW[best] ?? 0) ? f : best), HUE_FAMILIES[0]);
  const dominantHue: HueFamily = colourful / n < 0.15 || mS < 0.12 ? 'neutral' : top;

  // Sobel gradient magnitude on luma; "strong" = above 0.25 of full scale.
  const strong = { top: 0, middle: 0, bottom: 0 };
  const rows = { top: 0, middle: 0, bottom: 0 };
  for (let y = 1; y < H - 1; y++) {
    const band = y < H / 3 ? 'top' : y < (2 * H) / 3 ? 'middle' : 'bottom';
    for (let x = 1; x < W - 1; x++) {
      const p = (dx: number, dy: number) => luma[(y + dy) * W + x + dx]!;
      const gx = -p(-1, -1) - 2 * p(-1, 0) - p(-1, 1) + p(1, -1) + 2 * p(1, 0) + p(1, 1);
      const gy = -p(-1, -1) - 2 * p(0, -1) - p(1, -1) + p(-1, 1) + 2 * p(0, 1) + p(1, 1);
      rows[band]++;
      if (Math.hypot(gx, gy) > 1) strong[band]++;
    }
  }
  const frac = (k: 'top' | 'middle' | 'bottom') => r2(rows[k] ? strong[k] / rows[k] : 0);

  const palette = [...bins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([q, c]) => {
      const to = (v: number) => Math.round(v * 85 + 42).toString(16).padStart(2, '0'); // bin centre
      return { hex: `#${to((q >> 4) & 3)}${to((q >> 2) & 3)}${to(q & 3)}`, share: r2(c / n) };
    });

  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    aspect: r2((meta.width ?? 1) / (meta.height ?? 1)),
    brightness: r2(mL),
    contrast: r2(Math.sqrt(varL / n)),
    saturation: r2(mS),
    warmth: r2(warm / n),
    dominantHue,
    hueShare,
    palette,
    edgeDensity: { overall: r2((strong.top + strong.middle + strong.bottom) / (rows.top + rows.middle + rows.bottom || 1)), top: frac('top'), middle: frac('middle'), bottom: frac('bottom') },
  };
}

/** Analyse every stored cover that has no metrics yet. Returns how many were analysed. */
export async function analyzeCovers(db: Db, root: string): Promise<number> {
  const todo = db
    .prepare("SELECT a.sha256, a.asin, a.path FROM asset a WHERE a.kind = 'cover' AND a.sha256 NOT IN (SELECT sha256 FROM cover_metrics)")
    .all() as unknown as { sha256: string; asin: string; path: string }[];
  const put = db.prepare('INSERT OR REPLACE INTO cover_metrics (sha256, asin, metrics, analyzed_at) VALUES (?,?,?,?)');
  let done = 0;
  for (const t of todo) {
    const file = path.join(root, t.path);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) continue;
    try {
      put.run(t.sha256, t.asin, JSON.stringify(await coverMetrics(fs.readFileSync(file))), new Date().toISOString());
      done++;
    } catch {
      /* unreadable image: skip, it will be retried next time */
    }
  }
  return done;
}

export function latestCoverMetrics(db: Db, asin: string): CoverMetrics | null {
  const row = db
    .prepare(
      `SELECT m.metrics FROM cover_metrics m JOIN asset a ON a.sha256 = m.sha256 WHERE a.asin = ? AND a.kind = 'cover' ORDER BY a.captured_at DESC LIMIT 1`,
    )
    .get(asin) as unknown as { metrics: string } | undefined;
  return row ? (JSON.parse(row.metrics) as CoverMetrics) : null;
}

export interface CoverGroup {
  /** Books with an analysed cover. */
  known: number;
  brightness: number | null;
  contrast: number | null;
  saturation: number | null;
  warmth: number | null;
  edgeDensity: number | null;
  /** Count of books by dominant hue family. */
  dominantHues: Record<string, number>;
}

export interface CoverStats {
  topN: number;
  top: CoverGroup;
  rest: CoverGroup;
  /** Covers captured but not yet analysed. */
  pending: number;
  books: { asin: string; listRank: number; title: string | null; metrics: CoverMetrics }[];
}

export function coverStats(db: Db, categoryKey: string, topN = 10, books: CategoryBook[] = categoryBooks(db, categoryKey)): CoverStats {
  const rows = books.map((b) => ({ b, m: latestCoverMetrics(db, b.asin) })).filter((x): x is { b: CategoryBook; m: CoverMetrics } => x.m !== null);
  const group = (rs: typeof rows): CoverGroup => {
    const avg = (f: (m: CoverMetrics) => number) => (rs.length ? r2(mean(rs.map((x) => f(x.m)))!) : null);
    const hues: Record<string, number> = {};
    for (const x of rs) hues[x.m.dominantHue] = (hues[x.m.dominantHue] ?? 0) + 1;
    return { known: rs.length, brightness: avg((m) => m.brightness), contrast: avg((m) => m.contrast), saturation: avg((m) => m.saturation), warmth: avg((m) => m.warmth), edgeDensity: avg((m) => m.edgeDensity.overall), dominantHues: hues };
  };
  const analysedAsins = new Set(rows.map((x) => x.b.asin));
  const pending = books.filter((b) => !analysedAsins.has(b.asin) && db.scalar("SELECT 1 FROM asset WHERE asin = ? AND kind = 'cover'", b.asin)).length;
  return {
    topN,
    top: group(rows.filter((x) => x.b.listRank <= topN)),
    rest: group(rows.filter((x) => x.b.listRank > topN)),
    pending,
    books: rows.map((x) => ({ asin: x.b.asin, listRank: x.b.listRank, title: x.b.title, metrics: x.m })),
  };
}
