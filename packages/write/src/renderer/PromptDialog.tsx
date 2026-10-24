import { useEffect, useRef, useState } from 'react';
import { useEscape } from './useEscape';

export interface PromptSpec {
  title: string;
  label: string;
  /** Extra context shown under the title, e.g. which folder the file goes into. */
  hint?: string;
  initial: string;
  confirm: string;
  /** For file names: select only the part before the extension. */
  selectBase?: boolean;
  /** Error message to show, or null if the value is acceptable. */
  validate(value: string): string | null;
  /** Resolves to an error message to keep the dialog open, or null on success. */
  onSubmit(value: string): Promise<string | null>;
}

export function PromptDialog({ spec, onClose }: { spec: PromptSpec; onClose(): void }) {
  const [value, setValue] = useState(spec.initial);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEscape(onClose);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = spec.selectBase ? spec.initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : spec.initial.length);
  }, [spec]);

  const problem = value.trim() === '' ? '' : spec.validate(value);
  const valid = value.trim() !== '' && !problem;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const err = await spec.onSubmit(value.trim());
    setBusy(false);
    if (err) setServerError(err);
    else onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{spec.title}</h3>
        {spec.hint && <p className="modal-hint">{spec.hint}</p>}
        <label>
          {spec.label}
          <input
            ref={input}
            value={value}
            aria-invalid={!!(problem || serverError)}
            onChange={(e) => {
              setValue(e.target.value);
              setServerError(null);
            }}
          />
        </label>
        <div className="modal-error" role="alert">
          {serverError ?? problem}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid || busy}>
            {spec.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
