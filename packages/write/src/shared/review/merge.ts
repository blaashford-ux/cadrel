/**
 * Three-way merging of a manuscript that two people edited (collaboration).
 *
 * `base` is the text both sides last agreed on, `local` is this device's text and `remote` is the other side's. Chapters are
 * merged one by one (keyed like `chapterKeys`): a chapter only one side changed is taken as it is, a chapter both changed is
 * merged line by line, and where the two edits touch the same lines both versions are kept between conflict markers so
 * nothing anyone wrote is lost.
 */
import { splitChapters, type MarkdownDoc } from '../chapters';
import { chapterKeys } from './package';

const splitLines = (t: string): string[] => t.match(/[^\n]*\n|[^\n]+/g) ?? [];

interface Hunk {
  /** Range of base lines replaced (start inclusive, end exclusive); start === end is a pure insertion. */
  s: number;
  e: number;
  lines: string[];
}

/** The edits that turn `base` into `x`, found with a longest-common-subsequence over the lines between the common ends. */
function hunksOf(base: string[], x: string[]): Hunk[] {
  let head = 0;
  while (head < base.length && head < x.length && base[head] === x[head]) head++;
  let tail = 0;
  while (tail < base.length - head && tail < x.length - head && base[base.length - 1 - tail] === x[x.length - 1 - tail]) tail++;
  const a = base.slice(head, base.length - tail);
  const b = x.slice(head, x.length - tail);
  if (a.length === 0 && b.length === 0) return [];
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      open ??= { s: head + i, e: head + i, lines: [] };
      open.lines.push(b[j++]);
    } else {
      open ??= { s: head + i, e: head + i, lines: [] };
      open.e = head + ++i;
    }
  }
  close();
  return out;
}

/** `base[from, to)` with the hunks inside it applied. */
function apply(base: string[], hunks: Hunk[], from: number, to: number): string[] {
  const out: string[] = [];
  let at = from;
  for (const h of hunks) {
    out.push(...base.slice(at, h.s), ...h.lines);
    at = h.e;
  }
  out.push(...base.slice(at, to));
  return out;
}

export interface TextMerge {
  text: string;
  /** Places where both sides changed the same lines (both versions are in the text, between markers). */
  conflicts: number;
}

/** Merges two edits of `base`. `labels` name the sides in the conflict markers. */
export function mergeText(base: string, local: string, remote: string, labels: { local: string; remote: string } = { local: 'Yours', remote: 'Theirs' }): TextMerge {
  if (local === remote) return { text: local, conflicts: 0 };
  if (local === base) return { text: remote, conflicts: 0 };
  if (remote === base) return { text: local, conflicts: 0 };
  const b = splitLines(base);
  const l = hunksOf(b, splitLines(local));
  const r = hunksOf(b, splitLines(remote));
  const out: string[] = [];
  let conflicts = 0;
  let at = 0;
  let li = 0;
  let ri = 0;
  const overlaps = (x: Hunk, y: Hunk) => (x.s < y.e && y.s < x.e) || (x.s === x.e && y.s === y.e && x.s === y.s) || (x.s === x.e && y.s < x.s && x.s < y.e) || (y.s === y.e && x.s < y.s && y.s < x.e);
  while (li < l.length || ri < r.length) {
    const nextL = l[li];
    const nextR = r[ri];
    const first = !nextR || (nextL && nextL.s <= nextR.s) ? 'l' : 'r';
    const h = first === 'l' ? nextL : nextR;
    const other = first === 'l' ? nextR : nextL;
    if (!other || !overlaps(h, other)) {
      out.push(...b.slice(at, h.s), ...h.lines);
      at = h.e;
      first === 'l' ? li++ : ri++;
      continue;
    }
    // A cluster of overlapping edits: grow it until neither side has an edit that touches it.
    let s = Math.min(h.s, other.s);
    let e = Math.max(h.e, other.e);
    const lc: Hunk[] = [];
    const rc: Hunk[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      while (li < l.length && (l[li].s < e || (l[li].s === e && l[li].s === l[li].e && e === s))) {
        lc.push(l[li]);
        e = Math.max(e, l[li].e);
        s = Math.min(s, l[li].s);
        li++;
        grew = true;
      }
      while (ri < r.length && (r[ri].s < e || (r[ri].s === e && r[ri].s === r[ri].e && e === s))) {
        rc.push(r[ri]);
        e = Math.max(e, r[ri].e);
        s = Math.min(s, r[ri].s);
        ri++;
        grew = true;
      }
    }
    out.push(...b.slice(at, s));
    const mine = apply(b, lc, s, e);
    const theirs = apply(b, rc, s, e);
    if (mine.join('') === theirs.join('')) out.push(...mine);
    else {
      conflicts++;
      const nl = (lines: string[]) => (lines.length && !lines[lines.length - 1].endsWith('\n') ? [...lines.slice(0, -1), lines[lines.length - 1] + '\n'] : lines);
      out.push(`<<<<<<< ${labels.local}\n`, ...nl(mine), '=======\n', ...nl(theirs), `>>>>>>> ${labels.remote}\n`);
    }
    at = e;
  }
  out.push(...b.slice(at));
  return { text: out.join(''), conflicts };
}

export interface ManuscriptMerge {
  /** This device's whole file after the merge. */
  local: string;
  /** What the two sides now share: the merged chapters inside `scope`, in this device's order. */
  shared: string;
  conflicts: number;
}

function view(text: string, level: number, scope: Set<string> | null): { doc: MarkdownDoc; keys: string[]; raw: Map<string, string> } {
  const doc = splitChapters(text, level);
  const keys = chapterKeys(doc).map((k) => k.key);
  const raw = new Map<string, string>();
  doc.chapters.forEach((c, i) => {
    if (!scope || scope.has(keys[i])) raw.set(keys[i], c.raw);
  });
  return { doc, keys, raw };
}

/** Chapter texts joined, each non-final one ending in a newline so the next heading starts its own line. */
function joinRaws(raws: string[], eol: string): string {
  return raws.map((r, i) => (i < raws.length - 1 && r !== '' && !/[\r\n]$/.test(r) ? r + eol : r)).join('');
}

/** True when both texts hold the same chapters with the same content (their order is not compared). */
export function sameChapters(a: string, b: string, level: number): boolean {
  if (a === b) return true;
  const x = view(a, level, null).raw;
  const y = view(b, level, null).raw;
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k)?.replace(/(?:\r\n|\r|\n)+$/, '') !== v.replace(/(?:\r\n|\r|\n)+$/, '')) return false;
  return true;
}

/**
 * Merges two editions of a manuscript's chapters. With a `scope`, only chapters whose key is in it (or that the other side or the
 * base has) take part and the rest of `local` is left exactly as it is: that is how an owner merges a collaborator who was given
 * only some chapters. A null `base` (nothing agreed yet) makes every chapter both sides have, and differ on, a conflict.
 */
export function mergeManuscript(o: { base: string | null; local: string; remote: string; level: number; scope: Set<string> | null; labels?: { local: string; remote: string } }): ManuscriptMerge {
  const { level } = o;
  const L = view(o.local, level, null);
  const R = view(o.remote, level, null);
  const B = o.base === null ? null : view(o.base, level, null);
  const inScope = (k: string) => !o.scope || o.scope.has(k) || R.raw.has(k) || !!B?.raw.has(k);

  const merged = new Map<string, string>();
  let conflicts = 0;
  const same = (x: string | undefined, y: string | undefined) => x === y || (x !== undefined && y !== undefined && x.replace(/(?:\r\n|\r|\n)+$/, '') === y.replace(/(?:\r\n|\r|\n)+$/, ''));
  for (const k of new Set([...L.keys, ...R.keys])) {
    if (!inScope(k)) continue;
    const l = L.raw.get(k);
    const r = R.raw.get(k);
    const b = B?.raw.get(k);
    let out: string | undefined;
    if (same(l, r)) out = l;
    else if (B && same(l, b)) out = r;
    else if (B && same(r, b)) out = l;
    else if (l === undefined || r === undefined) out = l ?? r; // deleted on one side, edited on the other: keep the edit
    else {
      const m = mergeText(b ?? '', l, r, o.labels);
      conflicts += m.conflicts;
      out = m.text;
    }
    // The other side's copy may end its chapter differently (a subset ends at its last chapter); keep this file's own spacing.
    if (out !== undefined && l !== undefined && out !== l) out = out.replace(/(?:\r\n|\r|\n)*$/, /(?:\r\n|\r|\n)*$/.exec(l)![0]);
    if (out !== undefined) merged.set(k, out);
  }

  // Order: this device's, with chapters only the other side has placed after the chapter that precedes them there.
  const order = L.keys.filter((k) => merged.has(k));
  const after = new Map<string, string[]>();
  let anchor = '';
  for (const k of R.keys) {
    if (!merged.has(k)) continue;
    if (!L.raw.has(k) && !order.includes(k)) after.set(anchor, [...(after.get(anchor) ?? []), k]);
    anchor = k;
  }
  const chain = (k: string, into: string[]) => {
    for (const n of after.get(k) ?? []) {
      into.push(n);
      chain(n, into);
    }
  };
  const shared: string[] = [];
  chain('', shared);
  for (const k of order) {
    shared.push(k);
    chain(k, shared);
  }

  // The whole local file: chapters outside the scope stay where they are; those inside are replaced by the merged ones.
  const full: string[] = [];
  const put = (k: string) => full.push(merged.get(k)!);
  const floating = (k: string) => {
    const into: string[] = [];
    chain(k, into);
    into.forEach(put);
  };
  let started = false;
  L.doc.chapters.forEach((c, i) => {
    const k = L.keys[i];
    if (!started) {
      started = true;
      if (!c.isPreamble) floating('');
    }
    if (!inScope(k)) full.push(c.raw);
    else if (merged.has(k)) put(k);
    if (i === 0 && c.isPreamble) floating('');
    floating(k);
  });
  if (!started) floating('');
  const eol = L.doc.eol;
  return { local: L.doc.bom + joinRaws(full, eol), shared: L.doc.bom + joinRaws(shared.map((k) => merged.get(k)!), eol), conflicts };
}
