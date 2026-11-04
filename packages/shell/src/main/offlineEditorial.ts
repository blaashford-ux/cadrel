/**
 * Editorial records when the Studio's server cannot be reached. A wrapper round the remote service (see remote.ts) for the three namespaces the
 * editorial work lives in: `briefs`, `passes` and `queries`.
 *
 *   Reading   what the server last said about a call is kept on this computer; when the server cannot be reached the same call answers from that
 *             copy. A call never made before has nothing to answer from, and fails the way it did.
 *   Writing   the author's answers (`queries.answer`) and decisions (`queries.decide`) are checked at once with the server's own rules, kept in a
 *             queue on this computer, and sent in order when the Studio is back. Everything else (planning a pass, delivering it, marking it
 *             responded) changes what other people see and needs the server.
 *   Showing   while answers are waiting, the copy shows them as made, so the author sees their own work.
 *   Refused   an answer the server turns down when it is sent (the pass was closed in the meantime, say) is not lost or retried for ever: it is kept
 *             aside with the server's reason and the author's own words, until they dismiss it.
 *
 * The file is this person's, on this computer, for this Studio. Electron-free and given its inner service, so it is tested against the real Worker.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { checkAnswer, checkDecision, type EditDecisionRecord, type NewEditDecision, type QueryRecord } from '@cadrel/kernel';
import { decodeValue, encodeValue, type StudioService } from '@cadrel/service';
import { StudioOfflineError } from './studioClient';

const NAMESPACES = new Set(['briefs', 'passes', 'queries']);
/** The calls whose answers are kept, so they can be answered again with no server. */
const READS = new Set(['briefs.list', 'briefs.get', 'briefs.versions', 'passes.list', 'passes.get', 'queries.list', 'queries.counts', 'queries.decisions', 'queries.verification']);
const OUTBOX_MAX = 500;
const CACHE_MAX = 200;

export type QueuedCall = 'answer' | 'decide';
export interface Queued {
  id: string;
  personId: string;
  call: QueuedCall;
  queryId: string;
  /** The author's answer, or the decision, as the server will be given it. */
  response?: string;
  decision?: NewEditDecision;
  queuedAt: string;
}
export interface Refused extends Queued {
  error: string;
  refusedAt: string;
}
export interface EditorialOfflineStatus {
  /** The last call found the server unreachable. */
  offline: boolean;
  /** Answers and decisions waiting to be sent. */
  pending: number;
  /** Ones the server turned down, with why. */
  refused: Refused[];
}
interface File {
  version: 1;
  cache: Record<string, { at: string; value: string }>;
  outbox: Queued[];
  refused: Refused[];
}
const empty = (): File => ({ version: 1, cache: {}, outbox: [], refused: [] });

type Fn = (...a: unknown[]) => Promise<unknown>;

export class EditorialOffline {
  private f: File | null = null;
  private away = false;
  private flushing: Promise<{ offline: boolean }> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(private readonly inner: Pick<StudioService, 'as'>, private readonly o: { file: string; now?: () => Date }) {}

  /** The service, as one person, with the editorial namespaces wrapped. Everything else is the inner service's. */
  as(personId: string): ReturnType<StudioService['as']> {
    const real = this.inner.as(personId) as unknown as Record<string, unknown>;
    return new Proxy(real, {
      get: (t, name) => (typeof name === 'string' && NAMESPACES.has(name) ? this.namespace(personId, name, t[name] as Record<string, Fn>) : t[name as string])
    }) as unknown as ReturnType<StudioService['as']>;
  }

  /** This wrapper as a service, to stand where `remoteService(...)` stood. */
  service(): StudioService {
    return { as: (id: string) => this.as(id) } as unknown as StudioService;
  }

  async status(): Promise<EditorialOfflineStatus> {
    const f = await this.load();
    return { offline: this.away, pending: f.outbox.length, refused: f.refused };
  }

  /** Sends what is waiting, in the order it was made, stopping at the first sign the server is unreachable. */
  flush(): Promise<{ offline: boolean }> {
    return (this.flushing ??= this.doFlush().finally(() => (this.flushing = null)));
  }

  /** Forgets an answer the server turned down. */
  async dismiss(id: string): Promise<void> {
    const f = await this.load();
    f.refused = f.refused.filter((r) => r.id !== id);
    await this.save();
  }

  // ---- the file --------------------------------------------------------------------------------------------------------------

  private async load(): Promise<File> {
    if (this.f) return this.f;
    try {
      const j = JSON.parse(await fsp.readFile(this.o.file, 'utf8')) as Partial<File>;
      this.f = j && j.version === 1 ? { version: 1, cache: j.cache ?? {}, outbox: Array.isArray(j.outbox) ? j.outbox : [], refused: Array.isArray(j.refused) ? j.refused : [] } : empty();
    } catch {
      this.f = empty();
    }
    return this.f;
  }
  private save(): Promise<void> {
    const text = JSON.stringify(this.f);
    // one write at a time, each whole: a crash leaves the file as it was or as it is now, never half
    return (this.saving = this.saving.then(async () => {
      await fsp.mkdir(path.dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, text);
      await fsp.rename(tmp, this.o.file);
    }).catch(() => undefined));
  }
  private now = () => (this.o.now?.() ?? new Date()).toISOString();

  // ---- reading ---------------------------------------------------------------------------------------------------------------

  private namespace(personId: string, ns: string, target: Record<string, Fn>): unknown {
    return new Proxy(target, {
      get: (t, method) => {
        const fn = t[method as string];
        if (typeof method !== 'string' || typeof fn !== 'function') return fn;
        const key = `${ns}.${method}`;
        if (READS.has(key)) return (...args: unknown[]) => this.read(key, args, () => fn(...args));
        if (key === 'queries.answer') return (queryId: string, response: string) => this.write(personId, { call: 'answer', queryId, response }, () => fn(queryId, response));
        if (key === 'queries.decide') return (queryId: string, input: NewEditDecision) => this.write(personId, { call: 'decide', queryId, decision: input }, () => fn(queryId, input));
        return (...args: unknown[]) => fn(...args);
      }
    });
  }

  private async read(key: string, args: unknown[], run: () => Promise<unknown>): Promise<unknown> {
    const f = await this.load();
    const k = `${key}:${encodeValue(args)}`;
    if (f.outbox.length && (await this.flush()).offline) return this.fromCopy(k, key, args, new StudioOfflineError('Could not reach the Studio. Check your internet connection.'));
    try {
      const v = await run();
      this.away = false;
      f.cache[k] = { at: this.now(), value: encodeValue(v) };
      const keys = Object.keys(f.cache);
      if (keys.length > CACHE_MAX) for (const old of keys.sort((a, b) => f.cache[a]!.at.localeCompare(f.cache[b]!.at)).slice(0, keys.length - CACHE_MAX)) delete f.cache[old];
      await this.save();
      return v;
    } catch (e) {
      if (!(e instanceof StudioOfflineError)) throw e;
      this.away = true;
      return this.fromCopy(k, key, args, e);
    }
  }

  private fromCopy(k: string, key: string, args: unknown[], offline: Error): unknown {
    const hit = this.f!.cache[k];
    if (!hit) throw offline;
    return this.overlay(key, args, decodeValue(hit.value));
  }

  /** The copy, with the author's waiting answers and decisions shown as made. */
  private overlay(key: string, args: unknown[], value: unknown): unknown {
    const waiting = this.f!.outbox;
    if (!waiting.length) return value;
    if (key === 'queries.list' && Array.isArray(value)) {
      const answers = new Map(waiting.filter((w) => w.call === 'answer').map((w) => [w.queryId, w]));
      return (value as QueryRecord[]).map((q) => {
        const w = answers.get(q.id);
        return w && (q.state === 'open' || q.state === 'answered') ? { ...q, state: 'answered', response: w.response!, respondedBy: w.personId, respondedAt: w.queuedAt } : q;
      });
    }
    if (key === 'queries.decisions' && Array.isArray(value) && !(args[0] as { history?: boolean } | undefined)?.history) {
      const now = new Map(waiting.filter((w) => w.call === 'decide').map((w) => [w.queryId, w]));
      const kept = (value as EditDecisionRecord[]).filter((d) => !now.has(d.queryId));
      const before = new Map((value as EditDecisionRecord[]).map((d) => [d.queryId, d]));
      const made = [...now.values()].map((w): EditDecisionRecord => {
        const d = checkDecision(w.decision!);
        return { id: `queued:${w.id}`, queryId: w.queryId, outcome: d.outcome, reason: d.reason, revisit: d.revisit, ledgerId: '', taskId: null, supersedesId: before.get(w.queryId)?.id ?? null, decidedBy: w.personId, decidedAt: w.queuedAt };
      });
      return [...kept, ...made];
    }
    return value;
  }

  // ---- writing ---------------------------------------------------------------------------------------------------------------

  private async write(personId: string, w: Pick<Queued, 'call' | 'queryId' | 'response' | 'decision'>, run: () => Promise<unknown>): Promise<unknown> {
    const f = await this.load();
    // the server's own rules, so a mistake is told now and not when the Studio is next reached
    const response = w.call === 'answer' ? checkAnswer(w.response) : undefined;
    if (w.call === 'decide') checkDecision(w.decision!);

    if (f.outbox.length) await this.flush(); // what was made first goes first
    if (!f.outbox.length) {
      try {
        const r = await run();
        this.away = false;
        return r;
      } catch (e) {
        if (!(e instanceof StudioOfflineError)) throw e;
        this.away = true;
      }
    }
    return this.queue(personId, w, response);
  }

  private async queue(personId: string, w: Pick<Queued, 'call' | 'queryId' | 'response' | 'decision'>, response: string | undefined): Promise<unknown> {
    const f = this.f!;
    const known = this.knownQuery(w.queryId);
    if (!known) throw new StudioOfflineError('The Studio cannot be reached, and this item is not saved on this computer, so it cannot be answered now. Open the pass while you are online first.');
    // a later answer or decision on the same item replaces the one still waiting
    f.outbox = f.outbox.filter((x) => !(x.call === w.call && x.queryId === w.queryId));
    if (f.outbox.length >= OUTBOX_MAX) throw new StudioOfflineError(`${OUTBOX_MAX} answers are already waiting for the Studio. Connect to send them first.`);
    const entry: Queued = { id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`, personId, call: w.call, queryId: w.queryId, queuedAt: this.now(), ...(response !== undefined ? { response } : { decision: w.decision }) };
    f.outbox.push(entry);
    await this.save();
    if (w.call === 'answer') return { ...known, state: 'answered', response, respondedBy: personId, respondedAt: entry.queuedAt };
    const d = checkDecision(w.decision!);
    return { id: `queued:${entry.id}`, queryId: w.queryId, outcome: d.outcome, reason: d.reason, revisit: d.revisit, ledgerId: '', taskId: null, supersedesId: null, decidedBy: personId, decidedAt: entry.queuedAt } satisfies EditDecisionRecord;
  }

  /** The item as last seen on this computer, from any list of a pass's items kept in the copy. */
  private knownQuery(queryId: string): QueryRecord | null {
    for (const [k, v] of Object.entries(this.f!.cache)) {
      if (!k.startsWith('queries.list:')) continue;
      const hit = (decodeValue(v.value) as QueryRecord[]).find((q) => q.id === queryId);
      if (hit) return hit;
    }
    return null;
  }

  private async doFlush(): Promise<{ offline: boolean }> {
    const f = await this.load();
    while (f.outbox.length) {
      const w = f.outbox[0]!;
      const q = (this.inner.as(w.personId) as unknown as { queries: Record<string, Fn> }).queries;
      try {
        if (w.call === 'answer') await q.answer!(w.queryId, w.response);
        else await q.decide!(w.queryId, w.decision);
        f.outbox.shift();
        this.away = false;
      } catch (e) {
        if (e instanceof StudioOfflineError) {
          this.away = true;
          await this.save();
          return { offline: true };
        }
        f.outbox.shift();
        f.refused.push({ ...w, error: e instanceof Error ? e.message : 'The Studio did not accept it.', refusedAt: this.now() });
      }
      await this.save();
    }
    return { offline: false };
  }
}
