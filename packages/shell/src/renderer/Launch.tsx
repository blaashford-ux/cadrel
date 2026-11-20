import { useCallback, useEffect, useState } from 'react';
import { useScope } from './useScope';
import type { ArcReader, DecisionWindow } from '@cadrel/kernel';
import type { LaunchBriefView, LaunchItemRow, LaunchMarketView, LaunchPlanView, LaunchState, PlanSummary, StudioState } from '../shared/api';

const api = window.cadrel.launch;
type Ready = Extract<LaunchState, { available: true }>;
type PlanReady = Extract<LaunchPlanView, { available: true }>;
type BriefReady = Extract<LaunchBriefView, { available: true }>;
type MarketReady = Extract<LaunchMarketView, { available: true }>;
type Run = (job: () => Promise<unknown>) => Promise<boolean>;

const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => iso.slice(0, 10);
const STATE: Record<string, string> = { draft: 'Draft', approved: 'Approved', live: 'Live', reviewed: 'Reviewed', cancelled: 'Cancelled' };
const STATUS: Record<string, string> = { done: 'Done', late: 'Late', blocked: 'Blocked', outstanding: 'To do', cancelled: 'Cancelled' };
const READER_STATE: Record<string, string> = { invited: 'Invited', sent: 'Has the file', received: 'Received', reviewed: 'Reviewed', declined: 'Declined', bounced: 'Bounced' };
const when = (days: number) => (days === 0 ? 'Release day' : days > 0 ? `${plural(days, 'day')} to go` : `${plural(-days, 'day')} since release`);
const money = (n: number | null) => (n === null ? '—' : n.toFixed(2));

interface Props {
  /** Changes elsewhere reload the page. */
  studio: StudioState | null;
}

/** The release plans of the project in view, worked backwards from their dates, with what is outstanding computed from the records. */
export function LaunchPage({ studio }: Props) {
  // follows the project (and book) the app is showing, like Canon and Art: nothing to choose
  const scope = useScope();
  const project = scope?.book ?? scope?.project ?? undefined;
  const [state, setState] = useState<LaunchState | null>(null);
  const [tab, setTab] = useState<'plans' | 'briefs' | 'requests' | 'market'>('plans');
  const [open, setOpen] = useState<{ kind: 'plan' | 'brief'; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api.state(project).then((s) => (setState(s), setError(null)), (e) => setError(message(e))), [project]);
  useEffect(() => {
    setState(null);
    setOpen(null);
  }, [project]);
  useEffect(() => {
    if (scope) void reload();
  }, [reload, studio, scope]);

  if (error && !state) return <div className="banner error" role="alert">{error}</div>;
  if (!scope || !state) return <p className="muted">Loading…</p>;
  if (!state.available) return <section className="card"><p className="muted">{state.reason}</p></section>;
  const act: Run = async (job) => {
    setError(null);
    try {
      await job();
      await reload();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  };
  return (
    <div className="launch">
      <div className="row">
        <h2 style={{ margin: 0 }}>Launch</h2>
        <span className="chip" title="The project in view">{state.project.name}</span>
        {state.plans.some((p) => p.late > 0) && <span className="chip warn">{plural(state.plans.reduce((n, p) => n + p.late, 0), 'late item')}</span>}
      </div>
      <p className="muted small">A release worked backwards from its date. Each item is a task, so it is in the Planner. What is outstanding is worked out from the records (the cover, Preflight, sign-offs, requests, briefs, ARC readers), never typed in. It follows the project you are in.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      {open?.kind === 'plan' ? (
        <PlanDetail id={open.id} onBack={() => (setOpen(null), void reload())} act={act} />
      ) : open?.kind === 'brief' ? (
        <BriefDetail id={open.id} onBack={() => (setOpen(null), void reload())} act={act} />
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Launch">
            {([['plans', `Plans (${state.plans.length})`], ['briefs', `Briefs (${state.briefs.length})`], ['requests', `Art requests (${state.requests.length})`], ['market', 'Market']] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === 'plans' && <PlansTab s={state} act={act} onOpen={(id) => setOpen({ kind: 'plan', id })} />}
          {tab === 'briefs' && <BriefsTab s={state} act={act} onOpen={(id) => setOpen({ kind: 'brief', id })} />}
          {tab === 'requests' && <RequestsTab s={state} act={act} />}
          {tab === 'market' && <MarketTab project={project} />}
        </>
      )}
    </div>
  );
}

// ---- plans ---------------------------------------------------------------------------------------------------------------------

function PlansTab({ s, act, onOpen }: { s: Ready; act: Run; onOpen: (id: string) => void }) {
  return (
    <>
      {s.may.manage && <NewPlan s={s} act={act} />}
      {s.plans.length === 0 ? (
        <section className="card"><p className="muted">No release plan for {s.project.name} yet.{s.may.manage ? ' Make one from a template above.' : ''}</p></section>
      ) : (
        <section className="card" aria-label="Plans">
          <ul className="plain work-list">
            {s.plans.map((p: PlanSummary) => (
              <li key={p.plan.id}>
                <button type="button" className="link" onClick={() => onOpen(p.plan.id)}>{p.plan.name}</button> <span className="chip">{STATE[p.plan.state]}</span>
                <span className="muted small"> {p.plan.releaseDate} · {when(p.daysToRelease)}{p.editionLabel ? ` · ${p.editionLabel}` : ''}</span>
                {p.late > 0 && <span className="chip warn">{plural(p.late, 'late item')}</span>}
                {p.blocked > 0 && <span className="chip">{plural(p.blocked, 'blocked item')}</span>}
                <span className="chip">{p.outstanding} outstanding</span>
                {p.changedSinceApproval && <span className="chip warn">changed since approved</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function NewPlan({ s, act }: { s: Ready; act: Run }) {
  const [tpl, setTpl] = useState('');
  const [date, setDate] = useState('');
  const [edition, setEdition] = useState('');
  const [marketing, setMarketing] = useState('');
  const [art, setArt] = useState('');
  const t = s.templates.some((x) => x.id === tpl) ? tpl : s.templates.length === 1 ? s.templates[0]!.id : s.templates.find((x) => x.name === 'Ebook launch')?.id ?? '';
  const e = s.editions.some((x) => x.id === edition) ? edition : s.editions.length === 1 ? s.editions[0]!.id : '';
  return (
    <form className="card" aria-label="New plan" onSubmit={(ev) => { ev.preventDefault(); void act(() => api.call('createPlan', { projectId: s.project.id, templateId: t, releaseDate: date, editionId: e || null, assignees: { marketing: marketing || null, art: art || null } })); }}>
      <h4>Plan a release</h4>
      <div className="row">
        <select aria-label="Template" value={t} onChange={(ev) => setTpl(ev.target.value)}><option value="">Template…</option>{s.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <label className="small">Release date <input aria-label="Release date" type="date" value={date} onChange={(ev) => setDate(ev.target.value)} /></label>
        {s.editions.length > 1 ? <select aria-label="Edition" value={e} onChange={(ev) => setEdition(ev.target.value)}><option value="">Edition…</option>{s.editions.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select> : s.editions[0] ? <span className="muted small">{s.editions[0].label}</span> : null}
      </div>
      <div className="row">
        <select aria-label="Marketing" value={marketing} onChange={(ev) => setMarketing(ev.target.value)}><option value="">Marketing is…</option>{s.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select aria-label="Art" value={art} onChange={(ev) => setArt(ev.target.value)}><option value="">Art is…</option>{s.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button type="submit" disabled={!t || !date}>Make the plan</button>
      </div>
    </form>
  );
}

function PlanDetail({ id, onBack, act }: { id: string; onBack: () => void; act: Run }) {
  const [v, setV] = useState<LaunchPlanView | null>(null);
  const reload = useCallback(() => api.plan(id).then(setV, () => undefined), [id]);
  useEffect(() => void reload(), [reload]);
  if (!v) return <p className="muted">Loading…</p>;
  if (!v.available) return <section className="card"><button type="button" className="link" onClick={onBack}>Back</button><p className="muted">{v.reason}</p></section>;
  const run: Run = async (job) => {
    const ok = await act(job);
    await reload();
    return ok;
  };
  return <PlanBody v={v} onBack={onBack} run={run} />;
}

function ItemRow({ r, v, run }: { r: LaunchItemRow; v: PlanReady; run: Run }) {
  const { item, task, status, reasons, daysLate } = r.view;
  const manual = item.requirement.kind === 'manual';
  return (
    <li>
      <strong>{task.title}</strong> <span className={`chip ${status === 'late' ? 'warn' : status === 'done' ? 'ok' : ''}`}>{STATUS[status]}</span>
      {!item.required && <span className="chip">optional</span>}
      <span className="muted small"> due {task.due}{status === 'late' ? ` (${plural(daysLate, 'day')} late)` : ''}{r.assigneeName ? ` · ${r.assigneeName}` : ' · no one yet'}</span>
      {reasons.map((x) => <div key={x} className="small muted">{x}</div>)}
      {manual && (v.may.manage || task.assigneeId !== null) && status !== 'cancelled' && v.plan.state !== 'cancelled' && (
        <button type="button" onClick={() => void run(() => api.call('mark', v.plan.id, item.key, status !== 'done'))}>{status === 'done' ? 'Reopen' : 'Mark done'}</button>
      )}
    </li>
  );
}

function PlanBody({ v, onBack, run }: { v: PlanReady; onBack: () => void; run: Run }) {
  const p = v.plan;
  const [newDate, setNewDate] = useState('');
  const [why, setWhy] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const open = v.proposals.filter((x) => x.state === 'open');
  const live = p.state !== 'cancelled' && p.state !== 'reviewed';
  const phase = (r: LaunchItemRow) => (r.view.item.offsetDays < 0 ? 'Before the release' : r.view.item.offsetDays === 0 ? 'Release day' : 'After the release');
  return (
    <div className="plan">
      <button type="button" className="link" onClick={onBack}>← All plans</button>
      <div className="row">
        <h3 style={{ margin: 0 }}>{p.name}</h3> <span className="chip">{STATE[p.state]}</span> <span className="chip">{p.releaseDate}</span> <span className="muted small">{when(v.daysToRelease)}</span>
        {v.editionLabel && <span className="muted small">{v.editionLabel}</span>}
        {v.changedSinceApproval && <span className="chip warn">changed since it was approved</span>}
      </div>
      {p.approvedAt && <p className="muted small">Approved {day(p.approvedAt)} by {v.approvedByName}.</p>}
      {v.may.approve && live && (p.state === 'draft' || v.changedSinceApproval) && <button type="button" onClick={() => void run(() => api.call('approve', p.id, v.revision))}>Approve this plan as it stands</button>}
      {v.may.manage && p.state === 'approved' && !v.changedSinceApproval && <button type="button" onClick={() => void run(() => api.call('goLive', p.id))}>Mark it live</button>}
      {v.may.manage && live && (cancelling ? (
        <span className="row"><input aria-label="Why cancel" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} /><button type="button" disabled={!reason.trim()} onClick={() => void run(() => api.call('cancel', p.id, reason))}>Cancel the plan</button></span>
      ) : <button type="button" onClick={() => setCancelling(true)}>Cancel this plan…</button>)}

      <section className="card" aria-label="Outstanding">
        <h4>Outstanding for {p.releaseDate} <span className="chip">{v.outstanding.length}</span></h4>
        {v.outstanding.length === 0 ? <p className="muted small">Every required item is done.</p> : <ul className="plain work-list">{v.outstanding.map((r) => <ItemRow key={r.view.item.id} r={r} v={v} run={run} />)}</ul>}
      </section>

      {v.may.manage && live && (
        <section className="card" aria-label="Move the date">
          <h4>Move the release date</h4>
          {open.length === 0 ? (
            <form className="row" onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('proposeDate', p.id, newDate, why)).then(() => (setNewDate(''), setWhy(''))); }}>
              <input aria-label="New release date" type="date" value={newDate} onChange={(ev) => setNewDate(ev.target.value)} />
              <input aria-label="Why the date moves" placeholder="Why" value={why} onChange={(ev) => setWhy(ev.target.value)} />
              <button type="submit" disabled={!newDate}>Propose the new date</button>
            </form>
          ) : null}
          {open.map((x) => (
            <div key={x.id}>
              <p>Move from {x.fromDate} to {x.newDate}{x.reason ? `: ${x.reason}` : ''} <span className="muted small">(proposed by {x.proposerName}; nothing changes until it is applied)</span></p>
              <table className="small"><thead><tr><th>Item</th><th>Now</th><th>New</th><th /></tr></thead>
                <tbody>{x.changes.map((c) => <tr key={c.key}><td>{c.title}</td><td>{c.from ?? '—'}</td><td>{c.to}</td><td>{c.past && <span className="chip warn">already past</span>}{c.beforeDependency && <span className="chip warn">before “{c.beforeDependency}”</span>}</td></tr>)}</tbody></table>
              <button type="button" onClick={() => void run(() => api.call('applyDate', x.id))}>Apply the new dates</button>
              <button type="button" onClick={() => void run(() => api.call('rejectDate', x.id, 'Keeping the date.'))}>Keep the date</button>
            </div>
          ))}
          {v.proposals.filter((x) => x.state !== 'open').slice(-3).map((x) => <p key={x.id} className="muted small">{x.fromDate} to {x.newDate}: {x.state}{x.reason ? ` (${x.reason})` : ''}</p>)}
        </section>
      )}

      <section className="card" aria-label="Every item">
        <h4>Every item</h4>
        {(['Before the release', 'Release day', 'After the release'] as const).map((ph) => {
          const rows = v.items.filter((r) => phase(r) === ph);
          return rows.length === 0 ? null : <div key={ph}><h5>{ph}</h5><ul className="plain work-list">{rows.map((r) => <ItemRow key={r.view.item.id} r={r} v={v} run={run} />)}</ul></div>;
        })}
      </section>

      <Arc v={v} run={run} />
      <PlanRequests v={v} run={run} />
      <Review v={v} run={run} />
    </div>
  );
}

// ---- ARC ------------------------------------------------------------------------------------------------------------------------

function Arc({ v, run }: { v: PlanReady; run: Run }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [reviews, setReviews] = useState('');
  return (
    <section className="card" aria-label="ARC readers">
      <h4>ARC readers</h4>
      <p className="muted small">Cadrel keeps count; it does not send the file. No star rating is kept for any reader and nothing here asks for a favourable review: retailers do not allow an advance copy to depend on one.</p>
      {v.campaigns.map((k) => (
        <div key={k.id}>
          <p><strong>{k.name}</strong> <span className="chip">{k.counts.withFile} of {k.targetReaders || '—'} have the file</span> <span className="chip">{k.counts.reviewed} marked reviewed{k.reviewTarget ? ` of ${k.reviewTarget}` : ''}</span>
            {k.fileId && <span className="muted small"> file version {k.fileVersion}</span>}</p>
          <p className="small muted">Reviews the studio reports: {k.reportedReviews} (reported). Ratings counted on the book's page: {k.cross.measured?.ratings ?? 'not known'}{k.cross.measured ? ` (measured, captured ${day(k.cross.measured.capturedAt)})` : ''}.</p>
          {v.may.manage && <ReaderList campaignId={k.id} run={run} reported={k.reportedReviews} />}
        </div>
      ))}
      {v.may.manage && v.plan.state !== 'cancelled' && (
        <form className="row" aria-label="New ARC round" onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('createCampaign', { planId: v.plan.id, name, targetReaders: Number(target) || 0, reviewTarget: Number(reviews) || 0 })).then(() => (setName(''), setTarget(''), setReviews(''))); }}>
          <input aria-label="ARC round name" placeholder="First round" value={name} onChange={(ev) => setName(ev.target.value)} />
          <input aria-label="Readers wanted" type="number" min="0" placeholder="Readers wanted" value={target} onChange={(ev) => setTarget(ev.target.value)} />
          <input aria-label="Reviews hoped for" type="number" min="0" placeholder="Reviews hoped for" value={reviews} onChange={(ev) => setReviews(ev.target.value)} />
          <button type="submit" disabled={!name.trim()}>Start an ARC round</button>
        </form>
      )}
    </section>
  );
}

function ReaderList({ campaignId, run, reported }: { campaignId: string; run: Run; reported: number }) {
  const [list, setList] = useState<ArcReader[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [n, setN] = useState(String(reported));
  const [denied, setDenied] = useState<string | null>(null);
  const load = useCallback(() => api.readers(campaignId).then((r) => ('readers' in r ? (setList(r.readers), setDenied(null)) : setDenied(r.reason)), () => undefined), [campaignId]);
  if (denied) return <p className="muted small">{denied}</p>;
  if (!list) return <button type="button" onClick={() => void load()}>Show the readers (logged)</button>;
  const go = (job: () => Promise<unknown>) => run(job).then(() => load());
  return (
    <div>
      <ul className="plain">
        {list.map((r) => (
          <li key={r.id}>
            {r.erasedAt ? <span className="muted">(erased)</span> : <>{r.name} <span className="muted small">{r.email ?? ''}{r.source ? ` · ${r.source}` : ''}</span></>} <span className="chip">{READER_STATE[r.state]}</span>
            {!r.erasedAt && (
              <>
                <select aria-label={`State of ${r.name}`} value={r.state} onChange={(ev) => void go(() => api.call('setReader', r.id, ev.target.value))}>{Object.entries(READER_STATE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                <button type="button" onClick={() => void go(() => api.call('eraseReader', r.id))}>Erase their details</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form className="row" aria-label="Add a reader" onSubmit={(ev) => { ev.preventDefault(); void go(() => api.call('addReader', campaignId, { name, email: email || null })).then(() => (setName(''), setEmail(''))); }}>
        <input aria-label="Reader name" placeholder="Name" value={name} onChange={(ev) => setName(ev.target.value)} />
        <input aria-label="Reader email" placeholder="Email (optional)" value={email} onChange={(ev) => setEmail(ev.target.value)} />
        <button type="submit" disabled={!name.trim()}>Add a reader</button>
      </form>
      <form className="row" aria-label="Reviews reported" onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('reportReviews', campaignId, Number(n))); }}>
        <label className="small">Reviews posted, as the studio counts them <input aria-label="Reviews reported" type="number" min="0" value={n} onChange={(ev) => setN(ev.target.value)} /></label>
        <button type="submit">Save the count</button>
      </form>
    </div>
  );
}

// ---- requests to Art --------------------------------------------------------------------------------------------------------------

function PlanRequests({ v, run }: { v: PlanReady; run: Run }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('banner');
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [due, setDue] = useState('');
  return (
    <section className="card" aria-label="Art requests">
      <h4>Campaign art</h4>
      {v.requests.length === 0 && <p className="muted small">Nothing has been asked of Art for this launch.</p>}
      <ul className="plain">{v.requests.map((r) => <li key={r.request.id}>{r.request.title} <span className={`chip ${r.fulfilled ? 'ok' : ''}`}>{r.fulfilled ? 'delivered and approved' : r.request.state}</span> <span className="muted small">{r.reasons.join(' ')}{r.assigneeName ? ` · ${r.assigneeName}` : ''}</span></li>)}</ul>
      {v.may.manage && v.plan.state !== 'cancelled' && (
        <form className="row" aria-label="Ask Art" onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('ask', { projectId: v.plan.projectId, planId: v.plan.id, kind, title, due: due || null, spec: { width: Number(w) || undefined, height: Number(h) || undefined } })).then(() => setTitle('')); }}>
          <select aria-label="Request kind" value={kind} onChange={(ev) => setKind(ev.target.value)}>{['banner', 'ad', 'social', 'cover_variant', 'other'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
          <input aria-label="Request title" placeholder="Preorder banner" value={title} onChange={(ev) => setTitle(ev.target.value)} />
          <input aria-label="Width" type="number" min="1" placeholder="Width px" value={w} onChange={(ev) => setW(ev.target.value)} />
          <input aria-label="Height" type="number" min="1" placeholder="Height px" value={h} onChange={(ev) => setH(ev.target.value)} />
          <input aria-label="Due" type="date" value={due} onChange={(ev) => setDue(ev.target.value)} />
          <button type="submit" disabled={!title.trim()}>Ask Art</button>
        </form>
      )}
    </section>
  );
}

function RequestsTab({ s, act }: { s: Ready; act: Run }) {
  const [assets, setAssets] = useState<{ id: string; name: string; latest: number }[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  useEffect(() => {
    void window.cadrel.art.state(s.project.id).then((a) => a.available && setAssets(a.assets.filter((x) => x.state !== 'retired').map((x) => ({ id: x.id, name: x.name, latest: x.latestVersion }))), () => undefined);
  }, [s.project.id]);
  if (s.requests.length === 0) return <section className="card"><p className="muted">Nothing has been asked of Art for {s.project.name}.</p></section>;
  return (
    <section className="card" aria-label="Requests">
      <ul className="plain work-list">
        {s.requests.map((r) => {
          const chosen = pick[r.request.id] ?? (assets.length === 1 ? assets[0]!.id : '');
          const a = assets.find((x) => x.id === chosen);
          return (
            <li key={r.request.id}>
              <strong>{r.request.title}</strong> <span className={`chip ${r.fulfilled ? 'ok' : ''}`}>{r.fulfilled ? 'delivered and approved' : r.request.state}</span>
              <span className="muted small"> {r.projectName}{r.request.due ? ` · due ${r.request.due}` : ''}{r.assigneeName ? ` · ${r.assigneeName}` : ''}</span>
              {r.reasons.map((x) => <div key={x} className="small muted">{x}</div>)}
              {!r.fulfilled && r.request.state !== 'cancelled' && assets.length > 0 && (
                <span className="row">
                  {assets.length === 1 ? <span className="muted small">{assets[0]!.name}</span> : <select aria-label={`Asset for ${r.request.title}`} value={chosen} onChange={(ev) => setPick({ ...pick, [r.request.id]: ev.target.value })}><option value="">Asset…</option>{assets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
                  <button type="button" disabled={!a} onClick={() => void act(() => api.deliver(r.request.id, a!.id, a!.latest))}>Offer version {a?.latest ?? ''}</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- the review -------------------------------------------------------------------------------------------------------------------

function Review({ v, run }: { v: PlanReady; run: Run }) {
  const r = v.review;
  const [worked, setWorked] = useState(r?.worked ?? '');
  const [didNot, setDidNot] = useState(r?.didNot ?? '');
  const [next, setNext] = useState(r?.next ?? '');
  if (!r && !(v.may.manage && (v.plan.state === 'live' || v.plan.state === 'reviewed'))) return null;
  return (
    <section className="card" aria-label="Review">
      <h4>After the launch</h4>
      {!r ? <button type="button" onClick={() => void run(() => api.call('openReview', v.plan.id))}>Open the review</button> : (
        <>
          <table className="small"><thead><tr><th>Day</th><th>Captured</th><th>Rank</th><th>Price</th><th>Ratings</th></tr></thead>
            <tbody>{r.measured.map((m) => <tr key={m.day}><td>{m.day} ({m.due})</td><td>{m.figure ? day(m.figure.capturedAt) : <span className="muted">{m.missing}</span>}</td><td>{m.figure?.rank ?? '—'}</td><td>{money(m.figure?.price ?? null)}</td><td>{m.figure?.ratings ?? '—'}</td></tr>)}</tbody></table>
          <p className="muted small">Measured: from published captures, with their dates. Planned (kept apart): rank {r.planned.rank ?? '—'}, reviews {r.planned.reviews ?? '—'}, readers {r.planned.readers ?? '—'}.</p>
          {r.state === 'open' && v.may.manage ? (
            <form onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('writeReview', v.plan.id, { worked, didNot, next })); }}>
              <textarea aria-label="What worked" rows={2} placeholder="What worked" value={worked} onChange={(ev) => setWorked(ev.target.value)} style={{ width: '100%' }} />
              <textarea aria-label="What did not" rows={2} placeholder="What did not" value={didNot} onChange={(ev) => setDidNot(ev.target.value)} style={{ width: '100%' }} />
              <textarea aria-label="Next time" rows={2} placeholder="Next time" value={next} onChange={(ev) => setNext(ev.target.value)} style={{ width: '100%' }} />
              <button type="submit">Save</button>
              <button type="button" onClick={() => void run(() => api.call('refreshReview', v.plan.id))}>Fill in later days</button>
              <button type="button" onClick={() => void run(() => api.call('finishReview', v.plan.id))}>Close the review</button>
            </form>
          ) : <div><p><strong>Worked:</strong> {r.worked}</p><p><strong>Did not:</strong> {r.didNot}</p><p><strong>Next time:</strong> {r.next}</p></div>}
        </>
      )}
    </section>
  );
}

// ---- briefs and comps ----------------------------------------------------------------------------------------------------------------

function BriefsTab({ s, act, onOpen }: { s: Ready; act: Run; onOpen: (id: string) => void }) {
  const [kind, setKind] = useState<'launch' | 'campaign'>('launch');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <>
      {s.may.manage && (
        <form className="card" aria-label="New marketing brief" onSubmit={(ev) => { ev.preventDefault(); void act(() => api.call('createBrief', { projectId: s.project.id, kind, title, body })).then((ok) => ok && (setTitle(''), setBody(''))); }}>
          <h4>A new brief</h4>
          <div className="row">
            <select aria-label="Brief kind" value={kind} onChange={(ev) => setKind(ev.target.value as 'launch' | 'campaign')}><option value="launch">Marketing brief</option><option value="campaign">Campaign brief</option></select>
            <input aria-label="Brief title" placeholder="Launch brief for Book Four" value={title} onChange={(ev) => setTitle(ev.target.value)} />
          </div>
          <textarea aria-label="Brief" rows={4} placeholder="Who it is for, what it promises, what it stands against" value={body} onChange={(ev) => setBody(ev.target.value)} style={{ width: '100%' }} />
          <button type="submit" disabled={!title.trim() || !body.trim()}>Write the brief</button>
        </form>
      )}
      {s.briefs.length === 0 ? <section className="card"><p className="muted">No marketing brief for {s.project.name} yet.</p></section> : (
        <section className="card" aria-label="Briefs"><ul className="plain work-list">
          {s.briefs.map((b) => <li key={b.id}><button type="button" className="link" onClick={() => onOpen(b.id)}>{b.title}</button> <span className="chip">{b.kind === 'launch' ? 'Marketing brief' : 'Campaign brief'}</span> <span className="muted small">version {b.version} · {plural(b.comps, 'comp')}</span></li>)}
        </ul></section>
      )}
    </>
  );
}

function BriefDetail({ id, onBack, act }: { id: string; onBack: () => void; act: Run }) {
  const [v, setV] = useState<LaunchBriefView | null>(null);
  const reload = useCallback(() => api.brief(id).then(setV, () => undefined), [id]);
  useEffect(() => void reload(), [reload]);
  if (!v) return <p className="muted">Loading…</p>;
  if (!v.available) return <section className="card"><button type="button" className="link" onClick={onBack}>Back</button><p className="muted">{v.reason}</p></section>;
  const run: Run = async (job) => {
    const ok = await act(job);
    await reload();
    return ok;
  };
  return <BriefBody v={v} onBack={onBack} run={run} />;
}

function BriefBody({ v, onBack, run }: { v: BriefReady; onBack: () => void; run: Run }) {
  const [body, setBody] = useState(v.brief.body);
  const [note, setNote] = useState('');
  const [asins, setAsins] = useState(v.comps.map((c) => c.asin).join(' '));
  return (
    <div className="brief">
      <button type="button" className="link" onClick={onBack}>← All briefs</button>
      <div className="row"><h3 style={{ margin: 0 }}>{v.brief.title}</h3> <span className="chip">version {v.brief.version}</span> <span className="muted small">{v.brief.writtenByName}, {day(v.brief.writtenAt)}</span></div>
      {v.may.manage ? (
        <form aria-label="Revise the brief" onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('reviseBrief', v.brief.id, { body, note, basedOn: v.brief.version })).then(() => setNote('')); }}>
          <textarea aria-label="Brief" rows={6} value={body} onChange={(ev) => setBody(ev.target.value)} style={{ width: '100%' }} />
          <div className="row"><input aria-label="What changed" placeholder="What changed" value={note} onChange={(ev) => setNote(ev.target.value)} /><button type="submit" disabled={body.trim() === v.brief.body.trim()}>Save as version {v.brief.version + 1}</button></div>
        </form>
      ) : <p style={{ whiteSpace: 'pre-wrap' }}>{v.brief.body}</p>}
      <section className="card" aria-label="Comps">
        <h4>Comps this brief was written against</h4>
        <p className="muted small">The figures are as of each capture date, kept with this version of the brief. Newer captures do not change them.</p>
        {v.comps.length === 0 && <p className="muted small">No comps pinned yet.</p>}
        <ul className="plain">
          {v.comps.map((c) => (
            <li key={c.asin}>
              <strong>{c.figure?.title || c.asin}</strong> <span className="muted small">{c.asin} · {c.role}</span>{' '}
              {c.figure ? <span className="small">rank {c.figure.rank ?? '—'}, price {money(c.figure.price)}, {c.figure.ratings ?? '—'} ratings; captured {day(c.figure.capturedAt)} ({plural(c.ageDays ?? 0, 'day')} before today)</span> : <span className="chip warn">no figure published</span>}
              {v.newer.includes(c.asin) && <span className="chip">newer figure exists</span>}
            </li>
          ))}
        </ul>
        {v.may.manage && (
          <form className="row" aria-label="Pin comps" onSubmit={(ev) => { ev.preventDefault(); void run(() => api.call('pinComps', v.brief.id, v.brief.version, asins.split(/[\s,]+/).filter(Boolean).map((a) => ({ asin: a })))); }}>
            <input aria-label="ASINs" placeholder="ASINs, separated by spaces" value={asins} onChange={(ev) => setAsins(ev.target.value)} style={{ minWidth: 280 }} />
            <button type="submit">{v.newer.length ? 'Pin the newer figures' : 'Pin these comps'}</button>
          </form>
        )}
      </section>
      {v.versions.length > 1 && <details><summary>Earlier versions ({v.versions.length - 1})</summary>{v.versions.slice(1).map((x) => <div key={x.n}><p className="muted small">Version {x.n}, {x.writtenByName}, {day(x.writtenAt)}{x.note ? `: ${x.note}` : ''}</p><p style={{ whiteSpace: 'pre-wrap' }}>{x.body}</p></div>)}</details>}
    </div>
  );
}

// ---- market ---------------------------------------------------------------------------------------------------------------------------

function MarketTab({ project }: { project: string | undefined }) {
  const [v, setV] = useState<LaunchMarketView | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, DecisionWindow | { available: false; reason: string }>>({});
  const reload = useCallback(() => api.market(project).then(setV, () => undefined), [project]);
  useEffect(() => void reload(), [reload]);
  if (!v) return <p className="muted">Loading…</p>;
  if (!v.available) return <section className="card"><p className="muted">{v.reason}</p></section>;
  const m: MarketReady = v;
  const act = async (job: () => Promise<unknown>) => {
    setError(null);
    try {
      await job();
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div>
      {error && <div className="banner error" role="alert">{error}</div>}
      <section className="card" aria-label="Figures">
        <h4>Figures in the Studio</h4>
        <p className="muted small">Compact, dated figures published from a computer's Market library. They are what plans, briefs and reviews quote; the captured pages stay where they were captured.</p>
        <ul className="plain">
          {m.editions.map((e) => <li key={e.id}>{e.label}: {e.latest ? <span className="small">rank {e.latest.rank ?? '—'}, price {money(e.latest.price)}, {e.latest.ratings ?? '—'} ratings; newest capture {day(e.latest.capturedAt)}; {plural(e.figures, 'figure')}</span> : <span className="muted small">no figures published</span>}</li>)}
          {m.editions.length === 0 && <li className="muted small">No edition of a book in {m.project.name} is linked to it in the catalogue.</li>}
        </ul>
        {m.may.capture && (
          <button type="button" onClick={() => void api.publishFigures(project).then((r) => (setInfo('added' in r ? `Published ${plural(r.added, 'new figure')} for ${plural(r.books, 'book')} (${r.skipped} already there).` : r.reason), reload()), (e) => setError(message(e)))}>Publish from this computer</button>
        )}
        {info && <p className="small" role="status">{info}</p>}
      </section>
      <section className="card" aria-label="Changes made">
        <h4>Changes to cover, blurb, keywords and price</h4>
        {m.decisions.length === 0 && <p className="muted small">No change recorded.</p>}
        <ul className="plain work-list">
          {m.decisions.map((d) => {
            const w = shown[d.id];
            return (
              <li key={d.id}>
                <strong>{d.kind}</strong> {d.editionLabel} <span className="muted small">{day(d.decidedAt)} · {d.byName}</span>
                <div className="small">{d.fromValue ? `${d.fromValue} → ` : ''}{d.toValue} — {d.reason}</div>
                <button type="button" onClick={() => void api.decisionWindow(d.id, 30).then((r) => setShown({ ...shown, [d.id]: r }))}>What the figures did around it</button>
                {w && 'available' in w && <p className="muted small">{w.reason}</p>}
                {w && 'before' in w && (
                  <div className="small">
                    <div>Before: {plural(w.before.points.length, 'figure')}, middle rank {w.before.median.rank ?? '—'}, middle price {money(w.before.median.price)}. After: {plural(w.after.points.length, 'figure')}, middle rank {w.after.median.rank ?? '—'}, middle price {money(w.after.median.price)}.</div>
                    {w.alsoChanged.length > 0 && <div>Also changed in the same {w.days} days: {w.alsoChanged.map((o) => `${o.kind} (${day(o.decidedAt)})`).join(', ')}.</div>}
                    {w.caveats.map((c) => <div key={c} className="muted">{c}</div>)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {m.may.manage && m.editions.length > 0 && <DecisionForm m={m} act={act} />}
      </section>
      <section className="card" aria-label="Reports">
        <h4>Saved reports and comp sets</h4>
        <ul className="plain">{m.reports.map((r) => <li key={r.id}>{r.title} <span className="muted small">{r.kind.replace('_', ' / ')} · as of {r.asOf}</span></li>)}{m.compSets.map((c) => <li key={c.id}>{c.name} <span className="muted small">{plural(c.asins.length, 'book')}</span></li>)}</ul>
        {m.reports.length + m.compSets.length === 0 && <p className="muted small">None yet. Your assistant can compile a report and save it here.</p>}
      </section>
    </div>
  );
}

function DecisionForm({ m, act }: { m: MarketReady; act: (j: () => Promise<unknown>) => Promise<void> }) {
  const [edition, setEdition] = useState('');
  const [kind, setKind] = useState('cover');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const e = m.editions.some((x) => x.id === edition) ? edition : m.editions.length === 1 ? m.editions[0]!.id : '';
  const ed = m.editions.find((x) => x.id === e);
  return (
    <form className="row" aria-label="Record a change" onSubmit={(ev) => { ev.preventDefault(); void act(() => api.call('decide', { editionId: e, asin: ed?.asin ?? null, kind, from, to, reason, projectId: m.project.id })).then(() => (setFrom(''), setTo(''), setReason(''))); }}>
      {m.editions.length > 1 && <select aria-label="Edition changed" value={e} onChange={(ev) => setEdition(ev.target.value)}><option value="">Edition…</option>{m.editions.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>}
      <select aria-label="What changed" value={kind} onChange={(ev) => setKind(ev.target.value)}>{['cover', 'blurb', 'keywords', 'price', 'category', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}</select>
      <input aria-label="Changed from" placeholder="From" value={from} onChange={(ev) => setFrom(ev.target.value)} />
      <input aria-label="Changed to" placeholder="To" value={to} onChange={(ev) => setTo(ev.target.value)} />
      <input aria-label="Why it changed" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} />
      <button type="submit" disabled={!e || !reason.trim()}>Record the change</button>
    </form>
  );
}
