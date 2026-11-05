import { useEffect, useRef, useState } from 'react';
import type { OwnBookRow, CategorySummary, KeywordHistoryRow, KeywordIdea, KeywordString, InjectedSuggestion, OutlineRef, KeywordJob, KeywordLookupResult, KeywordRow, KeywordTable, SuggestSource } from '../../shared/api.js';
import { DataTable, type Column } from './DataTable.js';
import { scopedCategories, useMarketScope } from '../scope.js';

const api = window.cadrelMarket;
const LABEL: Record<SuggestSource, string> = { amazon: 'Amazon', google: 'Google', bing: 'Bing' };
const day = (iso: string) => iso.slice(0, 10);
const fmt = (v: number | null) => (v === null ? '–' : v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 }));
const AUTOCOMPLETE_NOTE: Record<KeywordIdea['autocomplete'], (i: KeywordIdea) => string> = {
  listed: () => 'autocomplete lists this phrase',
  empty: (i) => `no autocomplete suggestions when checked ${i.checkedAt}; too specific for autocomplete, so Search on Amazon is the way to see it`,
  unknown: () => 'not looked up yet',
};
const ARROW = { rising: '▲', falling: '▼', steady: '►', unknown: '' } as const;

/**
 * One column per source, each in its own units. Nothing here is a search volume, and nothing is added up into a score:
 * autocomplete gives a position, Reddit a count of mentions in the text you synced, Trends a relative index you imported,
 * and Amazon competition comes from search pages you captured yourself.
 */
export function KeywordsView({ version }: { version: number }) {
  const [seed, setSeed] = useState('');
  const [cats, setCats] = useState<CategorySummary[]>([]);
  const [cat, setCat] = useState('');
  const [table, setTable] = useState<KeywordTable | null>(null);
  const [notes, setNotes] = useState<KeywordLookupResult['notes']>([]);
  const [fallback, setFallback] = useState<KeywordLookupResult['fallback']>(undefined);
  const [job, setJob] = useState<KeywordJob | null>(null);
  const [sub, setSub] = useState<'search' | 'history'>('search');
  const [catChosen, setCatChosen] = useState(false);
  const [ideas, setIdeas] = useState<KeywordIdea[]>([]);
  const [strings, setStrings] = useState<KeywordString[]>([]);
  const [ownBooks, setOwnBooks] = useState<OwnBookRow[]>([]);
  const [forAsin, setForAsin] = useState('');
  const [outlines, setOutlines] = useState<{ available: boolean; outlines: OutlineRef[]; chosen: { project: string; file: string } | null; readable: boolean }>({ available: false, outlines: [], chosen: null, readable: true });
  const [injected, setInjected] = useState<InjectedSuggestion[]>([]);
  const [history, setHistory] = useState<KeywordHistoryRow[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // One category for the whole tab: searches and imported trends are filed under it, history is listed for it, and the Reddit column and
  // the suggestions read from it. It starts on the first category; "All categories" files nothing and reads every synced subreddit.
  const scope = useMarketScope();
  const keys = scope.keys;
  useEffect(() => { void api.categories().then((all) => { const c = scopedCategories(all, keys); setCats(c); setCat((cur) => (cur && !c.some((x) => x.key === cur) ? (keys ? c[0]?.key ?? '' : '') : !catChosen && !cur && c[0] ? c[0].key : cur)); }); }, [version, scope.token]);
  const ideasCat = cat || cats[0]?.key || '';
  const catName = (k: string) => cats.find((c) => c.key === k)?.name ?? k;
  const loadIdeas = () => (ideasCat ? api.keywordIdeas(ideasCat, forAsin || undefined).then(setIdeas, () => setIdeas([])) : Promise.resolve(setIdeas([])));
  const loadStrings = () => (ideasCat ? api.keywordStrings(ideasCat, forAsin || undefined).then(setStrings, () => setStrings([])) : Promise.resolve(setStrings([])));
  const loadOutlines = () => (ideasCat ? api.keywordOutlines(ideasCat).then(setOutlines, () => {}) : Promise.resolve());
  const loadInjected = () => (ideasCat ? api.injectedSuggestions(ideasCat).then(setInjected, () => setInjected([])) : Promise.resolve(setInjected([])));
  useEffect(() => { void loadIdeas(); void loadStrings(); void loadOutlines(); void loadInjected(); }, [ideasCat, forAsin, version]);
  const chooseOutline = (value: string) => {
    const ref = value ? (JSON.parse(value) as { project: string; file: string }) : null;
    void api.setKeywordOutline(ideasCat, ref).then(() => Promise.all([loadOutlines(), loadIdeas(), loadStrings()]), (e) => setErr(String(e.message ?? e)));
  };
  const outlineValue = outlines.chosen ? JSON.stringify({ project: outlines.chosen.project, file: outlines.chosen.file }) : '';
  useEffect(() => { void api.ownBooks().then((b) => setOwnBooks(b.filter((x) => x.snapshots > 0)), () => setOwnBooks([])); }, [version]);
  const loadHistory = () => api.keywordHistory(cat || undefined).then(setHistory, () => {});
  useEffect(() => { void loadHistory(); }, [sub, version, cat]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const show = (s: string) => api.keywordTable(s, cat || undefined).then(setTable, (e) => setErr(String(e.message ?? e)));
  useEffect(() => { if (table) void show(table.seed); }, [cat, version]);

  const follow = () => {
    if (timer.current) return;
    timer.current = setInterval(async () => {
      const j = await api.keywordStatus();
      setJob(j);
      if (!j && timer.current) { clearInterval(timer.current); timer.current = null; }
    }, 300);
  };

  const lookup = async (force: boolean, phrase: string = seed) => {
    setErr(''); setMsg(''); setNotes([]); setFallback(undefined);
    setJob({ seed: phrase, source: 'amazon', sourceIndex: 0, sourceCount: 1, done: 0, total: 27, startedAt: Date.now(), stopping: false });
    follow();
    try {
      const r = await api.keywordLookup(phrase, { force, categoryKey: cat || undefined });
      setTable(r.table); setNotes(r.notes); setFallback(r.fallback);
      if (r.fallback) setSeed(r.fallback.used);
    } catch (e) { setErr((e as Error).message); } finally { setJob(null); void loadHistory(); void loadIdeas(); }
  };

  /** A suggested phrase: put it in the box and run the search. */
  const searchFor = (phrase: string) => { setSeed(phrase); setSub('search'); void lookup(false, phrase); };

  /** A past search: back to the results page with what was saved, with no new request. */
  const reopen = async (h: KeywordHistoryRow) => {
    setErr(''); setNotes([]); setSeed(h.seed); setSub('search');
    try {
      setTable(await api.keywordTable(h.seed, cat || undefined));
      setMsg(h.saved ? `Showing the answers saved for “${h.seed}” (last searched ${day(h.lastAt)}). Press Refresh to ask again.` : `The saved answers for “${h.seed}” are gone; press Look up to ask again.`);
    } catch (e) { setErr((e as Error).message); }
  };

  const guard = async (fn: () => Promise<unknown>) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr((e as Error).message); } };

  const importCsv = (f: File | undefined) => guard(async () => {
    if (!f) return;
    const r = await api.importTrends(await f.text(), cat || undefined);
    setMsg(`Imported Google Trends data for ${r.keywords.join(', ')}.`);
    if (table) await show(table.seed);
  });

  const top5 = table ? table.rows.slice(0, 5).map((r) => r.keyword) : [];
  const lookedUp = table?.lookups.length ?? 0;

  const pos = (k: 'amazon' | 'google' | 'bing'): Column<KeywordRow> => ({
    key: k, label: LABEL[k], num: true,
    get: (r) => r[k]?.position ?? null,
    render: (r) => (r[k] ? `#${r[k]!.position}` : ''),
    title: (r) => (r[k] ? `Place ${r[k]!.position} in ${LABEL[k]}'s suggestions${r[k]!.via === 'seed' ? ' for the phrase itself' : ` after typing "${table!.seed} ${r[k]!.via}"`}. Lower is more popular.` : undefined),
  });
  const columns: Column<KeywordRow>[] = [
    {
      key: 'keyword', label: 'Phrase', get: (r) => r.keyword,
      render: (r) => (
        <>
          {r.keyword}{' '}
          <button className="link" title="Open this search on Amazon; the extension captures it automatically and the competition columns fill in" onClick={() => void guard(() => api.openAmazonSearch(r.keyword))}>Amazon ↗</button>
        </>
      ),
    },
    pos('amazon'), pos('google'), pos('bing'),
    { key: 'listed', label: 'Listed by', num: true, get: (r) => r.listedBy, title: () => 'How many of the autocomplete sources suggest this phrase' },
    {
      key: 'reddit', label: 'Reddit', num: true,
      get: (r) => (r.reddit && r.reddit.itemsSearched > 0 ? r.reddit.mentions : null),
      render: (r) => (r.reddit && r.reddit.itemsSearched > 0 ? r.reddit.mentions.toLocaleString() : ''),
      title: (r) => (r.reddit && r.reddit.itemsSearched > 0 ? `${r.reddit.mentions} mentions in ${r.reddit.threads} threads, ${r.reddit.per1000} per 1,000 items, of ${r.reddit.itemsSearched.toLocaleString()} synced items${r.reddit.bySubreddit.length ? ` (${r.reddit.bySubreddit.slice(0, 3).map((s) => `r/${s.subreddit} ${s.mentions}`).join(', ')})` : ''}` : 'Sync a subreddit under Analysis → Community sources to fill this column'),
    },
    {
      key: 'trend', label: 'Trends', num: true, get: (r) => r.trend?.latest ?? null,
      render: (r) => (r.trend ? `${r.trend.latest} ${ARROW[r.trend.direction]}` : ''),
      title: (r) => (r.trend ? `Relative interest ${r.trend.from} to ${r.trend.to}: now ${r.trend.latest}, average ${r.trend.average}, peak ${r.trend.peak}${r.trend.changePct !== null ? `, ${r.trend.changePct > 0 ? '+' : ''}${r.trend.changePct}% against the period before` : ''}. 100 is the peak of the terms compared in the export.` : 'Import a CSV from Google Trends to fill this column'),
    },
    {
      key: 'results', label: 'Amazon results', num: true, get: (r) => r.competition?.resultCount ?? null,
      render: (r) => (r.competition?.resultCount != null ? `${r.competition.resultCountIsMinimum ? '>' : ''}${r.competition.resultCount.toLocaleString()}` : r.competition ? '?' : ''),
      title: (r) => (r.competition ? `From the search you captured on ${day(r.competition.capturedAt)}` : 'Open the search on Amazon; the extension captures it automatically'),
    },
    { key: 'ratings', label: 'Top-10 median ratings', num: true, get: (r) => r.competition?.medianRatings ?? null, render: (r) => r.competition?.medianRatings?.toLocaleString() ?? '', title: (r) => (r.competition ? `Median ratings count of the first ${r.competition.top} organic results (${r.competition.sponsored} sponsored skipped)` : undefined) },
    {
      key: 'sales', label: 'Est. sales/day', num: true, get: (r) => r.competition?.estDailySales ?? null,
      render: (r) => (r.competition?.estDailySales != null ? `${fmt(r.competition.estDailySalesLow)}–${fmt(r.competition.estDailySalesHigh)}` : ''),
      title: (r) => (r.competition && r.competition.estDailySales != null ? `Middle ${fmt(r.competition.estDailySales)} per day. ${r.competition.salesBasis === 'calibrated' ? `Range from your own calibration${r.competition.salesIncludeKu ? ', counting Kindle Unlimited borrows as sales (so this is sales plus borrows)' : ''}.` : r.competition.salesBasis === 'custom' ? 'Range from your edited curve, widened by how far published methods disagree.' : 'Range spans three published rank-to-sales rules; calibrate with your own KDP sales in Settings to narrow it.'} Based on store ranks of ${r.competition.withRank} of the top ${r.competition.top} results whose book pages you captured; the others are not counted, so this is a floor.` : undefined),
    },
  ];

  return (
    <>
      <h1>Keywords</h1>
      <p className="muted">
        Each column is a different source with its own measure; none is a search volume and they are not combined into a score. Autocomplete position says how readily a phrase is suggested (lower is more popular), Reddit counts mentions in the subreddits you synced, Trends is the relative interest you imported, and the Amazon columns come from search pages you captured with the extension.
      </p>
      <div className="row">
        <label>Category{' '}
          <select value={cat} onChange={(e) => { setCatChosen(true); setCat(e.target.value); }} aria-label="Category">
            {!keys && <option value="">All categories</option>}
            {cats.map((c) => <option key={c.key} value={c.key}>{c.name ?? c.key}</option>)}
          </select>
        </label>
        <span className="muted">{cat ? `Searches and Google Trends imports are saved under ${catName(cat)}; the Reddit column reads its subreddits.` : 'Searches are not filed under a category; the Reddit column reads every synced subreddit.'}</span>
      </div>
      <div className="subtabs" aria-label="Keyword sections">
        <button className="tab" aria-pressed={sub === 'search'} onClick={() => setSub('search')}>Search</button>
        <button className="tab" aria-pressed={sub === 'history'} onClick={() => setSub('history')}>Search History{history.length ? ` (${history.length})` : ''}</button>
      </div>
      {sub === 'history' && (
        <>
          <p className="muted">{cat ? `The phrases researched for ${catName(cat)}, newest first.` : 'Every phrase you have searched, newest first.'} Click one to go back to its results; the answers were saved, so nothing is asked again unless you press Refresh.</p>
          {history.length === 0 ? (
            <p className="muted">{cat ? `No searches have been filed under ${catName(cat)} yet. Searches you run on the Search tab with it selected are kept here.` : 'No searches yet. Searches you run on the Search tab are kept here.'}</p>
          ) : (
            <>
              <div className="row"><button onClick={() => { if (window.confirm('Clear the whole search history? The saved answers stay until they expire.')) void api.clearKeywordHistory().then(loadHistory); }}>Clear history</button></div>
              <table>
                <thead><tr><th>Search</th><th>Last searched</th><th className="num">Times</th><th className="num">Phrases found</th><th>Sources</th><th>Category</th><th></th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.seed} data-seed={h.seed}>
                      <td><button className="link" onClick={() => void reopen(h)} title={h.saved ? 'Show the saved results' : 'The saved answers are gone; this reopens the search page to ask again'}>{h.seed}</button></td>
                      <td>{day(h.lastAt)}</td><td className="num">{h.searches}</td><td className="num">{h.phrases}</td>
                      <td>{h.sources.map((x) => LABEL[x]).join(', ') || '–'}</td>
                      <td>{h.categories.map(catName).join(', ') || <span className="muted">none</span>}</td>
                      <td><button className="link" onClick={() => void api.removeKeywordHistory(h.seed).then(loadHistory)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {sub === 'search' && (<>
      <div className="card" aria-label="Suggest Keywords">
        <h2 style={{ marginTop: 0 }}>Suggest Keywords</h2>
        {cats.length === 0 ? (
          <div className="muted">Capture a bestseller list first; suggestions come from the books on it.</div>
        ) : (
          <>
            <div className="row">
              <strong>{catName(ideasCat)}</strong>
              {ownBooks.length > 0 && (
                <label>Avoid words in{' '}
                  <select value={forAsin} onChange={(e) => setForAsin(e.target.value)} aria-label="Book whose title, subtitle and blurb words to leave out">
                    <option value="">the category only</option>
                    {ownBooks.map((b) => <option key={b.asin} value={b.asin}>{b.title ?? b.asin}</option>)}
                  </select>
                </label>
              )}
              {outlines.available && (
                <label>Build on outline{' '}
                  <select value={outlineValue} onChange={(e) => chooseOutline(e.target.value)} aria-label="Outline document to build suggestions on">
                    <option value="">none (the category only)</option>
                    {outlines.chosen && !outlines.outlines.some((o) => o.project === outlines.chosen!.project && o.file === outlines.chosen!.file) && <option value={outlineValue}>{outlines.chosen.project} / {outlines.chosen.file} (not found)</option>}
                    {outlines.outlines.map((o) => <option key={`${o.project}/${o.file}`} value={JSON.stringify({ project: o.project, file: o.file })}>{o.project} / {o.file} · {o.words.toLocaleString('en-US')} words</option>)}
                  </select>
                </label>
              )}
              <span className="muted">Click one to search it. Suggestions leave out words Amazon already reads from the category{forAsin ? ' and that book\'s title, subtitle and blurb' : ''}.</span>
            </div>
            <div className="row" role="list">
              {ideas.map((i) => (
                <span key={i.keyword} role="listitem">
                  <button className="tab" disabled={!!job} onClick={() => searchFor(i.keyword)} title={`${i.reason}. ${AUTOCOMPLETE_NOTE[i.autocomplete](i)}`}>{i.keyword}{i.autocomplete === 'empty' ? ' ⚠' : i.autocomplete === 'listed' ? ' ✓' : ''}</button>
                </span>
              ))}
              {ideas.length === 0 && <span className="muted">Nothing to suggest for this category yet.</span>}
            </div>
            {outlines.available && outlines.outlines.length === 0 && <div className="muted">No outline found. Cadrel looks in your projects for files named like an outline, beat sheet or synopsis, or kept in a folder called Outline.</div>}
            {outlines.chosen && !outlines.readable && <div className="banner error" role="alert">That outline can no longer be read, so these suggestions use the category alone. Choose another, or restore the file.</div>}
            {outlines.chosen && outlines.readable && <div className="muted">Built on your outline: what it says comes first, then what the category's books and readers add. Category phrases your outline does not mention are held back.</div>}
            {ideas.length > 0 && <div className="muted">{ideas.map((i) => `${i.keyword}: ${i.reason}${i.autocomplete === 'unknown' ? '' : ` (${AUTOCOMPLETE_NOTE[i.autocomplete](i)})`}`).join(' · ')}
              <div>✓ autocomplete lists it · ⚠ no autocomplete suggestions when last checked (use Search on Amazon for those) · no mark: not looked up yet</div></div>}
          </>
        )}
      </div>
      {injected.length > 0 && (
      <div className="card" aria-label="Suggestions from your AI assistant">
        <h2 style={{ marginTop: 0 }}>From your AI assistant</h2>
        <div className="muted">Sent by an AI app connected to Cadrel, after reading the outline and this category. Nothing is searched or changed until you click. Dismiss any you do not want.</div>
        <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
          {injected.map((i) => (
            <li key={i.id} title={i.reason}>
              <code>{i.keyword}</code> <span className="muted">{i.client}{i.kind === 'string' ? ` · ${i.keyword.length}/50` : ''}{i.reason ? ` · ${i.reason}` : ''}</span>
              {i.warnings.map((w) => <div key={w} className="muted">⚠ {w}</div>)}{' '}
              {i.kind === 'keyword' && <button disabled={!!job} onClick={() => searchFor(i.keyword)}>Search</button>}{' '}
              <button onClick={() => void navigator.clipboard?.writeText(i.keyword)} aria-label={`Copy ${i.keyword}`}>Copy</button>{' '}
              <button onClick={() => void api.dismissInjectedSuggestion(i.id).then(loadInjected)} aria-label={`Dismiss ${i.keyword}`}>Dismiss</button>
            </li>
          ))}
        </ul>
      </div>
      )}
      {cats.length > 0 && (
      <div className="card" aria-label="Keyword strings">
        <h2 style={{ marginTop: 0 }}>Seven keyword strings for KDP</h2>
        <div className="muted">One for each keyword box in KDP (50 characters each). Each is a few related terms a reader would search together; no word repeats across the boxes, and none repeats a word Amazon already reads from the category{forAsin ? ' or that book\'s title, subtitle and blurb' : ''}.</div>
        <ol aria-label="Keyword strings for KDP" style={{ margin: '6px 0' }}>
          {strings.map((k) => (
            <li key={k.keyword} title={k.parts.map((x) => `${x.phrase}: ${x.reason}`).join('\n')}>
              <code>{k.keyword}</code> <span className="muted">{k.chars}/50</span>{' '}
              <button onClick={() => void navigator.clipboard?.writeText(k.keyword)} aria-label={`Copy ${k.keyword}`}>Copy</button>
            </li>
          ))}
        </ol>
        {strings.length === 0 && <div className="muted">Not enough distinct terms in this category's books yet.</div>}
        {strings.length > 0 && strings.length < 7 && <div className="muted">Only {strings.length} distinct string{strings.length === 1 ? '' : 's'} could be built from this category's books; capture more of its books or sync a subreddit for more.</div>}
      </div>
      )}
      <div className="row">
        <input value={seed} onChange={(e) => setSeed(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !job && seed.trim().length >= 2) void lookup(false); }} placeholder="A phrase, e.g. cozy fantasy" aria-label="Phrase to look up" style={{ width: 280 }} />
        <button className="primary" disabled={!!job || seed.trim().length < 2} onClick={() => void lookup(false)}>Look up</button>
        <button disabled={!!job || seed.trim().length < 2} onClick={() => void lookup(true)} title="Ignore the saved answers and ask again">Refresh</button>
      </div>
      {job && (
        <div className="banner" role="status">
          Asking {LABEL[job.source]}{job.sourceCount > 1 ? ` (${job.sourceIndex + 1} of ${job.sourceCount})` : ''}: {job.done} of {job.total} queries…{' '}
          <button onClick={() => void api.stopKeywords()} disabled={job.stopping}>{job.stopping ? 'Stopping…' : 'Stop'}</button>
        </div>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      {msg && <div className="muted" role="status">{msg}</div>}
      {notes.length > 0 && (
        <div className="muted">
          {notes.map((n) => (
            <div key={n.source} className={n.stopped ? 'err' : undefined}>
              {LABEL[n.source]}: {n.count} phrases, {n.cached ? `saved answer from ${day(n.fetchedAt)}, no request made` : `${n.requests} request${n.requests === 1 ? '' : 's'} just now`}{n.stopped ? ` — ${n.stopped}` : n.count === 0 ? ' — answered, but has no suggestions for this phrase' : ''}
            </div>
          ))}
        </div>
      )}
      {fallback && (
        <div className="banner" role="status">
          No source had autocomplete suggestions for “{fallback.requested}” (autocomplete only lists phrases many people type), so this shows the broader “{fallback.used}”.{' '}
          <button onClick={() => void guard(() => api.openAmazonSearch(fallback.requested))}>Search “{fallback.requested}” on Amazon ↗</button>
        </div>
      )}
      {!fallback && notes.length > 0 && notes.every((n) => n.count === 0 && !n.stopped) && (
        <div className="banner" role="status">
          No source had autocomplete suggestions for “{table?.seed ?? seed}”. The phrase is probably too specific; try a shorter or more common one. You can still use Search on Amazon below to capture the real results.
        </div>
      )}
      {table && (
        <>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => void guard(() => api.openTrends(top5))} title="Opens Google Trends in your browser comparing these phrases. Use its Download button, then import the CSV here.">Compare top {top5.length} in Google Trends ↗</button>
            <label className="link" style={{ cursor: 'pointer' }}>
              Import Trends CSV…
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void importCsv(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <button onClick={() => void guard(() => api.openAmazonSearch(table.seed))}>Search “{table.seed}” on Amazon ↗</button>
          </div>
          {lookedUp === 0 && <div className="banner">No autocomplete answers saved for “{table.seed}” yet. Press Look up to ask the sources switched on in Settings.</div>}
          <DataTable rows={table.rows} columns={columns} rowKey={(r) => r.keyword} noun="phrase" empty="No phrases match the filters." />
          {table.redditItems === 0 && <div className="muted">The Reddit column is empty because no subreddit text is synced yet.</div>}
        </>
      )}
      </>)}
    </>
  );
}
