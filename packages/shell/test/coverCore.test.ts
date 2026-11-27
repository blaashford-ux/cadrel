// The Cover Designer's document, snapping, arranging and drawing: all pure, so all tested without a screen.
import { describe, expect, it } from 'vitest';
import { addLayer, addScrim, detachScrim, DesignError, duplicate, imageBox, layerOf, moveBy, newDesign, newImage, newShape, newText, parse, patchLayer, removeLayers, reorder, serialize, setFrame, type Design, type ImageLayer, type ScrimLayer, type TextLayer } from '../src/shared/cover/doc';
import { align, centreOnSpine, distribute, matchSize, stack, titleBlock } from '../src/shared/cover/arrange';
import { canRedo, canUndo, commit, redo, settle, startHistory, undo } from '../src/shared/cover/history';
import { linesFor, nearestScale, snapAll, snapGaps, snapMove, snapResize, stepScale, SNAP_AT } from '../src/shared/cover/snap';
import { fixedMeasure, fitTextFrames, layoutText } from '../src/shared/cover/text';
import { renderSvg } from '../src/shared/cover/render';
import { LIBRARY } from '../src/shared/cover/library';
import { TEXTURES } from '../src/shared/cover/fx';
import { DOMParser } from '@xmldom/xmldom';

const opts = { measure: fixedMeasure, imageHref: () => 'data:image/png;base64,AAAA' };
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rot: 0 });
const rect = (x: number, y: number, w: number, h: number) => newShape('rect', { frame: box(x, y, w, h) });

describe('the design document', () => {
  it('survives being written and read back, whatever is in it', () => {
    let d = newDesign('ebook');
    d = addLayer(d, newImage({ path: 'Art/a.png', hash: 'abc' }, { w: 1000, h: 1500 }, d.canvas));
    d = addLayer(d, newText('The Last Dragon', { font: 'Cinzel', fx: { glow: { color: '#ffd', size: 0.01, strength: 0.7 }, shadow: { color: '#000', dx: 0.002, dy: 0.004, blur: 0.006, opacity: 0.6 }, texture: { id: 'foil', strength: 0.6, scale: 1 } } }));
    d = addLayer(d, newShape('symbol', { symbol: 'crown', fill: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#fff' }, { at: 1, color: '#c9a24a' }] } }));
    const text = d.layers.find((l) => l.type === 'text')!;
    d = addScrim(d, text.id).design;
    const back = parse(serialize(d));
    expect(back.layers).toEqual(d.layers);
    expect(back.fonts).toEqual(['Cinzel']);
  });
  it('refuses what is not a design, and tells a newer file from a broken one', () => {
    expect(() => parse('nope')).toThrow(DesignError);
    expect(() => parse('{"format":99}')).toThrow(/newer Cadrel/);
    expect(() => parse('{"format":1,"layers":"x"}')).not.toThrow();
  });
  it('drops layers it cannot trust: a repeated id, an id with markup in it, a picture with no path', () => {
    const t = (id: string) => ({ id, type: 'text', text: 'x' });
    const d = parse(JSON.stringify({ format: 1, layers: [t('a'), t('a'), t('b"><script>'), { id: 'c', type: 'image', src: {} }, { id: 'd', type: 'weird' }, t('e')] }));
    expect(d.layers.map((l) => l.id)).toEqual(['a', 'e']);
  });
  it('keeps numbers inside their ranges', () => {
    const d = parse(JSON.stringify({ format: 1, canvas: { w: 999999, h: 5 }, layers: [{ id: 'a', type: 'text', size: 9, leading: 0, fx: { opacity: 4, texture: { id: 'x', strength: 9, scale: 99 } } }] }));
    expect(d.canvas).toEqual({ w: 8000, h: 200 });
    const l = d.layers[0] as TextLayer;
    expect([l.size, l.leading, l.fx.opacity, l.fx.texture!.strength, l.fx.texture!.scale]).toEqual([0.5, 0.7, 1, 1, 5]);
  });
  it('a paperback keeps its template and an ebook does not', () => {
    const tpl = { src: { path: 'T.png', hash: 'h' }, opacity: 0.4, hidden: false, back: 0.45, front: 0.55 };
    expect(parse(JSON.stringify({ format: 1, kind: 'paperback', template: tpl })).template).toEqual(tpl);
    expect(parse(JSON.stringify({ format: 1, kind: 'ebook', template: tpl })).template).toBeNull();
  });
});

describe('layers', () => {
  it('adds above a layer, reorders, duplicates and removes', () => {
    let d = newDesign('ebook');
    const a = rect(0, 0, 0.1, 0.1);
    const b = rect(0.2, 0, 0.1, 0.1);
    const c = rect(0.4, 0, 0.1, 0.1);
    d = addLayer(addLayer(addLayer(d, a), b), c, a.id);
    expect(d.layers.map((l) => l.id)).toEqual([a.id, c.id, b.id]);
    expect(reorder(d, a.id, 'front').layers.map((l) => l.id)).toEqual([c.id, b.id, a.id]);
    expect(reorder(d, b.id, 1)).toBe(d);
    const dup = duplicate(d, a.id);
    expect(dup.design.layers).toHaveLength(4);
    expect(layerOf(dup.design, dup.id!)!.id).not.toBe(a.id);
    expect(removeLayers(d, [a.id, b.id]).layers.map((l) => l.id)).toEqual([c.id]);
  });
  it('does not move a locked layer', () => {
    const l = { ...rect(0.1, 0.1, 0.2, 0.2), locked: true };
    const d = addLayer(newDesign('ebook'), l);
    expect(moveBy(d, [l.id], 0.1, 0.1)).toEqual(d);
  });
  it('lays a picture out to cover its frame, and keeps its proportions when contained', () => {
    const d = newDesign('ebook');
    const img = newImage({ path: 'a.png', hash: 'h' }, { w: 3000, h: 2000 }, d.canvas) as ImageLayer;
    const b = imageBox(img, d.canvas);
    expect(b.h).toBeCloseTo(1); // a wide picture fills the height of a tall cover and is cropped at the sides
    expect(b.w).toBeGreaterThan(1);
    expect(b.x).toBeCloseTo((1 - b.w) / 2);
    const inside = imageBox({ ...img, fit: 'contain' }, d.canvas);
    expect(inside.w).toBeCloseTo(1);
    expect(inside.h).toBeLessThan(1);
  });
});

describe('darkening behind text', () => {
  const setup = () => {
    const t = newText('Dragon', { frame: box(0.2, 0.3, 0.6, 0.1) });
    let d = addLayer(newDesign('ebook'), t);
    const r = addScrim(d, t.id);
    return { t, d: r.design, s: r.id! };
  };
  it('sits directly beneath the text, a little bigger than it', () => {
    const { t, d, s } = setup();
    const i = d.layers.findIndex((l) => l.id === s);
    expect(d.layers[i + 1]!.id).toBe(t.id);
    const sc = layerOf(d, s) as ScrimLayer;
    expect(sc.frame.x).toBeLessThan(t.frame.x);
    expect(sc.frame.y).toBeLessThan(t.frame.y);
    expect(sc.frame.w).toBeGreaterThan(t.frame.w);
    expect(sc.frame.h).toBeGreaterThan(t.frame.h);
  });
  it('follows the text when it moves, and when it is resized', () => {
    const { t, d, s } = setup();
    const moved = moveBy(d, [t.id], 0.1, 0.2);
    const a = layerOf(d, s)!.frame;
    const b = layerOf(moved, s)!.frame;
    expect(b.x - a.x).toBeCloseTo(0.1);
    expect(b.y - a.y).toBeCloseTo(0.2);
    const wider = setFrame(d, t.id, { w: 0.7 });
    expect(layerOf(wider, s)!.frame.w - a.w).toBeCloseTo(0.1);
  });
  it('stays put once detached, is not doubled by a second click, and lets go if its text is deleted', () => {
    const { t, d, s } = setup();
    const free = detachScrim(d, s);
    expect(layerOf(moveBy(free, [t.id], 0.3, 0), s)!.frame).toEqual(layerOf(free, s)!.frame);
    const again = addScrim(d, t.id, { strength: 0.9 });
    expect(again.design.layers.filter((l) => l.type === 'scrim')).toHaveLength(1);
    expect((layerOf(again.design, s) as ScrimLayer).strength).toBe(0.9);
    const gone = removeLayers(d, [t.id]);
    expect((layerOf(gone, s) as ScrimLayer).boundTo).toBeNull();
  });
  it('only goes behind text', () => {
    const r = rect(0, 0, 0.1, 0.1);
    const d = addLayer(newDesign('ebook'), r);
    expect(addScrim(d, r.id).id).toBeNull();
  });
});

describe('snapping', () => {
  const d0 = newDesign('ebook');
  it('snaps a layer to the middle, the margin and the edge when it is close, and not when it is far', () => {
    const lines = linesFor(d0);
    const mid = snapMove(box(0.5 - 0.15 + 0.005, 0.3, 0.3, 0.1), lines);
    expect(mid.frame.x + mid.frame.w / 2).toBeCloseTo(0.5);
    expect(mid.hits.some((h) => h.kind === 'centre' && h.axis === 'x')).toBe(true);
    const left = snapMove(box(0.063, 0.3, 0.3, 0.1), lines);
    expect(left.frame.x).toBeCloseTo(0.06);
    const edge = snapMove(box(0.004, 0.3, 0.3, 0.1), lines);
    expect(edge.frame.x).toBe(0);
    const far = snapMove(box(0.137, 0.213, 0.3, 0.1), lines);
    expect(far.frame).toEqual(box(0.137, 0.213, 0.3, 0.1));
    expect(far.hits).toEqual([]);
  });
  it('lands within the threshold of a line it reports, for any position (generated)', () => {
    const lines = linesFor(d0);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 400; i++) {
      const f = box(rnd() * 0.7, rnd() * 0.8, 0.05 + rnd() * 0.25, 0.03 + rnd() * 0.2);
      const s = snapMove(f, lines);
      for (const h of s.hits) {
        const at = h.axis === 'x' ? [s.frame.x, s.frame.x + s.frame.w / 2, s.frame.x + s.frame.w] : [s.frame.y, s.frame.y + s.frame.h / 2, s.frame.y + s.frame.h];
        expect(Math.min(...at.map((a) => Math.abs(a - h.at)))).toBeLessThan(1e-9);
        const before = h.axis === 'x' ? [f.x, f.x + f.w / 2, f.x + f.w] : [f.y, f.y + f.h / 2, f.y + f.h];
        expect(Math.min(...before.map((a) => Math.abs(a - h.at)))).toBeLessThanOrEqual(SNAP_AT + 1e-9);
      }
    }
  });
  it('snaps to another layer, ignoring itself and hidden ones', () => {
    const a = rect(0.1, 0.1, 0.2, 0.1);
    const hidden = { ...rect(0.713, 0.1, 0.1, 0.1), hidden: true };
    const d = addLayer(addLayer(d0, a), hidden);
    const s = snapMove(box(0.103, 0.5, 0.1, 0.1), linesFor(d, []));
    expect(s.frame.x).toBeCloseTo(0.1);
    const own = snapMove(box(0.103, 0.5, 0.1, 0.1), linesFor(d, [a.id]));
    expect(own.frame.x).toBeCloseTo(0.103);
    const h = snapMove(box(0.71, 0.5, 0.05, 0.1), linesFor(d, []));
    expect(h.frame.x).toBeCloseTo(0.71);
  });
  it('uses the person’s guides and the template’s marked regions', () => {
    const d: Design = { ...d0, guides: [{ axis: 'x', at: 0.8 }], kind: 'paperback', template: { src: { path: 't', hash: '' }, opacity: 0.3, hidden: false, back: 0.45, front: 0.55 } };
    expect(snapMove(box(0.795, 0.2, 0.1, 0.1), linesFor(d)).frame.x).toBeCloseTo(0.8);
    const spine = snapMove(box(0.5 - 0.02 + 0.004, 0.2, 0.04, 0.1), linesFor(d));
    expect(spine.frame.x + 0.02).toBeCloseTo(0.5);
    expect(linesFor({ ...d, template: { ...d.template!, hidden: true } }).some((l) => l.kind === 'region')).toBe(false);
  });
  it('resizes by an edge and keeps proportions when asked', () => {
    const lines = linesFor(d0);
    const east = snapResize(box(0.1, 0.2, 0.5, 0.2), 'e', lines);
    expect(east.frame.w).toBeGreaterThan(0.4); // the right edge (0.6) is within reach of the 2/3 line? no: it stays
    const s = snapResize(box(0.1, 0.2, 0.2, 0.2), 'e', lines, SNAP_AT);
    expect(s.frame.x).toBe(0.1);
    const near = snapResize(box(0.1, 0.2, 0.397, 0.2), 'e', lines);
    expect(near.frame.x + near.frame.w).toBeCloseTo(0.5); // the right edge reaches the middle
    const keep = snapResize(box(0.1, 0.2, 0.397, 0.2), 'se', lines, SNAP_AT, 2);
    expect(keep.frame.w / keep.frame.h).toBeCloseTo(2);
  });
  it('snaps to the middle of the gap between two layers, and to the same gap again', () => {
    const l = rect(0.05, 0.4, 0.2, 0.1);
    const r = rect(0.75, 0.4, 0.2, 0.1);
    const mid = snapGaps(box(0.4 + 0.006, 0.42, 0.2, 0.06), [l, r]);
    expect(mid.frame.x).toBeCloseTo(0.4);
    expect(mid.hits[0]!.kind).toBe('gap');
    const a = rect(0.05, 0.1, 0.1, 0.1);
    const b = rect(0.2, 0.1, 0.1, 0.1); // a gap of 0.05
    const same = snapGaps(box(0.35 + 0.006, 0.1, 0.1, 0.1), [a, b]);
    expect(same.frame.x).toBeCloseTo(0.35);
  });
  it('does not let a gap snap override a line it is already on', () => {
    const l = rect(0.05, 0.4, 0.2, 0.1);
    const r = rect(0.75, 0.4, 0.2, 0.1);
    const d = addLayer(addLayer(d0, l), r);
    const s = snapAll(box(0.5 - 0.1 + 0.003, 0.42, 0.2, 0.06), d, []);
    expect(s.frame.x + 0.1).toBeCloseTo(0.5);
  });
  it('gives type a short scale to choose from', () => {
    expect(nearestScale(0.061).id).toBe('l');
    expect(stepScale(0.06, 1)).toBeGreaterThan(0.06);
    expect(stepScale(0.06, -1)).toBeLessThan(0.06);
    expect(stepScale(0.17, 1)).toBe(0.17);
    expect(stepScale(0.016, -1)).toBe(0.016);
  });
});

describe('arranging', () => {
  const three = () => {
    const a = rect(0.1, 0.1, 0.2, 0.1);
    const b = rect(0.3, 0.3, 0.2, 0.1);
    const c = rect(0.8, 0.9, 0.1, 0.05);
    return { a, b, c, d: addLayer(addLayer(addLayer(newDesign('ebook'), a), b), c) };
  };
  it('aligns to the canvas and to each other', () => {
    const { a, b, c, d } = three();
    const ids = [a.id, b.id, c.id];
    expect(layerOf(align(d, [a.id], 'centre'), a.id)!.frame.x).toBeCloseTo(0.4);
    expect(layerOf(align(d, [c.id], 'bottom'), c.id)!.frame.y).toBeCloseTo(0.95);
    const left = align(d, ids, 'left', 'selection');
    expect(ids.map((i) => layerOf(left, i)!.frame.x)).toEqual([0.1, 0.1, 0.1]);
    const right = align(d, ids, 'right', 'selection');
    expect(ids.map((i) => layerOf(right, i)!.frame.x + layerOf(right, i)!.frame.w)).toEqual([0.9, 0.9, 0.9].map((v) => expect.closeTo(v)));
  });
  it('spreads three layers so the gaps are equal, and leaves the ends alone', () => {
    const { a, b, c, d } = three();
    const out = distribute(d, [a.id, b.id, c.id], 'x');
    const [fa, fb, fc] = [a, b, c].map((l) => layerOf(out, l.id)!.frame);
    expect(fa!.x).toBe(0.1);
    expect(fc!.x).toBe(0.8);
    expect(fb!.x - (fa!.x + fa!.w)).toBeCloseTo(fc!.x - (fb!.x + fb!.w));
    expect(distribute(d, [a.id, b.id], 'x')).toBe(d);
  });
  it('stacks one under another with a gap, and matches widths', () => {
    const { a, b, c, d } = three();
    const out = stack(d, [a.id, b.id, c.id], 0.02);
    const fs = [a, b, c].map((l) => layerOf(out, l.id)!.frame);
    expect(fs[1]!.y).toBeCloseTo(fs[0]!.y + fs[0]!.h + 0.02);
    expect(fs[2]!.y).toBeCloseTo(fs[1]!.y + fs[1]!.h + 0.02);
    for (const f of fs) expect(f.x + f.w / 2).toBeCloseTo(0.2);
    const m = matchSize(d, [a.id, c.id], 'width');
    expect(layerOf(m, c.id)!.frame.w).toBe(0.2);
  });
  it('moves a title block as one with its darkening band', () => {
    const t = newText('Dragon');
    const d = addScrim(addLayer(newDesign('ebook'), t), t.id).design;
    const out = distribute(align(d, [t.id], 'left'), [t.id], 'x');
    const s = out.layers.find((l) => l.type === 'scrim')!;
    expect(s.frame.x).toBeLessThan(out.layers.find((l) => l.id === t.id)!.frame.x);
  });
});

describe('title blocks', () => {
  const fields = { title: 'The Last Dragon Rider', subtitle: 'A Novel of the Ember Wars', series: 'Book Four', author: 'A. Writer' };
  it.each(['high', 'centre', 'low'] as const)('lays out a %s title block that stays on the cover, in order, with the right fonts', (layout) => {
    const { design, ids } = titleBlock(newDesign('ebook'), layout, 'epic', fields, fixedMeasure);
    expect(ids).toHaveLength(4);
    const by = (n: string) => design.layers.find((l) => l.name === n)!;
    for (const l of design.layers) {
      expect(l.frame.y).toBeGreaterThanOrEqual(0);
      expect(l.frame.y + l.frame.h).toBeLessThanOrEqual(1);
      expect(l.frame.x).toBeGreaterThanOrEqual(0);
      expect(l.frame.x + l.frame.w).toBeLessThanOrEqual(1);
    }
    expect(by('Series line').frame.y).toBeLessThan(by('Title').frame.y);
    expect(by('Title').frame.y + by('Title').frame.h).toBeLessThanOrEqual(by('Subtitle').frame.y + 1e-9);
    expect(by('Author').frame.y).toBeGreaterThan(by('Subtitle').frame.y);
    expect((by('Title') as TextLayer).font).toBe('Cinzel');
    expect((by('Title') as TextLayer).upper).toBe(true);
    const top = by('Series line').frame.y;
    const bottom = by('Subtitle').frame.y + by('Subtitle').frame.h;
    // high: the block starts near the top; centred: its middle is the cover's; low: it ends just above the author's name
    if (layout === 'high') expect(top).toBeLessThan(0.1);
    if (layout === 'centre') expect((top + bottom) / 2).toBeCloseTo(0.5, 1);
    if (layout === 'low') expect(bottom).toBeGreaterThan(0.7);
    expect(bottom).toBeLessThan(by('Author').frame.y);
  });
  it('shrinks a long title until its longest word fits, and replaces an earlier block rather than doubling it', () => {
    const long = titleBlock(newDesign('ebook'), 'high', 'thriller', { ...fields, title: 'Incomprehensibilities' }, fixedMeasure);
    const t = long.design.layers.find((l) => l.name === 'Title') as TextLayer;
    const px = t.size * 2560;
    expect(fixedMeasure('INCOMPREHENSIBILITIES', { font: t.font, weight: t.weight, italic: false, px, trackingPx: t.tracking * px })).toBeLessThanOrEqual(0.84 * 1600 + 1);
    const again = titleBlock(long.design, 'low', 'romance', { title: 'Short', author: 'Me' }, fixedMeasure);
    expect(again.design.layers.filter((l) => l.name === 'Title')).toHaveLength(1);
    expect(again.design.layers.filter((l) => l.name === 'Series line')).toHaveLength(0);
  });
  it('centres a layer on the marked spine', () => {
    const t = newText('SPINE', { frame: box(0.1, 0.2, 0.06, 0.5) });
    const d: Design = { ...addLayer({ ...newDesign('paperback'), template: { src: { path: 't', hash: '' }, opacity: 0.3, hidden: false, back: 0.44, front: 0.54 } }, t) };
    const f = layerOf(centreOnSpine(d, t.id), t.id)!.frame;
    expect(f.x + f.w / 2).toBeCloseTo(0.49);
  });
});

describe('text', () => {
  it('wraps to the layer’s width and counts a line for each break', () => {
    const t = newText('one two three four five six', { frame: box(0.1, 0, 0.3, 0.1), size: 0.02, tracking: 0, leading: 1.5 });
    const laid = layoutText(t, { w: 1000, h: 1600 }, fixedMeasure);
    expect(laid.lines.length).toBeGreaterThan(1);
    expect(laid.lines.join(' ')).toBe('one two three four five six');
    for (const l of laid.lines) expect(fixedMeasure(l, { font: 'x', weight: 400, italic: false, px: 32, trackingPx: 0 })).toBeLessThanOrEqual(300 + 1e-9);
    expect(layoutText({ ...t, text: 'a\n\nb' }, { w: 1000, h: 1600 }, fixedMeasure).lines).toEqual(['a', '', 'b']);
    expect(layoutText({ ...t, text: 'ab', upper: true }, { w: 1000, h: 1600 }, fixedMeasure).lines).toEqual(['AB']);
  });
  it('sets each text frame to the height its words need', () => {
    const t = newText('one two three four five six seven eight', { frame: box(0.1, 0, 0.2, 0.01), size: 0.03 });
    const d = fitTextFrames(addLayer(newDesign('ebook'), t), fixedMeasure);
    expect(layerOf(d, t.id)!.frame.h).toBeGreaterThan(0.06);
    expect(fitTextFrames(d, fixedMeasure)).toBe(d);
  });
});

describe('history', () => {
  it('undoes and redoes, and joins a drag into one step', () => {
    let h = startHistory(0);
    h = commit(h, 1);
    h = commit(h, 2, 'drag');
    h = commit(h, 3, 'drag');
    h = commit(h, 4, 'drag');
    expect(h.past).toEqual([0, 1]); // the three steps of the drag are one
    expect(undo(h).present).toBe(1); // back to before the drag began
    h = settle(h);
    h = commit(h, 5, 'drag');
    expect(h.past).toEqual([0, 1, 4]);
    const u = undo(undo(h));
    expect(u.present).toBe(1);
    expect(canRedo(u)).toBe(true);
    expect(redo(u).present).toBe(4);
    expect(commit(u, 9).future).toEqual([]);
    expect(canUndo(startHistory(0))).toBe(false);
    expect(undo(startHistory(0)).present).toBe(0);
  });
});

describe('the picture it draws', () => {
  const full = () => {
    let d = newDesign('ebook');
    d = addLayer(d, newImage({ path: 'a.png', hash: 'h' }, { w: 1000, h: 1500 }, d.canvas));
    d = patchLayer<ImageLayer>(d, d.layers[0]!.id, { grade: { brightness: 0.1, contrast: 0.2, saturation: -0.3, warmth: 0.4, vignette: 0.5, tint: { color: '#204060', strength: 0.2 } } });
    const t = newText('The <Last> & "Dragon"', { fx: { glow: { color: '#ffcc66', size: 0.01, strength: 0.8 }, shadow: { color: '#000000', dx: 0.002, dy: 0.004, blur: 0.006, opacity: 0.5 }, outline: { color: '#000', width: 0.002 }, blur: 0.0005, texture: { id: 'foil', strength: 0.7, scale: 1 }, opacity: 0.9, blend: 'screen' }, frame: { ...box(0.1, 0.2, 0.8, 0.12), rot: 5 } });
    d = addScrim(addLayer(d, t), t.id).design;
    for (const shape of ['rect', 'ellipse', 'line', 'ring'] as const) d = addLayer(d, newShape(shape, { fill: { type: 'radial', stops: [{ at: 0, color: '#fff' }, { at: 1, color: '#000', opacity: 0.2 }] } }));
    for (const item of LIBRARY) d = addLayer(d, newShape('symbol', { symbol: item.id }));
    for (const tx of TEXTURES) d = addLayer(d, newShape('rect', { fx: { texture: { id: tx.id, strength: 0.5, scale: 1 } } }));
    return d;
  };
  it('is well-formed SVG whatever is in the design, with every id unique', () => {
    const svg = renderSvg(full(), opts);
    const errors: string[] = [];
    const doc = new DOMParser({ onError: (_l: string, m: string) => void errors.push(m) } as never).parseFromString(svg, 'image/svg+xml');
    expect(errors).toEqual([]);
    expect(doc.documentElement!.getAttribute('viewBox')).toBe('0 0 1600 2560');
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref[1]);
  });
  it('escapes the words and takes only real colours and picture addresses', () => {
    const svg = renderSvg(full(), opts);
    expect(svg).toContain('The &lt;Last&gt; &amp;');
    expect(svg).toContain('&quot;Dragon&quot;');
    expect(svg).not.toContain('<Last>');
    let d = addLayer(newDesign('ebook'), newText('x', { fill: { type: 'solid', color: '"><script>alert(1)</script>' } }));
    expect(renderSvg(d, opts)).not.toContain('<script');
    d = addLayer(newDesign('ebook'), newImage({ path: 'a', hash: '' }, { w: 1, h: 1 }, d.canvas));
    expect(renderSvg(d, { ...opts, imageHref: () => 'x" onload="boom' })).not.toMatch(/onload="boom/);
  });
  it('leaves out hidden layers, draws a missing picture as a stand-in, and puts the template only where asked', () => {
    const t = newText('hidden words', { hidden: true });
    let d = addLayer(newDesign('paperback'), t);
    d = { ...d, template: { src: { path: 't.png', hash: 'h' }, opacity: 0.3, hidden: false, back: null, front: null } };
    expect(renderSvg(d, opts)).not.toContain('hidden words');
    expect(renderSvg(d, opts)).not.toContain('id="template"');
    expect(renderSvg(d, { ...opts, withTemplate: true })).toContain('id="template"');
    expect(renderSvg({ ...d, template: { ...d.template!, hidden: true } }, { ...opts, withTemplate: true })).not.toContain('id="template"');
    const img = addLayer(newDesign('ebook'), newImage({ path: 'a', hash: '' }, { w: 1, h: 1 }, d.canvas));
    expect(renderSvg(img, { ...opts, imageHref: () => null })).toContain('#8a8a96');
  });
  it('carries the fonts it is given inside the picture', () => {
    expect(renderSvg(newDesign('ebook'), { ...opts, fontCss: "@font-face{font-family:'Cinzel';src:url(data:font/woff2;base64,AA)}" })).toContain('@font-face');
  });
  it('draws every library piece and texture, and the library has no repeated name or id', () => {
    expect(new Set(LIBRARY.map((i) => i.id)).size).toBe(LIBRARY.length);
    expect(new Set(LIBRARY.map((i) => i.name)).size).toBe(LIBRARY.length);
    expect(LIBRARY.length).toBeGreaterThanOrEqual(30);
    for (const i of LIBRARY) expect(i.d).toMatch(/^M[\d.\- ]/);
  });
});

describe('picking and handles', async () => {
  const { hitTest, toLocal, handleAt, snapAngle, unionFrame, inRect, paletteOf } = await import('../src/shared/cover/hit');
  it('picks the topmost unlocked layer, honours rotation, and prefers a layer to a darkening band', () => {
    const under = rect(0.1, 0.1, 0.4, 0.4);
    const over = rect(0.3, 0.3, 0.4, 0.4);
    const locked = { ...rect(0.0, 0.0, 1, 1), locked: true };
    let d = addLayer(addLayer(addLayer(newDesign('ebook', { w: 1000, h: 1000 }), locked), under), over);
    expect(hitTest(d, 0.35, 0.35)!.id).toBe(over.id);
    expect(hitTest(d, 0.15, 0.15)!.id).toBe(under.id);
    expect(hitTest(d, 0.9, 0.9)).toBeNull(); // only the locked one is there
    const t = newText('x', { frame: box(0.75, 0.05, 0.2, 0.1) });
    d = addScrim(addLayer(d, t), t.id).design;
    expect(hitTest(d, 0.85, 0.1)!.id).toBe(t.id);
    const scrim = d.layers.find((l) => l.type === 'scrim')!;
    expect(hitTest(d, scrim.frame.x + 0.001, scrim.frame.y + 0.001)!.id).toBe(scrim.id);
    // a long thin layer turned a quarter turn
    const bar = { ...rect(0.1, 0.5, 0.8, 0.02), frame: { x: 0.1, y: 0.5, w: 0.8, h: 0.02, rot: 90 } };
    const e = addLayer(newDesign('ebook', { w: 1000, h: 1000 }), bar);
    expect(hitTest(e, 0.5, 0.2)!.id).toBe(bar.id);
    expect(hitTest(e, 0.2, 0.51)).toBeNull();
    expect(toLocal(box(0.25, 0.25, 0.5, 0.5), { w: 1000, h: 1000 }, 0.5, 0.5)).toEqual({ u: 0.5, v: 0.5 });
  });
  it('finds a corner handle, the rotation knob above the top edge, and nothing in the middle', () => {
    const f = box(0.3, 0.4, 0.4, 0.2);
    const c = { w: 1000, h: 1000 };
    expect(handleAt(f, c, 0.3, 0.4, 20)).toBe('nw');
    expect(handleAt(f, c, 0.7, 0.6, 20)).toBe('se');
    expect(handleAt(f, c, 0.5, 0.4, 20)).toBe('n');
    expect(handleAt(f, c, 0.5, 0.4 - 64 / 1000, 20)).toBe('rotate');
    expect(handleAt(f, c, 0.5, 0.5, 20)).toBeNull();
  });
  it('clings to quarter and 15-degree turns, selects by rectangle, and takes the union of frames', () => {
    expect(snapAngle(88)).toBe(90);
    expect(snapAngle(-2)).toBe(0);
    expect(snapAngle(358)).toBe(0);
    expect(snapAngle(50)).toBe(50);
    const a = rect(0.1, 0.1, 0.1, 0.1), b = rect(0.6, 0.6, 0.1, 0.1);
    const d = addLayer(addLayer(newDesign('ebook'), a), b);
    expect(inRect(d, { x: 0, y: 0, w: 0.3, h: 0.3 }).map((l) => l.id)).toEqual([a.id]);
    expect(unionFrame(d.layers)).toEqual({ x: 0.1, y: 0.1, w: 0.6, h: 0.6, rot: 0 });
    expect(unionFrame([])).toBeNull();
  });
  it('finds the colours that lead a picture, not the same colour twice', () => {
    const px: number[] = [];
    const add = (r: number, g: number, b: number, n: number) => { for (let i = 0; i < n; i++) px.push(r, g, b, 255); };
    add(200, 30, 30, 600); add(205, 35, 32, 300); add(20, 20, 60, 500); add(250, 250, 250, 200); add(240, 200, 60, 150);
    const p = paletteOf(Uint8ClampedArray.from(px), 4);
    expect(p).toHaveLength(4);
    expect(new Set(p).size).toBe(4);
    expect(p[0]).toMatch(/^#c[0-9a-f]2[0-9a-f]2[0-9a-f]$/i.source.length ? /^#[c-d]/ : /./); // a red leads
    expect(paletteOf(new Uint8ClampedArray(0))).toEqual([]);
  });
});
