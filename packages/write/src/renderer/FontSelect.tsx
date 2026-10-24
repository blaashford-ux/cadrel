import { useEffect, useState, type ReactNode } from 'react';
import { BUNDLED_FONTS, bundledFont, fontStack } from '../shared/export/fonts';

let installedPromise: Promise<string[]> | null = null;
/** The installed font list is fetched once per session (it can take a moment on Windows). */
const loadInstalled = () => (installedPromise ??= window.mdedit.listInstalledFonts().catch(() => []));

const previewLoaded = new Set<string>();
/** Registers a bundled font for the preview line, once. Returns the CSS family to use. */
async function ensurePreview(family: string): Promise<string> {
  const b = bundledFont(family);
  if (!b) return fontStack(family);
  const name = `mdedit-preview-${b.slug}`;
  if (!previewLoaded.has(name)) {
    previewLoaded.add(name);
    const url = await window.mdedit.bundledFontPreview(b.family).catch(() => null);
    if (url) {
      // From bytes, not a data: URL, so the page's content-security policy has nothing to object to.
      const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
      document.fonts.add(await new FontFace(name, bytes.buffer).load());
    }
  }
  return `"${name}", serif`;
}

interface Props {
  label: string;
  value: string;
  onChange(family: string): void;
  hint?: ReactNode;
}

/** A font picker: the bundled families first, then everything installed on this computer. */
export function FontSelect({ label, value, onChange, hint }: Props) {
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [previewFamily, setPreviewFamily] = useState(fontStack(value));

  useEffect(() => {
    let live = true;
    void loadInstalled().then((l) => live && setInstalled(l));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void ensurePreview(value).then((f) => live && setPreviewFamily(f));
    return () => {
      live = false;
    };
  }, [value]);

  const bundledNames = new Set(BUNDLED_FONTS.map((b) => b.family.toLowerCase()));
  const others = (installed ?? []).filter((f) => !bundledNames.has(f.toLowerCase()));
  const known = bundledNames.has(value.toLowerCase()) || others.some((f) => f.toLowerCase() === value.toLowerCase());
  const note = bundledFont(value)?.note;

  return (
    <div className="field font-field">
      <label>
        <span className="field-label">{label}</span>
        <select value={bundledFont(value)?.family ?? value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          <optgroup label="Included with MDEdit">
            {BUNDLED_FONTS.map((b) => (
              <option key={b.slug} value={b.family}>
                {b.family}
                {b.family === BUNDLED_FONTS[0].family ? ' (default)' : ''}
              </option>
            ))}
          </optgroup>
          <optgroup label={installed === null ? 'Installed on this computer — loading…' : `Installed on this computer (${others.length})`}>
            {!known && installed !== null && (
              <option value={value}>{value} (not installed here)</option>
            )}
            {others.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <div className="font-preview" style={{ fontFamily: previewFamily }} aria-label="Font preview">
        The quick brown fox jumps over the lazy dog. “Chapter One” — 0123456789
      </div>
      {note && <span className="field-hint">{note}</span>}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
