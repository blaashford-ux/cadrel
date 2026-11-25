import { z } from 'zod';
import {
  ArcticShift, cleanSubreddit, listCategories, listCommunitySources, resolveCategory, syncSubreddit, type Library, type SyncResult,
} from '@cadrel/market-library';
import type { ToolContext, ToolSpec } from './tools.js';

/**
 * Community source scans an AI (or a scheduled task in Claude Cowork) can start and then wait on. A scan reads a week of a subreddit a day at a
 * time and takes minutes, far longer than one tool call should last, so starting one returns a job id at once and the work carries on in this
 * server. `community_sync_status` reports progress, and with `wait_seconds` it holds the call open until the job ends (or the time is up), which is
 * how a caller "knows when it finishes". Stopping, or the server being closed, loses at most the day in progress: syncing again resumes.
 */

type ItemState = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
interface Item {
  category: string;
  category_name: string;
  subreddit: string;
  state: ItemState;
  /** What was read, once the scan of this subreddit has ended. */
  result?: {
    threads_read: number; comments_read: number; new_threads: number; new_comments: number; days_done: number; days: number;
    requests: number; not_found: boolean; truncated: boolean; error: string | null;
  };
  note?: string;
}
type JobState = 'running' | 'finished' | 'finished_with_errors' | 'stopped';
interface Job {
  id: string;
  mode: 'category' | 'subreddit' | 'all';
  state: JobState;
  stopping: boolean;
  started_at: string;
  finished_at: string | null;
  items: Item[];
  step: string;
  abort: AbortController;
  finished: Promise<void>;
}

interface Registry { jobs: Job[]; seq: number }
const registries = new WeakMap<Library, Registry>();
const registryOf = (lib: Library): Registry => {
  let r = registries.get(lib);
  if (!r) registries.set(lib, (r = { jobs: [], seq: 0 }));
  return r;
};
const KEEP = 10;

const running = (reg: Registry) => reg.jobs.find((j) => j.state === 'running');

function view(j: Job) {
  const done = j.items.filter((i) => ['done', 'failed', 'stopped', 'skipped'].includes(i.state)).length;
  const current = j.items.find((i) => i.state === 'running');
  return {
    job_id: j.id,
    mode: j.mode,
    state: j.state,
    finished: j.state !== 'running',
    stopping: j.state === 'running' && j.stopping,
    started_at: j.started_at,
    finished_at: j.finished_at,
    progress: { subreddits_done: done, subreddits_total: j.items.length, current: current ? `r/${current.subreddit} (${current.category_name})` : null, step: j.state === 'running' ? j.step : null },
    totals: {
      new_threads: j.items.reduce((n, i) => n + (i.result?.new_threads ?? 0), 0),
      new_comments: j.items.reduce((n, i) => n + (i.result?.new_comments ?? 0), 0),
      failed: j.items.filter((i) => i.state === 'failed').length,
    },
    order: j.items.map((i) => ({ category: i.category, category_name: i.category_name, subreddit: i.subreddit, state: i.state, ...(i.result ? { result: i.result } : {}), ...(i.note ? { note: i.note } : {}) })),
  };
}

const resultOf = (r: SyncResult): NonNullable<Item['result']> => ({
  threads_read: r.posts, comments_read: r.comments, new_threads: r.newPosts, new_comments: r.newComments, days_done: r.daysDone, days: r.days,
  requests: r.requests, not_found: r.notFound, truncated: r.truncated, error: r.error,
});

/** The scan order. Categories run in the order given (or alphabetically, as list_categories shows them); a category's subreddits run in the order they were linked. A subreddit linked to several categories is read once, under the first. */
function plan(ctx: ToolContext, a: { category?: string; subreddit?: string; order?: string[] }): { items: Item[]; mode: Job['mode'] } | { error: string } {
  const db = ctx.lib.db;
  const itemsFor = (key: string, name: string, only?: string): Item[] =>
    listCommunitySources(db, key).filter((s) => !only || s.subreddit === only).map((s) => ({ category: key, category_name: name, subreddit: s.subreddit, state: 'queued' as const }));

  if (a.category) {
    const r = resolveCategory(db, a.category);
    if ('error' in r) return r;
    const only = a.subreddit ? cleanSubreddit(a.subreddit) : undefined;
    const items = itemsFor(r.category.key, r.category.name ?? r.category.key, only);
    if (!items.length) return { error: only ? `r/${only} is not linked to ${r.category.name ?? r.category.key}; see community_sources` : `no subreddit is linked to ${r.category.name ?? r.category.key}: the user has to add one under Community sources first` };
    return { items, mode: only ? 'subreddit' : 'category' };
  }

  const cats: { key: string; name: string }[] = [];
  if (a.order?.length) {
    for (const ref of a.order) {
      const r = resolveCategory(db, ref);
      if ('error' in r) return { error: `order: ${r.error}` };
      if (!cats.some((c) => c.key === r.category.key)) cats.push({ key: r.category.key, name: r.category.name ?? r.category.key });
    }
  } else {
    for (const c of listCategories(db)) cats.push({ key: c.key, name: c.name ?? c.key });
  }
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const c of cats) {
    for (const it of itemsFor(c.key, c.name)) {
      if (seen.has(it.subreddit)) continue;
      seen.add(it.subreddit);
      items.push(it);
    }
  }
  if (!items.length) return { error: 'no subreddits are linked to any category: the user has to add some under Community sources first' };
  return { items, mode: 'all' };
}

function start(ctx: ToolContext, items: Item[], mode: Job['mode']): Job {
  const reg = registryOf(ctx.lib);
  const abort = new AbortController();
  const job: Job = {
    id: `sync-${++reg.seq}-${Date.now().toString(36)}`, mode, state: 'running', stopping: false, started_at: new Date().toISOString(), finished_at: null,
    items, step: 'Starting', abort, finished: Promise.resolve(),
  };
  reg.jobs.unshift(job);
  reg.jobs.splice(KEEP);
  job.finished = (async () => {
    try {
      for (const item of items) {
        if (abort.signal.aborted) { item.state = 'stopped'; continue; }
        item.state = 'running';
        try {
          const client = new ArcticShift({ ...ctx.arcticShift, signal: abort.signal, onWait: (m) => { job.step = m; } });
          const r = await syncSubreddit(ctx.lib.db, ctx.lib.root, item.subreddit, {
            client, signal: abort.signal,
            onProgress: (p) => { job.step = `${p.step} · day ${p.day} of ${p.days} · ${p.threads} threads, ${p.comments} comments`; },
          });
          item.result = resultOf(r);
          item.state = r.cancelled ? 'stopped' : r.error || r.notFound ? 'failed' : 'done';
          if (r.notFound) item.note = 'Arctic Shift has no such subreddit: check the spelling';
          else if (r.error) item.note = 'failed part-way; what was read is saved and syncing again resumes';
        } catch (e) {
          item.state = abort.signal.aborted ? 'stopped' : 'failed';
          item.note = (e as Error).message;
        }
        // One subreddit failing does not end the run: the next one may be fine, and nobody is watching a scheduled task.
      }
    } finally {
      job.state = abort.signal.aborted ? 'stopped' : items.some((i) => i.state === 'failed') ? 'finished_with_errors' : 'finished';
      job.finished_at = new Date().toISOString();
      job.step = '';
    }
  })();
  return job;
}

const categoryArg = z.string().describe('Category key, node id, or name from list_categories (e.g. "Humorous Fantasy")');

export const COMMUNITY_SYNC_TOOLS: ToolSpec[] = [
  {
    name: 'start_community_sync',
    description:
      'Start reading the last 7 days of threads and comments from the subreddits linked to a category (Community sources), from the Arctic Shift archive, and add them to the library: the same as pressing "Sync last 7 days" in the app. ' +
      'Give `category` (all its subreddits) or `category` + `subreddit` (just one); or `all: true` for Sync All, which scans every linked subreddit one after another, categories alphabetically unless `order` lists them (a subreddit linked to several categories is read once). ' +
      'It returns a job_id at once and carries on in the background; a scan takes minutes. Call community_sync_status with that job_id and wait_seconds to find out when it has finished. Only one sync runs at a time. Adds to what is stored and resumes after an earlier stopped scan; nothing is replaced.',
    shape: {
      category: categoryArg.optional(),
      subreddit: z.string().max(40).optional().describe('With category: scan only this one of its linked subreddits'),
      all: z.boolean().optional().describe('Sync All: every linked subreddit, one after another'),
      order: z.array(categoryArg).max(100).optional().describe('With all: the categories in the order to scan them. Categories left out are not scanned. Default: alphabetical.'),
    },
    readOnly: false,
    openWorld: true,
    run: (ctx, a) => {
      if (!!a.category === !!a.all) return { error: 'give either category (optionally with subreddit), or all: true' };
      if (a.subreddit && !a.category) return { error: 'subreddit goes with category' };
      if (a.order && !a.all) return { error: 'order goes with all: true' };
      const busy = running(registryOf(ctx.lib));
      if (busy) return { error: `a sync is already running (${busy.id}); wait for it with community_sync_status, or stop it with stop_community_sync` };
      const p = plan(ctx, a);
      if ('error' in p) return p;
      const job = start(ctx, p.items, p.mode);
      return { data: { started: true, ...view(job), next: 'Call community_sync_status with this job_id and wait_seconds (up to 50) until finished is true.' } };
    },
  },
  {
    name: 'community_sync_status',
    description:
      'How a community sync is going, and whether it has finished. Without job_id it reports the running one, or the latest. With wait_seconds (up to 50) the call holds until the job ends or the time is up, so repeat it until `finished` is true. ' +
      'When finished it lists every subreddit in the order scanned with its outcome (done, failed, stopped), and what was added. If the server was restarted the job is gone: use community_sources (last_synced) to see what was saved; starting a sync again resumes.',
    shape: { job_id: z.string().max(60).optional(), wait_seconds: z.number().int().min(0).max(50).default(0) },
    readOnly: true,
    run: async (ctx, a) => {
      const reg = registryOf(ctx.lib);
      const job = a.job_id ? reg.jobs.find((j) => j.id === a.job_id) : (running(reg) ?? reg.jobs[0]);
      if (!job) return { error: a.job_id ? `no sync job ${a.job_id} (the server may have been restarted; check community_sources for last_synced)` : 'no sync has been started since this server began' };
      if (job.state === 'running' && a.wait_seconds > 0) {
        let t: NodeJS.Timeout | undefined;
        await Promise.race([job.finished, new Promise<void>((r) => { t = setTimeout(r, a.wait_seconds * 1000); })]);
        clearTimeout(t);
      }
      return { data: view(job) };
    },
  },
  {
    name: 'stop_community_sync',
    description: 'Stop the running community sync after the day being read; what was already read stays saved and the rest of the queue is not scanned. Starting again carries on from where it stopped.',
    shape: { job_id: z.string().max(60).optional() },
    readOnly: false,
    run: (ctx, a) => {
      const reg = registryOf(ctx.lib);
      const job = a.job_id ? reg.jobs.find((j) => j.id === a.job_id) : running(reg);
      if (!job) return { error: a.job_id ? `no sync job ${a.job_id}` : 'no sync is running' };
      if (job.state !== 'running') return { data: view(job) };
      job.stopping = true;
      job.abort.abort();
      return { data: { stopping: true, job_id: job.id, next: 'Call community_sync_status with wait_seconds to see it end.' } };
    },
  },
];
