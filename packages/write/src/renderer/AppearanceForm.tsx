import { useState, type CSSProperties } from 'react';
import {
  colorsFor,
  contrast,
  DEFAULT_THEMES,
  isCustomised,
  normalizeHex,
  PRESETS,
  sanitizeThemeCustom,
  THEME_KEYS,
  THEME_LABELS,
  themeVars,
  type Scheme,
  type ThemeCustom,
  type ThemeKey
} from '../shared/theme';

interface Props {
  custom: ThemeCustom | undefined;
  onChange(next: ThemeCustom | undefined): void;
}

const systemScheme = (): Scheme => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** One colour: a picker and a hex box. The box keeps what is being typed until it is a valid colour. */
function ColorRow({ k, value, shipped, onSet }: { k: ThemeKey; value: string; shipped: string; onSet(hex: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const { label, hint } = THEME_LABELS[k];
  return (
    <div className="theme-row">
      <label className="theme-row-main">
        <input type="color" value={value} aria-label={`${label} colour`} onChange={(e) => onSet(e.target.value)} />
        <span className="theme-row-text">
          <span className="field-label">{label}</span>
          <span className="field-hint">{hint}</span>
        </span>
      </label>
      <input
        className="theme-hex"
        aria-label={`${label} hex value`}
        value={draft ?? value}
        maxLength={7}
        spellCheck={false}
        aria-invalid={draft !== null && normalizeHex(draft) === null}
        onChange={(e) => {
          setDraft(e.target.value);
          const hex = normalizeHex(e.target.value);
          if (hex) onSet(hex);
        }}
        onBlur={() => setDraft(null)}
      />
      <button type="button" className="theme-reset" disabled={value === shipped} onClick={() => (setDraft(null), onSet(shipped))} title="Back to the shipped colour">
        Reset
      </button>
    </div>
  );
}

/** File → Settings → Appearance: change the colours of the light and dark themes separately. Changes show at once. */
export function AppearanceForm({ custom, onChange }: Props) {
  const [scheme, setScheme] = useState<Scheme>(systemScheme);
  const colors = colorsFor(scheme, custom);
  const vars = themeVars(colors, scheme);
  const edited = isCustomised(custom, scheme);

  const set = (patch: Partial<Record<ThemeKey, string>>) => onChange(sanitizeThemeCustom({ ...custom, [scheme]: { ...(custom?.[scheme] ?? {}), ...patch } }));
  const clear = () => onChange(sanitizeThemeCustom({ ...custom, [scheme]: {} }));
  const readable = contrast(colors.fg, colors.bg);

  return (
    <section className="appearance">
      <p className="muted small">
        Light and dark have their own colours, so you can change one without touching the other. MDEdit shows the one that matches your system
        (or View → Theme). Pick five colours; panels, buttons and softer text are worked out from them.
      </p>

      <div className="subtabs" role="tablist" aria-label="Theme to edit">
        {(['light', 'dark'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={scheme === s} className={scheme === s ? 'active' : ''} onClick={() => setScheme(s)}>
            {s === 'light' ? 'Light theme' : 'Dark theme'}
            {isCustomised(custom, s) ? ' •' : ''}
          </button>
        ))}
      </div>

      <div className="theme-presets" role="group" aria-label="Starting points">
        <span className="muted small">Start from</span>
        {PRESETS.filter((p) => p.scheme === scheme).map((p) => (
          <button key={p.id} type="button" onClick={() => set(p.colors)} title={`Use the ${p.name} colours`}>
            <span className="theme-chip" style={{ background: p.colors.bg, borderColor: p.colors.accent, color: p.colors.fg }} aria-hidden="true">
              A
            </span>
            {p.name}
          </button>
        ))}
        <button type="button" onClick={clear} disabled={!edited} title={`Go back to the shipped ${scheme} theme`}>
          Shipped {scheme}
        </button>
      </div>

      <div className="theme-layout">
        <div className="theme-rows">
          {THEME_KEYS.map((k) => (
            <ColorRow key={`${scheme}-${k}`} k={k} value={colors[k]} shipped={DEFAULT_THEMES[scheme][k]} onSet={(hex) => set({ [k]: hex })} />
          ))}
          {readable < 4.5 && (
            <div className="banner warn" role="status">
              The text and page colours are too close to read comfortably (contrast {readable.toFixed(1)}:1; aim for 4.5 or more).
            </div>
          )}
        </div>

        <div className="theme-preview" style={vars as CSSProperties} aria-label={`Preview of the ${scheme} theme`} role="img">
          <div className="tp-side">
            <span className="tp-title">Sidebar</span>
            <span className="tp-item">The Lost King</span>
            <span className="tp-item selected">Chapter 1</span>
            <span className="tp-item">Chapter 2</span>
          </div>
          <div className="tp-card">
            <h5>Chapter 1</h5>
            <p>
              The rain had stopped by the time she reached the gate. <mark>Something</mark> moved in the dark, and the <em>lantern</em> guttered.
            </p>
            <p className="tp-muted">Quiet text looks like this. Unsaved marks and warnings use the highlight colour.</p>
            <div className="tp-buttons">
              <span className="tp-button">Cancel</span>
              <span className="tp-button primary">Save</span>
              <span className="tp-dirty">● unsaved</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
