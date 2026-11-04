import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditingCompare, EditingItem, EditingLaterVersion, EditingPassRow, EditingPassState, EditingPlanning, EditingState, EditingText, StudioState } from '../shared/api';

const api = window.cadrel.editing;
type Ready = Extract<EditingState, { available: true }>;
type PassReady = Extract<EditingPassState, { available: true }>;

const KIND_NAME: Record<EditingPassRow['kind'], string> = { developmental: 'Developmental edit', line: 'Line edit', copy: 'Copy edit', proof: 'Proofread' };
const STATE_NAME: Record<EditingPassRow['state'], string> = { planned: 'Planned', in_progress: 'In progress', delivered: 'Delivered', responded: 'Author responded', closed: 'Closed', cancelled: 'Called off' };
const NEXT_NAME: Record<NonNullable<EditingPassRow['next']>, string> = { start: 'Start it', deliver: 'Deliver it', answer: 'Answer and decide', respond: 'Mark it responded', close: 'Close it' };
const ITEM_KIND: Record<EditingItem['kind'], string> = { query: 'Query', comment: 'Comment', suggestion: 'Suggestion' };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  /** Changes elsewhere (a stage move, a task) reload the list. */
  studio: StudioState | null;
  onProject: (id: string) => void;
}

/** Editorial passes: what waits on you, and one pass at a time with its queries, comments and suggestions. */
export function Editing({ studio, onProject }: Props) {
  const [state, setState] = useState<EditingState | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const reload = useCallback(() => api.state().then((s) => (setState(s), setError(null)), (e) => setError(message(e))), []);
  useEffect(() => {
    void reload();
  }, [reload, studio]);

  if (error && !state) return <div className="banner error" role="alert">{error}</div>;
  if (!state) return <p className="muted">Loading…</p>;
  if (!state.available) return <section className="card"><p className="muted">{state.reason}</p></section>;
  if (open) return <PassView id={open} onBack={() => (setOpen(null), void reload())} onProject={onProject} />;

  const waiting = state.passes.filter((p) => p.next);
  const under = state.passes.filter((p) => !p.next && p.state !== 'closed');
  const done = state.passes.filter((p) => p.state === 'closed');
  return (
    <div className="editing">
      {error && <div className="banner error" role="alert">{error}</div>}
      <Waiting s={state} onDone={reload} onError={setError} />
      {state.may.assign && (planning ? <PlanForm onDone={(id) => (setPlanning(false), void reload(), id && setOpen(id))} onError={setError} /> : <p><button type="button" className="primary" onClick={() => setPlanning(true)}>Plan a pass…</button></p>)}
      {state.passes.length === 0 && <section className="card"><p className="muted">No editorial passes yet. An editor plans one on a manuscript in the vault; it will show here.</p></section>}
      <Group title="Waiting for you" rows={waiting} onOpen={setOpen} onProject={onProject} showNext />
      <Group title="Under way" rows={under} onOpen={setOpen} onProject={onProject} />
      <Group title="Done" rows={done} onOpen={setOpen} onProject={onProject} />
    </div>
  );
}

function Group({ title, rows, onOpen, onProject, showNext }: { title: string; rows: EditingPassRow[]; onOpen: (id: string) => void; onProject: (id: string) => void; showNext?: boolean }) {
  if (!rows.length) return null;
  return (
    <section className="card" aria-label={title}>
      <h3>{title} <span className="chip">{rows.length}</span></h3>
      <ul className="plain">
        {rows.map((p) => (
          <li key={p.id} className="row">
            <button type="button" className="link" onClick={() => onOpen(p.id)}>{p.title}</button>{' '}
            <span className="chip">{KIND_NAME[p.kind]}</span>{' '}
            <span className="chip">{STATE_NAME[p.state]}</span>{' '}
            <button type="button" className="link small" onClick={() => onProject(p.projectId)}>{p.projectName}</button>
            <span className="muted small"> · {p.filePath ?? 'file removed'} v{p.fileVersion} · {p.editorName}</span>
            {p.unanswered > 0 && <span className="chip warn">{p.unanswered} to answer</span>}
            {p.undecided > 0 && <span className="chip warn">{p.undecided} to decide</span>}
            {showNext && p.next && <strong className="small"> {NEXT_NAME[p.next]}</strong>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Answers kept for the Studio's server while it could not be reached, and any it turned down. */
function Waiting({ s, onDone, onError }: { s: Ready; onDone: () => void; onError: (m: string | null) => void }) {
  const o = s.offline;
  if (!o || (!o.away && o.pending === 0 && o.refused.length === 0)) return null;
  return (
    <section className="banner info" role="status" aria-label="Waiting for the Studio">
      {o.away && <p>The Studio cannot be reached. What is shown was saved on this computer the last time it was.</p>}
      {o.pending > 0 && (
        <p>
          {o.pending === 1 ? '1 answer or decision is' : `${o.pending} answers and decisions are`} waiting to be sent.{' '}
          <button type="button" onClick={() => void api.sendWaiting().then(onDone, (e) => onError(message(e)))}>Send now</button>
        </p>
      )}
      {o.refused.map((r) => (
        <div key={r.id}>
          <p>The Studio did not accept {r.call === 'answer' ? 'an answer' : 'a decision'} you made while away: {r.error}</p>
          {r.response && <blockquote className="small">{r.response}</blockquote>}
          <button type="button" className="quiet" onClick={() => void api.dismissRefused(r.id).then(onDone, (e) => onError(message(e)))}>Dismiss</button>
        </div>
      ))}
    </section>
  );
}

function PassView({ id, onBack, onProject }: { id: string; onBack: () => void; onProject: (id: string) => void }) {
  const [s, setS] = useState<EditingPassState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api.pass(id).then(setS, (e) => setError(message(e))), [id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  /** A change: the page shows the service's own reason if it is refused, and loads what is true now either way. */
  const run = async (job: () => Promise<unknown>): Promise<boolean> => {
    try {
      await job();
      setError(null);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      await reload();
    }
  };
  if (!s) return <p className="muted">{error ?? 'Loading…'}</p>;
  if (!s.available) return <section className="card"><button type="button" className="link" onClick={onBack}>← All passes</button><p className="muted">{s.reason}</p></section>;
  const p = s.pass;
  const mine = p.editorId === s.me;
  const runs = s.may.run && (mine || s.may.assign);
  return (
    <div className="editing-pass">
      <p><button type="button" className="link" onClick={onBack}>← All passes</button></p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <section className="card" aria-labelledby="ep-head">
        <h3 id="ep-head">{p.title}</h3>
        <p>
          <span className="chip">{KIND_NAME[p.kind]}</span> <span className="chip">{STATE_NAME[p.state]}</span>{' '}
          <button type="button" className="link small" onClick={() => onProject(p.projectId)}>{p.projectName}</button>
        </p>
        <p className="muted small">{p.filePath ?? 'The file was removed'}, version {p.fileVersion}{p.briefVersion ? `, brief version ${p.briefVersion}` : ''} · Editor: {p.editorName}</p>
        <div className="row">
          {p.state === 'planned' && runs && <button type="button" className="primary" onClick={() => void run(() => api.start(p.id))}>Start</button>}
          {p.state === 'in_progress' && runs && <button type="button" className="primary" onClick={() => void run(() => api.deliver(p.id))}>Deliver to the author</button>}
          {p.state === 'delivered' && s.may.respond && (
            <button type="button" className="primary" disabled={p.unanswered > 0 || p.undecided > 0} onClick={() => void run(() => api.respond(p.id))}>Mark as responded</button>
          )}
          {p.state === 'responded' && s.may.approve && <button type="button" className="primary" onClick={() => void run(() => api.close(p.id))}>Close the pass</button>}
          {p.state !== 'closed' && p.state !== 'cancelled' && s.may.assign && <button type="button" className="quiet" onClick={() => void run(() => api.cancel(p.id))}>Call it off</button>}
        </div>
        {p.state === 'delivered' && (p.unanswered > 0 || p.undecided > 0) && (
          <p className="muted small">{[p.unanswered > 0 && `${p.unanswered} ${p.unanswered === 1 ? 'query' : 'queries'} to answer`, p.undecided > 0 && `${p.undecided} ${p.undecided === 1 ? 'suggestion' : 'suggestions'} to decide`].filter(Boolean).join(' and ')} before it can be marked as responded.</p>
        )}
      </section>
      <TextPanel pass={p} canRaise={p.state === 'in_progress' && runs} onRaised={reload} onError={setError} />
      <RevisionPanel pass={p} canCheck={runs && (p.state === 'responded' || p.state === 'closed')} onChecked={reload} onError={setError} />
      {s.items.length === 0 ? <section className="card"><p className="muted">{p.state === 'in_progress' ? 'Nothing raised yet.' : 'No queries, comments or suggestions in this pass.'}</p></section> : s.items.map((i) => <Item key={i.id} item={i} s={s} run={run} />)}
    </div>
  );
}

function Item({ item: i, s, run }: { item: EditingItem; s: PassReady; run: (job: () => Promise<unknown>) => Promise<boolean> }) {
  const p = s.pass;
  const [answer, setAnswer] = useState(i.response ?? '');
  const [choose, setChoose] = useState<'reject' | 'defer' | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const mine = p.editorId === s.me;
  const delivered = p.state === 'delivered';
  const standing = i.state !== 'withdrawn';
  const editorCan = s.may.run && (mine || s.may.assign);
  const decide = async (input: { outcome: 'accept' | 'reject' | 'defer'; reason?: string; revisit?: string }) => {
    if (await run(() => api.decide(i.id, input))) (setChoose(null), setReason(''), setDate(''));
  };
  return (
    <section className={`card item item-${i.state}`} aria-label={`${ITEM_KIND[i.kind]} ${i.seq}`}>
      <p>
        <strong>{i.seq}.</strong> <span className="chip">{ITEM_KIND[i.kind]}</span>
        {i.category && <> <span className="chip">{i.category}</span></>} <span className="chip">{i.state}</span>
        {i.verified && <> <span className={`chip ${i.verified.result === 'made' ? '' : 'warn'}`} title={i.verified.note}>Revision: {i.verified.result}</span></>}
      </p>
      {i.anchor && <blockquote>{i.anchor.quote}</blockquote>}
      {i.body && <p>{i.body}</p>}
      {i.replacement !== null && <p><span className="muted small">Replace with</span> <strong>{i.replacement || '(nothing: take it out)'}</strong></p>}
      {i.response && <p><span className="muted small">Author’s answer</span><br />{i.response}</p>}
      {i.decision && (
        <p className="small">
          <strong>{i.decision.outcome === 'accept' ? 'Accepted' : i.decision.outcome === 'reject' ? 'Rejected' : `Deferred to ${i.decision.revisit}`}</strong>
          {i.decision.reason ? `: ${i.decision.reason}` : ''}
        </p>
      )}
      {delivered && standing && s.may.respond && (
        <div className="item-author">
          {i.kind === 'query' && (
            <form onSubmit={(e) => (e.preventDefault(), void run(() => api.answer(i.id, answer)))}>
              <label>Your answer<textarea value={answer} maxLength={4000} rows={3} onChange={(e) => setAnswer(e.target.value)} /></label>
              <button type="submit" disabled={!answer.trim()}>{i.state === 'answered' ? 'Change the answer' : 'Save the answer'}</button>
            </form>
          )}
          {i.kind !== 'query' && (
            <div className="row" role="group" aria-label="Your decision">
              <button type="button" className={i.decision?.outcome === 'accept' ? 'on' : ''} onClick={() => void decide({ outcome: 'accept' })}>Accept</button>
              <button type="button" className={i.decision?.outcome === 'reject' ? 'on' : ''} onClick={() => setChoose('reject')}>Reject…</button>
              <button type="button" className={i.decision?.outcome === 'defer' ? 'on' : ''} onClick={() => setChoose('defer')}>Defer…</button>
            </div>
          )}
          {choose && (
            <form onSubmit={(e) => (e.preventDefault(), void decide({ outcome: choose, reason, ...(choose === 'defer' ? { revisit: date } : {}) }))}>
              <label>Why<input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} /></label>
              {choose === 'defer' && <label>Come back to it on<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
              <button type="submit" className="primary" disabled={!reason.trim() || (choose === 'defer' && !date)}>{choose === 'reject' ? 'Reject' : 'Defer'}</button>{' '}
              <button type="button" className="quiet" onClick={() => setChoose(null)}>Back</button>
            </form>
          )}
        </div>
      )}
      {editorCan && standing && (
        <div className="row">
          {(p.state === 'delivered' || p.state === 'responded') && (i.state === 'open' || i.state === 'answered') && <button type="button" className="quiet" onClick={() => void run(() => api.resolve(i.id))}>Resolve</button>}
          {(p.state === 'in_progress' || p.state === 'delivered') && i.state === 'open' && <button type="button" className="quiet" onClick={() => void run(() => api.withdraw(i.id))}>Withdraw</button>}
        </div>
      )}
    </section>
  );
}

const KINDS: { value: EditingPassRow['kind']; label: string }[] = [
  { value: 'developmental', label: 'Developmental edit' },
  { value: 'line', label: 'Line edit' },
  { value: 'copy', label: 'Copy edit' },
  { value: 'proof', label: 'Proofread' }
];

/** Plans a pass: which book, which manuscript, what kind, who edits it, and (if the book has one) which edit brief it follows. */
function PlanForm({ onDone, onError }: { onDone: (newId?: string) => void; onError: (m: string | null) => void }) {
  const [plan, setPlan] = useState<EditingPlanning | null>(null);
  const [projectId, setProjectId] = useState('');
  const [fileId, setFileId] = useState('');
  const [fileVersion, setFileVersion] = useState<number | null>(null); // null: the newest
  const [kind, setKind] = useState<EditingPassRow['kind']>('line');
  const [editorId, setEditorId] = useState('');
  const [briefId, setBriefId] = useState('');
  const [title, setTitle] = useState('');
  useEffect(() => {
    let live = true;
    void api.planning(projectId || undefined).then(
      (p) => {
        if (!live) return;
        setPlan(p);
        if (!p.available) return;
        if (!projectId && p.projects[0]) setProjectId(p.projects[0].id);
        setFileId((f) => (p.files.some((x) => x.fileId === f) ? f : p.files[0]?.fileId ?? ''));
        setEditorId((e) => (p.editors.some((x) => x.id === e) ? e : p.editors[0]?.id ?? ''));
        setBriefId((b) => (p.briefs.some((x) => x.id === b) ? b : ''));
      },
      (e) => onError(message(e))
    );
    return () => {
      live = false;
    };
  }, [projectId, onError]);
  if (!plan) return <p className="muted">Loading…</p>;
  if (!plan.available) return <section className="card"><p className="muted">{plan.reason}</p><button type="button" className="quiet" onClick={() => onDone()}>Close</button></section>;
  const file = plan.files.find((f) => f.fileId === fileId);
  return (
    <section className="card" aria-label="Plan a pass">
      <h3>Plan a pass</h3>
      <form
        className="brief-form"
        onSubmit={(e) => {
          e.preventDefault();
          void api.plan({ projectId, kind, fileId, editorId, fileVersion: fileVersion ?? undefined, briefId: briefId || null, title: title.trim() || undefined }).then((r) => onDone(r.id), (er) => onError(message(er)));
        }}
      >
        <label>
          Book or project
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {plan.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Manuscript
          <select value={fileId} onChange={(e) => (setFileId(e.target.value), setFileVersion(null))}>
            {plan.files.map((f) => <option key={f.fileId} value={f.fileId}>{f.path} (version {f.version})</option>)}
          </select>
        </label>
        {file && file.version > 1 && (
          <label>
            Version to cover
            <select value={fileVersion ?? file.version} onChange={(e) => setFileVersion(Number(e.target.value) === file.version ? null : Number(e.target.value))}>
              {Array.from({ length: file.version }, (_, i) => file.version - i).map((n) => <option key={n} value={n}>{n === file.version ? `Version ${n} (the newest)` : `Version ${n}`}</option>)}
            </select>
          </label>
        )}
        <label>
          Kind of pass
          <select value={kind} onChange={(e) => setKind(e.target.value as EditingPassRow['kind'])}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
        <label>
          Editor
          <select value={editorId} onChange={(e) => setEditorId(e.target.value)}>
            {plan.editors.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {plan.briefs.length > 0 && (
          <label>
            Edit brief
            <select value={briefId} onChange={(e) => setBriefId(e.target.value)}>
              <option value="">None</option>
              {plan.briefs.map((b) => <option key={b.id} value={b.id}>{b.title} (version {b.version})</option>)}
            </select>
          </label>
        )}
        <label>Title (optional)<input value={title} maxLength={200} placeholder={KINDS.find((k) => k.value === kind)!.label} onChange={(e) => setTitle(e.target.value)} /></label>
        {file && <p className="muted small">The pass covers version {fileVersion ?? file.version} of {file.path}. Later changes to the manuscript do not move what the editor was shown.</p>}
        {plan.files.length === 0 && <p className="muted small">There is no manuscript in the vault yet. Add one on the Files page first.</p>}
        {plan.editors.length === 0 && projectId && <p className="muted small">Nobody is assigned to this project yet. Give the editor a role on it first (on its page, under People).</p>}
        <button type="submit" className="primary" disabled={!projectId || !fileId || !editorId}>Plan the pass</button>{' '}
        <button type="button" className="quiet" onClick={() => onDone()}>Cancel</button>
      </form>
    </section>
  );
}

/** The text of the version the pass covers. The editor selects a passage in it to raise a query, comment or suggestion about exactly that. */
function TextPanel({ pass, canRaise, onRaised, onError }: { pass: EditingPassRow; canRaise: boolean; onRaised: () => void; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState<EditingText | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const [picked, setPicked] = useState<{ start: number; end: number; text: string } | null>(null);
  const [kind, setKind] = useState<EditingItem['kind']>('query');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [category, setCategory] = useState('');
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    if (open && !t) void api.text(pass.id).then(setT, (e) => onError(message(e)));
  }, [open, t, pass.id, onError]);
  /** Where the selection is in the text: counted from the start of the text, so it is the same place the version has. */
  const select = () => {
    const sel = window.getSelection();
    const el = pre.current;
    if (!sel || !el || sel.rangeCount === 0 || sel.isCollapsed) return setPicked(null);
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return setPicked(null);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(r.startContainer, r.startOffset);
    const start = before.toString().length;
    setPicked({ start, end: start + r.toString().length, text: r.toString() });
  };
  const reset = () => (setBody(''), setReplacement(''), setCategory(''), setPicked(null));
  return (
    <section className="card" aria-labelledby="ed-text">
      <div className="card-head">
        <h3 id="ed-text">The manuscript, version {pass.fileVersion}</h3>
        <button type="button" className="link" onClick={() => setOpen((o) => !o)}>{open ? 'Hide the text' : canRaise ? 'Read it and raise items' : 'Read it'}</button>
      </div>
      {open && !t && <p className="muted">Loading…</p>}
      {open && t && (
        <>
          <pre ref={pre} className="ed-text" tabIndex={0} aria-label="Manuscript text" onMouseUp={select} onKeyUp={select}>{t.text}</pre>
          {canRaise && (
            <form
              className="brief-form"
              onSubmit={(e) => {
                e.preventDefault();
                void api
                  .raise(pass.id, [{ kind, ...(whole ? {} : { start: picked!.start, end: picked!.end }), body, ...(kind === 'suggestion' ? { replacement } : {}), category: category || undefined }])
                  .then(() => (reset(), onRaised()), (er) => onError(message(er)));
              }}
            >
              <p className="small">{whole ? 'A point about the whole pass.' : picked ? <>Selected: <q>{picked.text.length > 120 ? picked.text.slice(0, 120) + '…' : picked.text}</q></> : 'Select a passage in the text above.'}</p>
              <label className="inline small"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> About the whole pass, not a passage</label>
              <label>
                What to raise
                <select value={kind} onChange={(e) => setKind(e.target.value as EditingItem['kind'])}>
                  <option value="query">A query: needs the author’s answer</option>
                  <option value="comment">A comment: needs no answer</option>
                  <option value="suggestion">A suggestion: replacement text</option>
                </select>
              </label>
              <label>Text<textarea value={body} rows={3} maxLength={4000} onChange={(e) => setBody(e.target.value)} /></label>
              {kind === 'suggestion' && <label>Replace the passage with<input value={replacement} maxLength={2000} onChange={(e) => setReplacement(e.target.value)} /></label>}
              <label>About (optional)<input value={category} maxLength={40} placeholder="pacing, dialogue, clarity…" onChange={(e) => setCategory(e.target.value)} /></label>
              <button type="submit" className="primary" disabled={(!whole && !picked) || (kind !== 'suggestion' && !body.trim()) || (kind === 'suggestion' && whole)}>Add to the pass</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

/** What changed since the version the pass covers, side by side, and whether the changes the author accepted were made. */
function RevisionPanel({ pass, canCheck, onChecked, onError }: { pass: EditingPassRow; canCheck: boolean; onChecked: () => void; onError: (m: string | null) => void }) {
  const [versions, setVersions] = useState<EditingLaterVersion[] | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [cmp, setCmp] = useState<EditingCompare | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api.laterVersions(pass.id).then(
      (v) => live && (setVersions(v), setVersion((cur) => cur ?? v[0]?.n ?? null)),
      () => live && setVersions([]) // no vault here: nothing to compare with
    );
    return () => {
      live = false;
    };
  }, [pass.id]);
  if (!versions || versions.length === 0) return null;
  const go = async <T,>(job: () => Promise<T>, then: (r: T) => void) => {
    setBusy(true);
    try {
      then(await job());
      onError(null);
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="ed-rev">
      <h3 id="ed-rev">The revision</h3>
      <div className="row">
        <label className="inline">
          A later version{' '}
          <select value={version ?? ''} onChange={(e) => (setVersion(Number(e.target.value)), setCmp(null))}>
            {versions.map((v) => <option key={v.n} value={v.n}>Version {v.n} · {v.author}, {v.createdAt.slice(0, 10)}{v.comment ? ` · ${v.comment}` : ''}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy || version === null} onClick={() => void go(() => api.compare(pass.id, version!), setCmp)}>Compare with version {pass.fileVersion}</button>
        {canCheck && <button type="button" className="primary" disabled={busy || version === null} onClick={() => void go(() => api.verify(pass.id, version!), () => onChecked())}>Check the accepted changes</button>}
      </div>
      {canCheck && <p className="muted small">Checking looks for each change the author accepted in that version: made, changed some other way, or missed. The result shows on each item.</p>}
      {cmp && <Compare c={cmp} />}
    </section>
  );
}

function Compare({ c }: { c: EditingCompare }) {
  const st = c.stats;
  const words = (ops: { op: 'same' | 'del' | 'ins'; text: string }[], side: 'del' | 'ins') =>
    ops.filter((o) => o.op === 'same' || o.op === side).map((o, i) => (o.op === 'del' ? <del key={i}>{o.text}</del> : o.op === 'ins' ? <ins key={i}>{o.text}</ins> : <span key={i}>{o.text}</span>));
  return (
    <div className="ed-compare">
      <p className="small">
        {st.changed} changed, {st.added} added, {st.removed} removed · +{st.wordsAdded} words, −{st.wordsRemoved} words
        {st.changed + st.added + st.removed === 0 && ' · the two versions read the same'}
      </p>
      <table>
        <thead>
          <tr><th scope="col">Version {c.from}</th><th scope="col">Version {c.to}</th></tr>
        </thead>
        <tbody>
          {c.rows.map((r, i) =>
            r.kind === 'skip' ? (
              <tr key={i} className="skip"><td colSpan={2}>{r.count} unchanged {r.count === 1 ? 'paragraph' : 'paragraphs'}</td></tr>
            ) : r.kind === 'same' ? (
              <tr key={i}><td>{r.a.text}</td><td>{r.b.text}</td></tr>
            ) : r.kind === 'removed' ? (
              <tr key={i} className="removed"><td><del>{r.a.text}</del></td><td /></tr>
            ) : r.kind === 'added' ? (
              <tr key={i} className="added"><td /><td><ins>{r.b.text}</ins></td></tr>
            ) : (
              <tr key={i} className="changed"><td>{words(r.words, 'del')}</td><td>{words(r.words, 'ins')}</td></tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
