import { useCallback, useEffect, useState } from 'react';
import { useScope } from './useScope';
import type { PackInfo, PreflightRunView, PreflightState, StudioState } from '../shared/api';

const api = window.cadrel.preflight;
type Ready = Extract<PreflightState, { available: true }>;
type RunReady = Extract<PreflightRunView, { available: true }>;

const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const GRADE_NAME: Record<string, string> = { error: 'Errors', warning: 'Warnings', suggestion: 'Suggestions' };
const GRADE_HELP: Record<string, string> = { error: 'The retailer will reject it, or the file is broken.', warning: 'Accepted, but likely a problem.', suggestion: 'Better practice.' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => iso.slice(0, 10);
/** Limits older than this many months are shown as possibly out of date. */
const STALE_MONTHS = 6;

interface Props {
  /** Changes elsewhere reload the page. */
  studio: StudioState | null;
}

/** An EPUB checked before it is uploaded: the book's records and approved cover against its file, with each result graded and what was measured. */
export function PreflightPage({ studio }: Props) {
  // follows the project in view, like the other pages; its own EPUBs and editions are all it offers
  const scope = useScope();
  const project = scope?.book ?? scope?.project ?? undefined;
  const [state, setState] = useState<PreflightState | null>(null);
  const [file, setFile] = useState('');
  const [edition, setEdition] = useState('');
  const [view, setView] = useState<PreflightRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api.state(project).then((s) => (setState(s), setError(null)), (e) => setError(message(e))), [project]);
  useEffect(() => {
    setState(null);
    setView(null);
    setFile('');
    setEdition('');
  }, [project]);
  useEffect(() => {
    if (scope) void reload();
  }, [reload, studio, scope]);

  const ready = state && state.available ? state : null;
  const chosenFile = ready ? (ready.files.some((f) => f.fileId === file) ? file : ready.files.length === 1 ? ready.files[0]!.fileId : '') : '';
  const chosenEdition = ready ? (ready.editions.some((e) => e.id === edition) ? edition : ready.editions.length === 1 ? ready.editions[0]!.id : '') : '';
  // the latest run on the chosen file is shown until a new one is made
  const latest = ready?.files.find((f) => f.fileId === chosenFile)?.latest ?? null;
  useEffect(() => {
    setView(null);
    if (latest) void api.get(latest.id).then(setView, () => undefined);
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !state) return <div className="banner error" role="alert">{error}</div>;
  if (!scope || !state) return <p className="muted">Loading…</p>;
  if (!state.available) return <section className="card"><p className="muted">{state.reason}</p></section>;
  const s = state;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api.run(chosenFile, chosenEdition || null);
      setView(v);
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const waive = async (runId: string, seq: number, reason: string) => {
    try {
      setView(await api.waive(runId, seq, reason));
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className="preflight">
      <div className="row"><h2 style={{ margin: 0 }}>Preflight</h2><span className="chip" title="The project in view">{s.project.name}</span></div>
      <p className="muted small">Checks an EPUB before it is uploaded: its structure, its navigation, its names against the catalogue, its cover against the approved cover and the retailer's limits. Each result says what was measured and what was expected.</p>
      <PackNotice pack={s.pack} />
      {error && <div className="banner error" role="alert">{error}</div>}
      {s.files.length === 0 ? (
        <section className="card"><p className="muted">There is no EPUB in {s.project.name} yet. Export one from Write and check it into the vault.</p></section>
      ) : (
        <form className="row" aria-label="Run Preflight" onSubmit={(ev) => { ev.preventDefault(); void run(); }}>
          {s.files.length === 1 ? <span className="muted small">{s.files[0]!.path} (version {s.files[0]!.version})</span> : (
            <select aria-label="EPUB" value={chosenFile} onChange={(ev) => setFile(ev.target.value)}><option value="">EPUB…</option>{s.files.map((f) => <option key={f.fileId} value={f.fileId}>{f.path} (version {f.version}){f.latest ? (f.latest.ready ? ', ready' : `, ${plural(f.latest.errors, 'error')}`) : ''}</option>)}</select>
          )}
          {s.editions.length > 1 && <select aria-label="Edition" value={chosenEdition} onChange={(ev) => setEdition(ev.target.value)}><option value="">Edition…</option>{s.editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>}
          {s.editions.length === 1 && <span className="muted small">{s.editions[0]!.label}</span>}
          {s.may.run ? <button type="submit" disabled={!chosenFile || busy}>{busy ? 'Checking…' : latest ? 'Check again' : 'Run Preflight'}</button> : <span className="muted small">Your role may read Preflight but not run it.</span>}
        </form>
      )}
      {view && view.available && <RunResults v={view} onWaive={waive} />}
      {view && !view.available && <p className="muted">{view.reason}</p>}
      <details>
        <summary>What this does not check</summary>
        <ul>{s.pack.notChecked.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="muted small">epubcheck, the standard EPUB validator, {s.epubcheck ? 'is installed on this computer and adds its messages to each run.' : 'is not installed on this computer (it needs Java); runs here use Cadrel’s own checks only. Set EPUBCHECK_JAR to its jar to add it.'}</p>
      </details>
    </div>
  );
}

function PackNotice({ pack }: { pack: PackInfo }) {
  const old = pack.ageMonths === null || pack.ageMonths >= STALE_MONTHS;
  return (
    <p className={`small ${old ? 'banner' : 'muted'}`} role={old ? 'status' : undefined}>
      Rules: {pack.title}, version {pack.version}. {pack.verified ? `Limits last read from the retailer's pages on ${pack.verified}${pack.ageMonths !== null ? ` (${plural(pack.ageMonths, 'month')} ago)` : ''}.` : 'The limits have not been read from the retailer’s pages.'}{old ? ' Retailers change their limits: check the retailer’s own pages before relying on a result.' : ''}
      <details style={{ display: 'inline-block', marginLeft: 8 }}><summary>Where each limit came from</summary><ul>{pack.sources.map((x) => <li key={x.rule}>{x.rule}: {x.url.startsWith('http') ? <a href={x.url} target="_blank" rel="noreferrer">{x.url}</a> : x.url}{x.read ? ` (read ${x.read})` : ''}{x.note ? `. ${x.note}` : ''}</li>)}</ul></details>
    </p>
  );
}

function RunResults({ v, onWaive }: { v: RunReady; onWaive: (runId: string, seq: number, reason: string) => Promise<void> }) {
  const { run, results } = v;
  const [waiving, setWaiving] = useState<number | null>(null);
  const [why, setWhy] = useState('');
  return (
    <section className="card" aria-label="Result">
      <div className="row">
        <span className={`chip ${run.ready ? 'ok' : 'warn'}`}>{run.ready ? 'No errors' : `Not ready: ${plural(run.errors, 'error')}`}</span>
        {run.warnings > 0 && <span className="chip">{plural(run.warnings, 'warning')}</span>}
        {run.suggestions > 0 && <span className="chip">{plural(run.suggestions, 'suggestion')}</span>}
        <span className="muted small">{v.path}, version {run.fileVersion}, checked {day(run.at)} by {v.byName}{v.editionLabel ? ` against ${v.editionLabel}` : ''}{v.coverPath ? `, cover ${v.coverPath} version ${run.coverVersion}` : ', no approved cover'}</span>
      </div>
      {v.epubcheck === 'used' && <p className="muted small">epubcheck’s messages are included.</p>}
      {v.epubcheck === 'failed' && <p className="muted small">epubcheck is installed but did not finish; its messages are not included.</p>}
      {results.length === 0 && <p>Nothing found. {run.notChecked.length > 0 ? 'See what this does not check, below.' : ''}</p>}
      {(['error', 'warning', 'suggestion'] as const).map((g) => {
        const rows = results.filter((r) => r.grade === g);
        if (rows.length === 0) return null;
        return (
          <div key={g}>
            <h4>{GRADE_NAME[g]} <span className="muted small">{GRADE_HELP[g]}</span></h4>
            <ul className="plain work-list">
              {rows.map((r) => (
                <li key={r.seq} className={r.state === 'waived' ? 'muted' : ''}>
                  <strong>{r.what}</strong>
                  <div className="small">{r.location && <>In <code>{r.location}</code>. </>}{r.measured && <>Found: {r.measured}. </>}{r.expected && <>Expected: {r.expected}.</>}</div>
                  {r.state === 'waived' ? <div className="small"><span className="chip">waived</span> {r.waivedReason}{r.carried ? ' (waived on an earlier check of this file)' : ''}</div> : v.may.run && waiving !== r.seq && <button type="button" onClick={() => (setWaiving(r.seq), setWhy(''))}>Waive…</button>}
                  {waiving === r.seq && (
                    <form className="row" onSubmit={(ev) => { ev.preventDefault(); void onWaive(run.id, r.seq, why).then(() => setWaiving(null)); }}>
                      <input aria-label="Reason to waive" placeholder="Why this is acceptable" value={why} onChange={(ev) => setWhy(ev.target.value)} />
                      <button type="submit" disabled={!why.trim()}>Waive it</button>
                      <button type="button" onClick={() => setWaiving(null)}>Cancel</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
