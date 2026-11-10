import { useState } from 'react';
import type { SharedProject } from '../shared/review/sharedProject';
import { appName } from './appName';
import { useEscape } from './useEscape';
import { loadIdentity, saveIdentity } from './useReview';

interface Props {
  /** A link to start with (one the app was opened with). */
  initialLink?: string;
  onJoined(p: SharedProject): void;
  onClose(): void;
}

/** Open a Beta Reader invitation: paste the link (or the whole message) and the author's Studio gives the manuscript. */
export function JoinDialog({ initialLink = '', onJoined, onClose }: Props) {
  const [link, setLink] = useState(initialLink);
  const [name, setName] = useState(() => {
    const me = loadIdentity();
    return me.id === 'owner' ? '' : me.name;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);
  const app = appName();
  // the first word in what was pasted that is an invitation link
  const studioLink = /cadrel(?:-reader)?:\/\/join\?\S+/i.exec(link)?.[0] ?? null;

  const join = async () => {
    if (!studioLink) return;
    setBusy(true);
    setError(null);
    try {
      const shared = await window.cadrelWrite.joinReview(studioLink, name);
      // Remember who this is on this device, so notes are signed with the reader's name.
      saveIdentity({ id: shared.reviewerId, name: name.trim() || 'Reviewer' });
      onJoined(shared);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal join-dialog" role="dialog" aria-modal="true" aria-label="Open an invitation">
        <h3>Open an invitation</h3>
        <p className="modal-hint">
          Paste the invitation you were sent (or the whole message). {app} joins the author’s Studio with a key made on this computer, and shows you the chapters the author has opened to you. It never sees anything else.
        </p>
        <label>
          Invitation link
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="cadrel-reader://join?…" autoFocus aria-invalid={link !== '' && !studioLink} />
        </label>
        <label>
          Your name (shown on your notes)
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        {link !== '' && !studioLink && <div className="modal-error" role="alert">That doesn’t look like a Cadrel invitation. It starts with cadrel-reader://join</div>}
        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!studioLink || busy} onClick={() => void join()}>
            {busy ? 'Opening…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
