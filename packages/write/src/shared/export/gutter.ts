import { gutterForPages } from './trim';

export interface LayoutResult<T> {
  output: T;
  pages: number;
  gutter: number;
  /** How many times the book was laid out. */
  renders: number;
}

/**
 * Chooses the inside margin from the final page count (KDP's table), laying the book out as few
 * times as possible: usually once (the estimate was in the right band) or twice. If the page count
 * keeps crossing a threshold when the margin changes, the larger margin wins (safer for binding).
 */
export async function layoutWithGutter<T>(args: {
  auto: boolean;
  manualGutter: number;
  estimatedPages: number;
  render: (gutter: number) => Promise<{ output: T; pages: number }>;
}): Promise<LayoutResult<T>> {
  if (!args.auto) {
    const r = await args.render(args.manualGutter);
    return { ...r, gutter: args.manualGutter, renders: 1 };
  }
  let gutter = gutterForPages(args.estimatedPages);
  let renders = 0;
  const tried = new Map<number, { output: T; pages: number }>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await args.render(gutter);
    renders++;
    tried.set(gutter, r);
    const needed = gutterForPages(r.pages);
    if (needed === gutter) return { ...r, gutter, renders };
    if (tried.has(needed)) {
      // flip-flopping around a threshold: settle on the larger gutter
      const bigger = Math.max(gutter, needed);
      let chosen = tried.get(bigger);
      if (!chosen) {
        chosen = await args.render(bigger);
        renders++;
      }
      return { output: chosen.output, pages: chosen.pages, gutter: bigger, renders };
    }
    gutter = needed;
  }
  const last = tried.get(gutter)!;
  return { ...last, gutter, renders };
}
