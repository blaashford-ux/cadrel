import { useEffect, useState } from 'react';
import type { CategoryReport, CategorySummary, Weights } from '../../shared/api.js';
import { CommunitySources } from './CommunitySources.js';
import { NotesButton } from '../NotesButton.js';
import { CommunityInsightsPanel } from './CommunityInsights.js';
import { CharactersPanel, ClustersPanel, CompareCategories, OpportunityPanel, ShelvesPanel } from './OpportunityPanels.js';
import { ChartCard, GroupedBars, HBars, LineChart, Legend, S1, S2, Scatter } from '../charts.js';

const api = window.bookscout;
const num = (v: number | null | undefined, d = 1) => (v == null ? '–' : Number(v.toFixed(d)).toLocaleString('en-US'));
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const share = (rows: { count: number }[]) => {
  const t = rows.reduce((n, r) => n + r.count, 0);
  return rows.map((r) => (t ? r.count / t : 0));
};

function Tile({ n, l }: { n: string; l: string }) {
  return <div className="tile"><div className="n">{n}</div><div className="l">{l}</div></div>;
}

function Cohort({ r, topN }: { r: CategoryReport; topN: number }) {
  const rows: [string, string][] = [['price', 'Price ($)'], ['rating', 'Rating'], ['ratingCount', 'Ratings'], ['pages', 'Pages'], ['publicationYear', 'Publication year'], ['seriesPosition', 'Series position']];
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Top {topN} against the rest</h2>
      <table>
        <thead><tr><th>Metric (median)</th><th className="num">Top {topN}</th><th className="num">Rest</th><th className="num">Books with data (top / rest)</th></tr></thead>
        <tbody>
          {rows.map(([k, name]) => {
            const a = r.cohort.top.metrics[k]!, b = r.cohort.rest.metrics[k]!;
            const fmt = (v: number | null) => (k === 'publicationYear' ? (v == null ? '–' : String(Math.round(v))) : num(v, 2));
            return <tr key={k}><td>{name}</td><td className="num">{fmt(a.median)}</td><td className="num">{fmt(b.median)}</td><td className="num">{a.known} / {b.known}</td></tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function Weighting({ onSaved }: { onSaved: () => void }) {
  const [w, setW] = useState<Weights | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { void api.successWeights().then(setW); }, []);
  if (!w) return null;
  const field = (k: keyof Weights, label: string) => (
    <label>{label} <input type="number" min={0} max={1} step={0.05} value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} style={{ width: 70 }} /></label>
  );
  return (
    <div className="row">
      {field('rank', 'Rank')}{field('stability', 'Stability')}{field('velocity', 'Velocity')}
      <button onClick={async () => { try { setW(await api.setSuccessWeights(w)); setMsg('Saved'); onSaved(); } catch (e) { setMsg((e as Error).message); } }}>Apply weights</button>
      <span role="status" className="muted">{msg}</span>
    </div>
  );
}

export function AnalysisView({ version }: { version: number }) {
  const [cats, setCats] = useState<CategorySummary[]>([]);
  const [cat, setCat] = useState('');
  const [topN, setTopN] = useState(10);
  const [r, setR] = useState<CategoryReport | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  const [sub, setSub] = useState<'category' | 'text' | 'community'>('category');

  useEffect(() => {
    void api.categories().then((c) => { setCats(c); if (!cat && c[0]) setCat(c[0].key); });
  }, [version]);
  useEffect(() => {
    if (!cat) return;
    setErr('');
    api.analysis(cat, topN).then(setR, (e) => setErr(String(e.message ?? e)));
  }, [cat, topN, version, tick]);

  if (cats.length === 0) return <><h1>Analysis</h1><p className="muted">Capture a bestseller list first; the analysis is built from it.</p></>;
  const A = `Top ${topN}`;

  return (
    <>
      <h1>Analysis</h1>
      <div className="row">
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          {cats.map((c) => <option key={c.key} value={c.key}>{c.name ?? c.key}</option>)}
        </select>
        <label>Top <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} aria-label="Top N">{[5, 10, 20, 30].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <button onClick={async () => { const p = await api.exportCategory(cat, 'csv', topN); setMsg(p ? `Saved ${p}` : ''); }}>Export CSV</button>
        <button onClick={async () => { const p = await api.exportCategory(cat, 'md', topN); setMsg(p ? `Saved ${p}` : ''); }}>Export report</button>
        <NotesButton kind="category" id={cat} label={cats.find((c) => c.key === cat)?.name ?? cat} />
        <span role="status" className="muted">{msg}</span>
      </div>
      <CommunitySources categoryKey={cat} />
      <div className="subtabs" aria-label="Analysis sections">
        {([['category', 'Category Analysis'], ['text', 'Text Analysis'], ['community', 'Reader Community']] as const).map(([id, label]) => (
          <button key={id} className="tab" aria-pressed={sub === id} onClick={() => setSub(id)}>{label}</button>
        ))}
      </div>
      {sub === 'community' && <CommunityInsightsPanel categoryKey={cat} version={version} />}
      {err && sub !== 'community' && <div className="err" role="alert">{err}</div>}
      {r && sub !== 'community' && (
        <>
          <div className="banner" aria-label="Read this first">
            <strong>Read this first</strong>
            <ul>{r.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>

          {sub === 'category' && (
            <>
          <div className="tiles">
            <Tile n={String(r.books)} l="books on the list" />
            <Tile n={`${r.booksWithDetail}`} l="with detail pages" />
            <Tile n={num(r.cohort.top.metrics.price!.median, 2)} l={`median price, ${A.toLowerCase()} ($)`} />
            <Tile n={pct(r.market.series.top.share)} l={`in a series, ${A.toLowerCase()}`} />
          </div>

          <OpportunityPanel r={r} onChanged={() => setTick((t) => t + 1)} />
          <CompareCategories topN={topN} current={cat} onPick={setCat} version={version + tick} />

          <Cohort r={r} topN={topN} />

          <div className="two">
            <ChartCard
              title="Price"
              note={`Share of each group in each price band. Rank vs price: ρ = ${r.market.rankPriceCorrelation.rho ?? 'n/a'} (${r.market.rankPriceCorrelation.n} books; negative means better-ranked books cost more).`}
              table={{ head: ['Band', `${A} books`, 'Rest books'], rows: r.market.priceBands.top.map((b, i) => [b.label, b.count, r.market.priceBands.rest[i]!.count]) }}
            >
              <GroupedBars
                label="Price bands, top cohort against the rest"
                aLabel={A} bLabel="Rest"
                rows={(() => {
                  const a = share(r.market.priceBands.top), b = share(r.market.priceBands.rest);
                  return r.market.priceBands.top.map((x, i) => ({ label: x.label.replace('Under ', '<'), a: a[i]!, b: b[i]!, aN: x.count, bN: r.market.priceBands.rest[i]!.count }));
                })()}
              />
            </ChartCard>
            <ChartCard title="Rank against price" note="Each dot is a book; hover for its title." table={{ head: ['Rank', 'Price', 'Title'], rows: r.market.scatter.map((p) => [p.rank, p.price, p.title ?? p.asin]) }}>
              <Scatter
                label="List rank against price" aLabel={A} bLabel="Rest" xLabel="List rank (1 = best)" yLabel="Price ($)"
                points={r.market.scatter.map((p) => ({ x: p.rank, y: p.price, a: p.rank <= topN, tip: `#${p.rank} · $${p.price} · ${p.title ?? p.asin}` }))}
              />
            </ChartCard>
          </div>

          <div className="tiles">
            <Tile n={r.market.age.top.medianDays == null ? '–' : `${r.market.age.top.medianDays} d`} l={`median age, ${A.toLowerCase()}`} />
            <Tile n={r.market.age.rest.medianDays == null ? '–' : `${r.market.age.rest.medianDays} d`} l="median age, rest" />
            <Tile n={`${r.market.age.top.within90d} of ${r.market.age.top.known}`} l={`${A.toLowerCase()} released in last 90 days`} />
            <Tile n={`${r.market.series.top.book1} of ${r.market.series.top.books}`} l={`${A.toLowerCase()} that are book 1`} />
          </div>

          <div className="two">
            <ChartCard
              title="Length"
              note={`Pages, books with detail pages only (${r.market.pageBands.known.top} in ${A.toLowerCase()}, ${r.market.pageBands.known.rest} in the rest).`}
              table={{ head: ['Band', `${A} books`, 'Rest books'], rows: r.market.pageBands.top.map((b, i) => [b.label, b.count, r.market.pageBands.rest[i]!.count]) }}
            >
              <GroupedBars
                label="Page-count bands, top cohort against the rest" aLabel={A} bLabel="Rest"
                rows={(() => {
                  const a = share(r.market.pageBands.top), b = share(r.market.pageBands.rest);
                  return r.market.pageBands.top.map((x, i) => ({ label: x.label, a: a[i]!, b: b[i]!, aN: x.count, bN: r.market.pageBands.rest[i]!.count }));
                })()}
              />
            </ChartCard>
            <ChartCard title="Also ranked in" note="Other categories these books appear in (books with detail pages)." table={{ head: ['Category', 'Books'], rows: r.market.coCategories.map((c) => [c.name, c.books]) }}>
              {r.market.coCategories.length ? <HBars label="Co-categories" unit="" rows={r.market.coCategories.slice(0, 8).map((c) => ({ label: c.name.length > 26 ? c.name.slice(0, 25) + '…' : c.name, value: c.books }))} /> : <div className="muted">None yet.</div>}
            </ChartCard>
          </div>

          <ShelvesPanel r={r} />

          <ChartCard
            title="Covers"
            note={r.covers.pending ? `${r.covers.pending} cover(s) could not be analysed.` : 'Measured from the stored cover images; busyness is edge density, a proxy for how much lettering and detail there is, not a text reader.'}
          >
            {r.covers.top.known + r.covers.rest.known === 0 ? (
              <div className="muted">No covers captured yet. The browser extension saves each book's cover with its page.</div>
            ) : (
              <table>
                <thead><tr><th>Measure</th><th className="num">{A} ({r.covers.top.known})</th><th className="num">Rest ({r.covers.rest.known})</th></tr></thead>
                <tbody>
                  {([['brightness', 'Brightness (0 dark – 1 light)'], ['contrast', 'Contrast'], ['saturation', 'Saturation'], ['warmth', 'Warmth (−1 cool … +1 warm)'], ['edgeDensity', 'Busyness']] as const).map(([k, n]) => (
                    <tr key={k}><td>{n}</td><td className="num">{num(r.covers.top[k], 2)}</td><td className="num">{num(r.covers.rest[k], 2)}</td></tr>
                  ))}
                  <tr><td>Dominant hues</td>{(['top', 'rest'] as const).map((g) => <td key={g} className="num">{Object.entries(r.covers[g].dominantHues).sort((a, b) => b[1] - a[1]).map(([h, c]) => `${h} ${c}`).join(', ') || '–'}</td>)}</tr>
                </tbody>
              </table>
            )}
          </ChartCard>

          <div className="two">
            <ChartCard title="Median price over time" note="From each capture of this list.">
              <LineChart label="Median price per list capture" yLabel="$" points={r.trends.median_price.map((p) => ({ x: p.bucket, y: p.value }))} />
            </ChartCard>
            <ChartCard title="Median ratings count over time" note="Books gaining ratings quickly are selling.">
              <LineChart label="Median ratings count per list capture" yLabel="ratings" points={r.trends.median_rating_count.map((p) => ({ x: p.bucket, y: p.value }))} />
            </ChartCard>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Success score</h2>
            <p className="muted">
              A blend of three measures, each scored 0–1 against the rest of the category: rank on the list, how steady that rank is across captures, and how fast ratings arrive.
              Measures with no data yet are left out and the others re-weighted, so compare scores with the same "Missing" column.
            </p>
            <Weighting onSaved={() => setTick((t) => t + 1)} />
            <Legend items={[{ color: S1, label: 'Score (0–100)' }]} />
            <table>
              <thead><tr><th className="num">Rank</th><th>Title</th><th>Score</th><th className="num">Rank</th><th className="num">Stability</th><th className="num">Velocity (ratings/day)</th><th>Missing</th></tr></thead>
              <tbody>
                {r.scores.slice(0, 15).map((s) => (
                  <tr key={s.asin} data-asin={s.asin}>
                    <td className="num">{s.listRank}</td>
                    <td>{s.title ?? s.asin}</td>
                    <td style={{ whiteSpace: 'nowrap' }} title={`${s.components.velocity.basis}`}>{s.score == null ? '–' : <><span className="minibar" style={{ width: `${s.score * 0.8}px` }} /> {num(s.score)}</>}</td>
                    <td className="num">{num(s.components.rank.normalized, 2)}</td>
                    <td className="num">{num(s.components.stability.normalized, 2)}</td>
                    <td className="num" title={s.components.velocity.basis}>{num(s.components.velocity.raw, 2)}</td>
                    <td className="muted">{s.missing.join(', ') || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            </>
          )}
          {sub === 'text' && (
            <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Packaging</h2>
            <div className="muted">Titles use every listed book; blurbs only books with detail pages ({r.packaging.books.withBlurb.top} in the {A.toLowerCase()}, {r.packaging.books.withBlurb.rest} in the rest).</div>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Measure</th><th className="num">{A}</th><th className="num">Rest</th></tr></thead>
              <tbody>
                {([['title_words', 'Title length (words)'], ['blurb_words', 'Blurb length (words)'], ['hook_words', 'First sentence (words)'], ['reading_ease', 'Reading ease (Flesch)']] as const).map(([k, n]) => (
                  <tr key={k}><td>{n}</td><td className="num">{num(r.packaging.numeric[k]!.top.median)}</td><td className="num">{num(r.packaging.numeric[k]!.rest.median)}</td></tr>
                ))}
                {([['has_subtitle', 'Has a subtitle'], ['series_in_title', 'Series named in title'], ['has_question_hook', 'Blurb asks a question'], ['has_bullets', 'Blurb has bullet lines'], ['call_to_action', 'Blurb has a call to action'], ['comp_titles', 'Names comparable books/authors'], ['prestige_claims', 'Bestseller/award claims']] as const).map(([k, n]) => (
                  <tr key={k}><td>{n}</td><td className="num">{pct(r.packaging.flags[k]!.top.share)}</td><td className="num">{pct(r.packaging.flags[k]!.rest.share)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="two">
            <ChartCard title="Tropes in blurbs" note={`Share of ${A.toLowerCase()} blurbs naming each (books with detail pages).`} table={{ head: ['Trope', `${A}`, 'Rest'], rows: r.packaging.tropes.map((t) => [t.trope, `${t.top} (${pct(t.topShare)})`, `${t.rest} (${pct(t.restShare)})`]) }}>
              {r.packaging.tropes.length ? <HBars label="Tropes among top-cohort blurbs" rows={r.packaging.tropes.slice(0, 10).map((t) => ({ label: t.trope, value: t.topShare ?? 0, note: `${t.top} books` }))} /> : <div className="muted">No tropes found.</div>}
            </ChartCard>
            <ChartCard
              title="What readers talk about"
              note={`${r.voice.all.withText} on-page reviews pooled. ${r.voice.caveat}`}
              table={{ head: ['Theme', 'Mentioned in', '4–5★ reviews', '1–2★ reviews'], rows: Object.entries(r.voice.all.themes).map(([k, t]) => [k, pct(t.rate), t.inPositive, t.inNegative]) }}
            >
              {r.voice.all.withText ? <HBars label="Review themes" rows={Object.entries(r.voice.all.themes).sort((a, b) => b[1].rate - a[1].rate).slice(0, 8).map(([k, t]) => ({ label: k, value: t.rate, note: `${t.mentions} reviews` }))} /> : <div className="muted">No reviews captured yet.</div>}
            </ChartCard>
          </div>

          <CharactersPanel r={r} onRerun={() => setTick((t) => t + 1)} />

          <ClustersPanel r={r} />

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Inside the books</h2>
            {r.content.caveats.map((c, i) => <div key={i} className="muted">{c}</div>)}
            {r.content.top.known + r.content.rest.known > 0 && (
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Measure (median)</th><th className="num">{A} ({r.content.top.known})</th><th className="num">Rest ({r.content.rest.known})</th></tr></thead>
                <tbody>
                  {([['dialogue_share', 'Dialogue share of words', true], ['avg_sentence_words', 'Average sentence (words)', false], ['short_sentence_share', 'Sentences of 6 words or fewer', true], ['reading_ease', 'Reading ease (Flesch)', false], ['grade_level', 'Grade level', false], ['opening_first_sentence_words', 'Opening sentence (words)', false], ['opening_dialogue_share', 'Dialogue in the opening', true], ['opening_proper_nouns_per_100', 'Names introduced per 100 words, opening', false]] as const).map(([k, name, isPct]) => (
                    <tr key={k}><td>{name}</td>
                      <td className="num">{isPct ? pct(r.content.top.metrics[k]!.median) : num(r.content.top.metrics[k]!.median)}</td>
                      <td className="num">{isPct ? pct(r.content.rest.metrics[k]!.median) : num(r.content.rest.metrics[k]!.median)}</td></tr>
                  ))}
                  <tr><td>Opens with dialogue</td><td className="num">{pct(r.content.top.startsWithDialogue.share)}</td><td className="num">{pct(r.content.rest.startsWithDialogue.share)}</td></tr>
                </tbody>
              </table>
            )}
          </div>

            </>
          )}
        </>
      )}
    </>
  );
}
