import { useEffect, useState } from 'react';
import { aiReviewers, type AiReviewerSummary } from '../shared/agent/config';
import { useEscape } from './useEscape';

interface Props {
  project: string;
  projectName: string;
  onClose(): void;
}

/** The notes AI reviewers have left in this project, which can be removed. Connecting an AI app is on Cadrel's Extensions page. */
export function AiDialog({ project, projectName, onClose }: Props) {
  const api = window.cadrelWrite;
  const [reviewers, setReviewers] = useState<AiReviewerSummary[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  const load = () => void api.listReviews(project).then((l) => setReviewers(aiReviewers(l))).catch(() => undefined);
  useEffect(load, [project]);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-dialog ai-dialog" role="dialog" aria-modal="true" aria-label="AI reviewers">
        <h3>AI reviewers</h3>
        <p className="modal-hint">
          An AI app connected to Cadrel can read your chapters and leave comments and suggestions here. It can’t change your text: you accept or reject each note.
          To connect Claude or GPT, and to download everything it needs, open <strong>Extensions</strong> in Cadrel’s left bar.
        </p>
        <h4>Notes from AI in “{projectName}”</h4>
        <ul className="share-list">
          {reviewers.length === 0 && <li className="muted">None yet.</li>}
          {reviewers.map((r) => (
            <li key={r.id}>
              <span className="grow-text">
                {r.name}
                <span className="muted small share-sub"> {r.open} open of {r.total} note{r.total === 1 ? '' : 's'}</span>
              </span>
              {confirm === r.id ? (
                <>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirm(null);
                      setError(null);
                      void api.deleteReview(project, r.id).then(load, (e) => setError(e instanceof Error ? e.message : String(e)));
                    }}
                  >
                    Yes, delete {r.total}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirm(r.id)}>Delete all…</button>
              )}
            </li>
          ))}
        </ul>
        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
