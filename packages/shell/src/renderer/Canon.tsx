import { useCallback, useEffect, useState } from 'react';
import type { CanonEntryRow, CanonFactRow, CanonProposalRow, CanonState, ContinuityCheckRow, ContinuityCheckView, ContinuityState, FindingView, StudioState } from '../shared/api';

const canon = window.cadrel.canon;
const continuity = window.cadrel.continuity;
type Ready = Extract<CanonState, { available: true }>;
type CheckReady = Extract<ContinuityCheckView, { available: true }>;

const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const KINDS = ['character', 'place', 'rule', 'event', 'term'] as const;
const KIND_NAME: Record<string, string> = { character: 'Character', place: 'Place', rule: 'Rule', event: 'Event', term: 'Term' };
const SEVERITY: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const FINDING_STATE: Record<string, string> = { open: 'Open', fixed: 'Fixed', accepted_as_canon: 'Accepted as canon', dismissed: 'Dismissed' };
const CHECK_STATE: Record<string, string> = { open: 'The assistant is checking', delivered: 'Waiting for decisions', closed: 'Closed' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Props {
  /** Changes elsewhere (a stage move, a task) reload the page. */
  studio: StudioState | null;
  onProject: (id: string) => void;
}

/** A series' canon, the proposals waiting on someone, and the continuity checks of its books. Everything is a request the Studio decides. */
export function CanonPage({ studio, onProject }: Props) {
  const [state, setState] = useState<CanonState | null>(null);
  const [series, setSeries] = useState<string | undefined>();
  const [tab, setTab] = useState<'canon' | 'proposals' | 'continuity'>('canon');
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => canon.state(series).then((s) => (setState(s), setError(null)), (e) => setError(message(e))), [series]);
  useEffect(() => {
    void reload();
  }, [reload, studio]);

  if (error && !state) return <div className="banner error" role="alert">{error}</div>;
  if (!state) return <p className="muted">Loading…</p>;
  if (!state.available) return <section className="card"><p className="muted">{state.reason}</p></section>;
  const open = state.proposals.filter((p) => p.state === 'open');
  /** Runs a change, then shows the Studio as it is now. A refusal is shown in the Studio's own words. */
  const act = async (job: () => Promise<unknown>) => {
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
    <div className="canon">
      <div className="row">
        <h2 style={{ margin: 0 }}>Canon</h2>
        {state.series.length > 1 ? (
          <select aria-label="Series" value={state.current.id} onChange={(e) => setSeries(e.target.value)}>
            {state.series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <span className="chip">{state.current.name}</span>
        )}
        {state.waitingOnMe > 0 && <span className="chip warn" title="Proposals you may approve, in every series">{state.waitingOnMe} waiting on you</span>}
      </div>
      <p className="muted small">What the series has agreed about its characters, places, rules, events and terms. Nothing becomes canon until someone who may approve it does; every fact says where it was established.</p>
      <div className="tabs" role="tablist" aria-label="Canon">
        {([['canon', `Canon (${state.entries.length})`], ['proposals', open.length ? `Proposals (${open.length})` : 'Proposals'], ['continuity', 'Continuity checks']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {tab === 'canon' && <CanonTab s={state} act={act} />}
      {tab === 'proposals' && <ProposalsTab s={state} act={act} />}
      {tab === 'continuity' && <ContinuityTab onProject={onProject} onCanon={reload} studio={studio} />}
    </div>
  );
}

type Act = (job: () => Promise<unknown>) => Promise<boolean>;

// ---- canon --------------------------------------------------------------------------------------------------------------------

function CanonTab({ s, act }: { s: Ready; act: Act }) {
  const [kind, setKind] = useState<string>('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const shown = s.entries.filter((e) => (!kind || e.kind === kind) && (!q.trim() || [e.name, e.summary, ...e.aliases, ...e.facts.map((f) => f.text)].some((t) => t.toLowerCase().includes(q.trim().toLowerCase()))));
  // someone who may approve changes canon in one step; anyone else asks
  const verb = s.may.approve ? 'Add to canon' : 'Propose';
  const send = (change: unknown) => act(() => (s.may.approve ? canon.call('apply', s.current.id, change) : canon.call('propose', s.current.id, change)));
  return (
    <>
      <div className="row">
        <input type="search" aria-label="Search canon" placeholder="Search names, aliases and facts" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}
        </select>
        {s.may.propose && <button type="button" className="primary" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : s.may.approve ? 'Add an entry…' : 'Propose an entry…'}</button>}
      </div>
      {adding && <EntryForm verb={verb} onSend={async (c) => { if (await send(c)) setAdding(false); }} />}
      {!s.may.propose && <p className="muted small">You can read this series' canon. Proposing changes needs the right to propose canon on one of its books.</p>}
      {s.entries.length === 0 && <section className="card"><p className="muted">No canon yet. {s.may.propose ? 'Add the first entry, or ask your assistant to propose canon from the series’ tracker ledgers (canon_seed).' : ''}</p></section>}
      {shown.map((e) => <Entry key={e.id} e={e} s={s} verb={verb} send={send} />)}
    </>
  );
}

function EntryForm({ verb, onSend }: { verb: string; onSend: (change: unknown) => void }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>('character');
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [summary, setSummary] = useState('');
  return (
    <form className="card" onSubmit={(ev) => { ev.preventDefault(); onSend({ change: 'add_entry', kind, name, aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean), summary }); }}>
      <div className="row">
        <select aria-label="Kind of entry" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}</select>
        <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Aliases" placeholder="Other names, separated by commas" value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </div>
      <textarea aria-label="Summary" placeholder="A short summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      <div className="row"><button type="submit" className="primary" disabled={!name.trim() || !summary.trim()}>{verb}</button></div>
    </form>
  );
}

function Entry({ e, s, verb, send }: { e: CanonEntryRow; s: Ready; verb: string; send: (c: unknown) => Promise<boolean> }) {
  const [mode, setMode] = useState<'fact' | 'edit' | 'retire' | null>(null);
  const [text, setText] = useState('');
  const [book, setBook] = useState('');
  const [chapter, setChapter] = useState('');
  const [summary, setSummary] = useState(e.summary);
  const [reason, setReason] = useState('');
  const done = async (ok: Promise<boolean>) => {
    if (await ok) (setMode(null), setText(''), setChapter(''), setReason(''));
  };
  return (
    <section className="card" aria-label={e.name}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{e.name}</h3> <span className="chip">{KIND_NAME[e.kind]}</span>
        {e.aliases.length > 0 && <span className="muted small">also {e.aliases.join(', ')}</span>}
        {e.pending > 0 && <span className="chip warn" title="Proposals waiting for approval">{plural(e.pending, 'proposal')} waiting</span>}
      </div>
      {mode === 'edit' ? (
        <>
          <textarea aria-label="Summary" rows={3} value={summary} onChange={(ev) => setSummary(ev.target.value)} />
          <div className="row">
            <button type="button" className="primary" disabled={!summary.trim() || summary.trim() === e.summary} onClick={() => void done(send({ change: 'edit_entry', entryId: e.id, summary, basedOn: e.version }))}>{verb}</button>
            <button type="button" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </>
      ) : (
        <p>{e.summary}</p>
      )}
      <ul className="plain work-list">
        {e.facts.map((f) => <FactRow key={f.id} f={f} s={s} send={send} />)}
        {e.facts.length === 0 && <li className="muted small">No facts yet.</li>}
      </ul>
      {mode === 'fact' && (
        <form onSubmit={(ev) => { ev.preventDefault(); void done(send({ change: 'add_fact', entryId: e.id, text, bookProjectId: book || null, chapter: chapter ? Number(chapter) : null })); }}>
          <input aria-label="The fact" placeholder="A fact about it, in one sentence" value={text} onChange={(ev) => setText(ev.target.value)} style={{ width: '100%' }} />
          <div className="row">
            <select aria-label="Established in" value={book} onChange={(ev) => setBook(ev.target.value)}><option value="">Established in…</option>{s.books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <input aria-label="Chapter" type="number" min={1} placeholder="Chapter" value={chapter} onChange={(ev) => setChapter(ev.target.value)} style={{ width: '6rem' }} />
            <button type="submit" className="primary" disabled={!text.trim()}>{verb}</button>
            <button type="button" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      )}
      {mode === 'retire' && (
        <div className="row">
          <input aria-label="Why retire it" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} />
          <button type="button" className="danger" disabled={!reason.trim()} onClick={() => void done(send({ change: 'retire_entry', entryId: e.id, reason }))}>{s.may.approve ? 'Retire it' : 'Propose retiring it'}</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {s.may.propose && !mode && (
        <div className="row">
          <button type="button" onClick={() => setMode('fact')}>Add a fact…</button>
          <button type="button" className="quiet" onClick={() => setMode('edit')}>Revise the summary…</button>
          <button type="button" className="quiet" onClick={() => setMode('retire')}>Retire…</button>
        </div>
      )}
    </section>
  );
}

function FactRow({ f, s, send }: { f: CanonFactRow; s: Ready; send: (c: unknown) => Promise<boolean> }) {
  const [mode, setMode] = useState<'replace' | 'retire' | null>(null);
  const [text, setText] = useState(f.text);
  const [reason, setReason] = useState('');
  return (
    <li>
      <span>{f.text}</span>
      {f.established && <span className="muted small"> · {f.established}</span>}
      {f.source && <span className="muted small"> · “{f.source.anchor.quote.length > 60 ? `${f.source.anchor.quote.slice(0, 59)}…` : f.source.anchor.quote}” in {f.sourcePath ?? 'a file that is no longer in the vault'}, version {f.source.version}</span>}
      {s.may.propose && !mode && (
        <>
          {' '}<button type="button" className="link" onClick={() => setMode('replace')}>Replace</button>
          {' '}<button type="button" className="link" onClick={() => setMode('retire')}>Retire</button>
        </>
      )}
      {mode === 'replace' && (
        <div className="row">
          <input aria-label="The new fact" value={text} onChange={(ev) => setText(ev.target.value)} style={{ width: '60%' }} />
          <button type="button" className="primary" disabled={!text.trim() || text.trim() === f.text} onClick={async () => { if (await send({ change: 'supersede_fact', factId: f.id, text })) setMode(null); }}>{s.may.approve ? 'Replace' : 'Propose'}</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === 'retire' && (
        <div className="row">
          <input aria-label="Why retire it" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} />
          <button type="button" className="danger" disabled={!reason.trim()} onClick={async () => { if (await send({ change: 'retire_fact', factId: f.id, reason })) setMode(null); }}>{s.may.approve ? 'Retire' : 'Propose'}</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
    </li>
  );
}

// ---- proposals ----------------------------------------------------------------------------------------------------------------

function ProposalsTab({ s, act }: { s: Ready; act: Act }) {
  const open = s.proposals.filter((p) => p.state === 'open');
  const decided = s.proposals.filter((p) => p.state !== 'open');
  return (
    <>
      <section className="card" aria-label="Open proposals">
        <h3>Waiting for approval <span className="chip">{open.length}</span></h3>
        {open.length === 0 && <p className="muted small">Nothing is waiting.</p>}
        <ul className="plain work-list">{open.map((p) => <Proposal key={p.id} p={p} s={s} act={act} />)}</ul>
      </section>
      {decided.length > 0 && (
        <section className="card" aria-label="Decided proposals">
          <h3>Decided</h3>
          <ul className="plain work-list">{decided.map((p) => <Proposal key={p.id} p={p} s={s} act={act} />)}</ul>
        </section>
      )}
    </>
  );
}

function Proposal({ p, s, act }: { p: CanonProposalRow; s: Ready; act: Act }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <li>
      <span>{p.summary}</span>{' '}
      <span className="muted small">by {p.proposerName}{p.fromFinding ? ' from a continuity finding' : ''}</span>
      {p.state !== 'open' && <span className="chip">{p.state}</span>}
      {p.reason && <span className="muted small"> · {p.reason}</span>}
      {p.state === 'open' && (
        <>
          {s.may.approve && <> <button type="button" className="primary" onClick={() => void act(() => canon.call('approve', p.id))}>Approve</button> <button type="button" onClick={() => setRejecting(!rejecting)}>Reject…</button></>}
          {(p.proposedBy === s.me || s.may.approve) && <> <button type="button" className="link" onClick={() => void act(() => canon.call('withdraw', p.id))}>Withdraw</button></>}
        </>
      )}
      {rejecting && (
        <div className="row">
          <input aria-label="Why reject it" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} />
          <button type="button" className="danger" disabled={!reason.trim()} onClick={async () => { if (await act(() => canon.call('reject', p.id, reason))) setRejecting(false); }}>Reject</button>
        </div>
      )}
    </li>
  );
}

// ---- continuity ---------------------------------------------------------------------------------------------------------------

function ContinuityTab({ onProject, onCanon, studio }: { onProject: (id: string) => void; onCanon: () => Promise<unknown>; studio: StudioState | null }) {
  const [state, setState] = useState<ContinuityState | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [book, setBook] = useState('');
  const [file, setFile] = useState('');
  const reload = useCallback(() => continuity.state().then((s) => (setState(s), setError(null)), (e) => setError(message(e))), []);
  useEffect(() => {
    void reload();
  }, [reload, studio]);
  if (error && !state) return <div className="banner error" role="alert">{error}</div>;
  if (!state) return <p className="muted">Loading…</p>;
  if (!state.available) return <section className="card"><p className="muted">{state.reason}</p></section>;
  if (open) return <CheckView id={open} onBack={() => (setOpen(null), void reload())} onProject={onProject} onCanon={onCanon} />;
  const live = state.checks.filter((c) => c.state !== 'closed');
  const closed = state.checks.filter((c) => c.state === 'closed');
  return (
    <>
      {error && <div className="banner error" role="alert">{error}</div>}
      <p className="muted small">A check reads one book's manuscript, at an exact version, against the series' canon. Your assistant does the reading (ask it for a continuity check); every finding quotes the passage and cites the canon fact it conflicts with, and you decide each one.</p>
      {state.may.start && (
        <form className="row" onSubmit={async (ev) => { ev.preventDefault(); try { const k = (await continuity.call('start', book, file)) as { id: string }; await reload(); setOpen(k.id); } catch (e) { setError(message(e)); } }}>
          <select aria-label="Book" value={book} onChange={(ev) => setBook(ev.target.value)}><option value="">Book…</option>{state.books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <select aria-label="Manuscript" value={file} onChange={(ev) => setFile(ev.target.value)}><option value="">Manuscript…</option>{state.manuscripts.map((f) => <option key={f.fileId} value={f.fileId}>{f.path} (version {f.version})</option>)}</select>
          <button type="submit" disabled={!book || !file}>Start a check</button>
        </form>
      )}
      {state.checks.length === 0 && <section className="card"><p className="muted">No continuity checks yet.</p></section>}
      {live.length > 0 && <CheckList title="Under way" rows={live} onOpen={setOpen} />}
      {closed.length > 0 && <CheckList title="Closed" rows={closed} onOpen={setOpen} />}
    </>
  );
}

function CheckList({ title, rows, onOpen }: { title: string; rows: ContinuityCheckRow[]; onOpen: (id: string) => void }) {
  return (
    <section className="card" aria-label={title}>
      <h3>{title} <span className="chip">{rows.length}</span></h3>
      <ul className="plain work-list">
        {rows.map((k) => (
          <li key={k.id}>
            <button type="button" className="link" onClick={() => onOpen(k.id)}>{k.projectName}</button> <span className="muted small">{k.filePath ?? 'a file'} · version {k.fileVersion} · run by {k.runByName}</span>{' '}
            <span className="chip">{CHECK_STATE[k.state]}</span>
            {k.counts.open > 0 && <span className="chip warn">{plural(k.counts.open, 'open finding')}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckView({ id, onBack, onProject, onCanon }: { id: string; onBack: () => void; onProject: (id: string) => void; onCanon: () => Promise<unknown> }) {
  const [v, setV] = useState<ContinuityCheckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(() => continuity.check(id).then((s) => (setV(s), setError(null)), (e) => setError(message(e))), [id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (!v) return error ? <div className="banner error" role="alert">{error}</div> : <p className="muted">Loading…</p>;
  if (!v.available) return <section className="card"><button type="button" className="link" onClick={onBack}>← All checks</button><p className="muted">{v.reason}</p></section>;
  const k = v.check;
  const act = async (job: () => Promise<unknown>, ok?: (r: unknown) => string | null) => {
    setError(null);
    setNote(null);
    try {
      const r = await job();
      setNote(ok ? ok(r) : null);
      await reload();
      await onCanon();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  };
  return (
    <div>
      <button type="button" className="link" onClick={onBack}>← All checks</button>
      <section className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}><button type="button" className="link" onClick={() => onProject(k.projectId)}>{k.projectName}</button></h3>
          <span className="chip">{CHECK_STATE[k.state]}</span>
        </div>
        <p className="muted small">{k.filePath ?? 'a file'} · version {k.fileVersion} · canon as of {k.canonStamp ? k.canonStamp.slice(0, 10) : 'before any canon'} · run by {k.runByName}</p>
        <p className="small">{plural(k.counts.open, 'open finding')}, {k.counts.fixed} fixed, {k.counts.accepted_as_canon} accepted as canon, {k.counts.dismissed} dismissed.</p>
        <div className="row">
          {k.state === 'open' && v.may.deliver && <button type="button" onClick={() => void act(() => continuity.call('deliver', k.id))} title="No more findings can be added">Hand it over for decisions</button>}
          {k.state !== 'closed' && v.newerVersion !== null && v.may.decide && (
            <button type="button" onClick={() => void act(() => continuity.call('verify', k.id, v.newerVersion), (r) => { const x = r as { fixed: unknown[]; remaining: unknown[] }; return `Checked against version ${v.newerVersion}: ${plural(x.fixed.length, 'finding')} fixed, ${x.remaining.length} still there.`; })}>Re-check version {v.newerVersion}</button>
          )}
          {k.state === 'delivered' && v.may.close && <button type="button" className="primary" disabled={k.counts.open > 0} title={k.counts.open > 0 ? 'Decide every finding first' : ''} onClick={() => void act(() => continuity.call('close', k.id))}>Close the check</button>}
        </div>
      </section>
      {error && <div className="banner error" role="alert">{error}</div>}
      {note && <div className="banner info" role="status">{note}</div>}
      {v.findings.length === 0 && <section className="card"><p className="muted">{k.state === 'open' ? 'No findings yet. Ask your assistant to run the check.' : 'The check found nothing.'}</p></section>}
      {v.findings.map((f) => <Finding key={f.id} f={f} v={v} act={act} />)}
    </div>
  );
}

function Finding({ f, v, act }: { f: FindingView; v: CheckReady; act: (job: () => Promise<unknown>, ok?: (r: unknown) => string | null) => Promise<boolean> }) {
  const [mode, setMode] = useState<'dismiss' | 'accept' | null>(null);
  const [reason, setReason] = useState('');
  const [factId, setFactId] = useState(f.facts.find((x) => x.status === 'canon')?.id ?? '');
  const [text, setText] = useState('');
  const k = v.check;
  const decidable = v.may.decide && k.state === 'delivered' && f.state === 'open';
  return (
    <section className="card" aria-label={`Finding ${f.seq}`}>
      <div className="row">
        <strong>{f.seq}.</strong> <span className="chip">{f.kind}</span> <span className={`chip${f.severity === 'high' ? ' warn' : ''}`}>{SEVERITY[f.severity]} severity</span> <span className="chip">{SEVERITY[f.confidence]} confidence</span>
        <span className="chip">{FINDING_STATE[f.state]}</span>
      </div>
      <p>{f.body}</p>
      <blockquote className="small" style={{ margin: '6px 0', paddingLeft: 10, borderLeft: '3px solid var(--accent)' }}>
        {f.context && <span className="muted">{f.context.before}</span>}<mark>{f.anchor.quote}</mark>{f.context && <span className="muted">{f.context.after}</span>}
      </blockquote>
      <ul className="plain work-list">
        {f.facts.map((x) => (
          <li key={x.id}>
            <span className="chip">canon</span> <strong>{x.entry}</strong>: {x.text}{x.status === 'retired' ? <span className="muted"> (since retired)</span> : null}
            {x.established && <span className="muted small"> · {x.established}</span>}
            {x.passage && <span className="muted small"> · “{x.passage}”{x.sourcePath ? ` in ${x.sourcePath}` : ''}</span>}
          </li>
        ))}
      </ul>
      {f.response && <p className="small muted">{f.state === 'dismissed' ? 'Dismissed: ' : ''}{f.response}</p>}
      {f.fixedInVersion !== null && <p className="small muted">No longer in version {f.fixedInVersion}.</p>}
      {f.proposal && <p className="small muted">A canon change was proposed from this ({f.proposal.state}): {f.proposal.summary}</p>}
      {decidable && !mode && (
        <div className="row">
          <button type="button" onClick={() => setMode('dismiss')}>Dismiss…</button>
          <button type="button" onClick={() => (setText(f.anchor.quote), setMode('accept'))} title="The manuscript is right: propose changing canon to match it">The manuscript is right…</button>
        </div>
      )}
      {mode === 'dismiss' && (
        <div className="row">
          <input aria-label="Why dismiss it" placeholder="Why this is not a problem" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '60%' }} />
          <button type="button" className="danger" disabled={!reason.trim()} onClick={() => void act(() => continuity.call('decide', f.id, { outcome: 'dismiss', reason }))}>Dismiss</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {mode === 'accept' && (
        <div>
          <p className="small muted">This proposes a canon change; the series' approvers decide it. Choose the fact it replaces and say what canon should now say.</p>
          <div className="row">
            <select aria-label="Fact to replace" value={factId} onChange={(e) => setFactId(e.target.value)}>
              {f.facts.filter((x) => x.status === 'canon').map((x) => <option key={x.id} value={x.id}>{x.entry}: {x.text.length > 60 ? `${x.text.slice(0, 59)}…` : x.text}</option>)}
            </select>
          </div>
          <input aria-label="What canon should say" value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%' }} />
          <div className="row">
            <button type="button" className="primary" disabled={!factId || !text.trim()} onClick={() => void act(() => continuity.call('decide', f.id, { outcome: 'accept_as_canon', change: { change: 'supersede_fact', factId, text, source: { fileId: k.fileId, version: k.fileVersion, anchor: f.anchor }, bookProjectId: k.projectId, chapter: null } }))}>Propose the change</button>
            <button type="button" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

