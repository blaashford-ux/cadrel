/**
 * Autocomplete clients for Amazon's Kindle-store search box, Google and Bing. All three are undocumented, keyless
 * endpoints that answer a prefix with the phrases people type next, most popular first. A phrase's position is a
 * ranking signal, not a search volume.
 *
 * They are only ever called because the user pressed a button, from the user's own machine, a few dozen small
 * requests at a time. A source that answers with a block (429/403, or a page that is not JSON) is dropped after a
 * second one instead of being retried.
 */

export type SuggestSource = 'amazon' | 'google' | 'bing';
export const SUGGEST_SOURCES: SuggestSource[] = ['amazon', 'google', 'bing'];

export const SOURCE_LABEL: Record<SuggestSource | 'reddit' | 'trends', string> = {
  amazon: 'Amazon',
  google: 'Google',
  bing: 'Bing',
  reddit: 'Reddit',
  trends: 'Google Trends',
};

interface Endpoint {
  url(prefix: string): string;
  parse(json: unknown): string[];
}

const strings = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);

/** Google and Bing both answer the OpenSearch shape: [query, [suggestion, ...]]. */
const openSearch = (json: unknown): string[] => (Array.isArray(json) ? strings(json[1]) : []);

const ENDPOINTS: Record<SuggestSource, Endpoint> = {
  // alias=digital-text is the Kindle Store department, so the phrases are what readers type when shopping for ebooks
  amazon: {
    url: (p) => `https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=digital-text&limit=11&suggestion-type=KEYWORD&prefix=${encodeURIComponent(p)}`,
    parse: (json) => {
      const s = (json as { suggestions?: unknown } | null)?.suggestions;
      return Array.isArray(s) ? s.map((x) => (x as { value?: unknown } | null)?.value).filter((v): v is string => typeof v === 'string') : [];
    },
  },
  google: { url: (p) => `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(p)}`, parse: openSearch },
  bing: { url: (p) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(p)}`, parse: openSearch },
};

export interface Suggestion {
  keyword: string;
  /** 1-based place in the list the phrase came from. */
  position: number;
  /** What was typed to get it: the seed itself, or the seed plus a letter. */
  via: string;
}

export interface SuggestResult {
  source: SuggestSource;
  seed: string;
  suggestions: Suggestion[];
  requests: number;
  /** Why the lookup ended early, in words; null when every query ran. */
  stopped: string | null;
}

export interface SuggestOptions {
  fetch?: typeof fetch;
  /** Pause between requests, in ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Hard cap on requests in one lookup. */
  maxRequests?: number;
  /** Blocked answers tolerated before the source is dropped. */
  maxBlocks?: number;
  /** Letters appended to the seed to widen the list; defaults to a-z. */
  letters?: string;
  onProgress?: (done: number, total: number) => void;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const normalizeKeyword = norm;

export async function expandSeed(source: SuggestSource, seed: string, o: SuggestOptions = {}): Promise<SuggestResult> {
  const clean = norm(seed);
  if (clean.length < 2) throw new Error('type at least two characters');
  if (clean.length > 80) throw new Error('keep the phrase under 80 characters');
  const ep = ENDPOINTS[source];
  const doFetch = o.fetch ?? fetch;
  const delayMs = o.delayMs ?? 400;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    o.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  }));
  const maxRequests = o.maxRequests ?? 27;
  const maxBlocks = o.maxBlocks ?? 2;
  const queries = [clean, ...[...(o.letters ?? 'abcdefghijklmnopqrstuvwxyz')].map((l) => `${clean} ${l}`)].slice(0, maxRequests);

  const best = new Map<string, Suggestion>();
  let requests = 0;
  let blocks = 0;
  let stopped: string | null = null;

  for (const [i, q] of queries.entries()) {
    if (o.signal?.aborted) { stopped = 'cancelled'; break; }
    if (i > 0) await sleep(delayMs);
    o.onProgress?.(i, queries.length);
    requests++;
    let res: Response;
    try {
      res = await doFetch(ep.url(q), { signal: o.signal, headers: { accept: 'application/json' } });
    } catch (e) {
      if (o.signal?.aborted) { stopped = 'cancelled'; break; }
      stopped = `could not reach ${SOURCE_LABEL[source]} (${(e as Error).message})`;
      break;
    }
    let list: string[] | null = null;
    if (res.ok) {
      try { list = ep.parse(JSON.parse(await res.text())); } catch { list = null; }
    }
    if (list === null) {
      // 429/403, or a 200 that is a challenge page instead of JSON: do not push on
      blocks++;
      if (blocks >= maxBlocks) { stopped = `${SOURCE_LABEL[source]} stopped answering (${res.status}); try again later`; break; }
      await sleep(Math.max(delayMs, 2000));
      continue;
    }
    list.forEach((k, idx) => {
      const keyword = norm(k);
      if (!keyword) return;
      const cur = best.get(keyword);
      const cand: Suggestion = { keyword, position: idx + 1, via: q === clean ? 'seed' : q.slice(clean.length + 1) };
      // keep the strongest sighting: the plain seed beats a letter expansion, then the lower position
      if (!cur || (cand.via === 'seed' && cur.via !== 'seed') || (cand.via === cur.via && cand.position < cur.position)) best.set(keyword, cand);
    });
  }
  o.onProgress?.(queries.length, queries.length);
  if (!stopped && blocks > 0 && !best.size) stopped = `${SOURCE_LABEL[source]} stopped answering; try again later`;
  const suggestions = [...best.values()].sort((a, b) => Number(b.via === 'seed') - Number(a.via === 'seed') || a.position - b.position || a.keyword.localeCompare(b.keyword));
  return { source, seed: clean, suggestions, requests, stopped };
}
