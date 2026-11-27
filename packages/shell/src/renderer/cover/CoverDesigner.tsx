import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoverPicture } from '../../shared/api';
import { align, centreOnSpine, distribute, LAYOUTS, matchSize, stack, titleBlock, type AlignHow, type BlockLayout } from '../../shared/cover/arrange';
import { addLayer, clamp, DesignError, duplicate, EBOOK_SIZE, fontsUsed, layerOf, MAX_SIDE, newDesign, newImage, newShape, newText, parse, patchLayer, removeLayers, reorder, round, serialize, setFrame, type CoverKind, type Design, type Frame, type ImageLayer, type Layer, type Paint, type ShapeKind } from '../../shared/cover/doc';
import { PAIRINGS } from '../../shared/cover/fonts';
import { handleAt, HANDLES, hitTest, inRect, snapAngle, toLocal, unionFrame } from '../../shared/cover/hit';
import { GROUP_NAME, libraryItem, LIBRARY, type LibraryGroup } from '../../shared/cover/library';
import { renderSvg } from '../../shared/cover/render';
import { linesFor, nearestScale, SAFE_MARGIN, SCALES, snapAll, snapResize, SNAP_AT, type Handle, type SnapLine } from '../../shared/cover/snap';
import { fitTextFrames, type Measure } from '../../shared/cover/text';
import { canRedo, canUndo, commit, redo, settle, startHistory, undo, type History } from '../../shared/cover/history';
import { PaintEditor, Properties, type Edit } from './Panels';
import { coverApi, FontBook, installedFonts, makeMeasure, paletteFromUrl, Pictures, rasterisePdf, readFileBytes, renderPictures, thumbnailUrl } from './runtime';
import './cover.css';

/** What the designer draws with. The page's own are used unless a test gives others. */
export interface Deps {
  pics: Pictures;
  fonts: FontBook;
  measure: Measure;
  render: typeof renderPictures;
  thumb: typeof thumbnailUrl;
  palette: typeof paletteFromUrl;
  system: () => string[];
  pdf: typeof rasterisePdf;
}
export interface DesignerProps {
  projectId: string;
  projectName: string;
  kind: CoverKind;
  /** A design to open; without one a new design is started. */
  openPath?: string | null;
  fields: { title: string; series: string; author: string };
  pictures: CoverPicture[];
  may: { write: boolean };
  /** Called when the person leaves; `saved` says whether anything was saved, so the page can reload. */
  onClose: (saved: boolean) => void;
  deps?: Partial<Deps>;
}

const PAPERBACK_SIZE = { w: 3900, h: 2775 };
const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const base = (p: string) => p.split('/').pop() ?? p;

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; ids: string[]; orig: Map<string, Frame> }
  | { kind: 'resize'; handle: Handle; id: string; orig: Frame; size: number | null }
  | { kind: 'rotate'; id: string; orig: Frame }
  | { kind: 'marquee'; start: { x: number; y: number }; add: boolean }
  | { kind: 'region'; which: 'back' | 'front' };

type LeftTab = 'add' | 'library' | 'title' | 'cover';

export function CoverDesigner(props: DesignerProps) {
  const { projectId, projectName, kind, openPath, fields, may, onClose } = props;
  const deps = useMemo<Deps>(() => {
    const d = props.deps ?? {};
    return { pics: d.pics ?? new Pictures(), fonts: d.fonts ?? new FontBook(), measure: d.measure ?? makeMeasure(), render: d.render ?? renderPictures, thumb: d.thumb ?? thumbnailUrl, palette: d.palette ?? paletteFromUrl, system: d.system ?? installedFonts, pdf: d.pdf ?? rasterisePdf };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { pics, fonts, measure } = deps;
  const system = useMemo(() => deps.system(), [deps]);

  const [h, setH] = useState<History<Design>>(() => startHistory(newDesign(kind, kind === 'paperback' ? PAPERBACK_SIZE : EBOOK_SIZE)));
  const design = h.present;
  const designRef = useRef(design);
  designRef.current = design;
  const saved = useRef<Design>(design);
  const [sel, setSel] = useState<string[]>([]);
  const selRef = useRef<string[]>([]);
  selRef.current = sel;
  const [name, setName] = useState('');
  const [designPath, setDesignPath] = useState<string | null>(openPath ?? null);
  const [loading, setLoading] = useState(!!openPath);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [didSave, setDidSave] = useState(false);
  const [closing, setClosing] = useState(false);
  const [tab, setTab] = useState<LeftTab>('add');
  const [tick, setTick] = useState(0);
  const [hits, setHits] = useState<SnapLine[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [safe, setSafe] = useState(true);
  const [marking, setMarking] = useState(false);
  const [alignTo, setAlignTo] = useState<'canvas' | 'selection'>('selection');
  const [extra, setExtra] = useState<CoverPicture[]>([]);
  const [palette, setPalette] = useState<string[]>([]);
  const [thumb, setThumb] = useState<string | null>(null);
  const [avail, setAvail] = useState({ w: 520, h: 740 });
  const [libGroup, setLibGroup] = useState<LibraryGroup>('dividers');
  const [block, setBlock] = useState({ layout: 'low' as BlockLayout, pairing: 'epic', ...fields, subtitle: '', author: fields.author || 'Author Name' });
  const dragRef = useRef<Drag | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = design !== saved.current;
  const pictures = useMemo(() => [...props.pictures, ...extra].filter((p, i, a) => a.findIndex((q) => q.path === p.path) === i), [props.pictures, extra]);

  // ---- changing the design ----------------------------------------------------------------------------------------------------

  const edit: Edit = useCallback(
    (fn, key = null) =>
      setH((cur) => {
        let next = fn(cur.present);
        if (next === cur.present) return cur;
        next = fitTextFrames(next, measure);
        return commit(cur, next, key);
      }),
    [measure]
  );
  /** A change that is not the person's (a picture arrived, a font loaded): no step in the history. */
  const silent = useCallback((fn: (d: Design) => Design) => setH((cur) => { const next = fn(cur.present); if (next === cur.present) return cur; if (saved.current === cur.present) saved.current = next; return { ...cur, present: next }; }), []);
  const done = useCallback(() => setH((cur) => settle(cur)), []);

  // ---- opening -----------------------------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!openPath) return;
    let live = true;
    coverApi().open(openPath).then(
      (o) => {
        if (!live) return;
        try {
          const d = parse(o.text);
          saved.current = d;
          setH(startHistory(d));
          setName(base(o.path).replace(/\.cadrel-cover\.json$/, ''));
          const n: string[] = [];
          for (const p of o.pictures) {
            if (p.state === 'missing') n.push(`${base(p.path)} is not in the files any more, so a grey box stands in for it.`);
            if (p.state === 'changed') n.push(`${base(p.path)} has a newer version than the one this design was saved with. It shows the newest; save to keep it.`);
          }
          setNotes(n);
        } catch (e) {
          setError(e instanceof DesignError ? e.message : message(e));
        }
        setLoading(false);
      },
      (e) => { if (live) { setError(message(e)); setLoading(false); } }
    );
    return () => { live = false; };
  }, [openPath]);

  // pictures the design uses are read once, then drawn
  const paths = useMemo(() => [...new Set([...design.layers.flatMap((l) => (l.type === 'image' ? [l.src.path] : [])), ...(design.template ? [design.template.src.path] : [])])].sort().join('\n'), [design]);
  useEffect(() => {
    let live = true;
    for (const p of paths.split('\n').filter(Boolean)) {
      if (pics.get(p)) continue;
      void pics.load(p).then((l) => {
        if (!live || !l) return;
        setTick((t) => t + 1);
        // a picture's own size and version are what the design should remember
        silent((d) => ({ ...d, layers: d.layers.map((x) => (x.type === 'image' && x.src.path === p && (x.natural.w !== l.width || x.natural.h !== l.height) ? { ...x, natural: { w: l.width, h: l.height } } : x)) }));
      });
    }
    return () => { live = false; };
  }, [paths, pics, silent]);
  useEffect(() => () => { pics.dispose(); fonts.dispose(); }, [pics, fonts]);

  // fonts the design uses are loaded, and the text re-measured once they are
  const used = fontsUsed(design).join('|');
  useEffect(() => {
    let live = true;
    void fonts.ensure(used.split('|').filter(Boolean)).then(() => { if (live) { setTick((t) => t + 1); silent((d) => fitTextFrames(d, measure)); } }, () => undefined);
    return () => { live = false; };
  }, [used, fonts, measure, silent]);

  // the colours of the first picture, offered as swatches
  const firstImage = design.layers.find((l): l is ImageLayer => l.type === 'image');
  const firstPath = firstImage?.src.path;
  useEffect(() => {
    const p = firstPath ? pics.get(firstPath) : undefined;
    if (!p) { setPalette([]); return; }
    let live = true;
    deps.palette(p.url).then((c) => live && setPalette(c), () => live && setPalette([]));
    return () => { live = false; };
  }, [firstPath, tick, pics, deps]);

  // a small picture for the thumbnail strip, after the person pauses
  useEffect(() => {
    const t = setTimeout(() => {
      deps.thumb(designRef.current, pics, fonts, measure).then(setThumb, () => setThumb(null));
    }, 600);
    return () => clearTimeout(t);
  }, [design, tick, deps, pics, fonts, measure]);

  // the room the canvas has
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvail({ w: Math.max(200, el.clientWidth - 24 - (el.clientWidth > 520 ? 176 : 0)), h: Math.max(240, el.clientHeight - 24 - 44) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = Math.min(avail.w / design.canvas.w, avail.h / design.canvas.h);
  const shownW = Math.round(design.canvas.w * scale);
  const shownH = Math.round(design.canvas.h * scale);

  const svg = useMemo(() => renderSvg(design, { measure, imageHref: pics.href, withTemplate: true }), [design, measure, pics, tick]);

  // ---- selecting ---------------------------------------------------------------------------------------------------------------

  const selected = sel.map((id) => layerOf(design, id)).filter((l): l is Layer => !!l);
  const one = selected.length === 1 ? selected[0]! : null;
  useEffect(() => { setSel((s) => (s.every((id) => layerOf(design, id)) ? s : s.filter((id) => layerOf(design, id)))); }, [design]);

  // ---- adding things -----------------------------------------------------------------------------------------------------------

  const addAndSelect = (l: Layer) => { edit((d) => addLayer(d, l)); setSel([l.id]); };
  const addText = (title: boolean) =>
    addAndSelect(title ? newText('Title', { name: 'Title', size: 0.09, frame: { x: 0.1, y: 0.4, w: 0.8, h: 0.1, rot: 0 } }) : newText('Your words here', { name: 'Text', size: 0.035, font: 'Montserrat', weight: 400, tracking: 0.12, upper: true, frame: { x: 0.1, y: 0.55, w: 0.8, h: 0.05, rot: 0 } }));
  const addShape = (shape: ShapeKind) => {
    const s = newShape(shape);
    addAndSelect(shape === 'line' ? s : { ...s, frame: { ...s.frame, h: round((s.frame.w * design.canvas.w) / design.canvas.h) } });
  };
  const addSymbol = (id: string) => {
    const item = libraryItem(id);
    if (!item) return;
    const wide = item.vb.w / item.vb.h;
    const frameShape = item.group === 'frames';
    const w = frameShape ? 0.9 : wide > 2.5 ? 0.5 : wide > 1.2 ? 0.34 : 0.22;
    const hh = frameShape ? 0.9 * design.canvas.w * (item.vb.h / item.vb.w) / design.canvas.h : (w * design.canvas.w * item.vb.h) / item.vb.w / design.canvas.h;
    addAndSelect(newShape('symbol', { symbol: id, name: item.name, frame: { x: round((1 - w) / 2), y: round(frameShape ? (1 - hh) / 2 : 0.45), w, h: round(hh), rot: 0 } }));
  };
  const addPicture = async (path: string) => {
    setError(null);
    const l = await pics.load(path);
    if (!l) return setError(`${base(path)} could not be read as a picture.`);
    setTick((t) => t + 1);
    addAndSelect(newImage({ path, hash: l.hash }, { w: l.width, h: l.height }, designRef.current.canvas, base(path).replace(/\.[^.]+$/, '')));
  };
  const replacePicture = async (layerId: string, path: string) => {
    const l = await pics.load(path);
    if (!l) return setError(`${base(path)} could not be read as a picture.`);
    setTick((t) => t + 1);
    edit((d) => patchLayer<ImageLayer>(d, layerId, { src: { path, hash: l.hash }, natural: { w: l.width, h: l.height }, name: base(path).replace(/\.[^.]+$/, '') }));
  };
  const importFile = async (file: File, role: 'picture' | 'template') => {
    setBusy(true);
    setError(null);
    try {
      let bytes: Uint8Array = await readFileBytes(file);
      let fname = file.name;
      if (role === 'template' && (/\.pdf$/i.test(fname) || file.type === 'application/pdf')) {
        const r = await deps.pdf(bytes);
        bytes = r.png;
        fname = fname.replace(/\.pdf$/i, '') + '.png';
        if (r.pages > 1) setNotes((n) => [...n, 'That PDF has more than one page. Page one is used.']);
      }
      const r = await coverApi().importPicture({ projectId, name: fname, bytes, role });
      const l = await pics.load(r.path);
      if (!l) throw new Error('The picture was saved but could not be read back.');
      setTick((t) => t + 1);
      if (role === 'picture') {
        setExtra((e) => [...e, { fileId: '', path: r.path, version: 1 }]);
        addAndSelect(newImage({ path: r.path, hash: r.hash }, { w: r.width, h: r.height }, designRef.current.canvas, base(r.path).replace(/\.[^.]+$/, '')));
      } else {
        const k = Math.min(1, MAX_SIDE / Math.max(r.width, r.height));
        edit((d) => ({ ...d, canvas: { w: Math.round(r.width * k), h: Math.round(r.height * k) }, template: { src: { path: r.path, hash: r.hash }, opacity: 0.35, hidden: false, back: 0.46, front: 0.54 } }));
        setMarking(true);
        setStatus('Template laid over the cover. Drag the two lines to the edges of the spine.');
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- the pointer -------------------------------------------------------------------------------------------------------------

  const frac = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const capture = (e: React.PointerEvent) => { try { stageRef.current?.setPointerCapture?.(e.pointerId); } catch { /* a pointer that is already gone */ } };
  const reach = 10 / Math.max(scale, 0.01);
  const setFrames = (d: Design, m: Map<string, Frame>) => [...m].reduce((acc, [id, f]) => setFrame(acc, id, f), d);

  const onDown = (e: React.PointerEvent) => {
    const p = frac(e);
    if (!p || e.button !== 0) return;
    const d = designRef.current;
    stageRef.current?.focus();
    if (marking && d.template && d.template.back !== null && d.template.front !== null) {
      const near = (v: number) => Math.abs(p.x - v) < 0.012;
      if (near(d.template.back)) { dragRef.current = { kind: 'region', which: 'back' }; capture(e); return; }
      if (near(d.template.front)) { dragRef.current = { kind: 'region', which: 'front' }; capture(e); return; }
    }
    const cur = selRef.current.length === 1 ? layerOf(d, selRef.current[0]!) : undefined;
    if (cur && !cur.locked) {
      const hd = handleAt(cur.frame, d.canvas, p.x, p.y, reach);
      if (hd === 'rotate') { dragRef.current = { kind: 'rotate', id: cur.id, orig: cur.frame }; capture(e); return; }
      if (hd) { dragRef.current = { kind: 'resize', handle: hd, id: cur.id, orig: cur.frame, size: cur.type === 'text' ? cur.size : null }; capture(e); return; }
    }
    const hit = hitTest(d, p.x, p.y, 4 / Math.max(scale, 0.01));
    if (hit) {
      let ids: string[];
      if (e.shiftKey) ids = selRef.current.includes(hit.id) ? selRef.current.filter((x) => x !== hit.id) : [...selRef.current, hit.id];
      else ids = selRef.current.includes(hit.id) ? selRef.current : [hit.id];
      setSel(ids);
      const orig = new Map(ids.flatMap((id) => { const l = layerOf(d, id); return l && !l.locked ? [[id, l.frame] as const] : []; }));
      dragRef.current = { kind: 'move', start: p, ids: [...orig.keys()], orig };
    } else {
      if (!e.shiftKey) setSel([]);
      dragRef.current = { kind: 'marquee', start: p, add: e.shiftKey };
    }
    capture(e);
  };

  const onMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const p = frac(e);
    if (!drag || !p) return;
    const d = designRef.current;
    if (drag.kind === 'move') {
      const u = unionFrame(drag.ids.map((id) => layerOf(d, id)!).filter(Boolean).map((l) => ({ ...l, frame: drag.orig.get(l.id)! })));
      if (!u) return;
      const moved = { ...u, x: u.x + (p.x - drag.start.x), y: u.y + (p.y - drag.start.y) };
      const s = e.altKey ? { frame: moved, hits: [] as SnapLine[] } : snapAll(moved, d, drag.ids);
      setHits(s.hits);
      const dx = s.frame.x - u.x;
      const dy = s.frame.y - u.y;
      if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) < 0.002 && h.key === null) return;
      edit((dd) => setFrames(dd, new Map([...drag.orig].map(([id, f]) => [id, { ...f, x: round(f.x + dx), y: round(f.y + dy) }]))), 'drag');
    } else if (drag.kind === 'resize') {
      const l = layerOf(d, drag.id);
      if (!l) return;
      const { u, v } = toLocal(drag.orig, d.canvas, p.x, p.y);
      const o = drag.orig;
      let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
      if (drag.handle.includes('w')) left = o.x + u * o.w;
      if (drag.handle.includes('e')) right = o.x + u * o.w;
      if (drag.handle.includes('n')) top = o.y + v * o.h;
      if (drag.handle.includes('s')) bottom = o.y + v * o.h;
      const raw: Frame = { ...o, x: Math.min(left, right - 0.01), y: Math.min(top, bottom - 0.01), w: Math.max(0.01, right - left), h: Math.max(0.01, bottom - top) };
      const lines = e.altKey ? [] : linesFor(d, [drag.id]);
      if (l.type === 'text' && drag.size !== null) {
        const side = drag.handle === 'e' || drag.handle === 'w';
        if (side) {
          const s = snapResize(raw, drag.handle, lines, SNAP_AT);
          setHits(s.hits);
          edit((dd) => setFrame(dd, l.id, { x: round(s.frame.x), w: round(s.frame.w) }), 'resize');
        } else {
          // the corners and the top and bottom handles scale the type; its size lands on the scale when close
          const factor = drag.handle.length === 2 ? raw.w / o.w : raw.h / o.h;
          let size = clamp(drag.size * factor, 0.012, 0.3);
          const near = nearestScale(size);
          if (Math.abs(size / near.size - 1) < 0.06) size = near.size;
          const w = clamp(o.w * (size / drag.size), 0.05, 1.5);
          const x = drag.handle.includes('w') ? o.x + o.w - w : o.x;
          setHits([]);
          edit((dd) => setFrame(patchLayer(dd, l.id, { size } as never), l.id, { x: round(x), w: round(w) }), 'resize');
        }
        return;
      }
      const keep = (l.type === 'image' || (l.type === 'shape' && l.shape === 'symbol')) !== e.shiftKey;
      const ratio = keep && drag.handle.length === 2 ? o.w / o.h : undefined;
      const s = snapResize(raw, drag.handle, lines, SNAP_AT, ratio);
      setHits(s.hits);
      edit((dd) => setFrame(dd, l.id, { x: round(s.frame.x), y: round(s.frame.y), w: round(s.frame.w), h: round(s.frame.h) }), 'resize');
    } else if (drag.kind === 'rotate') {
      const o = drag.orig;
      const cx = (o.x + o.w / 2) * d.canvas.w;
      const cy = (o.y + o.h / 2) * d.canvas.h;
      const deg = (Math.atan2(p.y * d.canvas.h - cy, p.x * d.canvas.w - cx) * 180) / Math.PI + 90;
      edit((dd) => setFrame(dd, drag.id, { rot: e.altKey ? Math.round(deg) : snapAngle(deg) }), 'rotate');
    } else if (drag.kind === 'marquee') {
      setMarquee({ x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) });
    } else if (drag.kind === 'region') {
      const t = d.template;
      if (!t || t.back === null || t.front === null) return;
      const at = round(clamp(p.x, 0.02, 0.98));
      edit((dd) => ({ ...dd, template: { ...dd.template!, ...(drag.which === 'back' ? { back: Math.min(at, (dd.template!.front ?? 1) - 0.01) } : { front: Math.max(at, (dd.template!.back ?? 0) + 0.01) }) } }), 'region');
    }
  };

  const onUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setHits([]);
    if (drag?.kind === 'marquee' && marquee) {
      const found = inRect(designRef.current, marquee).map((l) => l.id);
      setSel((s) => (drag.add ? [...new Set([...s, ...found])] : found));
    }
    setMarquee(null);
    done();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); setH((c) => (e.shiftKey ? redo(c) : undo(c))); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); setH((c) => redo(c)); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
    if (mod && e.key.toLowerCase() === 'd' && one) { e.preventDefault(); const r = duplicate(designRef.current, one.id); if (r.id) { edit(() => r.design); setSel([r.id]); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); edit((d) => removeLayers(d, sel)); setSel([]); return; }
    if (e.key === 'Escape') { setSel([]); return; }
    const step = e.shiftKey ? 0.01 : 0.002;
    const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (mv[e.key] && sel.length) {
      e.preventDefault();
      const [dx, dy] = mv[e.key]!;
      edit((d) => setFrames(d, new Map(sel.flatMap((id) => { const l = layerOf(d, id); return l && !l.locked ? [[id, { ...l.frame, x: round(l.frame.x + dx), y: round(l.frame.y + dy) }] as const] : []; }))), 'nudge');
    }
  };

  // ---- saving ------------------------------------------------------------------------------------------------------------------

  async function save() {
    if (busy || !may.write) return;
    const cur = designRef.current;
    if (!designPath && !name.trim()) { setError('Give the cover a name first.'); return; }
    setBusy(true);
    setError(null);
    setStatus('Saving…');
    try {
      await fonts.ensure(fontsUsed(cur));
      // a design remembers the version of each picture it was saved with
      const withHashes: Design = { ...cur, layers: cur.layers.map((l) => (l.type === 'image' ? { ...l, src: { path: l.src.path, hash: pics.get(l.src.path)?.hash ?? l.src.hash } } : l)) };
      const { image, front } = await deps.render(withHashes, pics, fonts, measure);
      const r = await coverApi().save({ projectId, name: name.trim() || 'Cover', designPath, design: serialize(withHashes), image, front });
      saved.current = withHashes;
      setH((c) => ({ ...c, present: withHashes, key: null }));
      saved.current = withHashes;
      setDesignPath(r.designPath);
      setDidSave(true);
      setNotes([]);
      setStatus(`Saved as version ${r.version}. The cover is on the Art page${r.version === 1 ? ' as a draft, waiting for someone to approve it' : ''}.`);
    } catch (e) {
      setError(message(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  const close = () => (dirty ? setClosing(true) : onClose(didSave));

  // ---- the page ----------------------------------------------------------------------------------------------------------------

  const t = design.template;
  const canvasKind = design.kind === 'paperback' ? 'Paperback wrap' : 'eBook cover';
  const alignHow = (how: AlignHow) => edit((d) => align(d, sel, how, sel.length > 1 ? alignTo : 'canvas'));
  const stackOrder = [...design.layers].reverse();

  if (loading) return <p className="muted">Opening the design…</p>;

  return (
    <div className="cv" aria-label="Cover Designer">
      <header className="cv-top">
        <button type="button" className="link" onClick={close}>← Back to Art</button>
        <span className="chip">{canvasKind}</span>
        <span className="chip" title="The project">{projectName}</span>
        {!designPath ? (
          <input className="cv-name" aria-label="Cover name" placeholder="Name this cover" value={name} onChange={(e) => setName(e.target.value)} />
        ) : (
          <strong className="cv-title" title={designPath}>{base(designPath).replace(/\.cadrel-cover\.json$/, '')}</strong>
        )}
        <span className="cv-spacer" />
        <button type="button" onClick={() => setH((c) => undo(c))} disabled={!canUndo(h)} aria-label="Undo">Undo</button>
        <button type="button" onClick={() => setH((c) => redo(c))} disabled={!canRedo(h)} aria-label="Redo">Redo</button>
        <label className="cv-check"><input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Safe margin</label>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy || !may.write || (!!designPath && !dirty)}>{busy ? 'Saving…' : designPath && !dirty ? 'Saved' : 'Save'}</button>
      </header>
      {!may.write && <div className="banner warn" role="status">You can look at this design but your role does not let you change it.</div>}
      {error && <div className="banner error" role="alert">{error}</div>}
      {status && !error && <div className="banner info" role="status">{status}</div>}
      {notes.map((n) => <div key={n} className="banner warn" role="status">{n}</div>)}
      {closing && (
        <div className="banner warn" role="alertdialog" aria-label="Unsaved changes">
          This design has changes that are not saved.
          <button type="button" onClick={() => onClose(didSave)}>Leave without saving</button>
          <button type="button" onClick={() => setClosing(false)}>Keep working</button>
        </div>
      )}

      <div className="cv-body">
        <nav className="cv-left" aria-label="Add to the cover">
          <div className="cv-tabs" role="tablist">
            {([['add', 'Add'], ['library', 'Library'], ['title', 'Title block'], ['cover', design.kind === 'paperback' ? 'Wrap' : 'Cover']] as const).map(([k, n]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</button>
            ))}
          </div>
          {tab === 'add' && (
            <div className="cv-panel">
              <h4>Words</h4>
              <div className="cv-seg"><button type="button" onClick={() => addText(true)}>Add a title</button><button type="button" onClick={() => addText(false)}>Add text</button></div>
              <h4>Shapes</h4>
              <div className="cv-seg">{([['rect', 'Box'], ['ellipse', 'Oval'], ['line', 'Line'], ['ring', 'Ring']] as const).map(([k, n]) => <button key={k} type="button" onClick={() => addShape(k)}>{n}</button>)}</div>
              <h4>Pictures</h4>
              <label className="cv-file">
                Add a picture from your computer…
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" aria-label="Add a picture from your computer" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f, 'picture'); }} />
              </label>
              {pictures.length > 0 && (
                <label className="cv-field cv-block">
                  <span>or one already in this project</span>
                  <select aria-label="Picture from the project" value="" onChange={(e) => e.target.value && void addPicture(e.target.value)}>
                    <option value="">Choose…</option>
                    {pictures.map((p) => <option key={p.path} value={p.path}>{base(p.path)}</option>)}
                  </select>
                </label>
              )}
              <p className="muted small">New pictures are kept in this project's files, so their licence and history stay with them.</p>
            </div>
          )}
          {tab === 'library' && (
            <div className="cv-panel">
              <div className="cv-seg cv-wrap" role="group" aria-label="Library groups">
                {(Object.keys(GROUP_NAME) as LibraryGroup[]).map((g) => <button key={g} type="button" aria-pressed={libGroup === g} className={libGroup === g ? 'on' : ''} onClick={() => setLibGroup(g)}>{GROUP_NAME[g]}</button>)}
              </div>
              <div className="cv-library" aria-label={GROUP_NAME[libGroup]}>
                {LIBRARY.filter((i) => i.group === libGroup).map((i) => (
                  <button key={i.id} type="button" className="cv-lib" title={`Add ${i.name}`} aria-label={`Add ${i.name}`} onClick={() => addSymbol(i.id)}>
                    <svg viewBox={`0 0 ${i.vb.w} ${i.vb.h}`} aria-hidden="true"><path d={i.d} fill="currentColor" fillRule={i.evenodd ? 'evenodd' : 'nonzero'} /></svg>
                    <span>{i.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {tab === 'title' && (
            <div className="cv-panel">
              <p className="muted small">Lays out a title, its lines and the author's name as real text you can edit afterwards. Doing it again replaces the last block.</p>
              <label className="cv-field cv-block"><span>Title</span><input aria-label="Block title" value={block.title} onChange={(e) => setBlock({ ...block, title: e.target.value })} /></label>
              <label className="cv-field cv-block"><span>Line under it</span><input aria-label="Block subtitle" value={block.subtitle} onChange={(e) => setBlock({ ...block, subtitle: e.target.value })} /></label>
              <label className="cv-field cv-block"><span>Series</span><input aria-label="Block series" value={block.series} onChange={(e) => setBlock({ ...block, series: e.target.value })} /></label>
              <label className="cv-field cv-block"><span>Author</span><input aria-label="Block author" value={block.author} onChange={(e) => setBlock({ ...block, author: e.target.value })} /></label>
              <div className="cv-seg" role="group" aria-label="Where the title goes">{LAYOUTS.map((l) => <button key={l.id} type="button" aria-pressed={block.layout === l.id} className={block.layout === l.id ? 'on' : ''} onClick={() => setBlock({ ...block, layout: l.id })}>{l.name}</button>)}</div>
              <label className="cv-field cv-block"><span>Fonts</span>
                <select aria-label="Font pairing" value={block.pairing} onChange={(e) => setBlock({ ...block, pairing: e.target.value })}>{PAIRINGS.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.title.font} + {p.byline.font}</option>)}</select>
              </label>
              <button type="button" className="primary" disabled={!block.title.trim() || !block.author.trim()} onClick={async () => {
                const p = PAIRINGS.find((x) => x.id === block.pairing)!;
                await fonts.ensure([p.title.font, p.byline.font]);
                setTick((x) => x + 1);
                const r = titleBlock(designRef.current, block.layout, block.pairing, { title: block.title.trim(), subtitle: block.subtitle, series: block.series, author: block.author.trim() }, measure);
                edit(() => r.design);
                setSel(r.ids);
              }}>Lay out the title block</button>
            </div>
          )}
          {tab === 'cover' && (
            <div className="cv-panel">
              <PaintEditor label="Background" paint={design.background} palette={palette} onChange={(p: Paint, k) => edit((d) => ({ ...d, background: p }), `bg-${k}`)} />
              {design.kind === 'paperback' && (
                <section className="cv-section" aria-label="KDP template">
                  <h4>KDP template</h4>
                  <p className="muted small">Import the template KDP made for your book (PDF, PNG or JPG). It is laid over the cover as a faint guide: you cannot click it, and it is never in the saved picture.</p>
                  <label className="cv-file">
                    {t ? 'Replace the template…' : 'Import the KDP template…'}
                    <input type="file" accept="application/pdf,image/png,image/jpeg" aria-label="Import the KDP template" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f, 'template'); }} />
                  </label>
                  {t && (
                    <>
                      <label className="cv-field"><span>Template strength</span><input type="range" aria-label="Template strength" min={0.05} max={0.9} step={0.05} value={t.opacity} onChange={(e) => edit((d) => ({ ...d, template: { ...d.template!, opacity: Number(e.target.value) } }), 'tpl')} /><output>{Math.round(t.opacity * 100)}%</output></label>
                      <div className="cv-seg">
                        <button type="button" aria-pressed={t.hidden} className={t.hidden ? 'on' : ''} onClick={() => edit((d) => ({ ...d, template: { ...d.template!, hidden: !d.template!.hidden } }))}>{t.hidden ? 'Show template' : 'Hide template'}</button>
                        <button type="button" aria-pressed={marking} className={marking ? 'on' : ''} onClick={() => setMarking(!marking)}>{marking ? 'Done marking' : 'Mark the spine'}</button>
                      </div>
                      <p className="muted small">Back cover to {Math.round((t.back ?? 0) * 100)}%, spine to {Math.round((t.front ?? 0) * 100)}%, front cover after. {marking ? 'Drag the two lines on the cover.' : ''}</p>
                      {one && <button type="button" onClick={() => edit((d) => centreOnSpine(d, one.id))}>Centre the selected layer on the spine</button>}
                    </>
                  )}
                  {!t && <p className="muted small">Until a template is added this is a blank wrap, {design.canvas.w} × {design.canvas.h} px.</p>}
                </section>
              )}
              <p className="muted small">{canvasKind}, {design.canvas.w} × {design.canvas.h} px. {design.kind === 'ebook' ? 'KDP asks for at least 1,000 pixels on the long side and recommends 1,600 × 2,560.' : 'It is saved as a full wrap and, once the spine is marked, the front cover alone.'}</p>
            </div>
          )}
        </nav>

        <main className="cv-mid" ref={wrapRef}>
          {selected.length > 0 && (
            <div className="cv-bar" role="toolbar" aria-label="Arrange">
              {sel.length > 1 && <select aria-label="Align to" value={alignTo} onChange={(e) => setAlignTo(e.target.value as 'canvas' | 'selection')}><option value="selection">Align to each other</option><option value="canvas">Align to the cover</option></select>}
              {([['left', '⇤', 'Align left'], ['centre', '⇔', 'Centre across'], ['right', '⇥', 'Align right'], ['top', '⇡', 'Align top'], ['middle', '⇕', 'Centre up and down'], ['bottom', '⇣', 'Align bottom']] as const).map(([how, g, n]) => <button key={how} type="button" title={n} aria-label={n} onClick={() => alignHow(how)}>{g}</button>)}
              <button type="button" disabled={sel.length < 3} onClick={() => edit((d) => distribute(d, sel, 'x'))}>Space evenly across</button>
              <button type="button" disabled={sel.length < 3} onClick={() => edit((d) => distribute(d, sel, 'y'))}>Space evenly down</button>
              <button type="button" disabled={sel.length < 2} onClick={() => edit((d) => stack(d, sel))}>Stack</button>
              <button type="button" disabled={sel.length < 2} onClick={() => edit((d) => matchSize(d, sel, 'width'))}>Match width</button>
              <span className="cv-spacer" />
              <button type="button" onClick={() => { const r = duplicate(design, selected[0]!.id); if (r.id) { edit(() => r.design); setSel([r.id]); } }} disabled={sel.length !== 1}>Duplicate</button>
              <button type="button" onClick={() => { edit((d) => removeLayers(d, sel)); setSel([]); }}>Delete</button>
            </div>
          )}
          <div className="cv-work">
          <div
            className="cv-stage"
            ref={stageRef}
            role="application"
            aria-label="Cover canvas"
            tabIndex={0}
            style={{ width: shownW, height: shownH }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey}
            onDoubleClick={() => one?.type === 'text' && textRef.current?.focus()}
          >
            <div className="cv-art" data-testid="cover-art" dangerouslySetInnerHTML={{ __html: svg }} />
            <svg className="cv-over" viewBox={`0 0 ${design.canvas.w} ${design.canvas.h}`} aria-hidden="true">
              {safe && <rect className="cv-safe" x={SAFE_MARGIN * design.canvas.w} y={SAFE_MARGIN * design.canvas.h} width={(1 - 2 * SAFE_MARGIN) * design.canvas.w} height={(1 - 2 * SAFE_MARGIN) * design.canvas.h} />}
              {t && !t.hidden && t.back !== null && t.front !== null && (
                <g className={marking ? 'cv-regions on' : 'cv-regions'}>
                  <rect x={t.back * design.canvas.w} y={0} width={(t.front - t.back) * design.canvas.w} height={design.canvas.h} className="cv-spine" />
                  {[t.back, t.front].map((v, i) => <line key={i} x1={v * design.canvas.w} x2={v * design.canvas.w} y1={0} y2={design.canvas.h} />)}
                </g>
              )}
              {hits.map((ln, i) => (ln.axis === 'x' ? <line key={i} className={`cv-hit ${ln.kind}`} x1={ln.at * design.canvas.w} x2={ln.at * design.canvas.w} y1={0} y2={design.canvas.h} /> : <line key={i} className={`cv-hit ${ln.kind}`} y1={ln.at * design.canvas.h} y2={ln.at * design.canvas.h} x1={0} x2={design.canvas.w} />))}
              {selected.map((l) => {
                const f = l.frame;
                const x = f.x * design.canvas.w, y = f.y * design.canvas.h, w = f.w * design.canvas.w, hh = f.h * design.canvas.h;
                const k = 1 / Math.max(scale, 0.01);
                return (
                  <g key={l.id} transform={f.rot ? `rotate(${f.rot} ${x + w / 2} ${y + hh / 2})` : undefined}>
                    <rect className="cv-sel" x={x} y={y} width={w} height={hh} strokeWidth={1.5 * k} />
                    {selected.length === 1 && !l.locked && (
                      <>
                        {HANDLES.map((hd) => <rect key={hd.id} className="cv-handle" x={x + hd.u * w - 5 * k} y={y + hd.v * hh - 5 * k} width={10 * k} height={10 * k} strokeWidth={1.5 * k} />)}
                        <line className="cv-stem" x1={x + w / 2} x2={x + w / 2} y1={y} y2={y - 28 * k} strokeWidth={1.5 * k} />
                        <circle className="cv-handle" cx={x + w / 2} cy={y - 32 * k} r={5 * k} strokeWidth={1.5 * k} />
                      </>
                    )}
                  </g>
                );
              })}
              {marquee && <rect className="cv-marquee" x={marquee.x * design.canvas.w} y={marquee.y * design.canvas.h} width={marquee.w * design.canvas.w} height={marquee.h * design.canvas.h} />}
            </svg>
          </div>
          <div className="cv-thumbs" aria-label="How it looks small">
            {thumb ? [160, 80, 40].map((w) => <figure key={w}><img src={thumb} width={w} alt={`Cover at ${w} pixels wide`} /><figcaption>{w}px</figcaption></figure>) : <span className="muted small">Small sizes appear here once the picture is drawn.</span>}
          </div>
          </div>
        </main>

        <aside className="cv-right" aria-label="Layers and settings">
          <section className="cv-layers" aria-label="Layers">
            <h4>Layers</h4>
            {design.layers.length === 0 ? <p className="muted small">Nothing on the cover yet. Add a picture, some words or a shape.</p> : (
              <ul className="plain">
                {stackOrder.map((l) => (
                  <li key={l.id} className={sel.includes(l.id) ? 'on' : ''}>
                    <button type="button" className="cv-pick" aria-pressed={sel.includes(l.id)} onClick={(e) => setSel(e.shiftKey ? (sel.includes(l.id) ? sel.filter((x) => x !== l.id) : [...sel, l.id]) : [l.id])}>
                      <span className="cv-kind" aria-hidden="true">{l.type === 'text' ? 'T' : l.type === 'image' ? '▣' : l.type === 'scrim' ? '◐' : '◆'}</span> {l.name}
                    </button>
                    <button type="button" className="cv-mini" aria-label={`${l.hidden ? 'Show' : 'Hide'} ${l.name}`} aria-pressed={l.hidden} onClick={() => edit((d) => patchLayer(d, l.id, { hidden: !l.hidden }))}>{l.hidden ? '◌' : '●'}</button>
                    <button type="button" className="cv-mini" aria-label={`${l.locked ? 'Unlock' : 'Lock'} ${l.name}`} aria-pressed={l.locked} onClick={() => edit((d) => patchLayer(d, l.id, { locked: !l.locked }))}>{l.locked ? '🔒' : '🔓'}</button>
                    <button type="button" className="cv-mini" aria-label={`Bring ${l.name} forward`} onClick={() => edit((d) => reorder(d, l.id, 1))}>↑</button>
                    <button type="button" className="cv-mini" aria-label={`Send ${l.name} back`} onClick={() => edit((d) => reorder(d, l.id, -1))}>↓</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {one ? (
            <Properties layer={one} env={{ d: design, edit, palette, system, pictures, onReplacePicture: (id, p) => void replacePicture(id, p), textRef }} />
          ) : sel.length > 1 ? (
            <p className="muted small">{sel.length} layers selected. Move them together, or use the arrange bar above the cover.</p>
          ) : (
            <p className="muted small">Click something on the cover to change it. Drag to move; the handles resize, and the dot above turns it. Lines appear when it lines up with the middle, a third, the margin or another layer; hold Alt to move freely.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
