/** The Cover Designer's property panels: small controls with a clear name each, and the panel for whatever layer is selected. */
import { addScrim, BLENDS, detachScrim, patchFx, patchLayer, solid, type Blend, type Design, type Effects, type ImageLayer, type Layer, type Paint, type ScrimLayer, type ShapeLayer, type TextLayer } from '../../shared/cover/doc';
import { TEXTURES } from '../../shared/cover/fx';
import { STARTER_FONTS } from '../../shared/cover/fonts';
import { nearestScale, SCALES, stepScale } from '../../shared/cover/snap';

export type Edit = (fn: (d: Design) => Design, key?: string | null) => void;

export const hex6 = (c: string): string => {
  const t = c.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(t);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : '#888888';
};

export function Slider({ label, value, min, max, step, onChange, show, id }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; show?: (v: number) => string; id?: string }) {
  return (
    <label className="cv-field">
      <span>{label}</span>
      <input type="range" aria-label={label} id={id} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{show ? show(value) : String(Math.round(value * 1000) / 1000)}</output>
    </label>
  );
}
export function ColourInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="cv-field cv-colour">
      <span>{label}</span>
      <input type="color" aria-label={label} value={hex6(value)} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
function Check({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="cv-check">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
const pct = (v: number) => `${Math.round(v * 100)}%`;

// ---- paints --------------------------------------------------------------------------------------------------------------------

/** Solid colour or a gradient of two colours, with swatches from the cover's own picture. */
export function PaintEditor({ label, paint, onChange, palette }: { label: string; paint: Paint; onChange: (p: Paint, key: string) => void; palette: string[] }) {
  const kind = paint.type;
  const first = paint.type === 'solid' ? paint.color : paint.stops[0]!.color;
  const last = paint.type === 'solid' ? paint.color : paint.stops[paint.stops.length - 1]!.color;
  const stops = (a: string, b: string) => [{ at: 0, color: a }, { at: 1, color: b }];
  const set = (to: 'solid' | 'linear' | 'radial') => {
    if (to === 'solid') onChange(solid(first), `${label}-kind`);
    else if (to === 'linear') onChange({ type: 'linear', angle: paint.type === 'linear' ? paint.angle : 180, stops: paint.type === 'solid' ? stops(first, shade(first)) : paint.stops }, `${label}-kind`);
    else onChange({ type: 'radial', stops: paint.type === 'solid' ? stops(first, shade(first)) : paint.stops }, `${label}-kind`);
  };
  const setStop = (i: number, color: string) => {
    if (paint.type === 'solid') return onChange({ ...paint, color }, `${label}-c0`);
    onChange({ ...paint, stops: paint.stops.map((s, j) => (j === i ? { ...s, color } : s)) }, `${label}-c${i}`);
  };
  return (
    <fieldset className="cv-group" aria-label={label}>
      <legend>{label}</legend>
      <div className="cv-seg" role="group" aria-label={`${label} kind`}>
        {([['solid', 'Solid'], ['linear', 'Gradient'], ['radial', 'Radial']] as const).map(([k, n]) => (
          <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => set(k)}>{n}</button>
        ))}
      </div>
      {paint.type === 'solid' ? (
        <ColourInput label={`${label} colour`} value={paint.color} onChange={(c) => setStop(0, c)} />
      ) : (
        <>
          <ColourInput label={`${label} from`} value={first} onChange={(c) => setStop(0, c)} />
          <ColourInput label={`${label} to`} value={last} onChange={(c) => setStop(paint.stops.length - 1, c)} />
          {paint.type === 'linear' && <Slider label={`${label} angle`} value={paint.angle} min={0} max={360} step={5} show={(v) => `${v}°`} onChange={(v) => onChange({ ...paint, angle: v }, `${label}-angle`)} />}
          <button type="button" className="link" onClick={() => onChange(paint.type === 'linear' ? { ...paint, stops: [...paint.stops].reverse().map((s, i, a) => ({ ...s, at: i / (a.length - 1) })) } : { ...paint, stops: [...paint.stops].reverse().map((s, i, a) => ({ ...s, at: i / (a.length - 1) })) }, `${label}-swap`)}>Swap colours</button>
        </>
      )}
      {palette.length > 0 && (
        <div className="cv-swatches" aria-label={`${label} colours from the picture`}>
          {palette.map((c) => (
            <button key={c} type="button" className="cv-swatch" title={`Use ${c}`} aria-label={`Use ${c}`} style={{ background: c }} onClick={() => setStop(0, c)} />
          ))}
        </div>
      )}
    </fieldset>
  );
}
/** A darker version of a colour, to make a second stop when a solid becomes a gradient. */
function shade(c: string): string {
  const h = hex6(c);
  const n = [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.45));
  return `#${n.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// ---- effects -------------------------------------------------------------------------------------------------------------------

export function EffectsPanel({ layer, edit }: { layer: Layer; edit: Edit }) {
  const fx = layer.fx;
  const set = (patch: Partial<Effects>, key: string) => edit((d) => patchFx(d, layer.id, patch), key);
  const off = (k: keyof Effects) => edit((d) => patchFx(d, layer.id, (cur) => { const n = { ...cur }; delete n[k]; return n; }));
  const shadow = fx.shadow;
  const dist = shadow ? Math.hypot(shadow.dx, shadow.dy) : 0;
  const ang = shadow ? (Math.atan2(shadow.dy, shadow.dx) * 180) / Math.PI : 90;
  const setShadow = (dist2: number, ang2: number, rest: Partial<NonNullable<Effects['shadow']>>, key: string) =>
    set({ shadow: { color: shadow!.color, blur: shadow!.blur, opacity: shadow!.opacity, ...rest, dx: dist2 * Math.cos((ang2 * Math.PI) / 180), dy: dist2 * Math.sin((ang2 * Math.PI) / 180) } }, key);
  return (
    <section className="cv-section" aria-label="Effects">
      <h4>Effects</h4>
      <Slider label="Opacity" value={fx.opacity ?? 1} min={0} max={1} step={0.01} show={pct} onChange={(v) => set({ opacity: v }, 'opacity')} />
      <label className="cv-field">
        <span>Blend</span>
        <select aria-label="Blend" value={fx.blend ?? 'normal'} onChange={(e) => set({ blend: e.target.value as Blend }, 'blend')}>
          {BLENDS.map((b) => <option key={b} value={b}>{b === 'soft-light' ? 'Soft light' : b[0]!.toUpperCase() + b.slice(1)}</option>)}
        </select>
      </label>

      <Check label="Glow" on={!!fx.glow} onChange={(on) => (on ? set({ glow: { color: '#ffd27a', size: 0.008, strength: 0.6 } }, 'glow-on') : off('glow'))} />
      {fx.glow && (
        <div className="cv-sub">
          <ColourInput label="Glow colour" value={fx.glow.color} onChange={(c) => set({ glow: { ...fx.glow!, color: c } }, 'glow-c')} />
          <Slider label="Glow size" value={fx.glow.size} min={0.001} max={0.03} step={0.001} show={(v) => `${Math.round(v * 1000)}`} onChange={(v) => set({ glow: { ...fx.glow!, size: v } }, 'glow-s')} />
          <Slider label="Glow strength" value={fx.glow.strength} min={0} max={1} step={0.05} show={pct} onChange={(v) => set({ glow: { ...fx.glow!, strength: v } }, 'glow-k')} />
        </div>
      )}

      <Check label="Drop shadow" on={!!shadow} onChange={(on) => (on ? set({ shadow: { color: '#000000', dx: 0.002, dy: 0.004, blur: 0.005, opacity: 0.6 } }, 'sh-on') : off('shadow'))} />
      {shadow && (
        <div className="cv-sub">
          <ColourInput label="Shadow colour" value={shadow.color} onChange={(c) => set({ shadow: { ...shadow, color: c } }, 'sh-c')} />
          <Slider label="Shadow distance" value={dist} min={0} max={0.03} step={0.001} show={(v) => `${Math.round(v * 1000)}`} onChange={(v) => setShadow(v, ang, {}, 'sh-d')} />
          <Slider label="Shadow angle" value={Math.round((ang + 360) % 360)} min={0} max={359} step={5} show={(v) => `${v}°`} onChange={(v) => setShadow(dist, v, {}, 'sh-a')} />
          <Slider label="Shadow softness" value={shadow.blur} min={0} max={0.03} step={0.001} show={(v) => `${Math.round(v * 1000)}`} onChange={(v) => setShadow(dist, ang, { blur: v }, 'sh-b')} />
          <Slider label="Shadow strength" value={shadow.opacity} min={0} max={1} step={0.05} show={pct} onChange={(v) => setShadow(dist, ang, { opacity: v }, 'sh-o')} />
        </div>
      )}

      {layer.type !== 'image' && layer.type !== 'scrim' && (
        <>
          <Check label="Outline" on={!!fx.outline} onChange={(on) => (on ? set({ outline: { color: '#000000', width: 0.003 } }, 'ol-on') : off('outline'))} />
          {fx.outline && (
            <div className="cv-sub">
              <ColourInput label="Outline colour" value={fx.outline.color} onChange={(c) => set({ outline: { ...fx.outline!, color: c } }, 'ol-c')} />
              <Slider label="Outline width" value={fx.outline.width} min={0.0005} max={0.012} step={0.0005} show={(v) => `${Math.round(v * 10000) / 10}`} onChange={(v) => set({ outline: { ...fx.outline!, width: v } }, 'ol-w')} />
            </div>
          )}
        </>
      )}

      <Check label="Texture" on={!!fx.texture} onChange={(on) => (on ? set({ texture: { id: 'grain', strength: 0.5, scale: 1 } }, 'tx-on') : off('texture'))} />
      {fx.texture && (
        <div className="cv-sub">
          <label className="cv-field">
            <span>Kind</span>
            <select aria-label="Texture kind" value={fx.texture.id} onChange={(e) => set({ texture: { ...fx.texture!, id: e.target.value } }, 'tx-id')}>
              {TEXTURES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <Slider label="Texture strength" value={fx.texture.strength} min={0} max={1} step={0.05} show={pct} onChange={(v) => set({ texture: { ...fx.texture!, strength: v } }, 'tx-k')} />
          <Slider label="Texture scale" value={fx.texture.scale} min={0.25} max={4} step={0.05} show={(v) => `${v}×`} onChange={(v) => set({ texture: { ...fx.texture!, scale: v } }, 'tx-s')} />
        </div>
      )}

      <Check label="Blur" on={!!fx.blur} onChange={(on) => (on ? set({ blur: 0.002 }, 'bl-on') : off('blur'))} />
      {fx.blur !== undefined && <Slider label="Blur amount" value={fx.blur} min={0.0005} max={0.012} step={0.0005} show={(v) => `${Math.round(v * 10000) / 10}`} onChange={(v) => set({ blur: v }, 'bl')} />}
    </section>
  );
}

// ---- one layer's own panel ------------------------------------------------------------------------------------------------------

export interface PanelEnv {
  d: Design;
  edit: Edit;
  palette: string[];
  /** Installed system fonts to offer beside the starter ones. */
  system: string[];
  pictures: { path: string }[];
  onReplacePicture: (layerId: string, path: string) => void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
}

function TextPanel({ l, env }: { l: TextLayer; env: PanelEnv }) {
  const { edit } = env;
  const set = (patch: Partial<TextLayer>, key?: string) => edit((d) => patchLayer<TextLayer>(d, l.id, patch), key ?? null);
  const starter = STARTER_FONTS.find((f) => f.family === l.font);
  const scale = nearestScale(l.size);
  const hasScrim = env.d.layers.find((x): x is ScrimLayer => x.type === 'scrim' && x.boundTo === l.id);
  return (
    <>
      <label className="cv-field cv-block">
        <span>Words</span>
        <textarea ref={env.textRef as React.RefObject<HTMLTextAreaElement>} aria-label="Words" rows={3} value={l.text} onChange={(e) => set({ text: e.target.value, name: e.target.value.split('\n')[0]!.slice(0, 28) || 'Text' }, `text-${l.id}`)} />
      </label>
      <label className="cv-field">
        <span>Font</span>
        <select aria-label="Font" value={l.font} onChange={(e) => set({ font: e.target.value, ...(STARTER_FONTS.find((f) => f.family === e.target.value)?.files[700] ? {} : { weight: 400 as const }) })}>
          <optgroup label="Starter fonts">{STARTER_FONTS.map((f) => <option key={f.family} value={f.family}>{f.family} · {f.feel.split(':')[0]}</option>)}</optgroup>
          {env.system.length > 0 && <optgroup label="On this computer">{env.system.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>}
          {!STARTER_FONTS.some((f) => f.family === l.font) && !env.system.includes(l.font) && <option value={l.font}>{l.font} (not on this computer)</option>}
        </select>
      </label>
      <div className="cv-seg" role="group" aria-label="Style">
        <button type="button" aria-pressed={l.weight === 700} className={l.weight === 700 ? 'on' : ''} disabled={!!starter && !starter.files[700]} onClick={() => set({ weight: l.weight === 700 ? 400 : 700 })} title="Bold"><b>B</b></button>
        <button type="button" aria-pressed={l.italic} className={l.italic ? 'on' : ''} onClick={() => set({ italic: !l.italic })} title="Italic"><i>I</i></button>
        <button type="button" aria-pressed={l.upper} className={l.upper ? 'on' : ''} onClick={() => set({ upper: !l.upper })} title="All capitals">AA</button>
        {(['left', 'center', 'right'] as const).map((a) => <button key={a} type="button" aria-pressed={l.align === a} className={l.align === a ? 'on' : ''} onClick={() => set({ align: a })} title={`Align ${a}`}>{a === 'left' ? '⇤' : a === 'right' ? '⇥' : '↔'}</button>)}
      </div>
      <div className="cv-field">
        <span>Size</span>
        <div className="cv-seg" role="group" aria-label="Size">
          <button type="button" aria-label="Smaller" onClick={() => set({ size: stepScale(l.size, -1) })}>−</button>
          <select aria-label="Size" value={scale.id} onChange={(e) => set({ size: SCALES.find((s) => s.id === e.target.value)!.size })}>
            {SCALES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button type="button" aria-label="Bigger" onClick={() => set({ size: stepScale(l.size, 1) })}>+</button>
        </div>
      </div>
      <Slider label="Letter spacing" value={l.tracking} min={-0.05} max={0.6} step={0.01} show={(v) => `${Math.round(v * 100)}`} onChange={(v) => set({ tracking: v }, `track-${l.id}`)} />
      <Slider label="Line spacing" value={l.leading} min={0.8} max={2} step={0.05} show={(v) => `${v}`} onChange={(v) => set({ leading: v }, `lead-${l.id}`)} />
      <PaintEditor label="Text fill" paint={l.fill} palette={env.palette} onChange={(p, k) => set({ fill: p }, `${l.id}-${k}`)} />
      <section className="cv-section" aria-label="Darken behind text">
        <h4>Behind the words</h4>
        {hasScrim ? (
          <>
            <Slider label="Darkness" value={hasScrim.strength} min={0.1} max={1} step={0.05} show={pct} onChange={(v) => edit((d) => addScrim(d, l.id, { strength: v }).design, `scrim-${l.id}`)} />
            <Slider label="Band size" value={hasScrim.pad} min={0} max={0.12} step={0.005} show={(v) => `${Math.round(v * 1000)}`} onChange={(v) => edit((d) => addScrim(d, l.id, { pad: v }).design, `scrimpad-${l.id}`)} />
            <div className="cv-seg" role="group" aria-label="Band shape">
              {([['around', 'Soft box'], ['down', 'Fade down'], ['up', 'Fade up']] as const).map(([k, n]) => <button key={k} type="button" aria-pressed={hasScrim.dir === k} className={hasScrim.dir === k ? 'on' : ''} onClick={() => edit((d) => addScrim(d, l.id, { dir: k }).design)}>{n}</button>)}
            </div>
            <button type="button" className="link" onClick={() => edit((d) => patchLayer<ScrimLayer>(d, hasScrim.id, { hidden: !hasScrim.hidden }))}>{hasScrim.hidden ? 'Show the band' : 'Hide the band'}</button>
          </>
        ) : (
          <button type="button" onClick={() => edit((d) => addScrim(d, l.id).design)}>Darken behind this text</button>
        )}
      </section>
    </>
  );
}

function ShapePanel({ l, env }: { l: ShapeLayer; env: PanelEnv }) {
  const set = (patch: Partial<ShapeLayer>, key?: string) => env.edit((d) => patchLayer<ShapeLayer>(d, l.id, patch), key ?? null);
  return (
    <>
      <PaintEditor label="Fill" paint={l.fill} palette={env.palette} onChange={(p, k) => set({ fill: p }, `${l.id}-${k}`)} />
      {l.shape === 'rect' && <Slider label="Rounded corners" value={l.radius} min={0} max={0.5} step={0.01} show={pct} onChange={(v) => set({ radius: v }, `r-${l.id}`)} />}
      {l.shape === 'ring' && <Slider label="Ring thickness" value={l.thick} min={0.01} max={0.5} step={0.01} show={pct} onChange={(v) => set({ thick: v }, `t-${l.id}`)} />}
    </>
  );
}

function ImagePanel({ l, env }: { l: ImageLayer; env: PanelEnv }) {
  const set = (patch: Partial<ImageLayer>, key?: string) => env.edit((d) => patchLayer<ImageLayer>(d, l.id, patch), key ?? null);
  const g = l.grade;
  const grade = (patch: Partial<ImageLayer['grade']>, key: string) => set({ grade: { ...g, ...patch } }, `${l.id}-${key}`);
  return (
    <>
      <div className="cv-seg" role="group" aria-label="Picture fit">
        {([['cover', 'Fill the frame'], ['contain', 'Fit inside']] as const).map(([k, n]) => <button key={k} type="button" aria-pressed={l.fit === k} className={l.fit === k ? 'on' : ''} onClick={() => set({ fit: k })}>{n}</button>)}
        <button type="button" aria-pressed={l.flipX} className={l.flipX ? 'on' : ''} onClick={() => set({ flipX: !l.flipX })}>Flip</button>
      </div>
      <Slider label="Zoom" value={l.zoom} min={1} max={4} step={0.05} show={(v) => `${v}×`} onChange={(v) => set({ zoom: v }, `z-${l.id}`)} />
      {l.fit === 'cover' && (
        <>
          <Slider label="Slide across" value={l.focus.x} min={0} max={1} step={0.01} show={pct} onChange={(v) => set({ focus: { ...l.focus, x: v } }, `fx-${l.id}`)} />
          <Slider label="Slide up and down" value={l.focus.y} min={0} max={1} step={0.01} show={pct} onChange={(v) => set({ focus: { ...l.focus, y: v } }, `fy-${l.id}`)} />
        </>
      )}
      <section className="cv-section" aria-label="Colour and mood">
        <h4>Colour and mood</h4>
        <Slider label="Brightness" value={g.brightness} min={-1} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}`} onChange={(v) => grade({ brightness: v }, 'b')} />
        <Slider label="Contrast" value={g.contrast} min={-1} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}`} onChange={(v) => grade({ contrast: v }, 'c')} />
        <Slider label="Colour strength" value={g.saturation} min={-1} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}`} onChange={(v) => grade({ saturation: v }, 's')} />
        <Slider label="Warm or cool" value={g.warmth} min={-1} max={1} step={0.05} show={(v) => (v > 0 ? `warm ${Math.round(v * 100)}` : v < 0 ? `cool ${Math.round(-v * 100)}` : 'neutral')} onChange={(v) => grade({ warmth: v }, 'w')} />
        <Slider label="Dark edges" value={g.vignette} min={0} max={1} step={0.05} show={pct} onChange={(v) => grade({ vignette: v }, 'v')} />
        <Check label="Tint" on={!!g.tint} onChange={(on) => set({ grade: on ? { ...g, tint: { color: '#203a60', strength: 0.25 } } : (() => { const n = { ...g }; delete n.tint; return n; })() })} />
        {g.tint && (
          <div className="cv-sub">
            <ColourInput label="Tint colour" value={g.tint.color} onChange={(c) => grade({ tint: { ...g.tint!, color: c } }, 'tc')} />
            <Slider label="Tint strength" value={g.tint.strength} min={0} max={0.8} step={0.05} show={pct} onChange={(v) => grade({ tint: { ...g.tint!, strength: v } }, 'ts')} />
          </div>
        )}
      </section>
      {env.pictures.length > 1 && (
        <label className="cv-field">
          <span>Swap picture</span>
          <select aria-label="Swap picture" value={l.src.path} onChange={(e) => env.onReplacePicture(l.id, e.target.value)}>
            {!env.pictures.some((p) => p.path === l.src.path) && <option value={l.src.path}>{l.src.path}</option>}
            {env.pictures.map((p) => <option key={p.path} value={p.path}>{p.path.split('/').pop()}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

function ScrimPanel({ l, env }: { l: ScrimLayer; env: PanelEnv }) {
  const set = (patch: Partial<ScrimLayer>, key?: string) => env.edit((d) => patchLayer<ScrimLayer>(d, l.id, patch), key ?? null);
  return (
    <>
      <ColourInput label="Band colour" value={l.color} onChange={(c) => set({ color: c }, `sc-${l.id}`)} />
      <Slider label="Darkness" value={l.strength} min={0.1} max={1} step={0.05} show={pct} onChange={(v) => set({ strength: v }, `ss-${l.id}`)} />
      <div className="cv-seg" role="group" aria-label="Band shape">
        {([['around', 'Soft box'], ['down', 'Fade down'], ['up', 'Fade up']] as const).map(([k, n]) => <button key={k} type="button" aria-pressed={l.dir === k} className={l.dir === k ? 'on' : ''} onClick={() => set({ dir: k })}>{n}</button>)}
      </div>
      {l.boundTo ? <button type="button" onClick={() => env.edit((d) => detachScrim(d, l.id))}>Let it go (stop following the text)</button> : <p className="muted small">Not following any text. Move and resize it yourself.</p>}
    </>
  );
}

export function Properties({ layer, env }: { layer: Layer; env: PanelEnv }) {
  return (
    <div className="cv-props" aria-label={`Settings for ${layer.name}`}>
      <label className="cv-field">
        <span>Name</span>
        <input aria-label="Layer name" value={layer.name} onChange={(e) => env.edit((d) => patchLayer(d, layer.id, { name: e.target.value }), `name-${layer.id}`)} />
      </label>
      {layer.type === 'text' && <TextPanel l={layer} env={env} />}
      {layer.type === 'shape' && <ShapePanel l={layer} env={env} />}
      {layer.type === 'image' && <ImagePanel l={layer} env={env} />}
      {layer.type === 'scrim' && <ScrimPanel l={layer} env={env} />}
      <EffectsPanel layer={layer} edit={env.edit} />
    </div>
  );
}
