import { useState } from 'react';
import type { StudiosView } from '../shared/api';

const api = window.cadrel.studios;

/** Switches between the Studios this person can use: their own and any they were invited to. Joining one is here too. */
export function StudioSwitcher({ studios }: { studios: StudiosView }) {
  const active = studios.studios.find((s) => s.id === studios.activeId)!;
  const [switching, setSwitching] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (id: string) => {
    setError(null);
    const to = studios.studios.find((s) => s.id === id)!;
    setSwitching(to.name);
    try {
      await api.setActive(id); // Cadrel restarts into the other Studio's folders; this page is replaced
    } catch (e) {
      setSwitching(null);
      setError((e as Error).message);
    }
  };

  return (
    <div className="studio-switch-wrap">
      <div className="studio-switch">
        <label htmlFor="studio-select" className="muted small">Studio</label>
        <select id="studio-select" value={studios.activeId} disabled={!!switching} onChange={(e) => void pick(e.target.value)}>
          {studios.studios.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.role === 'member' ? ' (invited)' : ''}</option>
          ))}
        </select>
        <span className="chip">{active.status === 'local' ? 'On this computer' : active.role === 'owner' ? 'You own it' : 'Member'}</span>
        <button type="button" className="link" onClick={() => setJoining(true)}>Join a Studio…</button>
        {switching && <span role="status" className="muted small">Opening {switching}…</span>}
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </div>
  );
}

function JoinDialog({ onClose }: { onClose(): void }) {
  const [link, setLink] = useState('');
  const [you, setYou] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const before = new Set((await api.get()).studios.map((s) => s.id));
      const v = await api.join(link.trim(), { yourName: you, ...(name.trim() ? { studioName: name.trim() } : {}) });
      setDone(v.studios.find((s) => !before.has(s.id))?.name ?? 'the Studio');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="modal" role="dialog" aria-modal="true" aria-label="Join a Studio" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <h3>Join a Studio</h3>
        {done ? (
          <>
            <p role="status">You are in <strong>{done}</strong>. Choose it from the Studio menu on Home to open it.</p>
            <div className="modal-actions"><button type="button" className="primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <p className="muted small">Paste the invitation link its owner sent you. It works once. Cadrel checks the Studio belongs to the owner the link names before it sends anything.</p>
            <label className="field"><span className="field-label">Invitation link</span><textarea rows={3} value={link} onChange={(e) => setLink(e.target.value)} placeholder="cadrel://join?…" spellCheck={false} /></label>
            <label className="field"><span className="field-label">Your name in this Studio</span><input value={you} onChange={(e) => setYou(e.target.value)} maxLength={60} /></label>
            <label className="field"><span className="field-label">What to call the Studio on this computer (optional)</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="the owner’s name for it" /></label>
            {error && <div className="banner error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" className="primary" disabled={busy || !link.trim() || !you.trim()}>{busy ? 'Joining…' : 'Join'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
