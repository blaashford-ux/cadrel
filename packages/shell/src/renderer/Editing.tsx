import { useCallback, useEffect, useState } from 'react';
import type { EditingItem, EditingPassRow, EditingPassState, EditingState, StudioState } from '../shared/api';

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
