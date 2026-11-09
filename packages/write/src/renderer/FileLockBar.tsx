import { useState } from 'react';
import type { FileLock } from '../shared/api';

interface Props {
  lock: FileLock;
  /** The name of the file, for words. */
  name: string;
  busy: boolean;
  error: string | null;
  onCheckOut(keepChanges: boolean): void;
  /** Saves what is open in the file first, then checks it in with the person's words about it. */
  onCheckIn(comment: string): void;
  onUndo(): void;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

/**
 * Above an open file: who has it and what can be done. A file is read-only until it is checked out; a check-in is what makes a new version,
 * and nothing else does. Shown only where the files are kept in a Studio's vault.
 */
export function FileLockBar({ lock, name, busy, error, onCheckOut, onCheckIn, onUndo }: Props) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  if (lock.kind === 'unmanaged') return null;

  return (
    <div className={`banner file-lock lock-${lock.kind}`} role="status" aria-label={`${name}: check-out`}>
      {lock.kind === 'free' && (
        <>
          <span><strong>Checked in</strong> · version {lock.version} · read-only.</span>{' '}
          <button type="button" className="primary" disabled={busy} onClick={() => onCheckOut(false)}>Check out to edit</button>
        </>
      )}
      {lock.kind === 'unprotected' && (
        <>
          <span><strong>Changed without a check-out.</strong> It is read-only until you check it out, keeping the changes; nothing is overwritten.</span>{' '}
          <button type="button" className="primary" disabled={busy} onClick={() => onCheckOut(true)}>Check out, keeping my changes</button>
        </>
      )}
      {lock.kind === 'other' && (
        <span><strong>Checked out by {lock.by}</strong> since {when(lock.since)} · version {lock.version}. You can read it, and change it once they have checked it in.</span>
      )}
      {lock.kind === 'mine' && !asking && (
        <>
          <span><strong>Checked out by you</strong>{lock.changed ? ' · changed' : ''}. Check it in to make a new version.</span>{' '}
          <button type="button" className="primary" disabled={busy} onClick={() => setAsking(true)}>Check in…</button>{' '}
          <button type="button" disabled={busy} onClick={() => { if (!lock.changed || window.confirm(`Give up your changes to ${name}? It goes back to version ${lock.version}.`)) onUndo(); }}>Undo check-out</button>
        </>
      )}
      {lock.kind === 'mine' && asking && (
        <form
          className="file-lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            onCheckIn(comment);
            setAsking(false);
            setComment('');
          }}
        >
          <input aria-label="What changed" placeholder="What changed (optional)" value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />{' '}
          <button type="submit" className="primary" disabled={busy}>Check in</button>{' '}
          <button type="button" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
        </form>
      )}
      {error && <span className="file-lock-error" role="alert"> {error}</span>}
    </div>
  );
}
