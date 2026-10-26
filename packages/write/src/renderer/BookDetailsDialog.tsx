import { useState } from 'react';
import { basename } from '../shared/paths';
import { BackMatterForm, FrontMatterForm, TitleCopyrightForm } from './bookForms';
import { LayerProvider } from './layerEditor';
import { useBookLayers } from './useBookLayers';
import { useEscape } from './useEscape';

type Tab = 'title' | 'front' | 'back';

interface Props {
  file: string;
  onClose(): void;
  /** Called after a successful save. */
  onSaved?(): void;
}

/** The Book Details form: title page, copyright page, optional front matter, and back matter. */
export function BookDetailsDialog({ file, onClose, onSaved }: Props) {
  const { loaded, layer, dirty, error: loadError, save: saveLayers } = useBookLayers(file);
  const [tab, setTab] = useState<Tab>('title');
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const damaged = loaded?.damaged ?? false;
  const details = layer?.details ?? null;

  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  useEscape(() => (confirmDiscard ? setConfirmDiscard(false) : requestClose()));

  const save = async () => {
    if (!layer || saving) return;
    setSaving(true);
    try {
      await saveLayers();
      onSaved?.();
      onClose();
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : e}`);
      setSaving(false);
    }
  };

  if (!details || !layer) {
    return (
      <div className="modal-backdrop">
        <div className="modal wide" role="dialog" aria-label="Book Details">
          <h3>Book Details</h3>
          {error || loadError ? <div className="banner error">{error ?? loadError}</div> : <p className="muted">Loading…</p>}
          {(error || loadError) && (
            <div className="modal-actions">
              <button onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const set = layer.set;

  return (
    <div className="modal-backdrop">
      <form
        className="modal wide book-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Book Details"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3>
          Book Details <span className="muted">— {basename(file)}</span>
        </h3>
        <div className="subtabs" role="tablist">
          {(
            [
              ['title', 'Title & copyright'],
              ['front', 'Front matter'],
              ['back', 'Back matter']
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        <div className="dialog-body">
          {damaged && (
            <div className="banner warn">
              The saved export settings for this file couldn’t be read, so these are fresh defaults. The old file is kept as a <code>.bak</code> when you save.
            </div>
          )}
          {error && <div className="banner error">{error}</div>}

          <p className="muted small">
            Settings marked “From project settings” or “From app settings” follow those. Change one here to give this book its own value; Reset hands it back.
          </p>
          <LayerProvider value={layer}>
            {tab === 'title' && <TitleCopyrightForm details={details} set={set} />}

            {tab === 'front' && <FrontMatterForm details={details} set={set} />}

            {tab === 'back' && <BackMatterForm details={details} set={set} />}
          </LayerProvider>
        </div>

        <div className="modal-actions">
          {/* Separate keyed containers: React must never reuse the "Keep editing" button DOM node as the
              submit button mid-click, or that click would also submit (save) the form. */}
          {confirmDiscard ? (
            <div className="confirm-row" key="confirm">
              <span className="muted">Discard your changes?</span>
              <button type="button" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
              <button type="button" className="danger" onClick={onClose}>
                Discard
              </button>
            </div>
          ) : (
            <div className="confirm-row" key="normal">
              <button type="button" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving || !dirty}>
                Save
              </button>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
