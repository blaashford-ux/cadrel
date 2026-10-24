import { useRef, useState } from 'react';
import { parseInviteLink } from '../shared/review/link';
import type { SharedProject } from '../shared/review/share';
import { PickerFrame, pickerUrl } from './PickerFrame';
import { pickAll, shortIds } from './pickFiles';
import { useEscape } from './useEscape';
import { loadIdentity, saveIdentity } from './useReview';

interface Props {
  onJoined(p: SharedProject): void;
  onClose(): void;
}

/** Open an invitation: paste the link, let Google's picker grant access to the two files, then download the project. */
export function JoinDialog({ onJoined, onClose }: Props) {
  const [link, setLink] = useState('');
  const [name, setName] = useState(() => {
    const me = loadIdentity();
    return me.id === 'owner' ? '' : me.name;
  });
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Phone: the picker runs in the browser and this dialog waits for it. Cancelling bumps the counter so a late answer is ignored.
  const [waiting, setWaiting] = useState(false);
  const [waitingFor, setWaitingFor] = useState(2);
  const attempt = useRef(0);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);
  const api = window.mdedit;
  const invite = parseInviteLink(link);

  const start = async () => {
    if (!invite) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api.pickerToken();
      if (invite && api.pickInBrowser) {
        const mine = ++attempt.current;
        const need = [invite.packageId, invite.commentsId];
        // Ask for the files still missing, so picking just one of the two is not a dead end.
        const outcome = await pickAll(need, async (missing) => {
          if (attempt.current !== mine) return null; // cancelled meanwhile
          setWaiting(true);
          setWaitingFor(missing.length);
          return api.pickInBrowser!(pickerUrl(t, missing, true)).catch((e) => {
            if (attempt.current === mine) setError(e instanceof Error ? e.message : String(e));
            return null;
          });
        });
        if (attempt.current !== mine) return;
        setWaiting(false);
        if (outcome.done) await finish();
        else if (!outcome.cancelled) {
          setError(`Google’s picker didn’t return the project’s files (asked for ${shortIds(need)}; it returned ${outcome.got.map(shortIds).join(' / ')}). Try the invitation link again, and tell the person who sent it if this keeps happening.`);
        }
        return;
      }
      setToken(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setToken(null);
    setBusy(true);
    try {
      const shared = await api.joinReview(link, name);
      // Remember who this is on this device, so notes are signed with the reviewer's name.
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
        {waiting ? (
          <>
            <p className="modal-hint">{waitingFor > 1 ? 'Google’s file picker is open in your browser. Select both files there' : 'One more file to go: Google’s file picker is open again in your browser. Select the file it shows'}; if the browser doesn’t switch back by itself, come back to MDEdit (on the phone, tap “Return to MDEdit”).</p>
            <div className="modal-actions">
              <button type="button" onClick={() => (attempt.current++, setWaiting(false), setBusy(false))}>Cancel</button>
            </div>
          </>
        ) : token && invite ? (
          <PickerFrame
            token={token}
            ids={[invite.packageId, invite.commentsId]}
            onPicked={(ids) => (ids.includes(invite.packageId) && ids.includes(invite.commentsId) ? void finish() : (setToken(null), setError('Select both files so MDEdit can open the project and save your notes.')))}
            onCancel={() => setToken(null)}
            onError={() => (setToken(null), setError('Couldn’t load Google’s file picker. Check your connection and try again.'))}
          />
        ) : (
          <>
            <p className="modal-hint">Paste the link you were sent (or the whole message). Google will ask you to select two files; that is how MDEdit is allowed to open this one project (and nothing else in your Drive).</p>
            <label>
              Invitation link
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" autoFocus aria-invalid={link !== '' && !invite} />
            </label>
            <label>
              Your name (shown on your notes)
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </label>
            {link !== '' && !invite && <div className="modal-error" role="alert">That doesn’t look like a MDEdit invitation.</div>}
            {error && <div className="modal-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" disabled={!invite || busy} onClick={() => void start()}>
                {busy ? 'Opening…' : 'Continue'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
