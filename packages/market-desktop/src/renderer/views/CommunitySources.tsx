import { useEffect, useRef, useState } from 'react';
import type { CommunityJob, CommunitySource, SyncResult } from '../../shared/api.js';

const api = window.cadrelMarket;
const n = (v: number) => v.toLocaleString('en-US');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '–');

/** Subreddits linked to a category, and the button that fetches their last 7 days of threads and comments into the library. */
const elapsed = (ms: number) => { const s = Math.max(Math.round(ms / 1000), 0); return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };

/** Subreddits linked to a category, and the controls that fetch their last 7 days of threads and comments into the library. */
export function CommunitySources({ categoryKey }: { categoryKey: string }) {
  const [sources, setSources] = useState<CommunitySource[]>([]);
  const [name, setName] = useState('');
  const [job, setJob] = useState<CommunityJob | null>(null);
  const [, setNow] = useState(0);
  const [results, setResults] = useState<SyncResult[]>([]);
  const [err, setErr] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const running = job !== null;

  const load = () => api.communitySources(categoryKey).then(setSources, (e) => setErr(String(e.message ?? e)));

  /** Follow a running sync (this one, or one still going after the page was left) until it ends. */
  const follow = () => {
    if (timer.current) return;
    timer.current = setInterval(async () => {
      const j = await api.communityStatus();
      setJob(j);
      setNow(Date.now());
      if (!j) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        void load();
      }
    }, 500);
  };

  useEffect(() => {
    setResults([]); setErr('');
    void load();
    void api.communityStatus().then((j) => { if (j) { setJob(j); follow(); } });
  }, [categoryKey]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); } catch (e) { setErr((e as Error).message); }
  };

  const start = async () => {
    setResults([]);
    setJob({ categoryKey, subreddit: sources[0]?.subreddit ?? '', subredditIndex: 0, subredditCount: sources.length, step: 'Starting', day: 1, days: 7, threads: 0, comments: 0, requests: 0, startedAt: Date.now(), stopping: false });
    follow();
    await run(async () => setResults(await api.syncCommunity(categoryKey)));
    await load();
  };
  const stop = () => run(async () => { await api.stopCommunity(); setJob((j) => (j ? { ...j, stopping: true } : j)); });

  const resumable = sources.some((s) => s.resumeFrom);
  const doneDays = job ? job.subredditIndex * job.days + (job.day - 1) : 0;
  const totalDays = job ? job.subredditCount * job.days : 1;

  return (
    <section className="card" aria-label="Community sources">
      <h2 style={{ marginTop: 0 }}>Community sources</h2>
      <div className="muted">
        Subreddits to read for this category. Sync fetches the last 7 days of threads (title and text) and their comments from the Arctic Shift archive and adds them to your library, where they can be searched here and from Claude.
        Only text, scores, post flair and dates are kept: no usernames. Scores on threads under about 36 hours old are not final.
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          value={name} onChange={(e) => setName(e.target.value)} placeholder="subreddit, e.g. cozyfantasy" aria-label="Subreddit" disabled={running}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void run(async () => { setSources(await api.addCommunitySource(categoryKey, name)); setName(''); }); }}
        />
        <button disabled={!name.trim() || running} onClick={() => run(async () => { setSources(await api.addCommunitySource(categoryKey, name)); setName(''); })}>Add</button>
        {running
          ? <button onClick={stop} disabled={job!.stopping}>{job!.stopping ? 'Stopping…' : 'Stop'}</button>
          : <button className="primary" disabled={sources.length === 0} onClick={start}>{resumable ? 'Resume sync' : 'Sync last 7 days'}</button>}
      </div>
      {job && (
        <div aria-label="Sync progress" style={{ marginBottom: 8 }}>
          <progress value={doneDays} max={totalDays} style={{ width: '100%' }} aria-label="Days read" />
          <div role="status">
            <strong>r/{job.subreddit}</strong>{job.subredditCount > 1 ? ` (${job.subredditIndex + 1} of ${job.subredditCount})` : ''}: day {job.day} of {job.days} · {job.stopping ? 'stopping, keeping the days already saved' : job.step}
          </div>
          <div className="muted">
            {n(job.threads)} threads and {n(job.comments)} comments kept so far · {n(job.requests)} requests · {elapsed(Date.now() - job.startedAt)}
          </div>
        </div>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      {sources.length > 0 && (
        <table>
          <thead><tr><th>Subreddit</th><th className="num">Threads</th><th className="num">Comments</th><th>Threads from</th><th>Last synced</th><th /></tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.subreddit} data-subreddit={s.subreddit}>
                <td>r/{s.subreddit}</td>
                <td className="num">{n(s.posts)}</td>
                <td className="num">{n(s.comments)}</td>
                <td>{s.posts ? `${day(s.from)} to ${day(s.to)}` : '–'}</td>
                <td>{s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'never'}{s.resumeFrom ? <span className="muted"> · stopped, resumes from {s.resumeFrom.slice(0, 16).replace('T', ' ')} UTC</span> : ''}</td>
                <td>
                  <button className="link" disabled={running} onClick={() => {
                    if (!window.confirm(`Remove r/${s.subreddit} from this category? Its ${n(s.posts)} threads and ${n(s.comments)} comments are deleted from your library unless another category uses it.`)) return;
                    void run(async () => setSources(await api.removeCommunitySource(categoryKey, s.subreddit)));
                  }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {results.map((r) => (
        <div key={r.subreddit} role="status" className={r.truncated || r.cancelled || r.error || r.notFound ? 'err' : 'muted'} style={{ marginTop: 6 }}>
          r/{r.subreddit}: {r.error ? `stopped by an error after ${r.daysDone} of ${r.days} days (${r.error}). ` : r.cancelled ? `stopped after ${r.daysDone} of ${r.days} days. ` : ''}{r.notFound
            ? `Subreddit not found, check the spelling. ${r.daysDone === 0 ? 'Arctic Shift has no posts from it at all, so nothing was read.' : `Arctic Shift returned no threads or comments for it in the last ${r.days} days, and none are stored.`} (It can also be private, banned or too new for the archive.)`
            : r.posts + r.comments === 0 && !r.error
            ? `Arctic Shift returned no threads or comments for the last ${r.days} days, so nothing was added and nothing stored was changed.`
            : r.newPosts + r.newComments === 0 && !r.error && !r.cancelled
              ? `Already up to date: all ${n(r.posts)} threads and ${n(r.comments)} comments it found were already stored, so nothing new was added. A sync reads the whole last ${r.days} days each time and only adds what is not stored yet.`
              : `${n(r.newPosts)} new threads and ${n(r.newComments)} new comments (${n(r.posts)} and ${n(r.comments)} seen).`}
          {' '}Skipped {n(r.skipped.removed)} removed/deleted and {n(r.skipped.bots)} bot items{r.dropped ? `; dropped ${n(r.dropped)} stored items that have since been removed` : ''}.
          {r.cancelled || r.error ? ' Everything read so far is saved; press Resume sync to carry on.' : ''}
          {r.truncated ? ' Stopped at the size cap: part of the week is missing.' : ''}
        </div>
      ))}
    </section>
  );
}
