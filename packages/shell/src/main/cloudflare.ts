/**
 * Building a Studio in a person's own Cloudflare account, with nothing but Cloudflare's REST API: a D1 database, an R2 bucket and a Worker
 * (the Studio's server, shipped inside this app) bound to them. Each step first looks for what an earlier try already made, so a build that
 * stopped half way is finished by pressing Provision again, and an upgrade is the same upload again. Electron-free: `fetch` is passed in, so
 * this is tested against a fake Cloudflare (test/cloudflare.test.ts).
 *
 * The token only ever goes to api.cloudflare.com, in an Authorization header, and is never written into a log line or an error message.
 */
import { fingerprint, STUDIO_API_VERSION, STUDIO_SCHEMA_VERSION } from '@cadrel/kernel';
import type { StudioEntry } from '../shared/api';

export class CloudflareError extends Error {}

const API = 'https://api.cloudflare.com/client/v4';
/** What the Worker is told it is running on. Only changed deliberately: a new date can change how the platform behaves. */
const COMPATIBILITY_DATE = '2025-09-01';

export interface CloudflareOptions {
  fetchFn: typeof fetch;
  /** Cloudflare's API address; a test points it at a fake. */
  base?: string;
  /** Where a Worker is served from, given its name and the account's subdomain. Default: workers.dev. A test serves it from the fake. */
  workerUrl?: (worker: string, subdomain: string) => string;
  sleep?: (ms: number) => Promise<void>;
  /** Progress, in words the person can read ("Creating the database…"). */
  step?: (text: string) => void;
}

export interface Build {
  accountId: string;
  apiToken: string;
  /** The Studio's id: it names everything made for it. */
  studioId: string;
  /** The owner's public key, given to the Worker so only its holder can administer the Studio. */
  ownerKey: string;
  /** The Studio server, as a Worker module. */
  workerSource: string;
}

export interface Built {
  url: string;
  resources: NonNullable<StudioEntry['resources']>;
  server: { api: number; schema: number };
}

/** The names of what a Studio is made of in Cloudflare. Letters, digits and dashes only: the Worker's name becomes part of its address. */
export const namesFor = (studioId: string) => {
  const base = `cadrel-studio-${studioId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return { worker: base, d1: base, bucket: base };
};

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message?: string }[];
}

export class Cloudflare {
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly o: CloudflareOptions, private readonly token: string) {
    this.base = o.base ?? API;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private say(t: string) {
    this.o.step?.(t);
  }

  /** One call. A refusal becomes a sentence, with Cloudflare's own words when they help; the token is never in it. */
  private async call<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
      });
    } catch {
      throw new CloudflareError('Could not reach Cloudflare. Check your internet connection and try again.');
    }
    if (allow404 && res.status === 404) return null;
    let env: Envelope<T> | null = null;
    try {
      env = (await res.json()) as Envelope<T>;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new CloudflareError('Cloudflare did not accept that API token. Check it was copied whole, and has not expired or been deleted.');
    if (res.status === 403) throw new CloudflareError('That API token is not allowed to do this. It needs Workers Scripts: Edit, D1: Edit and R2: Edit for this account.');
    if (!res.ok || !env?.success) {
      const why = env?.errors?.map((e) => e.message).filter(Boolean).join('; ');
      throw new CloudflareError(`Cloudflare refused a request (${method} ${path.replace(/\/accounts\/[0-9a-f]{32}/, '/accounts/…')}, status ${res.status})${why ? `: ${why}` : '.'}`);
    }
    return env.result;
  }

  /** The address the account's Workers are served from, or a sentence on how to get one. */
  async subdomain(account: string): Promise<string> {
    const r = await this.call<{ subdomain?: string | null }>('GET', `/accounts/${account}/workers/subdomain`);
    if (!r?.subdomain) throw new CloudflareError('This Cloudflare account has no workers.dev address yet. Open Workers & Pages in your Cloudflare dashboard once to choose one, then press Provision again.');
    return r.subdomain;
  }

  async ensureDatabase(account: string, name: string): Promise<string> {
    const found = await this.call<{ uuid: string; name: string }[]>('GET', `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`);
    const have = found?.find((d) => d.name === name);
    if (have) return have.uuid;
    this.say('Creating the database…');
    const made = await this.call<{ uuid: string }>('POST', `/accounts/${account}/d1/database`, { name });
    return made!.uuid;
  }

  async ensureBucket(account: string, name: string): Promise<void> {
    if (await this.call('GET', `/accounts/${account}/r2/buckets/${name}`, undefined, true)) return;
    this.say('Creating the file store…');
    await this.call('POST', `/accounts/${account}/r2/buckets`, { name });
  }

  async uploadWorker(b: Build, names: ReturnType<typeof namesFor>, d1Id: string): Promise<void> {
    const form = new FormData();
    form.set(
      'metadata',
      new Blob(
        [
          JSON.stringify({
            main_module: 'worker.mjs',
            compatibility_date: COMPATIBILITY_DATE,
            bindings: [
              { type: 'd1', name: 'DB', id: d1Id },
              { type: 'r2_bucket', name: 'FILES', bucket_name: names.bucket },
              { type: 'plain_text', name: 'STUDIO_ID', text: b.studioId },
              { type: 'plain_text', name: 'OWNER_KEY', text: b.ownerKey },
              { type: 'plain_text', name: 'ENVIRONMENT', text: 'studio' }
            ]
          })
        ],
        { type: 'application/json' }
      )
    );
    form.set('worker.mjs', new Blob([b.workerSource], { type: 'application/javascript+module' }), 'worker.mjs');
    this.say('Uploading the Studio’s server…');
    await this.call('PUT', `/accounts/${b.accountId}/workers/scripts/${names.worker}`, form);
    await this.call('POST', `/accounts/${b.accountId}/workers/scripts/${names.worker}/subdomain`, { enabled: true, previews_enabled: false });
  }

  /** Waits for the new Worker to answer as the Studio it was told it is (a fresh Worker can take a little while to be reachable). */
  async waitUntilAnswering(url: string, expected: string, tries = 20): Promise<{ api: number; schema: number }> {
    this.say('Waiting for the Studio to answer…');
    let last = 'it did not answer';
    for (let i = 0; i < tries; i++) {
      try {
        const res = await this.o.fetchFn(`${url}/v1/info`);
        if (res.ok) {
          const info = (await res.json()) as { ownerFingerprint?: string; apiVersion?: number; schemaVersion?: number };
          if (info.ownerFingerprint === expected) return { api: info.apiVersion ?? 0, schema: info.schemaVersion ?? 0 };
          last = 'it answered, but as a different Studio';
          break;
        }
        last = `it answered with status ${res.status}`;
      } catch {
        last = 'it could not be reached yet';
      }
      await this.sleep(1500);
    }
    throw new CloudflareError(`The Studio was uploaded, but ${last}. Wait a minute and press Provision again: nothing will be made twice.`);
  }
}

/** Builds a Studio, or finishes building one. */
export async function buildStudio(o: CloudflareOptions, b: Build): Promise<Built> {
  const cf = new Cloudflare(o, b.apiToken);
  const names = namesFor(b.studioId);
  o.step?.('Checking your Cloudflare account…');
  const sub = await cf.subdomain(b.accountId);
  const d1Id = await cf.ensureDatabase(b.accountId, names.d1);
  await cf.ensureBucket(b.accountId, names.bucket);
  await cf.uploadWorker(b, names, d1Id);
  const url = o.workerUrl ? o.workerUrl(names.worker, sub) : `https://${names.worker}.${sub}.workers.dev`;
  const server = await cf.waitUntilAnswering(url, await fingerprint(b.ownerKey));
  return { url, server, resources: { worker: names.worker, d1Id, d1Name: names.d1, bucket: names.bucket } };
}

/**
 * Puts this app's version of the Studio server on a built Studio. Never goes backwards: a Studio that is already ahead of this app is left
 * alone (the app is the thing to update), because the Studio is shared with every other app, development builds included, that uses it.
 */
export async function upgradeStudio(o: CloudflareOptions, b: Build, studio: Pick<StudioEntry, 'url' | 'resources'>): Promise<Built> {
  if (!studio.url || !studio.resources?.d1Id) throw new CloudflareError('This Studio was never fully built. Press Provision to finish it.');
  const cf = new Cloudflare(o, b.apiToken);
  try {
    const res = await o.fetchFn(`${studio.url}/v1/info`);
    if (res.ok) {
      const now = (await res.json()) as { apiVersion?: number; schemaVersion?: number };
      if ((now.schemaVersion ?? 0) > STUDIO_SCHEMA_VERSION || (now.apiVersion ?? 0) > STUDIO_API_VERSION) {
        throw new CloudflareError('This Studio is newer than this version of Cadrel. Update Cadrel instead; the Studio is left as it is.');
      }
    }
  } catch (e) {
    if (e instanceof CloudflareError) throw e;
    /* the Studio is not answering: uploading again is what may fix that */
  }
  await cf.uploadWorker(b, namesFor(b.studioId), studio.resources.d1Id);
  const server = await cf.waitUntilAnswering(studio.url, await fingerprint(b.ownerKey));
  return { url: studio.url, server, resources: studio.resources };
}
