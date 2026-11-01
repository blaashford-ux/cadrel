import { useCallback, useEffect, useState } from 'react';
import type { FileVersion } from '@cadrel/kernel';
import type { VaultState } from '../shared/api';

const api = window.cadrel.vault;
type Ready = Extract<VaultState, { available: true }>;
type Entry = Ready['entries'][number];
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const kb = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const STATUS: Record<Entry['status'], { label: string; hint: string }> = {
  untracked: { label: 'Not in the vault', hint: 'It is in your working folder but nobody else can see it yet.' },
  'not-local': { label: 'Not downloaded', hint: 'It is in the vault; get it to work with it here.' },
  latest: { label: 'Latest', hint: 'Your copy is the newest version and is read-only.' },
  'out-of-date': { label: 'Newer version available', hint: 'Get latest to update your copy.' },
  'checked-out-by-me': { label: 'Checked out by you', hint: 'Only you can change it. Check it in to save a new version.' },
  'checked-out-by-other': { label: 'Checked out', hint: 'Someone else is editing it. You can read your copy.' },
  'modified-unprotected': { label: 'Changed without a check-out', hint: 'Your copy was changed outside a check-out, so it will not be overwritten. Discard the changes to get the vault’s version.' },
  missing: { label: 'Missing from your folder', hint: 'You have it checked out but the file is gone. Undo the check-out to get it back.' }
};

/** The vault's files: what state each is in for you on this computer, and what you can do with it. */
export function Files() {
  const [s, setS] = useState<VaultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api.state().then((v) => (setS(v), v), (e) => (setError(clean(e)), null)), []);
  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const run = async <T,>(job: () => Promise<T>, ok?: string): Promise<{ ok: true; value: T } | { ok: false }> => {
    setError(null);
    setNote(null);
    try {
      const value = await job();
      if (ok) setNote(ok);
      await load();
      return { ok: true, value };
    } catch (e) {
      setError(clean(e));
      await load();
      return { ok: false };
    }
  };

  if (!s) return error ? <div className="banner error" role="alert">{error}</div> : <p className="muted">Loading…</p>;
  if (!s.available) return <section className="card"><p className="muted">{s.reason}</p></section>;
  const nameOf = (id: string) => s.people.find((p) => p.id === id)?.name ?? 'someone';
  const q = filter.trim().toLowerCase();
  const rows = s.entries.filter((e) => !q || e.path.toLowerCase().includes(q));
  const mine = s.entries.filter((e) => e.status === 'checked-out-by-me').length;
  const stale = s.entries.filter((e) => e.status === 'out-of-date').length;

  return (
    <div className="files">
      <p className="muted">Real files in your working folder, kept in the vault. A file nobody is editing is read-only; check it out to edit it (nobody else can then), check it in to save a new version. <button type="button" className="link" onClick={() => void api.openFolder()}>Open the folder</button> <span className="muted small">{s.dir}</span></p>
      {s.offline && <div className="banner" role="status"><strong>The Studio cannot be reached.</strong> This is what was last known. Files you have checked out can still be edited here; check them in when you are back online. Check-out, check-in and Get latest need the connection.</div>}
      {s.kept.map((k) => (
        <div key={k.path} className="banner" role="alert">
          <strong>{nameOf(k.removedBy)} released your check-out of {k.path}.</strong> {k.reason && `“${k.reason}”. `}
          {k.savedAs ? <>What you had not saved is kept as <code>{k.savedAs}</code> in your folder; nothing was deleted.</> : 'You had no unsaved changes.'}
        </div>
      ))}
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {note && <div className="banner info" role="status">{note}</div>}
      <div className="row">
        <input aria-label="Search files" placeholder="Search files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" onClick={() => void run(() => api.getLatest(), 'Copies updated where they could be.').then((r) => r.ok && r.value.skipped.length && setNote(`Updated ${r.value.updated.length}. Left alone: ${r.value.skipped.map((k) => `${k.path} (${k.why})`).join(' ')}`))}>
          Get latest{stale ? ` (${stale})` : ''}
        </button>
        <span className="muted small">{mine ? `${mine} checked out by you` : 'Nothing checked out by you'}</span>
      </div>
      {s.entries.length === 0 ? (
        <div className="empty"><p><strong>No files yet.</strong></p><p className="muted">Put files in the working folder, then add them to the vault from here.</p></div>
      ) : (
        <table className="table">
          <thead><tr><th>File</th><th>State</th><th className="num">Version</th><th className="num">Size</th><th /></tr></thead>
          <tbody>
            {rows.map((e) => <Row key={e.path} e={e} s={s} nameOf={nameOf} run={run} open={open === e.path} onOpen={() => setOpen(open === e.path ? null : e.path)} />)}
          </tbody>
        </table>
      )}
      {s.orphans.length > 0 && (
        <section className="card" aria-labelledby="f-orph">
          <h3 id="f-orph">Copies kept aside</h3>
          <p className="muted small">When an administrator releases a check-out, the work you had not saved is kept next to the file, never deleted. Save it as a new file or merge it by hand.</p>
          <ul className="plain">{s.orphans.map((o) => <li key={o.savedAs}><code>{o.savedAs}</code> <span className="muted small">from {o.path}, released by {nameOf(o.removedBy)} on {o.removedAt.slice(0, 10)}{o.reason ? `: ${o.reason}` : ''}</span></li>)}</ul>
        </section>
      )}
    </div>
  );
}

type Run = <T>(job: () => Promise<T>, ok?: string) => Promise<{ ok: true; value: T } | { ok: false }>;

function Row({ e, s, nameOf, run, open, onOpen }: { e: Entry; s: Ready; nameOf: (id: string) => string; run: Run; open: boolean; onOpen: () => void }) {
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState<'in' | 'force' | null>(null);
  const [reason, setReason] = useState('');
  const st = STATUS[e.status];
  const holder = e.lock ? (e.lock.personId === s.me ? 'you, on another computer' : nameOf(e.lock.personId)) : null;
  return (
    <>
      <tr data-path={e.path}>
        <th>{e.fileId ? <button type="button" className="link" aria-expanded={open} onClick={onOpen}>{e.path}</button> : e.path} <span className="chip">{e.kind}</span></th>
        <td title={st.hint}>
          {st.label}{e.status === 'checked-out-by-other' && holder ? ` by ${holder}` : ''}{e.status === 'checked-out-by-me' && e.modified ? ' · changed' : ''}
          {e.lock && <span className="muted small"> since {e.lock.since.slice(0, 10)}</span>}
        </td>
        <td className="num">{e.version ?? ''}{e.localVersion !== null && e.version !== null && e.localVersion !== e.version ? <span className="muted small"> (yours {e.localVersion})</span> : null}</td>
        <td className="num">{kb(e.size)}</td>
        <td className="wf-actions">
          {e.status === 'untracked' && <button type="button" onClick={() => void run(() => api.add(e.path), `${e.path} is in the vault.`)}>Add to the vault</button>}
          {(e.status === 'not-local' || e.status === 'out-of-date') && <button type="button" onClick={() => void run(() => api.getLatest([e.path]))}>Get latest</button>}
          {(e.status === 'latest' || e.status === 'not-local' || e.status === 'out-of-date') && <button type="button" className="primary" onClick={() => void run(() => api.checkOut(e.path))}>Check out</button>}
          {e.status === 'checked-out-by-me' && <button type="button" className="primary" onClick={() => setMode(mode === 'in' ? null : 'in')}>Check in…</button>}
          {(e.status === 'checked-out-by-me' || e.status === 'missing') && <button type="button" onClick={() => { if (!e.modified || window.confirm(`Discard your changes to ${e.path}?`)) void run(() => api.undoCheckOut(e.path)); }}>Undo check-out</button>}
          {e.status === 'modified-unprotected' && <button type="button" onClick={() => { if (window.confirm(`Discard the changes to your copy of ${e.path}? They cannot be recovered.`)) void run(() => api.discardLocalChanges(e.path)); }}>Discard changes</button>}
          {s.may.force && e.lock && !(e.lock.personId === s.me && e.lock.machine === s.machine) && <button type="button" className="quiet" onClick={() => setMode(mode === 'force' ? null : 'force')}>Release…</button>}
        </td>
      </tr>
      {mode === 'in' && (
        <tr><td colSpan={5}>
          <form className="row" onSubmit={(ev) => (ev.preventDefault(), void run(() => api.checkIn(e.path, comment), 'Saved.').then((r) => r.ok && (setMode(null), setComment(''))))}>
            <input aria-label="What changed" placeholder="What changed (optional)" value={comment} onChange={(ev) => setComment(ev.target.value)} autoFocus />
            <button type="submit" className="primary">Check in</button>
            <button type="button" className="quiet" onClick={() => setMode(null)}>Cancel</button>
          </form>
        </td></tr>
      )}
      {mode === 'force' && (
        <tr><td colSpan={5}>
          <div className="banner" role="alertdialog" aria-label="Release a check-out">
            <p><strong>{holder} has this file checked out.</strong> Releasing it means whatever they have not checked in is not in the vault. It is kept aside on their computer, never deleted, and they are told. This is recorded.</p>
            <form className="row" onSubmit={(ev) => (ev.preventDefault(), void run(() => api.forceRelease(e.path, reason), 'Released.').then((r) => r.ok && (setMode(null), setReason(''))))}>
              <input aria-label="Reason" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus />
              <button type="submit" className="danger" disabled={!reason.trim()}>Release the lock</button>
              <button type="button" className="quiet" onClick={() => setMode(null)}>Cancel</button>
            </form>
          </div>
        </td></tr>
      )}
      {open && e.fileId && <tr><td colSpan={5}><History path={e.path} entries={s.entries} canWrite={e.kind === 'manuscript' || e.kind === 'asset'} onChanged={() => undefined} /></td></tr>}
    </>
  );
}

function History({ path, entries, canWrite, onChanged }: { path: string; entries: Entry[]; canWrite: boolean; onChanged: () => void }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.detail>> | null>(null);
  const [asName, setAsName] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'versions' | 'links' | 'card'>('versions');
  const [to, setTo] = useState('');
  const [fields, setFields] = useState<[string, string][]>([]);
  const [newKey, setNewKey] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void api.detail(path).then((x) => (setD(x), setFields(Object.entries(x.card.fields))), (e) => setErr(clean(e)));
  }, [path, tick]);
  const go = async (job: () => Promise<unknown>) => {
    setErr(null);
    try {
      await job();
      setTick((t) => t + 1);
      onChanged();
    } catch (e) {
      setErr(clean(e));
    }
  };
  if (err && !d) return <p className="warn small">{err}</p>;
  if (!d) return <p className="muted small">Loading…</p>;
  const others = entries.filter((e) => e.fileId && e.path !== path && !d.uses.some((u) => u.path === e.path));
  return (
    <div className="file-detail">
      <div className="tabs" role="tablist" aria-label={`About ${path}`}>
        {([['versions', 'Versions'], ['links', `Uses and used by (${d.uses.length + d.usedBy.length})`], ['card', 'Data card']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {err && <p className="warn small" role="alert">{err}</p>}
      {tab === 'versions' && (
        <ul className="plain" aria-label={`Versions of ${path}`}>
          {d.versions.map((x) => (
            <li key={x.n}>
              <strong>Version {x.n}</strong> <span className="muted small">{x.createdAt.slice(0, 16).replace('T', ' ')} · {kb(x.size)}{x.comment ? ` · ${x.comment}` : ''}</span>{' '}
              <input aria-label={`Save version ${x.n} as`} placeholder="Save as…" value={asName[x.n] ?? ''} onChange={(e) => setAsName({ ...asName, [x.n]: e.target.value })} size={22} />
              <button type="button" disabled={!(asName[x.n] ?? '').trim()} onClick={() => void go(() => api.saveVersionAs(path, x.n, asName[x.n]!))}>Save a copy</button>
            </li>
          ))}
        </ul>
      )}
      {tab === 'links' && (
        <>
          <h4>Uses</h4>
          {d.uses.length === 0 && <p className="muted small">Not using any other file.</p>}
          <ul className="plain" aria-label="Files this one uses">
            {d.uses.map((r) => (
              <li key={r.fileId}>
                {r.path} <span className="muted small">{r.version === null ? 'latest' : `version ${r.version}`}{r.note ? ` · ${r.note}` : ''}</span>
                {r.stale && <> <span className="warn small">version {r.currentVersion} exists</span>{canWrite && <button type="button" className="link" onClick={() => void go(() => api.setReferenceVersion(path, r.path, r.currentVersion))}>Update to it</button>}</>}
                {canWrite && <button type="button" className="quiet" onClick={() => void go(() => api.removeReference(path, r.path))}>Remove</button>}
              </li>
            ))}
          </ul>
          {canWrite && others.length > 0 && (
            <div className="row">
              <select aria-label="File to use" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Use another file…</option>{others.map((e) => <option key={e.path} value={e.path}>{e.path}</option>)}</select>
              <button type="button" disabled={!to} onClick={() => void go(() => api.addReference(path, to, null)).then(() => setTo(''))}>Add (always the latest)</button>
            </div>
          )}
          <h4>Used by</h4>
          {d.usedBy.length === 0 ? <p className="muted small">Nothing uses this file. Changing it affects no other file.</p> : (
            <ul className="plain" aria-label="Files that use this one">
              {d.usedBy.map((r) => <li key={r.fileId}>{r.path} <span className="muted small">{r.version === null ? 'follows the latest' : `uses version ${r.version}`}</span>{r.stale && <span className="warn small"> · newer version exists</span>}</li>)}
            </ul>
          )}
        </>
      )}
      {tab === 'card' && (
        <>
          <p className="muted small">A few facts about the file that people can read and search: trim size, licence, purpose…{d.card.updatedAt ? ` Last changed ${d.card.updatedAt.slice(0, 10)}.` : ''}</p>
          {fields.map(([k, v], i) => (
            <div key={k} className="row">
              <strong className="small">{k}</strong>
              <input aria-label={k} value={v} disabled={!canWrite} onChange={(e) => setFields(fields.map((f, j) => (j === i ? [k, e.target.value] : f)))} />
            </div>
          ))}
          {canWrite && (
            <div className="row">
              <input aria-label="New field" placeholder="New field name" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
              <button type="button" disabled={!newKey.trim() || fields.some(([k]) => k.toLowerCase() === newKey.trim().toLowerCase())} onClick={() => (setFields([...fields, [newKey.trim(), '']]), setNewKey(''))}>Add field</button>
              <button type="button" className="primary" onClick={() => void go(() => api.setCard(path, Object.fromEntries(fields), d.card.projectId))}>Save card</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
