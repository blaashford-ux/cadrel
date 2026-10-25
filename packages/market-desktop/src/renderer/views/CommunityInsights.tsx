import { useEffect, useState } from 'react';
import type { CommunityInsights, ThreadRef } from '../../shared/api.js';

const api = window.cadrelMarket;
const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const SIGNAL: Record<string, { label: string; title: string }> = {
  underserved: { label: 'talked about, few books', title: 'Many threads mention it, but few of the books on the lists do' },
  crowded: { label: 'many books, little talk', title: 'Many listed books carry it, but readers talk about it far less' },
  balanced: { label: 'about even', title: 'Talk and supply are roughly in step' },
  thin: { label: 'too little to say', title: 'Too few threads or books to compare' },
};

function Thread({ t }: { t: ThreadRef }) {
  return (
    <>
      <button className="link" onClick={() => void api.openThread(t.url).catch(() => {})} title="Open this thread on Reddit">{t.title}</button>
      <span className="muted"> r/{t.subreddit} · {t.score ?? '–'} points · {t.comments} comment{t.comments === 1 ? '' : 's'}</span>
    </>
  );
}

/**
 * What the readers of the subreddits linked to this category are discussing and asking for: counted from the synced threads and comments,
 * beside what the books on the category's lists carry. Everything here is word counts: the caveats say what that can and cannot tell.
 */
export function CommunityInsightsPanel({ categoryKey, version }: { categoryKey: string; version: number }) {
  const [r, setR] = useState<CommunityInsights | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!categoryKey) return;
    setErr('');
    api.communityInsights(categoryKey).then(setR, (e) => setErr(String(e.message ?? e)));
  }, [categoryKey, version, tick]);

  if (err) return <div className="err" role="alert">{err}</div>;
  if (!r) return null;
  const c = r.coverage;
  if (c.threads === 0) return <p className="muted">Nothing synced for this category yet. Add a subreddit under Community sources above and press Sync; then what readers are asking for appears here.</p>;
  const asked = r.elements.filter((e) => e.asked > 0).sort((a, b) => b.asked - a.asked || b.threads - a.threads).slice(0, 10);

  return (
    <>
      <div className="banner" aria-label="Read this first">
        <strong>Read this first</strong>
        <ul>{r.caveats.map((x, i) => <li key={i}>{x}</li>)}</ul>
        <button onClick={() => setTick((n) => n + 1)}>Refresh</button>
      </div>

      <div className="tiles">
        <div className="tile"><div className="n">{c.threads.toLocaleString()}</div><div className="l">threads</div></div>
        <div className="tile"><div className="n">{c.comments.toLocaleString()}</div><div className="l">comments</div></div>
        <div className="tile"><div className="n">{c.requestThreads}</div><div className="l">asking for books ({pct(c.requestShare)})</div></div>
        <div className="tile"><div className="n">{c.subreddits.length}</div><div className="l">subreddit{c.subreddits.length === 1 ? '' : 's'}</div></div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>What readers are asking for</h2>
        <p className="muted">Threads where someone asks for a book, best-engaged first: the plainest statement of what readers are looking for.</p>
        {r.requests.length === 0 ? <div className="muted">No request threads found.</div> : <ol>{r.requests.slice(0, 10).map((t, i) => <li key={i}><Thread t={t} /></li>)}</ol>}
        {asked.length > 0 && (
          <>
            <h3>Tropes and wants named in those requests</h3>
            <table>
              <thead><tr><th>Element</th><th className="num">Requests naming it</th><th className="num">Share of requests</th></tr></thead>
              <tbody>{asked.map((e) => <tr key={e.element}><td>{e.element}</td><td className="num">{e.asked}</td><td className="num">{pct(c.requestThreads ? e.asked / c.requestThreads : null)}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>What is being discussed</h2>
        <p className="muted">Phrases that recur across threads (the category's own words are left out). Threads count a post or any comment under it.</p>
        <table>
          <thead><tr><th>Phrase</th><th className="num">Threads</th><th className="num">Share</th><th className="num">In requests</th><th className="num">Avg. points</th><th>Example</th></tr></thead>
          <tbody>
            {r.topics.map((t) => (
              <tr key={t.phrase}>
                <td>{t.phrase}</td><td className="num">{t.threads}</td><td className="num">{pct(t.share)}</td><td className="num">{t.asked}</td><td className="num">{t.avgScore ?? '–'}</td>
                <td>{t.examples[0] ? <Thread t={t.examples[0]} /> : ''}</td>
              </tr>
            ))}
            {r.topics.length === 0 && <tr><td colSpan={6} className="muted">Nothing recurs often enough yet; sync more days.</td></tr>}
          </tbody>
        </table>
        {r.themes.length > 0 && (
          <>
            <h3>What readers talk about</h3>
            <div className="muted">Share of threads that touch each theme: {r.themes.map((t) => `${t.theme} ${pct(t.share)}`).join(' · ')}</div>
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Loved, avoided, and what the books deliver</h2>
        <p className="muted">
          For each trope or want: how many threads mention it, how many request threads ask for it, how many posts and comments praise it or complain about it (one sentence at a time), and how many of the {r.elements[0] ? 'books on the category\'s lists' : 'listed books'} carry it. “Talked about, few books” is where readers' interest outruns supply.
        </p>
        <table>
          <thead>
            <tr><th>Element</th><th className="num">Threads</th><th className="num">Share</th><th className="num">Asked</th><th className="num">Praised</th><th className="num">Complained</th><th className="num">Books carrying it</th><th>Read</th></tr>
          </thead>
          <tbody>
            {r.elements.map((e) => (
              <tr key={e.element}>
                <td>{e.element}</td><td className="num">{e.threads}</td><td className="num">{pct(e.threadShare)}</td><td className="num">{e.asked}</td>
                <td className="num">{e.loved}</td><td className="num">{e.avoided}</td><td className="num">{e.supplyBooks} ({pct(e.supplyShare)})</td>
                <td title={SIGNAL[e.signal]!.title}>{SIGNAL[e.signal]!.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.avoid.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>What readers say they avoid</h2>
          <p className="muted">Clauses where readers say they are tired of, hate or avoid something, highest-scored first.</p>
          <ul>{r.avoid.map((q, i) => <li key={i}>“{q.text}” <span className="muted">r/{q.subreddit} · {q.score ?? '–'} points </span><button className="link" onClick={() => void api.openThread(q.url).catch(() => {})}>open</button></li>)}</ul>
        </div>
      )}

      {r.recommended.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Books readers name</h2>
          <p className="muted">Books on this category's lists whose titles appear in the threads and comments, with replies in request threads first (those are recommendations).</p>
          <table>
            <thead><tr><th>Book</th><th className="num">List rank</th><th className="num">Mentions</th><th className="num">Threads</th><th className="num">In requests</th></tr></thead>
            <tbody>{r.recommended.map((b) => <tr key={b.asin}><td>{b.title}</td><td className="num">{b.listRank}</td><td className="num">{b.mentions}</td><td className="num">{b.threads}</td><td className="num">{b.inRequests}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
