import { useCallback, useEffect, useRef, useState } from 'react';
import { useScope } from './useScope';
import { CoverDesigner } from './cover/CoverDesigner';
import { CreateAssetMenu } from './cover/CreateAssetMenu';
import type { CoverKind } from '../shared/cover/doc';
import type { CoverContext, CoverDesignRow, ArtBriefRow, ArtCandidate, AssetRow, AssetView, BriefView, ConceptRow, FeedbackRow, PreviewView, ArtState, StudioState } from '../shared/api';

const art = window.cadrel.art;
type Ready = Extract<ArtState, { available: true }>;
type AssetReady = Extract<AssetView, { available: true }>;
type BriefReady = Extract<BriefView, { available: true }>;
type Region = { x: number; y: number; w: number; h: number };

const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const KIND_NAME: Record<string, string> = { cover: 'Cover', banner: 'Banner', ad: 'Ad', interior: 'Interior', character: 'Character art', map: 'Map', other: 'Other' };
const STATE_NAME: Record<string, string> = { draft: 'Draft', in_review: 'In review', approved: 'Approved', retired: 'Retired' };
const CONCEPT_STATE: Record<string, string> = { submitted: 'Submitted', shortlisted: 'Shortlisted', chosen: 'Chosen', rejected: 'Rejected' };
const USE_KINDS = [['listing', 'A listing'], ['ad', 'An ad'], ['banner', 'A banner'], ['release', 'A release'], ['edition', 'An edition'], ['other', 'Something else']] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => iso.slice(0, 10);
const licenceText = (a: Pick<AssetRow, 'licenceDaysLeft' | 'licenceExpired' | 'licence'>) =>
  a.licence.expires ? (a.licenceExpired ? `Licence ran out ${a.licence.expires}` : a.licenceDaysLeft! <= 60 ? `Licence runs out in ${plural(a.licenceDaysLeft!, 'day')}` : `Licence to ${a.licence.expires}`) : a.licence.kind ? `${a.licence.kind} licence` : '';

interface Props {
  /** Changes elsewhere reload the page. */
  studio: StudioState | null;
}

/** The art of the project in view: assets with approved versions, licences and uses, and the cover and art briefs with their concepts. */
export function ArtPage({ studio }: Props) {
  // like Canon, the page follows the project (and book) the app is showing; there is nothing to choose
  const scope = useScope();
  const project = scope?.book ?? scope?.project ?? undefined;
  const [state, setState] = useState<ArtState | null>(null);
  const [tab, setTab] = useState<'assets' | 'briefs'>('assets');
  const [open, setOpen] = useState<{ kind: 'asset' | 'brief'; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the Cover Designer is offered for this project, and the designer itself when it is open. */
  const [cover, setCover] = useState<CoverContext | null>(null);
  const [designer, setDesigner] = useState<{ kind: CoverKind; openPath: string | null } | null>(null);
  const reload = useCallback(() => {
    void Promise.resolve(window.cadrel.cover?.context(project)).then((c) => setCover(c ?? null), () => setCover(null));
    return art.state(project).then((s) => (setState(s), setError(null)), (e) => setError(message(e)));
  }, [project]);
  useEffect(() => {
    setState(null);
    setOpen(null);
    setDesigner(null);
  }, [project]);
  useEffect(() => {
    if (scope) void reload();
  }, [reload, studio, scope]);

  if (error && !state) return <div className="banner error" role="alert">{error}</div>;
  if (!scope || !state) return <p className="muted">Loading…</p>;
  if (!state.available) return <section className="card"><p className="muted">{state.reason}</p></section>;
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
  const designFor = (assetPath: string): CoverDesignRow | undefined => (cover?.available ? cover.designs.find((d) => d.imagePath === assetPath) : undefined);
  if (designer && cover?.available) {
    return (
      <CoverDesigner
        projectId={cover.project.id}
        projectName={cover.project.name}
        kind={designer.kind}
        openPath={designer.openPath}
        fields={cover.fields}
        pictures={cover.pictures}
        may={cover.may}
        onClose={(saved) => { setDesigner(null); if (saved) void reload(); }}
      />
    );
  }
  return (
    <div className="art">
      <div className="row">
        <h2 style={{ margin: 0 }}>Art</h2>
        <span className="chip" title="The project in view">{state.project.name}</span>
        {state.licencesDue.length > 0 && <span className="chip warn" title="Licences that have run out or will within 60 days">{plural(state.licencesDue.length, 'licence')} to renew</span>}
      </div>
      <p className="muted small">Covers and other art as the Studio keeps them: which version is approved, under what licence, and where it is used. It follows the project you are in. Approving names one exact version; a new version is not approved until someone approves it.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      {open?.kind === 'asset' ? (
        <AssetDetail id={open.id} onBack={() => (setOpen(null), void reload())} act={act} designFor={designFor} onEditDesign={(p) => setDesigner({ kind: 'ebook', openPath: p })} />
      ) : open?.kind === 'brief' ? (
        <BriefDetail id={open.id} onBack={() => (setOpen(null), void reload())} act={act} />
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Art">
            {([['assets', `Assets (${state.assets.length})`], ['briefs', `Briefs and concepts (${state.briefs.length})`]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === 'assets' && <AssetsTab s={state} act={act} onOpen={(id) => setOpen({ kind: 'asset', id })} canDesign={!!cover?.available && cover.may.write} onCreate={(kind) => setDesigner({ kind, openPath: null })} designFor={designFor} onEditDesign={(p) => setDesigner({ kind: 'ebook', openPath: p })} />}
          {tab === 'briefs' && <BriefsTab s={state} act={act} onOpen={(id) => setOpen({ kind: 'brief', id })} />}
        </>
      )}
    </div>
  );
}

// ---- assets ---------------------------------------------------------------------------------------------------------------------

function AssetsTab({ s, act, onOpen, canDesign, onCreate, designFor, onEditDesign }: { s: Ready; act: (j: () => Promise<unknown>) => Promise<boolean>; onOpen: (id: string) => void; canDesign: boolean; onCreate: (kind: CoverKind) => void; designFor: (assetPath: string) => CoverDesignRow | undefined; onEditDesign: (path: string) => void }) {
  return (
    <>
      {s.licencesDue.length > 0 && (
        <section className="card" aria-label="Licences to renew">
          <h3>Licences to renew</h3>
          <ul className="plain">
            {s.licencesDue.map((d) => (
              <li key={d.assetId}><button type="button" className="link" onClick={() => onOpen(d.assetId)}>{d.name}</button> <span className={`chip ${d.days < 0 ? 'warn' : ''}`}>{d.days < 0 ? `ran out ${plural(-d.days, 'day')} ago` : d.days === 0 ? 'runs out today' : `${plural(d.days, 'day')} left`}</span></li>
            ))}
          </ul>
        </section>
      )}
      {s.may.write && (
        <div className="row" aria-label="Make an asset">
          {canDesign && <CreateAssetMenu onCreate={onCreate} />}
          <AddAsset s={s} act={act} />
        </div>
      )}
      {s.assets.length === 0 ? (
        <section className="card"><p className="muted">No assets in {s.project.name} yet.{s.may.write && s.candidates.length > 0 ? ' Add one from the files above.' : ''}</p></section>
      ) : (
        <section className="card" aria-label="Assets">
          <ul className="plain work-list">
            {s.assets.map((a) => (
              <li key={a.id}>
                <button type="button" className="link" onClick={() => onOpen(a.id)}>{a.name}</button>{' '}
                <span className="chip">{KIND_NAME[a.kind]}</span> <span className={`chip ${a.state === 'approved' ? 'ok' : ''}`}>{STATE_NAME[a.state]}</span>
                {a.approvedNow !== null && <span className="muted small"> version {a.approvedNow} approved</span>}
                {a.newerThanApproved && <span className="chip warn" title={`Version ${a.latestVersion} is newer than the approved one`}>newer version not approved</span>}
                {a.needUpdate > 0 && <span className="chip warn">{plural(a.needUpdate, 'use')} to update</span>}
                {a.openFeedback > 0 && <span className="chip">{plural(a.openFeedback, 'open comment')}</span>}
                {licenceText(a) && <span className={`chip ${a.licenceExpired || (a.licenceDaysLeft ?? 999) <= 60 ? 'warn' : ''}`}>{licenceText(a)}</span>}
                {designFor(a.path) && <button type="button" className="link" onClick={() => onEditDesign(designFor(a.path)!.path)}>Edit design</button>}
                <span className="muted small"> {a.projectName !== '' ? `· ${a.projectName}` : ''} · {a.path}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AddAsset({ s, act }: { s: Ready; act: (j: () => Promise<unknown>) => Promise<boolean> }) {
  const [file, setFile] = useState('');
  const [kind, setKind] = useState('cover');
  // only this project's own design files are offered; with one, it is the one
  const chosen = s.candidates.some((c) => c.fileId === file) ? file : s.candidates.length === 1 ? s.candidates[0]!.fileId : '';
  if (s.candidates.length === 0) return null;
  return (
    <form className="row" aria-label="Add an asset" onSubmit={(ev) => { ev.preventDefault(); void act(() => window.cadrel.art.call('create', { projectId: s.project.id, fileId: chosen, kind })); }}>
      {s.candidates.length === 1 ? <span className="muted small">{s.candidates[0]!.path}</span> : (
        <select aria-label="File" value={chosen} onChange={(ev) => setFile(ev.target.value)}><option value="">File…</option>{s.candidates.map((c) => <option key={c.fileId} value={c.fileId}>{c.path}</option>)}</select>
      )}
      <select aria-label="Kind" value={kind} onChange={(ev) => setKind(ev.target.value)}>{Object.entries(KIND_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <button type="submit" disabled={!chosen}>Add as an asset</button>
    </form>
  );
}

function AssetDetail({ id, onBack, act, designFor, onEditDesign }: { id: string; onBack: () => void; act: (j: () => Promise<unknown>) => Promise<boolean>; designFor: (assetPath: string) => CoverDesignRow | undefined; onEditDesign: (path: string) => void }) {
  const [v, setV] = useState<AssetView | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [pin, setPin] = useState<Region | null>(null);
  const reload = useCallback(() => art.asset(id).then(setV, () => undefined), [id]);
  useEffect(() => void reload(), [reload]);
  if (!v) return <p className="muted">Loading…</p>;
  if (!v.available) return <section className="card"><button type="button" className="link" onClick={onBack}>Back</button><p className="muted">{v.reason}</p></section>;
  const run = async (job: () => Promise<unknown>) => {
    if (await act(job)) await reload();
  };
  return <AssetBody v={v} onBack={onBack} run={run} shown={shown} setShown={setShown} pin={pin} setPin={setPin} design={designFor(v.asset.path)} onEditDesign={onEditDesign} />;
}

function AssetBody({ v, onBack, run, shown, setShown, pin, setPin, design, onEditDesign }: { design?: CoverDesignRow; onEditDesign: (path: string) => void; v: AssetReady; onBack: () => void; run: (j: () => Promise<unknown>) => Promise<void>; shown: number | null; setShown: (n: number) => void; pin: Region | null; setPin: (r: Region | null) => void }) {
  const a = v.asset;
  const version = shown ?? v.versions[0]?.n ?? a.latestVersion;
  const standing = a.approved.map((r) => r.version);
  return (
    <div className="asset">
      <button type="button" className="link" onClick={onBack}>← All assets</button>
      <div className="row">
        <h3 style={{ margin: 0 }}>{a.name}</h3> <span className="chip">{KIND_NAME[a.kind]}</span> <span className={`chip ${a.state === 'approved' ? 'ok' : ''}`}>{STATE_NAME[a.state]}</span>
        {licenceText(a) && <span className={`chip ${a.licenceExpired || (a.licenceDaysLeft ?? 999) <= 60 ? 'warn' : ''}`}>{licenceText(a)}</span>}
      </div>
      <p className="muted small">{a.path}</p>
      {design && v.may.write && <p><button type="button" onClick={() => onEditDesign(design.path)}>Edit design</button> <span className="muted small">Opens the cover's design. Saving makes a new version of this asset; it is not approved until someone approves it.</span></p>}
      <div className="grid-2">
        <section className="card" aria-label="Picture">
          <div className="row"><label className="small">Version <select aria-label="Version" value={version} onChange={(ev) => setShown(Number(ev.target.value))}>{v.versions.map((x) => <option key={x.n} value={x.n}>{x.n}{x.approved ? ' (approved)' : ''}</option>)}</select></label></div>
          <Picture fileId={a.fileId} version={version} marks={v.feedback.filter((f) => f.fileVersion === version && f.region && f.state === 'open')} onPin={v.may.comment ? setPin : undefined} pin={pin} />
          {v.may.comment && <CommentForm target={{ targetKind: 'asset', targetId: a.id }} version={version} pin={pin} onDone={() => setPin(null)} run={run} />}
        </section>
        <section className="card" aria-label="Versions">
          <h4>Versions</h4>
          <ul className="plain">
            {v.versions.map((x) => (
              <li key={x.n}>
                Version {x.n} <span className="muted small">{day(x.at)}, {x.byName}{x.comment ? `: ${x.comment}` : ''}</span> {x.approved && <span className="chip ok">approved</span>}
                {v.may.approve && !x.approved && a.state !== 'retired' && <button type="button" onClick={() => void run(() => window.cadrel.art.call('approve', a.id, x.n))}>Approve version {x.n}</button>}
                {v.may.approve && x.approved && <RevokeButton onRevoke={(reason) => run(() => window.cadrel.art.call('revoke', a.id, x.n, reason))} version={x.n} />}
              </li>
            ))}
          </ul>
          {standing.length === 0 && <p className="muted small">No version is approved yet.</p>}
        </section>
      </div>
      {v.may.manage && <LicenceForm a={a} run={run} />}
      <UsesSection v={v} run={run} />
      <ReplacementsSection v={v} run={run} />
      <FeedbackList items={v.feedback} canResolve={v.may.comment} run={run} />
      {v.may.manage && a.state !== 'retired' && <RetireButton onRetire={(reason) => run(() => window.cadrel.art.call('retire', a.id, reason))} />}
    </div>
  );
}

function RevokeButton({ onRevoke, version }: { onRevoke: (reason: string) => Promise<void>; version: number }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  if (!asking) return <button type="button" onClick={() => setAsking(true)}>Take back approval of version {version}</button>;
  return (
    <span className="row">
      <input aria-label="Why" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} />
      <button type="button" disabled={!reason.trim()} onClick={() => void onRevoke(reason)}>Take it back</button>
    </span>
  );
}
function RetireButton({ onRetire }: { onRetire: (reason: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  if (!asking) return <button type="button" onClick={() => setAsking(true)}>Retire this asset…</button>;
  return (
    <span className="row">
      <input aria-label="Reason to retire" placeholder="Why it is retired" value={reason} onChange={(ev) => setReason(ev.target.value)} />
      <button type="button" disabled={!reason.trim()} onClick={() => void onRetire(reason)}>Retire</button>
    </span>
  );
}

function LicenceForm({ a, run }: { a: AssetRow; run: (j: () => Promise<unknown>) => Promise<void> }) {
  const [l, setL] = useState({ kind: a.licence.kind, licensor: a.licence.licensor, ref: a.licence.ref, expires: a.licence.expires ?? '', territory: a.licence.territory, creditLine: a.licence.creditLine });
  const set = (k: keyof typeof l) => (ev: React.ChangeEvent<HTMLInputElement>) => setL({ ...l, [k]: ev.target.value });
  return (
    <section className="card" aria-label="Licence">
      <h4>Licence</h4>
      <form className="row" onSubmit={(ev) => { ev.preventDefault(); void run(() => window.cadrel.art.call('update', a.id, { licence: { ...l, expires: l.expires || null } })); }}>
        <input aria-label="Licence kind" placeholder="Kind (stock, commissioned…)" value={l.kind} onChange={set('kind')} />
        <input aria-label="Licensor" placeholder="Licensor" value={l.licensor} onChange={set('licensor')} />
        <input aria-label="Licence reference" placeholder="Reference" value={l.ref} onChange={set('ref')} />
        <input aria-label="Runs to" type="date" value={l.expires} onChange={set('expires')} />
        <input aria-label="Territory" placeholder="Territory" value={l.territory} onChange={set('territory')} />
        <input aria-label="Credit line" placeholder="Credit line" value={l.creditLine} onChange={set('creditLine')} />
        <button type="submit">Save licence</button>
      </form>
      <p className="muted small">An expired licence stops a new version being approved; what is approved stays, flagged.</p>
    </section>
  );
}

function UsesSection({ v, run }: { v: AssetReady; run: (j: () => Promise<unknown>) => Promise<void> }) {
  const [kind, setKind] = useState<string>('listing');
  const [label, setLabel] = useState('');
  return (
    <section className="card" aria-label="Where used">
      <h4>Where it is used</h4>
      {v.uses.length === 0 && v.fileUses.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ul className="plain">
        {v.uses.map((u) => (
          <li key={u.id}>
            {u.label} <span className="chip">{USE_KINDS.find(([k]) => k === u.userKind)?.[1] ?? u.userKind}</span>{u.version !== null && <span className="muted small"> version {u.version}</span>}{' '}
            {u.state === 'needs_update' && <span className="chip warn">needs update</span>}{u.state === 'done' && <span className="chip ok">updated</span>}
            {v.may.write && u.state === 'needs_update' && <button type="button" onClick={() => void run(() => window.cadrel.art.call('setUseState', u.id, 'done'))}>Mark updated</button>}
          </li>
        ))}
        {v.fileUses.map((f) => <li key={f.fileId}>{f.path} <span className="chip">a file</span>{f.version !== null && <span className="muted small"> version {f.version}</span>}</li>)}
      </ul>
      {v.may.write && v.asset.state !== 'retired' && (
        <form className="row" aria-label="Add a use" onSubmit={(ev) => { ev.preventDefault(); void run(() => window.cadrel.art.call('addUse', v.asset.id, { kind, label })).then(() => setLabel('')); }}>
          <select aria-label="Kind of use" value={kind} onChange={(ev) => setKind(ev.target.value)}>{USE_KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
          <input aria-label="Where" placeholder="Amazon US listing, spring ad…" value={label} onChange={(ev) => setLabel(ev.target.value)} />
          <button type="submit" disabled={!label.trim()}>Add a use</button>
        </form>
      )}
    </section>
  );
}

function ReplacementsSection({ v, run }: { v: AssetReady; run: (j: () => Promise<unknown>) => Promise<void> }) {
  const standing = v.asset.approved.map((r) => r.version);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [reason, setReason] = useState('');
  const open = v.replacements.filter((r) => r.state === 'open');
  const f = standing.includes(from) ? from : standing[0] ?? 0;
  const t = standing.includes(to) && to !== f ? to : standing.find((n) => n !== f) ?? 0;
  if (standing.length < 2 && open.length === 0 && v.replacements.length === 0) return null;
  return (
    <section className="card" aria-label="Replacements">
      <h4>Replacing a version</h4>
      <p className="muted small">A replacement is a proposal. Approving it changes nothing by itself: each use is marked "needs update" and its owner marks it done.</p>
      <ul className="plain">
        {v.replacements.map((r) => (
          <li key={r.id}>
            Version {r.fromVersion} to {r.toVersion}: {r.reason} <span className="muted small">({r.proposerName})</span> <span className="chip">{r.state}</span>
            {r.state === 'open' && v.may.approve && (
              <>
                <button type="button" onClick={() => void run(() => window.cadrel.art.call('decideReplacement', r.id, { approve: true }))}>Approve</button>
                <button type="button" onClick={() => void run(() => window.cadrel.art.call('decideReplacement', r.id, { approve: false, reason: 'Not now.' }))}>Reject</button>
              </>
            )}
            {r.state === 'open' && v.may.write && <button type="button" onClick={() => void run(() => window.cadrel.art.call('withdrawReplacement', r.id))}>Withdraw</button>}
          </li>
        ))}
      </ul>
      {v.may.write && standing.length >= 2 && open.length === 0 && (
        <form className="row" aria-label="Propose a replacement" onSubmit={(ev) => { ev.preventDefault(); void run(() => window.cadrel.art.call('proposeReplacement', v.asset.id, { fromVersion: f, toVersion: t, reason })).then(() => setReason('')); }}>
          <label className="small">Replace <select aria-label="Replace version" value={f} onChange={(ev) => setFrom(Number(ev.target.value))}>{standing.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="small">with <select aria-label="With version" value={t} onChange={(ev) => setTo(Number(ev.target.value))}>{standing.filter((n) => n !== f).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <input aria-label="Reason" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} />
          <button type="submit" disabled={!reason.trim()}>Propose</button>
        </form>
      )}
    </section>
  );
}

// ---- pictures, with a region drawn on them for feedback ------------------------------------------------------------------------------

function Picture({ fileId, version, marks = [], onPin, pin }: { fileId: string; version: number; marks?: FeedbackRow[]; onPin?: (r: Region | null) => void; pin?: Region | null }) {
  const [p, setP] = useState<PreviewView | null>(null);
  useEffect(() => {
    setP(null);
    let live = true;
    art.preview(fileId, version).then((x) => live && setP(x), () => live && setP({ kind: 'none', reason: 'The picture could not be read.' }));
    return () => void (live = false);
  }, [fileId, version]);
  const box = useRef<HTMLDivElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  if (!p) return <p className="muted small">Loading the picture…</p>;
  if (p.kind === 'none') return <p className="muted small">{p.reason}{p.width && p.height ? ` (${p.width} × ${p.height} pixels)` : ''}</p>;
  const at = (ev: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) };
  };
  const pct = (r: Region) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
  return (
    <div>
      <div
        ref={box}
        className="pinned"
        style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', cursor: onPin ? 'crosshair' : 'default', userSelect: 'none' }}
        onMouseDown={(ev) => { if (onPin) from.current = at(ev); }}
        onMouseUp={(ev) => {
          if (!onPin || !from.current) return;
          const a = from.current;
          const b = at(ev);
          from.current = null;
          const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
          onPin(r.w < 0.01 || r.h < 0.01 ? null : r);
        }}
      >
        <img src={p.dataUrl} alt={`Version ${version}`} draggable={false} style={{ maxWidth: '100%', maxHeight: 520, display: 'block' }} />
        {marks.map((m, i) => <div key={m.id} className="pin" title={m.body} style={{ position: 'absolute', border: '2px solid var(--warn, #c60)', ...pct(m.region!) }}><span className="chip">{i + 1}</span></div>)}
        {pin && <div className="pin new" style={{ position: 'absolute', border: '2px dashed var(--accent, #36c)', ...pct(pin) }} />}
      </div>
      <p className="muted small">{p.format.toUpperCase()}{p.width && p.height ? `, ${p.width} × ${p.height} pixels` : ''}{p.note ? `. ${p.note}` : ''}{onPin ? ' Drag on the picture to point at something.' : ''}</p>
    </div>
  );
}

function CommentForm({ target, version, pin, onDone, run }: { target: { targetKind: 'asset' | 'concept'; targetId: string }; version: number; pin: Region | null; onDone: () => void; run: (j: () => Promise<unknown>) => Promise<void> }) {
  const [body, setBody] = useState('');
  return (
    <form className="row" aria-label="Comment" onSubmit={(ev) => { ev.preventDefault(); void run(() => window.cadrel.art.call('comment', { ...target, fileVersion: version, region: pin, body })).then(() => (setBody(''), onDone())); }}>
      <input aria-label="Comment" placeholder={pin ? 'About the marked part' : 'About the whole picture'} value={body} onChange={(ev) => setBody(ev.target.value)} />
      <button type="submit" disabled={!body.trim()}>{pin ? 'Comment on the marked part' : 'Comment'}</button>
    </form>
  );
}

function FeedbackList({ items, canResolve, run }: { items: FeedbackRow[]; canResolve: boolean; run: (j: () => Promise<unknown>) => Promise<void> }) {
  if (items.length === 0) return null;
  return (
    <section className="card" aria-label="Comments">
      <h4>Comments</h4>
      <ul className="plain">
        {items.map((f) => (
          <li key={f.id}>
            {f.body} <span className="muted small">{f.byName}, on version {f.fileVersion}{f.region ? ', marked' : ''}</span> {f.state === 'resolved' && <span className="chip ok">resolved</span>}
            {canResolve && f.state === 'open' && <button type="button" onClick={() => void run(() => window.cadrel.art.call('resolveFeedback', f.id))}>Resolve</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- briefs and concepts -----------------------------------------------------------------------------------------------------------

function BriefsTab({ s, act, onOpen }: { s: Ready; act: (j: () => Promise<unknown>) => Promise<boolean>; onOpen: (id: string) => void }) {
  const [kind, setKind] = useState<'cover' | 'art'>('cover');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <>
      {s.may.brief && (
        <form className="card" aria-label="New brief" onSubmit={(ev) => { ev.preventDefault(); void act(() => window.cadrel.art.call('createBrief', { projectId: s.project.id, kind, title, body })).then((ok) => ok && (setTitle(''), setBody(''))); }}>
          <h4>A new brief</h4>
          <div className="row">
            <select aria-label="Brief kind" value={kind} onChange={(ev) => setKind(ev.target.value as 'cover' | 'art')}><option value="cover">Cover brief</option><option value="art">Art brief</option></select>
            <input aria-label="Brief title" placeholder="Cover for Book Four" value={title} onChange={(ev) => setTitle(ev.target.value)} />
          </div>
          <textarea aria-label="Brief" rows={4} placeholder="What it must show, the feel, comparable covers, what to avoid" value={body} onChange={(ev) => setBody(ev.target.value)} style={{ width: '100%' }} />
          <button type="submit" disabled={!title.trim() || !body.trim()}>Write the brief</button>
        </form>
      )}
      {s.briefs.length === 0 ? (
        <section className="card"><p className="muted">No briefs for {s.project.name} yet.</p></section>
      ) : (
        <section className="card" aria-label="Briefs">
          <ul className="plain work-list">
            {s.briefs.map((b: ArtBriefRow) => (
              <li key={b.id}>
                <button type="button" className="link" onClick={() => onOpen(b.id)}>{b.title}</button> <span className="chip">{b.kind === 'cover' ? 'Cover brief' : 'Art brief'}</span>
                <span className="muted small"> version {b.version} · {plural(b.concepts, 'concept')}</span> {b.chosen && <span className="chip ok">concept chosen</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function BriefDetail({ id, onBack, act }: { id: string; onBack: () => void; act: (j: () => Promise<unknown>) => Promise<boolean> }) {
  const [v, setV] = useState<BriefView | null>(null);
  const reload = useCallback(() => art.brief(id).then(setV, () => undefined), [id]);
  useEffect(() => void reload(), [reload]);
  if (!v) return <p className="muted">Loading…</p>;
  if (!v.available) return <section className="card"><button type="button" className="link" onClick={onBack}>Back</button><p className="muted">{v.reason}</p></section>;
  const run = async (job: () => Promise<unknown>) => {
    if (await act(job)) await reload();
  };
  return <BriefBody v={v} onBack={onBack} run={run} />;
}

function BriefBody({ v, onBack, run }: { v: BriefReady; onBack: () => void; run: (j: () => Promise<unknown>) => Promise<void> }) {
  const [body, setBody] = useState(v.brief.body);
  const [note, setNote] = useState('');
  const [file, setFile] = useState('');
  const chosenFile = v.candidates.some((c) => c.fileId === file) ? file : v.candidates.length === 1 ? v.candidates[0]!.fileId : '';
  return (
    <div className="brief">
      <button type="button" className="link" onClick={onBack}>← All briefs</button>
      <div className="row"><h3 style={{ margin: 0 }}>{v.brief.title}</h3> <span className="chip">{v.brief.kind === 'cover' ? 'Cover brief' : 'Art brief'}</span> <span className="muted small">version {v.brief.version}, {v.brief.writtenByName}, {day(v.brief.writtenAt)}</span></div>
      {v.may.brief ? (
        <form aria-label="Revise the brief" onSubmit={(ev) => { ev.preventDefault(); void run(() => window.cadrel.art.call('reviseBrief', v.brief.id, { body, note, basedOn: v.brief.version })).then(() => setNote('')); }}>
          <textarea aria-label="Brief" rows={6} value={body} onChange={(ev) => setBody(ev.target.value)} style={{ width: '100%' }} />
          <div className="row"><input aria-label="What changed" placeholder="What changed" value={note} onChange={(ev) => setNote(ev.target.value)} /><button type="submit" disabled={body.trim() === v.brief.body.trim()}>Save as version {v.brief.version + 1}</button></div>
        </form>
      ) : <p style={{ whiteSpace: 'pre-wrap' }}>{v.brief.body}</p>}
      {v.versions.length > 1 && <details><summary>Earlier versions ({v.versions.length - 1})</summary>{v.versions.slice(1).map((x) => <div key={x.n}><p className="muted small">Version {x.n}, {x.writtenByName}, {day(x.writtenAt)}{x.note ? `: ${x.note}` : ''}</p><p style={{ whiteSpace: 'pre-wrap' }}>{x.body}</p></div>)}</details>}
      <h4>Concepts</h4>
      {v.may.write && v.candidates.length > 0 && (
        <form className="row" aria-label="Offer a concept" onSubmit={(ev) => { ev.preventDefault(); void run(() => window.cadrel.art.call('submitConcept', { briefId: v.brief.id, fileId: chosenFile })); }}>
          {v.candidates.length === 1 ? <span className="muted small">{v.candidates[0]!.path} (version {v.candidates[0]!.version})</span> : (
            <select aria-label="Concept file" value={chosenFile} onChange={(ev) => setFile(ev.target.value)}><option value="">File…</option>{v.candidates.map((c: ArtCandidate) => <option key={c.fileId} value={c.fileId}>{c.path} (version {c.version})</option>)}</select>
          )}
          <button type="submit" disabled={!chosenFile}>Offer as a concept</button>
        </form>
      )}
      {v.concepts.length === 0 && <p className="muted small">No concepts yet.</p>}
      <div className="grid-2">
        {v.concepts.map((c) => <ConceptCard key={c.id} c={c} may={v.may} run={run} />)}
      </div>
    </div>
  );
}

function ConceptCard({ c, may, run }: { c: ConceptRow; may: BriefReady['may']; run: (j: () => Promise<unknown>) => Promise<void> }) {
  const [pin, setPin] = useState<Region | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState('');
  return (
    <section className="card" aria-label={`Concept ${c.path}`}>
      <div className="row"><strong>{c.path}</strong> <span className="muted small">version {c.fileVersion}, {c.byName}</span> <span className={`chip ${c.state === 'chosen' ? 'ok' : ''}`}>{CONCEPT_STATE[c.state]}</span></div>
      <Picture fileId={c.fileId} version={c.fileVersion} marks={c.feedback.filter((f) => f.region && f.state === 'open')} onPin={may.comment ? setPin : undefined} pin={pin} />
      {c.note && <p className="muted small">{c.note}</p>}
      {may.comment && <CommentForm target={{ targetKind: 'concept', targetId: c.id }} version={c.fileVersion} pin={pin} onDone={() => setPin(null)} run={run} />}
      <FeedbackList items={c.feedback} canResolve={may.comment} run={run} />
      {may.approve && c.state !== 'chosen' && c.state !== 'rejected' && (
        <div className="row">
          {c.state !== 'shortlisted' && <button type="button" onClick={() => void run(() => window.cadrel.art.call('decideConcept', c.id, 'shortlisted'))}>Shortlist</button>}
          <button type="button" onClick={() => void run(() => window.cadrel.art.call('chooseConcept', c.id))}>Choose this concept</button>
          {rejecting ? (
            <>
              <input aria-label="Why not" placeholder="Why not" value={why} onChange={(ev) => setWhy(ev.target.value)} />
              <button type="button" disabled={!why.trim()} onClick={() => void run(() => window.cadrel.art.call('decideConcept', c.id, 'rejected', why))}>Reject</button>
            </>
          ) : <button type="button" onClick={() => setRejecting(true)}>Reject…</button>}
        </div>
      )}
      {c.state === 'chosen' && <p className="muted small">Chosen. It is an asset in review now; approve a version of it on the Assets tab.</p>}
    </section>
  );
}
