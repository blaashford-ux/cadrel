export function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const mean = (v: number[]): number | null => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function stdev(v: number[]): number | null {
  const m = mean(v);
  if (m === null || v.length < 2) return null;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Average ranks (ties share the mean of their positions), 1-based. */
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; null with fewer than 3 pairs or no variation. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const a = ranks(x);
  const b = ranks(y);
  const ma = mean(a)!, mb = mean(b)!;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 1000) / 1000 : null;
}

/** Fraction of values at or below x among `values` (0 to 1). */
export function percentileRank(values: number[], x: number): number {
  if (!values.length) return 0;
  const below = values.filter((v) => v < x).length;
  const equal = values.filter((v) => v === x).length;
  return (below + equal / 2) / values.length;
}

export interface Band {
  label: string;
  from: number;
  /** exclusive upper bound; Infinity for the last band */
  to: number;
}

export function bandCounts(values: number[], bands: Band[]): { label: string; count: number }[] {
  return bands.map((b) => ({ label: b.label, count: values.filter((v) => v >= b.from && v < b.to).length }));
}

/** Flesch reading ease (higher is easier; roughly 60-70 is plain English). */
export function fleschReadingEase(text: string): number | null {
  const words = text.match(/[A-Za-z']+/g) ?? [];
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((s) => /[A-Za-z]/.test(s)).length;
  if (words.length < 5 || sentences === 0) return null;
  const syll = words.reduce((n, w) => n + syllables(w), 0);
  const v = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syll / words.length);
  return Math.round(v * 10) / 10;
}

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}
