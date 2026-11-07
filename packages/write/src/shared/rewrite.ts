/**
 * Rewrite mode: an original manuscript file and the new file its rewrite is written in, linked so either can bring up the other beside it and
 * scrolling one scrolls the other. Pure: link rules over relative paths and the mapping of one pane's scroll position to the other's. The
 * links are kept in the project's metadata (see `ProjectMeta.rewriteLinks`), like the edited-chapter marks; the panes are drawn by the app.
 *
 * A file is in at most one link, as the original or as the rewrite. Paths are relative to the project and written with "/".
 */
import { remapPath } from './paths';

export interface RewriteLink {
  original: string;
  rewrite: string;
}

/** The most links a project keeps. */
export const REWRITE_LINKS_MAX = 200;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The links as stored, from whatever was read: only well-formed ones, none that repeats a file, at most REWRITE_LINKS_MAX. `ok` says whether a path is safe. */
export function sanitizeRewriteLinks(raw: unknown, ok: (rel: string) => boolean): RewriteLink[] {
  if (!Array.isArray(raw)) return [];
  const out: RewriteLink[] = [];
  const used = new Set<string>();
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const o = (l as Partial<RewriteLink>).original;
    const r = (l as Partial<RewriteLink>).rewrite;
    if (typeof o !== 'string' || typeof r !== 'string') continue;
    const original = o.replace(/\\/g, '/');
    const rewrite = r.replace(/\\/g, '/');
    if (!ok(original) || !ok(rewrite) || same(original, rewrite) || used.has(original.toLowerCase()) || used.has(rewrite.toLowerCase())) continue;
    used.add(original.toLowerCase());
    used.add(rewrite.toLowerCase());
    out.push({ original, rewrite });
    if (out.length >= REWRITE_LINKS_MAX) break;
  }
  return out;
}

/** The link a file is in, and which side of it the file is. */
export function rewriteLinkOf(links: readonly RewriteLink[], rel: string): { role: 'original' | 'rewrite'; other: string; link: RewriteLink } | null {
  for (const link of links) {
    if (same(link.original, rel)) return { role: 'original', other: link.rewrite, link };
    if (same(link.rewrite, rel)) return { role: 'rewrite', other: link.original, link };
  }
  return null;
}

/** A new link. A file already in a link, or a file linked to itself, is refused with the reason. */
export function addRewriteLink(links: readonly RewriteLink[], original: string, rewrite: string): RewriteLink[] {
  if (same(original, rewrite)) throw new Error('A file cannot be the rewrite of itself.');
  for (const f of [original, rewrite]) {
    const at = rewriteLinkOf(links, f);
    if (at) throw new Error(`${f} is already linked to ${at.other} as a rewrite. Unlink them first.`);
  }
  return [...links, { original, rewrite }];
}

/** Takes away the link a file is in (the other file stays). */
export function removeRewriteLink(links: readonly RewriteLink[], rel: string): RewriteLink[] {
  return links.filter((l) => !same(l.original, rel) && !same(l.rewrite, rel));
}

/** Points the links at a renamed file, or at everything under a renamed folder. */
export function remapRewriteLinks(links: readonly RewriteLink[], from: string, to: string): RewriteLink[] {
  return links.map((l) => ({ original: remapPath(l.original, from, to), rewrite: remapPath(l.rewrite, from, to) }));
}

/** Drops the links of a deleted file, or of everything under a deleted folder. The surviving file of a link stays as an ordinary file. */
export function dropRewriteLinksUnder(links: readonly RewriteLink[], rel: string): RewriteLink[] {
  const under = (p: string) => same(p, rel) || p.toLowerCase().startsWith(rel.toLowerCase() + '/');
  return links.filter((l) => !under(l.original) && !under(l.rewrite));
}

/** "Book (rewrite).md" for "Book.md"; "Book (rewrite 2).md" and so on when that name is taken. `taken` holds the names already in the folder. */
export function rewriteFileName(original: string, taken: ReadonlySet<string>): string {
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : '.md';
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `${stem} (rewrite${n === 1 ? '' : ' ' + n})${ext}`;
    if (!lower.has(name.toLowerCase())) return name;
  }
}

// ---- scrolling together ---------------------------------------------------------------------------------------------------------

/** Where the blocks (paragraphs, headings) of a pane start, top to bottom in px from the top of its content, and how tall the content is. */
export interface Blocks {
  tops: readonly number[];
  total: number;
}

/**
 * The scroll position in `to` that shows what `from` shows at `fromTop`. Paragraphs are matched by number: the paragraph at the top of one pane
 * is lined up with the same-numbered paragraph at the top of the other, and how far into it the pane is carries across. When the two have a
 * different number of paragraphs the position is carried across as a share of all paragraphs, so the panes stay roughly level while one is
 * longer. With nothing to match (an empty pane) it falls back to a share of the whole height.
 */
export function mapScroll(from: Blocks, to: Blocks, fromTop: number): number {
  const n = from.tops.length;
  const m = to.tops.length;
  const clamp = (v: number) => Math.max(0, Math.min(v, Math.max(0, to.total)));
  if (n === 0 || m === 0) return from.total > 0 ? clamp((fromTop / from.total) * to.total) : 0;
  // above the first block (a title, padding): carried across as a share of the space above the other pane's first block
  if (fromTop < from.tops[0]!) return clamp(from.tops[0]! > 0 ? (Math.max(0, fromTop) / from.tops[0]!) * to.tops[0]! : 0);
  let i = 0;
  while (i + 1 < n && from.tops[i + 1]! <= fromTop) i++;
  const end = i + 1 < n ? from.tops[i + 1]! : from.total;
  const span = end - from.tops[i]!;
  const frac = span > 0 ? Math.max(0, Math.min(1, (fromTop - from.tops[i]!) / span)) : 0;
  const at = ((i + frac) / n) * m;
  const j = Math.min(m - 1, Math.floor(at));
  const jEnd = j + 1 < m ? to.tops[j + 1]! : to.total;
  return clamp(to.tops[j]! + (at - j) * (jEnd - to.tops[j]!));
}
