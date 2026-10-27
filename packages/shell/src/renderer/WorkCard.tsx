import { useCallback, useEffect, useState } from 'react';
import type { WorkState } from '../shared/api';

const api = window.cadrel.work;
type Act = <T>(job: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
type Ready = Extract<WorkState, { available: true }>;
const today = () => new Date().toISOString().slice(0, 10);

/** Tasks and deadlines, sign-offs and the decision ledger for a project and its subprojects. */
export function WorkCard({ projectId, projectName, act, onChanged }: { projectId: string; projectName: string; act: Act; onChanged: () => void }) {
  const [s, setS] = useState<WorkState | null>(null);
  const reload = useCallback(() => api.state(projectId).then(setS, () => setS(null)), [projectId]);
  useEffect(() => {
    setS(null);
    void reload();
  }, [reload]);
  const run = async <T,>(job: () => Promise<T>) => {
    const r = await act(job);
    await reload();
    onChanged();
    return r;
  };
  if (!s) return null;
  if (!s.available) return <section className="card" aria-labelledby="pd-work"><h3 id="pd-work">Tasks and sign-offs</h3><p className="muted">{s.reason}</p></section>;
  return (
    <>
      <Tasks s={s} projectId={projectId} projectName={projectName} run={run} />
      <Signoffs s={s} projectId={projectId} projectName={projectName} run={run} />
      <Decisions s={s} projectId={projectId} projectName={projectName} run={run} />
    </>
  );
}

type Run = <T>(job: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
interface Sub { s: Ready; projectId: string; projectName: string; run: Run }
const nameOf = (s: Ready, id: string | null) => (id ? s.people.find((p) => p.id === id)?.name ?? 'someone' : 'nobody');

function Tasks({ s, projectId, projectName, run }: Sub) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'task' | 'deadline'>('task');
  const [due, setDue] = useState('');
  const [who, setWho] = useState('');
  const [showDone, setShowDone] = useState(false);
  const open = s.tasks.filter((t) => t.state === 'open');
  const shown = showDone ? s.tasks : open;
  const mayChange = (assignee: string | null) => s.may.manage || (s.may.edit && assignee === s.me);
  const titleOf = (id: string) => s.tasks.find((t) => t.id === id)?.title ?? 'a task';
  const add = async () => {
    const r = await run(() => api.createTask({ projectId, title, kind, due: due || null, assigneeId: who || null }));
    if (r.ok) (setTitle(''), setDue(''), setWho(''));
  };
  return (
    <section className="card" aria-labelledby="pd-tasks">
      <h3 id="pd-tasks">Tasks and deadlines</h3>
      {shown.length === 0 && <p className="muted">{s.tasks.length ? 'Nothing open.' : 'No tasks yet.'}</p>}
      <ul className="plain work-list" aria-label="Tasks">
        {shown.map((t) => {
          const late = t.state === 'open' && t.due !== null && t.due < today();
          const waiting = t.dependsOn.filter((d) => s.tasks.find((x) => x.id === d)?.state === 'open');
          return (
            <li key={t.id} className={t.state === 'open' ? '' : 'archived'}>
              <input type="checkbox" aria-label={`${t.title} is done`} checked={t.state === 'done'} disabled={!mayChange(t.assigneeId) || t.state === 'cancelled' || waiting.length > 0} onChange={(e) => void run(() => api.setState(t.id, e.target.checked ? 'done' : 'open'))} />
              <span className="grow-text">
                <strong>{t.title}</strong> {t.kind === 'deadline' && <span className="chip">deadline</span>}
                {t.projectId !== projectId && <span className="muted small"> · {t.projectName}</span>}
                <span className="muted small"> · {nameOf(s, t.assigneeId)}</span>
                {t.due && <span className={late ? 'warn small' : 'muted small'}> · {late ? 'late: ' : 'due '}{t.due}</span>}
                {waiting.length > 0 && <span className="muted small"> · waiting for {waiting.map(titleOf).join(', ')}</span>}
                {t.state === 'cancelled' && <span className="muted small"> · cancelled</span>}
              </span>
              {t.state === 'open' && mayChange(t.assigneeId) && <button type="button" className="quiet" onClick={() => void run(() => api.setState(t.id, 'cancelled'))}>Cancel</button>}
            </li>
          );
        })}
      </ul>
      {s.tasks.some((t) => t.state !== 'open') && <label className="inline small muted"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show finished</label>}
      {s.may.edit && (
        <form className="row" onSubmit={(e) => (e.preventDefault(), void add())} aria-label={`Add a task to ${projectName}`}>
          <input aria-label="Title" placeholder="What needs doing" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as 'task' | 'deadline')}><option value="task">Task</option><option value="deadline">Deadline</option></select>
          <input type="date" aria-label="Due" value={due} onChange={(e) => setDue(e.target.value)} />
          <select aria-label="Assigned to" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Not assigned</option>
            {s.people.filter((p) => s.may.assign || p.id === s.me).map((p) => <option key={p.id} value={p.id}>{p.id === s.me ? `${p.name} (me)` : p.name}</option>)}
          </select>
          <button type="submit" className="primary" disabled={!title.trim() || (kind === 'deadline' && !due)}>Add</button>
        </form>
      )}
    </section>
  );
}

function Signoffs({ s, projectId, projectName, run }: Sub) {
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const ask = async () => {
    const r = await run(() => api.requestApproval({ projectId, label, note, approverIds: picked }));
    if (r.ok) (setLabel(''), setNote(''), setPicked([]));
  };
  return (
    <section className="card" aria-labelledby="pd-sign">
      <h3 id="pd-sign">Sign-offs</h3>
      <p className="muted small">A sign-off is an answer the named people give. A stage gate can ask for one before a project moves on.{s.approved.length ? ` Standing approved: ${s.approved.join(', ')}.` : ''}</p>
      {s.approvals.length === 0 && <p className="muted">None asked for yet.</p>}
      <ul className="plain work-list" aria-label="Sign-offs">
        {s.approvals.map((a) => {
          const mine = a.approvers.find((x) => x.personId === s.me);
          const canAnswer = a.state === 'pending' && mine && mine.response === null;
          return (
            <li key={a.id}>
              <span className="grow-text">
                <strong>{a.label}</strong> <span className={`chip${a.state === 'rejected' ? ' warn' : ''}`}>{a.state}</span>
                {a.projectId !== projectId && <span className="muted small"> · {a.projectName}</span>}
                <span className="muted small"> · asked by {nameOf(s, a.requestedBy)}; {a.approvers.map((x) => `${nameOf(s, x.personId)}${x.response ? ` ${x.response}${x.reason ? ` (${x.reason})` : ''}` : ''}`).join(', ')}{a.required < a.approvers.length ? `; ${a.required} needed` : ''}</span>
                {a.note && <span className="muted small"> — {a.note}</span>}
              </span>
              {canAnswer && reasonFor !== a.id && (
                <>
                  <button type="button" className="primary" onClick={() => void run(() => api.respond(a.id, 'approved'))}>Approve</button>
                  <button type="button" onClick={() => (setReasonFor(a.id), setReason(''))}>Reject…</button>
                </>
              )}
              {canAnswer && reasonFor === a.id && (
                <form className="row" onSubmit={(e) => (e.preventDefault(), void run(() => api.respond(a.id, 'rejected', reason)).then(() => setReasonFor(null)))}>
                  <input aria-label="Why" placeholder="Why" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  <button type="submit" disabled={!reason.trim()}>Reject</button>
                  <button type="button" className="quiet" onClick={() => setReasonFor(null)}>Back</button>
                </form>
              )}
              {a.state === 'pending' && (a.requestedBy === s.me || s.may.manage) && <button type="button" className="quiet" onClick={() => void run(() => api.withdraw(a.id))}>Withdraw</button>}
            </li>
          );
        })}
      </ul>
      {s.may.edit && (
        <form className="work-ask" onSubmit={(e) => (e.preventDefault(), void ask())} aria-label={`Ask for a sign-off on ${projectName}`}>
          <div className="row">
            <input aria-label="Sign-off label" placeholder="Cover approved" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
            <input aria-label="Note" className="grow-text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="row" role="group" aria-label="Who is asked">
            {s.people.map((p) => (
              <label key={p.id} className="inline small"><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /> {p.id === s.me ? `${p.name} (me)` : p.name}</label>
            ))}
            <button type="submit" className="primary" disabled={!label.trim() || picked.length === 0}>Ask</button>
          </div>
        </form>
      )}
    </section>
  );
}

function Decisions({ s, projectId, projectName, run }: Sub) {
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [context, setContext] = useState('');
  const [replace, setReplace] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = all ? s.decisions : s.decisions.filter((d) => !d.supersededBy);
  const save = async () => {
    const r = await run(() => api.recordDecision({ projectId, title, context, outcome, supersedes: replace }));
    if (r.ok) (setTitle(''), setOutcome(''), setContext(''), setReplace(null));
  };
  return (
    <section className="card" aria-labelledby="pd-dec">
      <h3 id="pd-dec">Decisions</h3>
      <p className="muted small">A record of what was decided and why. Entries are never edited or removed; a later decision replaces an earlier one and the earlier one stays on the record.</p>
      {shown.length === 0 && <p className="muted">Nothing recorded yet.</p>}
      <ul className="plain work-list" aria-label="Decisions">
        {shown.map((d) => (
          <li key={d.id} className={d.supersededBy ? 'archived' : ''}>
            <span className="grow-text">
              <strong>{d.title}</strong>: {d.outcome}
              <span className="muted small"> · {nameOf(s, d.decidedBy)}, {d.decidedAt.slice(0, 10)}{d.projectId && d.projectId !== projectId ? ` · ${d.projectName}` : ''}{d.supersededBy ? ' · replaced' : ''}</span>
              {d.context && <span className="muted small"> — {d.context}</span>}
            </span>
            {s.may.edit && !d.supersededBy && <button type="button" className="quiet" onClick={() => (setReplace(d.id), setTitle(d.title), setContext(''), setOutcome(''))}>Replace…</button>}
          </li>
        ))}
      </ul>
      {s.decisions.some((d) => d.supersededBy) && <label className="inline small muted"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show replaced decisions</label>}
      {s.may.edit && (
        <form className="work-ask" onSubmit={(e) => (e.preventDefault(), void save())} aria-label={`Record a decision on ${projectName}`}>
          {replace && <p className="small muted">Replacing “{s.decisions.find((d) => d.id === replace)?.title}”. <button type="button" className="link" onClick={() => setReplace(null)}>Not a replacement</button></p>}
          <div className="row">
            <input aria-label="Decision title" placeholder="What was decided about" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <input aria-label="Outcome" className="grow-text" placeholder="The outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          </div>
          <div className="row">
            <input aria-label="Context" className="grow-text" placeholder="Why (optional)" value={context} onChange={(e) => setContext(e.target.value)} />
            <button type="submit" className="primary" disabled={!title.trim() || !outcome.trim()}>Record</button>
          </div>
        </form>
      )}
    </section>
  );
}
