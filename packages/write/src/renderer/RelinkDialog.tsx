import { useState } from 'react';
import { basename } from '../shared/paths';
import { useEscape } from './useEscape';

interface Props {
  /** Path of the orphaned `<name>.export.json`. */
  sidecar: string;
  /** Manuscripts in the same folder that have no export settings of their own. */
  candidates: { name: string; path: string }[];
  onLink(markdownFile: string): Promise<boolean>;
  onClose(): void;
}

export function RelinkDialog({ sidecar, candidates, onLink, onClose }: Props) {
  const [choice, setChoice] = useState(candidates[0]?.path ?? '');
  const [busy, setBusy] = useState(false);
  useEscape(onClose);
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Link export settings"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!choice || busy) return;
          setBusy(true);
          if (await onLink(choice)) onClose();
          else setBusy(false);
        }}
      >
        <h3>Link export settings</h3>
        <p className="muted small">
          <code>{basename(sidecar)}</code> holds a book’s title page, copyright page and export choices, but the manuscript it belonged to is gone (renamed outside MDEdit?). Pick the file it should belong to.
        </p>
        {candidates.length === 0 ? (
          <p className="bad">There is no manuscript in this folder without export settings of its own.</p>
        ) : (
          <label className="field">
            <span className="field-label">Manuscript</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {candidates.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!choice || busy}>
            Link
          </button>
        </div>
      </form>
    </div>
  );
}
