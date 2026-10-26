import { describe, expect, it, vi } from 'vitest';
import { layoutWithGutter } from './gutter';

/** A fake renderer whose page count depends on the gutter, like a real layout. */
const fake = (pagesAt: (g: number) => number) =>
  vi.fn(async (g: number) => ({ output: `pdf@${g}`, pages: pagesAt(g) }));

describe('layoutWithGutter', () => {
  it('manual gutter: one render, used as given', async () => {
    const render = fake(() => 400);
    const r = await layoutWithGutter({ auto: false, manualGutter: 0.9, estimatedPages: 100, render });
    expect(render).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ gutter: 0.9, pages: 400, renders: 1, output: 'pdf@0.9' });
  });

  it('auto: the estimate was in the right band → a single render', async () => {
    const render = fake(() => 280);
    const r = await layoutWithGutter({ auto: true, manualGutter: 0, estimatedPages: 260, render });
    expect(render).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ gutter: 0.5, pages: 280, renders: 1 });
  });

  it('auto: the estimate was low → re-lays out once with the right gutter', async () => {
    const render = fake(() => 320); // really 301–500 pages → 0.625
    const r = await layoutWithGutter({ auto: true, manualGutter: 0, estimatedPages: 250, render });
    expect(render.mock.calls.map((c) => c[0])).toEqual([0.5, 0.625]);
    expect(r).toMatchObject({ gutter: 0.625, pages: 320, renders: 2, output: 'pdf@0.625' });
  });

  it('auto: a bigger gutter pushes the page count over a threshold the other way → larger gutter wins', async () => {
    // 0.5in gutter → 299 pages (needs 0.5 ✓) is stable, but start from 0.625: 301 pages at 0.5? build a flip-flop:
    const render = fake((g) => (g === 0.5 ? 302 : 299)); // at 0.5: 302 pages (needs 0.625); at 0.625: 299 pages (needs 0.5)
    const r = await layoutWithGutter({ auto: true, manualGutter: 0, estimatedPages: 250, render });
    expect(r.gutter).toBe(0.625);
    expect(r.output).toBe('pdf@0.625');
    expect(r.renders).toBeLessThanOrEqual(3);
  });

  it('never loops more than three layouts', async () => {
    let n = 0;
    const render = vi.fn(async (g: number) => ({ output: g, pages: [100, 200, 400, 600, 800][n++ % 5] }));
    const r = await layoutWithGutter({ auto: true, manualGutter: 0, estimatedPages: 100, render });
    expect(render.mock.calls.length).toBeLessThanOrEqual(4);
    expect(r.pages).toBeGreaterThan(0);
  });
});
