import { useEffect } from 'react';
import { mapScroll, type Blocks } from '../shared/rewrite';

/** The paragraphs and headings of a pane (the formatted editor's blocks, or the non-blank lines of the raw Markdown), where each starts. */
export function blocksOf(pane: HTMLElement): Blocks {
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  const tops: number[] = [];
  pane.querySelectorAll<HTMLElement>('.ProseMirror > *, .cm-content > .cm-line').forEach((el) => {
    if (el.classList.contains('cm-line') && !el.textContent?.trim()) return;
    tops.push(el.getBoundingClientRect().top - origin);
  });
  return { tops, total: pane.scrollHeight };
}

/**
 * Rewrite mode: scrolling one pane scrolls the other to the same place (paragraph by paragraph; see `mapScroll`). The two panes are the tab
 * sections of the files, found by their `data-file`. `on` is false when the mode is off or the person has switched linked scrolling off.
 * `watch` changes when panes come and go, so the listeners are put on the right elements.
 */
export function useRewriteScroll(o: { on: boolean; left: string | null; right: string | null; watch: unknown }): void {
  const { on, left, right, watch } = o;
  useEffect(() => {
    if (!on || !left || !right) return;
    const find = (file: string) => [...document.querySelectorAll<HTMLElement>('section.pane[data-file]')].find((e) => e.dataset.file === file);
    const l = find(left);
    const r = find(right);
    if (!l || !r) return;
    // Where we just put each pane: its scroll event is ours, not the person's, and is not carried back. Anything else the person does is.
    const put = new Map<HTMLElement, { top: number; at: number }>();
    const carry = (from: HTMLElement, to: HTMLElement) => () => {
      const ours = put.get(from);
      if (ours && Math.abs(from.scrollTop - ours.top) < 1.5 && Date.now() - ours.at < 300) {
        put.delete(from);
        return;
      }
      const want = mapScroll(blocksOf(from), blocksOf(to), from.scrollTop);
      to.scrollTop = want;
      put.set(to, { top: to.scrollTop, at: Date.now() }); // as the browser kept it (rounded, or held inside the pane)
      // The other pane has run out of text (a rewrite that is shorter than its original): this one stops at the matching place instead of going on.
      if (want - to.scrollTop > 1.5) {
        from.scrollTop = mapScroll(blocksOf(to), blocksOf(from), to.scrollTop);
        put.set(from, { top: from.scrollTop, at: Date.now() });
      }
    };
    const a = carry(l, r);
    const b = carry(r, l);
    l.addEventListener('scroll', a, { passive: true });
    r.addEventListener('scroll', b, { passive: true });
    return () => {
      l.removeEventListener('scroll', a);
      r.removeEventListener('scroll', b);
    };
  }, [on, left, right, watch]);
}
