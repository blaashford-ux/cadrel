import type { ReactNode } from 'react';
import { LayerTag } from './layerEditor';

export function Field(props: {
  label: string;
  value: string;
  onChange(v: string): void;
  hint?: ReactNode;
  placeholder?: string;
  required?: boolean;
  type?: string;
  width?: number;
  /** The BookDetails field this edits, so a layered form can show where its value comes from. */
  path?: string;
}) {
  const missing = props.required && props.value.trim() === '';
  return (
    <label className="field" style={props.width ? { maxWidth: props.width } : undefined}>
      <span className="field-label">
        {props.label}
        {props.required && <span className="req"> *</span>}
        <LayerTag path={props.path} />
      </span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        aria-invalid={missing || undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function TextArea(props: { label: string; value: string; onChange(v: string): void; rows?: number; hint?: ReactNode; placeholder?: string; path?: string }) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        <LayerTag path={props.path} />
      </span>
      <textarea value={props.value} rows={props.rows ?? 4} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange(v: boolean): void; hint?: ReactNode; path?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>
        {props.label}
        {props.hint && <span className="field-hint"> {props.hint}</span>}
        <LayerTag path={props.path} />
      </span>
    </label>
  );
}

export function Select<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
  hint?: ReactNode;
  path?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        <LayerTag path={props.path} />
      </span>
      <select
        value={String(props.value)}
        onChange={(e) => {
          const picked = props.options.find((o) => String(o.value) === e.target.value);
          if (picked) props.onChange(picked.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function NumberField(props: { label: string; value: number; min: number; max: number; step?: number; onChange(v: number): void; unit?: string; hint?: ReactNode; path?: string }) {
  return (
    <label className="field" style={{ maxWidth: props.path ? undefined : 160 }}>
      <span className="field-label">
        {props.label}
        <LayerTag path={props.path} />
      </span>
      <span className="with-unit">
        <input
          type="number"
          value={Number.isFinite(props.value) ? props.value : ''}
          min={props.min}
          max={props.max}
          step={props.step ?? 0.05}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, n)));
          }}
        />
        {props.unit && <span className="unit">{props.unit}</span>}
      </span>
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

/** A list of rows the user can add to, remove from and reorder. */
export function ListEditor<T>(props: {
  items: T[];
  onChange(items: T[]): void;
  blank: () => T;
  addLabel: string;
  row(item: T, update: (next: T) => void, index: number): ReactNode;
  path?: string;
}) {
  const { items, onChange } = props;
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="list-editor">
      {props.path && (
        <div className="field-label">
          <LayerTag path={props.path} />
        </div>
      )}
      {items.map((item, i) => (
        <div className="list-row" key={i}>
          <div className="list-fields">{props.row(item, (n) => onChange(items.map((x, k) => (k === i ? n : x))), i)}</div>
          <div className="list-actions">
            <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button type="button" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
              ↓
            </button>
            <button type="button" aria-label="Remove" onClick={() => onChange(items.filter((_, k) => k !== i))}>
              ✕
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="add-row" onClick={() => onChange([...items, props.blank()])}>
        ＋ {props.addLabel}
      </button>
    </div>
  );
}
