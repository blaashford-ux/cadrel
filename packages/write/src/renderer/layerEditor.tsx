import { createContext, useContext, type ReactNode } from 'react';
import { applyOverrides, getPath, inheritable, LEAF_PATHS, pathLabel, valueLabel, type Origin, type Overrides } from '../shared/export/layers';
import type { BookDetails } from '../shared/export/model';

/** The parts of a book that belong to it alone, edited beside its overrides. */
export type Identity = Pick<BookDetails, 'title' | 'subtitle' | 'marked'>;

export interface LayerState {
  overrides: Overrides;
  identity?: Identity;
}

export interface LayerEditor {
  /** What the forms show: the inherited settings with this layer's own laid over them. */
  details: BookDetails;
  edit(fn: (d: BookDetails) => void): void;
  set(patch: Partial<BookDetails>): void;
  /** True when this layer sets the field itself. */
  isOwn(path: string): boolean;
  /** Where the field's value comes from when this layer does not set it. */
  originOf(path: string): Origin;
  /** The value the field would have without this layer's own setting. */
  inheritedValue(path: string): unknown;
  /** Goes back to the inherited value. */
  reset(path: string): void;
  scope: 'project' | 'book';
}

/**
 * A layer's own settings over what it inherits. Editing a field makes it this layer's own; resetting hands it
 * back to the layer below. `onChange` receives the whole new state (the editor holds none of its own).
 */
export function layerEditor(opts: {
  inherited: BookDetails;
  /** Origin of each inherited field. A project layer inherits everything from the app. */
  origins?: Record<string, Origin>;
  state: LayerState;
  scope: 'project' | 'book';
  onChange(next: LayerState): void;
}): LayerEditor {
  const { inherited, state, scope, onChange } = opts;
  const details: BookDetails = { ...applyOverrides(inherited, state.overrides), ...(state.identity ?? {}) };
  const edit = (fn: (d: BookDetails) => void) => {
    const next = structuredClone(details);
    fn(next);
    const overrides = { ...state.overrides };
    for (const p of LEAF_PATHS) if (JSON.stringify(getPath(next, p)) !== JSON.stringify(getPath(details, p))) overrides[p] = getPath(next, p);
    onChange({ overrides, identity: state.identity ? { title: next.title, subtitle: next.subtitle, marked: next.marked } : undefined });
  };
  return {
    details,
    edit,
    set: (patch) => edit((d) => void Object.assign(d, patch)),
    isOwn: (p) => p in state.overrides,
    originOf: (p) => opts.origins?.[p] ?? 'app',
    inheritedValue: (p) => getPath(inherited, p),
    reset: (p) => {
      const overrides = { ...state.overrides };
      delete overrides[p];
      onChange({ ...state, overrides });
    },
    scope
  };
}

// ---- showing it in the forms ---------------------------------------------------------------------

const LayerContext = createContext<LayerEditor | null>(null);
export const LayerProvider = LayerContext.Provider;

const ORIGIN_LABEL: Record<Origin, string> = { app: 'app settings', project: 'project settings' };

/** "From the app" / "Set for this book · Reset" beside a field. Nothing when the form isn't layered or the field is book-only. */
export function LayerTag({ path }: { path?: string }): ReactNode {
  const layer = useContext(LayerContext);
  if (!layer || !path || !inheritable(path)) return null;
  const scope = layer.scope === 'book' ? 'this book' : 'this project';
  if (layer.isOwn(path)) {
    const origin = ORIGIN_LABEL[layer.originOf(path)];
    return (
      <span className="layer-tag own">
        <span>Set for {scope}</span>
        <button type="button" className="layer-reset" title={`Go back to the ${origin}: ${valueLabel(layer.inheritedValue(path))}`} onClick={() => layer.reset(path)}>
          Reset
        </button>
      </span>
    );
  }
  return <span className="layer-tag">From {ORIGIN_LABEL[layer.originOf(path)]}</span>;
}

/** Every field that doesn't simply follow the app, with where it is set: the last look before an export. */
export function SettingsReview({ layer }: { layer: LayerEditor }) {
  const rows = LEAF_PATHS.filter((p) => inheritable(p)).flatMap((p) => {
    const own = layer.isOwn(p);
    const origin = layer.originOf(p);
    if (!own && origin === 'app') return [];
    return [{ path: p, own, origin }];
  });
  const total = LEAF_PATHS.filter((p) => inheritable(p)).length;
  return (
    <section aria-label="Where settings come from">
      <h4>Where your settings come from</h4>
      <p className="muted small">
        {total - rows.length} of {total} settings follow the app’s defaults. These don’t:
      </p>
      {rows.length === 0 ? (
        <p className="muted small">None — everything follows the app’s defaults.</p>
      ) : (
        <ul className="layer-review-list">
          {rows.map((r) => (
            <li key={r.path}>
              <span className="review-name">{pathLabel(r.path)}</span>
              <span className="layer-review-value">{valueLabel(getPath(layer.details, r.path))}</span>
              <span className={'layer-tag' + (r.own ? ' own' : '')}>{r.own ? 'This book' : 'Project'}</span>
              {r.own ? (
                <button type="button" className="layer-reset" title={`Go back to the ${ORIGIN_LABEL[r.origin]}: ${valueLabel(layer.inheritedValue(r.path))}`} onClick={() => layer.reset(r.path)}>
                  Reset
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
