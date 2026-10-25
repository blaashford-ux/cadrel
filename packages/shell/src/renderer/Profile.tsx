import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, UserView } from '../shared/api';
import { IMAGE_MIME } from '@cadrel/kernel';
import { formatBytes } from './format';
import { Avatar } from './Avatar';

const api = window.cadrel.user;

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Who you are in Cadrel, and the files that go with you (a photo, an author bio, a contract). */
export function Profile() {
  const [view, setView] = useState<UserView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: '', email: '', penNames: '', bio: '' });
  const [saved, setSaved] = useState(false);
  const [over, setOver] = useState(false);
  const loaded = useRef(false);

  const take = useCallback((v: UserView) => {
    setView(v);
    // Fill the form once; later updates from outside (a photo change) must not overwrite what is being typed.
    if (!loaded.current) {
      loaded.current = true;
      setForm({ displayName: v.profile.displayName, email: v.profile.email, penNames: v.profile.penNames.join(', '), bio: v.profile.bio });
    }
  }, []);

  useEffect(() => {
    void api.get().then(take, (e) => setError(clean(e)));
    return api.onChange(take);
  }, [take]);

  /** Runs a change and shows a refusal as text. */
  const run = async (job: () => Promise<UserView | null | void>) => {
    setError(null);
    try {
      const v = await job();
      if (v) setView(v);
      return true;
    } catch (e) {
      setError(clean(e));
      return false;
    }
  };

  const save = async () => {
    const ok = await run(() => api.update({ displayName: form.displayName, email: form.email, penNames: form.penNames.split(/[,\n]/).map((x) => x.trim()).filter(Boolean), bio: form.bio }));
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    }
  };

  if (!view) return <p className="muted">{error ?? 'Loading…'}</p>;
  const p = view.profile;
  const dirty =
    form.displayName.trim() !== p.displayName || form.email.trim() !== p.email || form.penNames.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join(', ') !== p.penNames.join(', ') || form.bio.trim() !== p.bio;
  const problem = (a: Attachment) => view.problems.find((x) => x.id === a.id);

  return (
    <div className="profile">
      {error && <div className="banner error" role="alert">{error} <button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

      <section className="card" aria-labelledby="pf-you">
        <div className="profile-head">
          <Avatar size={72} />
          <div>
            <h3 id="pf-you">{view.name}</h3>
            <p className="muted small">{view.nameIsDefault ? 'Using your Windows user name until you set one below.' : 'This is the name on your notes, comments and approvals.'}</p>
          </div>
        </div>
        <form className="profile-form" noValidate onSubmit={(e) => (e.preventDefault(), void save())}>
          <label className="field">
            <span className="field-label">Name</span>
            <input value={form.displayName} maxLength={80} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Your name" />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" value={form.email} maxLength={200} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" />
            <span className="field-hint">Used to sign you in to a studio and to send you invitations. Never shown on notes.</span>
          </label>
          <label className="field">
            <span className="field-label">Pen names</span>
            <input value={form.penNames} onChange={(e) => setForm({ ...form, penNames: e.target.value })} placeholder="Separate with commas" />
          </label>
          <label className="field">
            <span className="field-label">About me</span>
            <textarea rows={4} value={form.bio} maxLength={2000} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="A short author bio, or how you like to write." />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={!dirty}>Save</button>
            {saved && <span role="status" className="muted">Saved</span>}
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby="pf-ai">
        <h3 id="pf-ai">AI assistant</h3>
        <label className="check-row">
          <input type="checkbox" checked={p.assistant.files} onChange={(e) => void run(() => api.setAssistantFiles(e.target.checked))} />{' '}
          Let the AI assistant see and read my attached files
        </label>
        <p className="muted small">
          {p.assistant.files
            ? 'On: through Cadrel’s AI connection the assistant can list your attached files and open the ones you have not hidden, to sign things and write in your voice. Your email is never shared. Turn it off and it cannot tell you have any files.'
            : 'Off: the assistant is told only that you have turned this off. Your name, pen names and about-me are still available to it.'}
        </p>
        {p.assistantReads.length > 0 && (
          <details>
            <summary className="small">Recently opened by the assistant ({p.assistantReads.length})</summary>
            <ul className="reads">
              {[...p.assistantReads].reverse().slice(0, 20).map((r, i) => (
                <li key={i} className="small"><strong>{r.by}</strong> opened {r.name} <span className="muted">· {new Date(r.at).toLocaleString()}</span></li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section
        className={`card drop${over ? ' over' : ''}`}
        aria-labelledby="pf-files"
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = [...e.dataTransfer.files];
          if (files.length) void run(() => api.attachDropped(files));
        }}
      >
        <div className="card-head">
          <h3 id="pf-files">Your files</h3>
          <button type="button" onClick={() => void run(() => api.attach())}>Attach files…</button>
        </div>
        <p className="muted small">A photo, an author bio, a signed contract, a tax form. They are copied into Cadrel; the originals stay where they are. Drop files here too.</p>
        {p.attachments.length === 0 ? (
          <p className="muted">Nothing attached yet.</p>
        ) : (
          <ul className="attachments">
            {p.attachments.map((a) => (
              <li key={a.id}>
                <div className="att-main">
                  <strong className="att-name">{a.name}</strong>
                  <span className="muted small">{formatBytes(a.size)} · added {new Date(a.addedAt).toLocaleDateString()}</span>
                  {p.avatarId === a.id && <span className="chip">your photo</span>}
                  {a.origin === 'assistant' && <span className="chip ai">added by AI</span>}
                  {problem(a) && <span className="warn small">{problem(a)!.problem === 'missing' ? 'the copy is missing' : 'the copy has changed'}</span>}
                </div>
                <input
                  className="att-note"
                  defaultValue={a.note}
                  maxLength={300}
                  placeholder="What is this for?"
                  aria-label={`Note on ${a.name}`}
                  onBlur={(e) => e.target.value.trim() !== a.note && void run(() => api.editAttachment(a.id, { note: e.target.value }))}
                />
                <div className="att-actions">
                  <button type="button" onClick={() => void run(() => api.open(a.id))}>Open</button>
                  <button type="button" onClick={() => void run(() => api.reveal(a.id))}>Show in folder</button>
                  <label className="inline small" title={p.assistant.files ? 'Untick to hide this file from the assistant' : 'The assistant cannot see any of your files while access is off'}>
                    <input type="checkbox" checked={a.assistant} disabled={!p.assistant.files} onChange={(e) => void run(() => api.editAttachment(a.id, { assistant: e.target.checked }))} /> AI can read
                  </label>
                  {IMAGE_MIME.test(a.mime) && (p.avatarId === a.id ? (
                    <button type="button" onClick={() => void run(() => api.setAvatar(null))}>Remove as photo</button>
                  ) : (
                    <button type="button" onClick={() => void run(() => api.setAvatar(a.id))}>Use as photo</button>
                  ))}
                  <button type="button" className="quiet" onClick={() => void run(() => api.removeAttachment(a.id))}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
