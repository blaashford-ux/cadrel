import { useEffect, useState } from 'react';
import type { CategoryReport, Opportunity, OpportunityWeights, SalesCurve } from '../../shared/api.js';
import { ChartCard, GroupedBars, Legend, S1 } from '../charts.js';

const api = window.cadrelMarket;
const num = (v: number | null | undefined, d = 1) => (v == null ? '–' : Number(v.toFixed(d)).toLocaleString('en-US'));
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const COMPONENT_NAMES: Record<keyof OpportunityWeights, string> = {
  demand: 'Demand',
  reviewBarrier: 'Review barrier',
  openness: 'Openness',
  churn: 'Churn',
};
const COMPONENT_HELP: Record<keyof OpportunityWeights, string> = {
  demand: 'Estimated sales per day of the book at #20 on the list. A list where #20 sells almost nothing is not worth entering.',
  reviewBarrier: 'Median ratings on the top books. Few ratings means a new book can compete (50 or fewer scores 1, 2,000 or more scores 0).',
  openness: 'Share of the top books published in the last year. New books reaching the top means the door is open.',
  churn: 'Share of today’s top books that were not in the top when the list was first captured. Needs two captures a day or more apart.',
};

function OpportunityWeightsEditor({ onSaved }: { onSaved: () => void }) {
  const [w, setW] = useState<OpportunityWeights | null>(null);
  const [curve, setCurve] = useState<SalesCurve | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { void api.opportunityWeights().then(setW); void api.salesCurve().then(setCurve); }, []);
  if (!w || !curve) return null;
  const field = (k: keyof OpportunityWeights) => (
    <label>{COMPONENT_NAMES[k]} <input type="number" min={0} max={1} step={0.05} value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} style={{ width: 70 }} /></label>
  );
  const save = async (f: () => Promise<unknown>, ok: string) => {
    try { await f(); setMsg(ok); onSaved(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <>
      <div className="row">
        {(Object.keys(COMPONENT_NAMES) as (keyof OpportunityWeights)[]).map((k) => <span key={k}>{field(k)}</span>)}
        <button onClick={() => save(async () => setW(await api.setOpportunityWeights(w)), 'Weights saved')}>Save opportunity weights</button>
      </div>
      <div className="row">
        <label>Sales per day at rank 1: <input type="number" min={1} step={100} value={curve.a} onChange={(e) => setCurve({ ...curve, a: Number(e.target.value) })} style={{ width: 90 }} aria-label="Curve constant a" /></label>
        <label>Falloff exponent: <input type="number" min={0.1} max={3} step={0.01} value={curve.b} onChange={(e) => setCurve({ ...curve, b: Number(e.target.value) })} style={{ width: 70 }} aria-label="Curve exponent b" /></label>
        <button onClick={() => save(async () => setCurve(await api.setSalesCurve(curve)), 'Sales curve saved')}>Save sales curve</button>
        <span role="status" className="muted">{msg}</span>
      </div>
      <div className="muted">Sales per day = a × rank<sup>−b</sup>. The default is a rough fit to commonly quoted Kindle figures; replace it with numbers you trust.</div>
    </>
  );
}

export function OpportunityPanel({ r, onChanged }: { r: CategoryReport; onChanged: () => void }) {
  const o = r.opportunity;
  const comps = Object.entries(o.components) as [keyof OpportunityWeights, Opportunity['components'][keyof OpportunityWeights]][];
  return (
    <div className="card" aria-label="Opportunity">
      <h2 style={{ marginTop: 0 }}>Opportunity</h2>
      <p className="muted">
        How attractive this category looks for a new book, from 0 to 100. It blends four measures; measures with no data yet are left out and the others re-weighted, so a score with
        items under "Missing" is less certain. It is an estimate built on top-100 lists, not a forecast.
      </p>
      <div className="tiles">
        <div className="tile"><div className="n">{o.score == null ? '–' : num(o.score)}</div><div className="l">opportunity score (0–100)</div></div>
        <div className="tile"><div className="n">{num(o.benchmarks.medianRatingCount, 0)}</div><div className="l">median ratings, top {o.topN}</div></div>
        <div className="tile"><div className="n">{o.benchmarks.booksUnder100Ratings}</div><div className="l">of the top {o.topN} have under 100 ratings</div></div>
        <div className="tile"><div className="n">{o.benchmarks.newWithin365d.known ? `${o.benchmarks.newWithin365d.count} of ${o.benchmarks.newWithin365d.known}` : '–'}</div><div className="l">top {o.topN} published in the last year</div></div>
      </div>
      <Legend items={[{ color: S1, label: 'Component score (0 bad for a new book, 1 good)' }]} />
      <table>
        <thead><tr><th>Component</th><th>Score</th><th className="num">Value</th><th>Basis</th></tr></thead>
        <tbody>
          {comps.map(([k, c]) => (
            <tr key={k} data-component={k}>
              <td title={COMPONENT_HELP[k]}>{COMPONENT_NAMES[k]}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{c.normalized == null ? <span className="muted">Missing</span> : <><span className="minibar" style={{ width: `${c.normalized * 80}px` }} /> {num(c.normalized, 2)}</>}</td>
              <td className="num">{num(c.raw, 2)}</td>
              <td className="muted">{c.basis}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Depth: what it takes to sit at each place on the list</h3>
      {o.depth.at ? (
        <table>
          <thead><tr><th className="num">List position</th><th className="num">Est. Kindle Store rank</th><th className="num">Est. sales per day</th></tr></thead>
          <tbody>{o.depth.at.map((p) => <tr key={p.listRank}><td className="num">#{p.listRank}</td><td className="num">{num(p.overallRank, 0)}</td><td className="num">{num(p.estDailySales)}</td></tr>)}</tbody>
        </table>
      ) : null}
      <div className="muted">{o.depth.caveat}</div>
      <h3>Adjust</h3>
      <OpportunityWeightsEditor onSaved={onChanged} />
    </div>
  );
}

export function CompareCategories({ topN, current, onPick, version }: { topN: number; current: string; onPick: (key: string) => void; version: number }) {
  const [rows, setRows] = useState<Opportunity[] | null>(null);
  useEffect(() => { void api.rankCategories(topN).then(setRows); }, [topN, version]);
  if (!rows || rows.length < 2) return null;
  return (
    <div className="card" aria-label="Compare categories">
      <h2 style={{ marginTop: 0 }}>Compare categories</h2>
      <div className="muted">Every category with a list capture, best opportunity first. Compare scores only between rows with the same "Missing" column.</div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Category</th><th>Score</th><th className="num">Median ratings</th><th className="num">Est. sales/day at #20</th><th>Missing</th></tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.category} data-category={o.category} style={o.category === current ? { fontWeight: 600 } : undefined}>
              <td><button className="link" onClick={() => onPick(o.category)}>{o.name ?? o.category}</button></td>
              <td style={{ whiteSpace: 'nowrap' }}>{o.score == null ? '–' : <><span className="minibar" style={{ width: `${o.score * 0.8}px` }} /> {num(o.score)}</>}</td>
              <td className="num">{num(o.benchmarks.medianRatingCount, 0)}</td>
              <td className="num">{num(o.components.demand.raw)}</td>
              <td className="muted">{o.missing.join(', ') || '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SIGNAL_TEXT: Record<string, string> = {
  gap: 'Gap: common at the top, thin below',
  crowded: 'Crowded: many books below, few at the top',
  neutral: 'Neither',
  thin: 'Too few books to say',
};

export function ClustersPanel({ r }: { r: CategoryReport }) {
  const c = r.clusters;
  const A = `Top ${c.topN}`;
  return (
    <ChartCard
      title="Trope clusters"
      note={<>Books grouped by what their titles and blurbs are about. {c.withBlurb} of {c.books} have a blurb (the rest are grouped by title). {c.unclustered} matched no group.</>}
      table={{ head: ['Theme', 'Signal', `${A} books`, 'Rest books', 'Lift'], rows: c.clusters.map((x) => [x.label.join(', '), x.signal, x.top, x.rest, num(x.lift, 2)]) }}
    >
      {c.caveats.map((t, i) => <div key={i} className="muted">{t}</div>)}
      {c.clusters.length > 0 && (
        <>
          <GroupedBars
            label="Share of the top cohort and of the rest in each trope cluster"
            aLabel={A} bLabel="Rest"
            rows={c.clusters.slice(0, 6).map((x) => ({ label: trunc(x.label[0] ?? `#${x.id}`, 11), a: x.topShare ?? 0, b: x.restShare ?? 0, aN: x.top, bN: x.rest }))}
          />
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Theme</th><th>Signal</th><th className="num">Books</th><th className="num">{A}</th><th className="num">Rest</th><th className="num">Median ratings</th><th>Examples</th></tr></thead>
            <tbody>
              {c.clusters.map((x) => (
                <tr key={x.id} data-cluster={x.id}>
                  <td title={x.tropes.length ? `Tropes in most of these books: ${x.tropes.join(', ')}` : undefined}>{x.label.join(', ')}</td>
                  <td><span className={`pill${x.signal === 'gap' ? ' opened' : ''}`} title={SIGNAL_TEXT[x.signal]}>{x.signal}</span></td>
                  <td className="num">{x.books}</td>
                  <td className="num">{x.top} ({pct(x.topShare)})</td>
                  <td className="num">{x.rest} ({pct(x.restShare)})</td>
                  <td className="num">{num(x.medianRatingCount, 0)}</td>
                  <td className="muted">{x.examples.map((e) => `#${e.listRank} ${trunc(e.title ?? e.asin, 36)}`).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ marginTop: 6 }}>Gap = a bigger share of the top than of the rest. Crowded = a bigger share of the rest than of the top. Check the examples before trusting a theme.</div>
        </>
      )}
    </ChartCard>
  );
}

export function ShelvesPanel({ r }: { r: CategoryReport }) {
  const rows = r.shelves.filter((s) => s.salesToTop10 != null);
  return (
    <div className="card" aria-label="Sub-category shelves">
      <h2 style={{ marginTop: 0 }}>Sub-category shelves</h2>
      <p className="muted">
        Estimated sales per day a book needs to reach the top 10 of each shelf, worked out from the sub-category ranks on captured book pages (covering every category in the library).
        Niche shelves with several books behind them are the leads; shelves marked "No" have no list capture yet, so capture them to check.
      </p>
      {rows.length === 0 ? (
        <div className="muted">Nothing to estimate yet: it needs book pages whose sub-category ranks fall in a shelf's top 100.</div>
      ) : (
        <table>
          <thead><tr><th>Shelf</th><th>Label</th><th className="num">Sales/day to reach #10</th><th className="num">Books used</th><th>List captured</th></tr></thead>
          <tbody>
            {rows.slice(0, 20).map((s) => (
              <tr key={s.key} data-shelf={s.key} title={s.note}>
                <td>
                  <button className="link" onClick={() => void api.openShelf(s.key).catch(() => {})} title={`Open ${s.name ?? s.key} Best Sellers on Amazon`}>{s.name ?? s.key}</button>{' '}
                  <span className="muted">({s.store === 'books' ? 'Books' : 'Kindle'})</span>
                </td>
                <td><span className={`pill${s.label === 'niche' ? ' opened' : ''}`}>{s.label}</span></td>
                <td className="num">{num(s.salesToTop10)}</td>
                <td className="num">{s.usedBooks}</td>
                <td>{s.listCaptured ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ marginTop: 6 }}>Dead: under 1 sale/day. Niche: 1–10. Competitive: 10–50. Hot: 50 or more. Estimates ignore Kindle Unlimited.</div>
    </div>
  );
}

type Tally = CategoryReport['characters']['mainCharacterGender'][number];

function TallyTable({ title, note, rows, A, empty }: { title: string; note?: string; rows: Tally[]; A: string; empty?: string }) {
  return (
    <ChartCard title={title} note={note} table={{ head: ['', A, 'Rest'], rows: rows.map((t) => [t.label, `${t.top} (${pct(t.topShare)})`, `${t.rest} (${pct(t.restShare)})`]) }}>
      {rows.length ? (
        <GroupedBars
          label={`${title}, top cohort against the rest`} aLabel={A} bLabel="Rest"
          rows={rows.slice(0, 8).map((t) => ({ label: trunc(t.label, 14), a: t.topShare ?? 0, b: t.restShare ?? 0, aN: t.top, bN: t.rest }))}
        />
      ) : <div className="muted">{empty ?? 'Nothing found in the blurbs read.'}</div>}
    </ChartCard>
  );
}

/** Main character and love interest(s): gender, dual POV, archetypes and tropes, read from blurbs. */
export function CharactersPanel({ r, onRerun }: { r: CategoryReport; onRerun: () => void }) {
  const c = r.characters;
  const A = `Top ${c.topN}`;
  return (
    <section aria-label="Main character and love interests">
      <div className="row">
        <h2 style={{ margin: 0 }}>Main character and love interest(s)</h2>
        <span className="spacer" />
        <span className="muted" role="status">Last run {new Date(r.generatedAt).toLocaleTimeString()}</span>
        <button onClick={onRerun} title="Read every book's blurb, sample and uploaded text again, for example after reading a sample or attaching a book file">Re-run character analysis</button>
      </div>
      <div className="banner">
        <ul>{c.caveats.map((t, i) => <li key={i}>{t}</li>)}</ul>
        <div className="muted">Books read: {c.readable.top} in the {A.toLowerCase()}, {c.readable.rest} in the rest; {c.withText.top} and {c.withText.rest} of them with a sample or uploaded text as well as the blurb.</div>
      </div>
      {c.readable.top + c.readable.rest === 0 ? <div className="muted">Capture some book pages first; this is read from their blurbs, samples and uploaded text.</div> : (
        <>
          <div className="two">
            <TallyTable title="Main character gender" rows={c.mainCharacterGender} A={A} />
            <TallyTable title="Love interest gender" note="Among blurbs with a romance. With a lead of the same gender the pronouns cannot say, so those show as not stated." rows={c.loveInterestGender} A={A} />
          </div>
          <div className="two">
            <TallyTable title="Number of love interests" rows={c.loveInterestCount} A={A} />
            <ChartCard title="Dual POV" note="Counted only when the blurb names dual or alternating points of view." table={{ head: ['', A, 'Rest'], rows: [['Names dual POV', `${c.dualPov.top} (${pct(c.dualPov.topShare)})`, `${c.dualPov.rest} (${pct(c.dualPov.restShare)})`]] }}>
              <GroupedBars label="Dual POV named in the blurb" aLabel={A} bLabel="Rest" rows={[{ label: 'Dual POV', a: c.dualPov.topShare ?? 0, b: c.dualPov.restShare ?? 0, aN: c.dualPov.top, bN: c.dualPov.rest }]} />
            </ChartCard>
          </div>
          <div className="two">
            <TallyTable title="Main character archetypes" rows={c.mainCharacterArchetypes} A={A} />
            <TallyTable title="Love interest archetypes" rows={c.loveInterestArchetypes} A={A} />
          </div>
          <TallyTable title="Character and relationship tropes" rows={c.tropes} A={A} />
        </>
      )}
    </section>
  );
}
