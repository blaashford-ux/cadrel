/**
 * A small client for the Arctic Shift archive of Reddit (https://github.com/ArthurHeitmann/arctic_shift/tree/master/api):
 * a public, keyless service. Only the fields Cadrel Market keeps are requested, plus `author` for a transient bot filter
 * (it is never stored).
 */
export const ARCTIC_SHIFT_URL = 'https://arctic-shift.photon-reddit.com';

export interface ArcticPost {
  id: string;
  title: string;
  selftext: string;
  created_utc: number;
  score: number | null;
  link_flair_text: string | null;
  author?: string;
}

export interface ArcticComment {
  id: string;
  link_id: string;
  parent_id: string;
  body: string;
  created_utc: number;
  score: number | null;
  author?: string;
}

export interface ArcticOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Pause between requests, in ms; the service asks users to be considerate. */
  delayMs?: number;
  /** Replaceable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  userAgent?: string;
  /** Called before a long wait (the service is busy or rate-limiting), so the screen can say why nothing is moving. */
  onWait?: (message: string) => void;
}

/** The service gave up on a query that was too heavy (it answers 422 "Timeout. Maybe slow down a bit", or 5xx). A smaller window usually works. */
export class ArcticTimeout extends Error {}

/** Waits (ms) between the tries at a query that keeps timing out. The first two are always used; a window that cannot be split any further goes on through the rest, since the service's timeouts are load and tend to clear within a minute or two. */
const QUICK_WAITS = [2000, 4000];
const PATIENT_WAITS = [10000, 30000, 60000, 60000, 60000];
/** After a timeout, requests are spaced further apart (up to this), and ease back after a run of clean answers. */
const MAX_PACE_MS = 5000;

const POST_FIELDS = 'id,title,selftext,created_utc,score,link_flair_text,author';
const COMMENT_FIELDS = 'id,link_id,parent_id,body,created_utc,score,author';

export class ArcticShift {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly delayMs: number;
  /** The gap kept between requests now: the configured one, widened after timeouts. */
  private pace: number;
  private clean = 0;
  private readonly onWait?: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal?: AbortSignal;
  requests = 0;

  constructor(o: ArcticOptions = {}) {
    this.base = (o.baseUrl ?? ARCTIC_SHIFT_URL).replace(/\/$/, '');
    this.doFetch = o.fetch ?? fetch;
    this.delayMs = o.delayMs ?? 300;
    this.pace = this.delayMs;
    this.onWait = o.onWait;
    this.signal = o.signal;
    // waits end early when the sync is stopped
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => {
      const t = setTimeout(r, ms);
      o.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    }));
  }

  private slowDown(): void {
    this.pace = Math.min(Math.max(this.pace * 2, 1000), MAX_PACE_MS);
    this.clean = 0;
  }

  private easeOff(): void {
    if (this.pace > this.delayMs && ++this.clean >= 5) {
      this.pace = Math.max(this.delayMs, Math.floor(this.pace / 2));
      this.clean = 0;
    }
  }

  private async wait(ms: number, why: string): Promise<void> {
    if (ms >= 5000) this.onWait?.(`${why}: waiting ${Math.round(ms / 1000)} s, then trying again`);
    await this.sleep(ms);
  }

  /**
   * GET with retries: 429 waits for the reset the service reports; timeouts and 5xx back off (the database may need to warm up).
   * `patient` is for a window that cannot be split any smaller: it keeps trying through longer waits before giving up.
   */
  private async get<T>(path: string, params: Record<string, string | number>, patient = false): Promise<T[]> {
    const what = `${path} ${Object.entries(params).filter(([k]) => k !== 'fields').map(([k, v]) => `${k}=${v}`).join(' ')}`;
    const url = `${this.base}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;
    let lastErr = '';
    let timedOut = false;
    let timeouts = 0;
    const waits = patient ? [...QUICK_WAITS, ...PATIENT_WAITS] : QUICK_WAITS;
    for (let attempt = 0; attempt < (patient ? 10 : 5); attempt++) {
      if (this.signal?.aborted) throw new Error('cancelled');
      if (attempt > 0 || this.requests > 0) await this.sleep(attempt === 0 ? this.pace : 0);
      this.requests++;
      let res: Response;
      try {
        res = await this.doFetch(url, { signal: this.signal, headers: { accept: 'application/json' } });
      } catch (e) {
        if (this.signal?.aborted) throw new Error('cancelled');
        lastErr = `could not reach Arctic Shift (${(e as Error).message})`;
        await this.wait(2000 * 2 ** Math.min(attempt, 4), 'Arctic Shift is not answering');
        continue;
      }
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        lastErr = 'Arctic Shift is rate-limiting requests';
        this.slowDown();
        await this.wait(Math.min(Math.max(Number.isFinite(reset) && reset > 0 ? reset * 1000 : 5000, 1000), 60000), 'Arctic Shift is rate-limiting requests');
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { /* not JSON: handled below */ }
      // Judge the service's own `error` field and the HTTP status, never the words inside the data: a comment can say "timed out".
      const apiError = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : null;
      const TIMEOUT = /time(?:d)?[ -]?out/i;
      if (res.status >= 500 || (!res.ok || apiError ? TIMEOUT.test(apiError ?? text) : false)) {
        lastErr = `Arctic Shift ${res.status >= 500 ? `error ${res.status}` : `rejected the query (${res.status}: ${(apiError ?? text).slice(0, 120)})`} for ${what}`;
        timedOut = true;
        // two quick retries (the database may need to warm up), then let the caller try a smaller window; a window that cannot be split goes on, slower
        this.slowDown();
        if (timeouts >= waits.length) break;
        await this.wait(waits[timeouts++]!, 'Arctic Shift is busy');
        continue;
      }
      timedOut = false;
      this.easeOff();
      if (!res.ok || apiError) throw new Error(`Arctic Shift answered ${res.status} for ${what}: ${(apiError ?? text).slice(0, 200)}`);
      if (json === undefined) throw new Error('Arctic Shift sent something that is not JSON');
      const data = Array.isArray(json) ? json : (json as { data?: unknown }).data;
      if (!Array.isArray(data)) throw new Error('Arctic Shift sent an unexpected response');
      return data as T[];
    }
    const msg = `${lastErr || 'Arctic Shift did not answer'}; try again later`;
    throw timedOut ? new ArcticTimeout(msg) : new Error(msg);
  }

  /** All items between two times (epoch seconds, oldest first), paging forward from the last timestamp received. */
  /** A window the service times out on is halved, down to an hour, and the halves are joined. */
  private async windowSplit<T extends { id: string; created_utc: number }>(path: string, base: Record<string, string | number>, fromSec: number, toSec: number, max: number, onPage?: (n: number) => void, into: Map<string, T> = new Map()): Promise<{ items: T[]; truncated: boolean }> {
    try {
      // a window of an hour or less cannot be split further, so it is retried patiently instead
      return await this.window<T>(path, base, fromSec, toSec, max, onPage, into, toSec - fromSec <= 3600);
    } catch (e) {
      if (!(e instanceof ArcticTimeout)) throw e;
      if (toSec - fromSec <= 3600) throw e;
      const mid = Math.floor((fromSec + toSec) / 2);
      const a = await this.windowSplit<T>(path, base, fromSec, mid, max, onPage, into);
      if (a.truncated) return a;
      return this.windowSplit<T>(path, base, mid, toSec, max, onPage, into);
    }
  }

  private async window<T extends { id: string; created_utc: number }>(path: string, base: Record<string, string | number>, fromSec: number, toSec: number, max: number, onPage?: (n: number) => void, seen: Map<string, T> = new Map(), patient = false): Promise<{ items: T[]; truncated: boolean }> {
    // the service's bounds may or may not include the boundary second, so overlap by one second; ids de-duplicate
    let after = fromSec - 1;
    toSec += 1;
    for (;;) {
      const page = await this.get<T>(path, { ...base, after, before: toSec, sort: 'asc', limit: 100 }, patient);
      if (!page.length) break;
      let last = after;
      let fresh = 0;
      for (const it of page) {
        if (typeof it.id !== 'string' || typeof it.created_utc !== 'number') continue;
        if (!seen.has(it.id)) fresh++;
        seen.set(it.id, it);
        last = Math.max(last, it.created_utc);
      }
      onPage?.(seen.size);
      if (seen.size >= max) {
        for (const id of [...seen.keys()].slice(max)) seen.delete(id); // the shared map holds exactly the capped set
        return { items: [...seen.values()], truncated: true };
      }
      // Step back one second so items sharing the last second of a page are not skipped (ids de-duplicate); a page with nothing new must move on.
      const next = fresh > 0 ? Math.max(last - 1, after) : Math.max(last, after + 1);
      after = next;
      if (after >= toSec) break;
    }
    return { items: [...seen.values()], truncated: false };
  }

  /** `into` receives items as they are read, so a failure or a stop still leaves everything read so far with the caller. */
  posts(subreddit: string, fromSec: number, toSec: number, max = 5000, onPage?: (n: number) => void, into?: Map<string, ArcticPost>) {
    return this.windowSplit<ArcticPost>('/api/posts/search', { subreddit, fields: POST_FIELDS }, fromSec, toSec, max, onPage, into);
  }

  comments(subreddit: string, fromSec: number, toSec: number, max = 20000, onPage?: (n: number) => void, into?: Map<string, ArcticComment>) {
    return this.windowSplit<ArcticComment>('/api/comments/search', { subreddit, fields: COMMENT_FIELDS }, fromSec, toSec, max, onPage, into);
  }

  /**
   * Whether the archive holds any post from a subreddit, ever, and when the newest one is: one cheap request, made before a sync so a
   * misspelt name is caught at once. (The archive's own list of subreddits is updated only now and then, so it is not used.)
   */
  async subredditSeen(subreddit: string): Promise<{ exists: boolean; latest: number | null }> {
    const rows = await this.get<{ id?: string; created_utc?: number }>('/api/posts/search', { subreddit, sort: 'desc', limit: 1, fields: 'id,created_utc' });
    return { exists: rows.length > 0, latest: typeof rows[0]?.created_utc === 'number' ? rows[0].created_utc : null };
  }

  /** Posts by id (the service takes up to 500 at a time). */
  async postsByIds(ids: string[]): Promise<ArcticPost[]> {
    const out: ArcticPost[] = [];
    for (let i = 0; i < ids.length; i += 200) out.push(...(await this.get<ArcticPost>('/api/posts/ids', { ids: ids.slice(i, i + 200).join(','), fields: POST_FIELDS })));
    return out;
  }
}
