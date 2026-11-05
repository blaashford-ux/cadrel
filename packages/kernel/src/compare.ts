/**
 * Comparing two versions of a text manuscript, paragraph by paragraph, for the side-by-side view and for checking a revision. Pure: two texts in,
 * rows out. Paragraphs are runs of text separated by blank lines (how Markdown manuscripts are written). A paragraph that was reworded is shown
 * as one changed row with a word-level difference inside it, not as one removed and one added. Text only: nothing here reads .docx or other formats.
 */

export interface Paragraph {
  text: string;
  /** Where it starts and ends in the whole text. */
  start: number;
  end: number;
}
export type WordOp = { op: 'same' | 'del' | 'ins'; text: string };
export type CompareRow =
  | { kind: 'same'; a: Paragraph; b: Paragraph }
  | { kind: 'removed'; a: Paragraph }
  | { kind: 'added'; b: Paragraph }
  | { kind: 'changed'; a: Paragraph; b: Paragraph; words: WordOp[] };

export interface CompareResult {
  rows: CompareRow[];
  stats: { same: number; added: number; removed: number; changed: number; wordsAdded: number; wordsRemoved: number };
}

/** The largest grid the difference is worked out on; past it a stretch is shown as removed and added instead of paired. */
const GRID_MAX = 25_000_000;
/** How alike two paragraphs must be (shared words / all words) to be shown as one changed paragraph. */
const ALIKE = 0.4;

export function paragraphsOf(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /\S[\s\S]*?(?=\n[ \t]*\n|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const raw = m[0];
    const trimmed = raw.replace(/\s+$/, '');
    out.push({ text: trimmed, start: m.index, end: m.index + trimmed.length });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The longest common subsequence of two key lists, as matched index pairs. Null if the grid would be too large. */
function lcs(a: string[], b: string[]): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > GRID_MAX) return null;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) (out.push([i, j]), i++, j++);
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

const words = (s: string) => s.split(/(\s+)/).filter(Boolean);
const wordSet = (s: string) => new Set(norm(s).toLowerCase().split(' ').filter(Boolean));
function alike(x: string, y: string): number {
  const p = wordSet(x);
  const q = wordSet(y);
  if (!p.size || !q.size) return 0;
  let shared = 0;
  for (const w of p) if (q.has(w)) shared++;
  return shared / (p.size + q.size - shared);
}

/** The words of `a` and `b` side by side: what stayed, what was taken out, what was put in. */
export function wordDiff(a: string, b: string): WordOp[] {
  const x = words(a);
  const y = words(b);
  const pairs = lcs(x, y);
  if (!pairs) return [{ op: 'del', text: a }, { op: 'ins', text: b }];
  const ops: WordOp[] = [];
  const push = (op: WordOp['op'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text;
    else ops.push({ op, text });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    while (i < pi) push('del', x[i++]!);
    while (j < pj) push('ins', y[j++]!);
    push('same', x[i]!);
    i++;
    j++;
  }
  while (i < x.length) push('del', x[i++]!);
  while (j < y.length) push('ins', y[j++]!);
  return ops;
}

export function compareTexts(before: string, after: string): CompareResult {
  const A = paragraphsOf(before);
  const B = paragraphsOf(after);
  const ka = A.map((p) => norm(p.text));
  const kb = B.map((p) => norm(p.text));
  const rows: CompareRow[] = [];

  // what is the same at the start and the end needs no difference worked out
  let head = 0;
  while (head < A.length && head < B.length && ka[head] === kb[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && ka[A.length - 1 - tail] === kb[B.length - 1 - tail]) tail++;

  for (let i = 0; i < head; i++) rows.push({ kind: 'same', a: A[i]!, b: B[i]! });
  const midA = A.slice(head, A.length - tail);
  const midB = B.slice(head, B.length - tail);
  const pairs = lcs(ka.slice(head, A.length - tail), kb.slice(head, B.length - tail)) ?? [];
  const gap = (fromA: number, toA: number, fromB: number, toB: number) => {
    const removed = midA.slice(fromA, toA);
    const added = midB.slice(fromB, toB);
    let j = 0;
    for (const r of removed) {
      let best = -1;
      let bestScore = ALIKE;
      for (let k = j; k < added.length; k++) {
        const s = alike(r.text, added[k]!.text);
        if (s >= bestScore) (best = k, (bestScore = s));
      }
      if (best === -1) {
        rows.push({ kind: 'removed', a: r });
        continue;
      }
      while (j < best) rows.push({ kind: 'added', b: added[j++]! });
      rows.push({ kind: 'changed', a: r, b: added[best]!, words: wordDiff(r.text, added[best]!.text) });
      j = best + 1;
    }
    while (j < added.length) rows.push({ kind: 'added', b: added[j++]! });
  };
  let ia = 0;
  let ib = 0;
  for (const [pa, pb] of pairs) {
    gap(ia, pa, ib, pb);
    rows.push({ kind: 'same', a: midA[pa]!, b: midB[pb]! });
    ia = pa + 1;
    ib = pb + 1;
  }
  gap(ia, midA.length, ib, midB.length);
  for (let i = tail; i > 0; i--) rows.push({ kind: 'same', a: A[A.length - i]!, b: B[B.length - i]! });

  const stats = { same: 0, added: 0, removed: 0, changed: 0, wordsAdded: 0, wordsRemoved: 0 };
  const count = (s: string) => (s.match(/\S+/g) ?? []).length;
  for (const r of rows) {
    stats[r.kind]++;
    if (r.kind === 'added') stats.wordsAdded += count(r.b.text);
    else if (r.kind === 'removed') stats.wordsRemoved += count(r.a.text);
    else if (r.kind === 'changed') for (const w of r.words) w.op === 'ins' ? (stats.wordsAdded += count(w.text)) : w.op === 'del' ? (stats.wordsRemoved += count(w.text)) : 0;
  }
  return { rows, stats };
}
