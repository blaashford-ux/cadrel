import { useCallback, useEffect, useState } from 'react';
import type { BriefKind, BriefRecord, BriefVersion } from '@cadrel/kernel';
import type { EditingBriefs } from '../shared/api';

const api = window.cadrel.editing;
type Ready = Extract<EditingBriefs, { available: true }>;
const KIND: Record<BriefKind, string> = { manuscript: 'Manuscript brief', edit: 'Edit brief' };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const day = (iso: string) => iso.slice(0, 10);

/** A book's briefs: what the manuscript is meant to be, and what each edit is asked to do. Every revision is kept; an edit pass names the version it followed. */
export function BriefCard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [s, setS] = useState<EditingBriefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const reload = useCallback(() => api.briefs(projectId).then((b) => (setS(b), setError(null)), (e) => setError(message(e))), [projectId]);
  useEffect(() => {
    setS(null);
    setAdding(false);
    void reload();
  }, [reload]);
  if (!s) return error ? <div className="banner error" role="alert">{error}</div> : null;
  if (!s.available) return null; // a role that cannot see briefs has no card, not a message
  const mayAdd = s.may.manuscript || s.may.edit;
  if (!s.briefs.length && !mayAdd) return null;
  return (
    <section className="card" aria-labelledby="pd-briefs">
      <div className="card-head">
        <h3 id="pd-briefs">Briefs</h3>
        {mayAdd && !adding && <button type="button" className="link" onClick={() => setAdding(true)}>New brief</button>}
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {s.briefs.length === 0 && !adding && <p className="muted">No briefs for {projectName} yet.</p>}
      {adding && <NewBrief s={s} projectId={projectId} onDone={() => (setAdding(false), void reload())} onError={setError} />}
      {s.briefs.map((b) => (
        <Brief key={b.id} b={b} s={s} onChanged={reload} onError={setError} />
      ))}
    </section>
  );
}

function NewBrief({ s, projectId, onDone, onError }: { s: Ready; projectId: string; onDone: () => void; onError: (m: string | null) => void }) {
  const [kind, setKind] = useState<BriefKind>(s.may.manuscript ? 'manuscript' : 'edit');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <form
      className="brief-form"
      onSubmit={(e) => {
        e.preventDefault();
        void api.createBrief({ projectId, kind, title, body }).then(() => onDone(), (er) => onError(message(er)));
      }}
    >
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as BriefKind)}>
          {s.may.manuscript && <option value="manuscript">{KIND.manuscript}</option>}
          {s.may.edit && <option value="edit">{KIND.edit}</option>}
        </select>
      </label>
      <label>Title<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Brief<textarea value={body} rows={6} maxLength={100000} onChange={(e) => setBody(e.target.value)} /></label>
      <button type="submit" className="primary" disabled={!title.trim() || !body.trim()}>Save the brief</button>{' '}
      <button type="button" className="quiet" onClick={onDone}>Cancel</button>
    </form>
  );
}

function Brief({ b, s, onChanged, onError }: { b: BriefRecord; s: Ready; onChanged: () => void; onError: (m: string | null) => void }) {
  const [revising, setRevising] = useState(false);
  const [history, setHistory] = useState<BriefVersion[] | null>(null);
  const [title, setTitle] = useState(b.title);
  const [body, setBody] = useState(b.current.body);
  const [note, setNote] = useState('');
  const may = b.kind === 'manuscript' ? s.may.manuscript : s.may.edit;
  const who = (id: string) => s.people.find((p) => p.id === id)?.name ?? 'someone';
  return (
    <article className="brief" aria-label={b.title}>
      <p>
        <strong>{b.title}</strong> <span className="chip">{KIND[b.kind]}</span> <span className="chip">version {b.current.n}</span>
        <span className="muted small"> · {who(b.current.writtenBy)}, {day(b.current.writtenAt)}</span>
      </p>
      {!revising && <p className="brief-body">{b.current.body}</p>}
      {revising && (
        <form
          className="brief-form"
          onSubmit={(e) => {
            e.preventDefault();
            void api.reviseBrief(b.id, { body, note, title, basedOn: b.current.n }).then(
              () => (setRevising(false), setNote(''), onChanged()),
              (er) => (onError(message(er)), onChanged())
            );
          }}
        >
          <label>Title<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>Brief<textarea value={body} rows={6} maxLength={100000} onChange={(e) => setBody(e.target.value)} /></label>
          <label>What changed (optional)<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
          <button type="submit" className="primary" disabled={!title.trim() || !body.trim() || (body === b.current.body && title === b.title)}>Save as version {b.current.n + 1}</button>{' '}
          <button type="button" className="quiet" onClick={() => (setRevising(false), setTitle(b.title), setBody(b.current.body))}>Cancel</button>
        </form>
      )}
      <div className="row">
        {may && !revising && <button type="button" className="quiet" onClick={() => setRevising(true)}>Revise…</button>}
        {b.current.n > 1 && (
          <button type="button" className="quiet" onClick={() => (history ? setHistory(null) : void api.briefVersions(b.id).then(setHistory, (er) => onError(message(er))))}>
            {history ? 'Hide earlier versions' : 'Earlier versions'}
          </button>
        )}
      </div>
      {history && (
        <ol className="brief-history" reversed>
          {[...history].reverse().map((v) => (
            <li key={v.n}>
              <span className="small"><strong>Version {v.n}</strong> · {who(v.writtenBy)}, {day(v.writtenAt)}{v.note ? ` · ${v.note}` : ''}</span>
              <p className="brief-body small">{v.body}</p>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
