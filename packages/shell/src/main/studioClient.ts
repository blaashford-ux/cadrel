/**
 * The app's side of a Studio's own API: signing every request with this computer's key for that Studio. Electron-free (`fetch` is passed
 * in) so it is tested against the real Worker code (test/provisioning.test.ts).
 */
import { fingerprint, generateKeyPair, invitationLink, parseInvitation, signRequest, type KeyPair, type ProjectTree } from '@cadrel/kernel';
import { decodeError, decodeValue, encodeValue, type WireError } from '@cadrel/service';
import type { StudioInvite, StudioMember } from '../shared/api';

export class StudioApiError extends Error {}
/** The Studio could not be reached at all (no network, the server down), as opposed to answering with a refusal. */
export class StudioOfflineError extends StudioApiError {}

/**
 * The service's calls that only read. The answers to these are kept here until the Studio says something changed (see `StudioClient.rpc`), so a
 * page that refreshes itself does not make the server read its database again to be told the same thing. Anything not listed is a change,
 * or is not known to be a pure read, and is always sent.
 */
const READS = new Set([
  'can', 'canOn', 'canAt', 'explain', 'visibleProjects',
  'catalogue.ips', 'catalogue.series', 'catalogue.books', 'catalogue.book', 'catalogue.byAsin', 'catalogue.projectLinks',
  'people.list', 'people.get', 'people.teams', 'people.directory', 'people.penNames', 'people.penNameNames', 'people.roles', 'people.assignments', 'people.capabilityReview', 'people.explainAccess', 'people.effectiveCapabilities',
  'business.contributions', 'business.credits', 'business.rights', 'business.shares',
  'work.tasks', 'work.task', 'work.openTaskCount', 'work.assignable', 'work.approvals', 'work.waitingForMe', 'work.editorialFacts', 'work.approvedLabels', 'work.decisions', 'work.decision',
  'briefs.list', 'briefs.get', 'briefs.versions', 'passes.list', 'passes.get', 'queries.list', 'queries.counts', 'queries.decisions', 'queries.verification',
  'workflows.list', 'workflows.defaultFor', 'workflows.stageOptions', 'workflows.allowMove'
]);
/** How long the Studio's change counter is trusted before it is asked again. */
export const FRESH_MS = 3_000;
/** The longest an answer is kept even if nothing changed: a role that ends at a set time changes an answer without any record changing. */
export const KEEP_MS = 5 * 60_000;

export class StudioClient {
  constructor(private readonly o: { url: string; key: KeyPair; fetchFn: typeof fetch; now?: () => number }) {}

  private readonly kept = new Map<string, { at: number; value: unknown }>();
  private seen: string | null = null;
  private unversioned = false;
  private checkedAt = -Infinity;
  /** Moves when a change is made from here, so an answer that was on its way back when it happened is not kept. */
  private generation = 0;
  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }
  /** What this computer has changed (or cannot be sure of) may make every kept answer wrong: start over. */
  forget(): void {
    this.generation++;
    this.kept.clear();
    this.checkedAt = -Infinity;
  }
  /** Asks the Studio whether anything changed since the last time, and drops what was kept if so. One cheap request, however many answers are kept. */
  private async check(): Promise<void> {
    let v: { data: string; access: string };
    try {
      v = await this.version();
    } catch (e) {
      if (e instanceof StudioOfflineError) throw e;
      this.unversioned = true; // a Studio from before the counters: nothing can be kept, everything is asked every time
      this.kept.clear();
      return;
    }
    const stamp = `${v.data}`;
    if (stamp !== this.seen) {
      this.kept.clear();
      this.seen = stamp;
    }
    this.checkedAt = this.now();
  }
  /** The Studio's change counters: they differ whenever any of its records (data) or who may do what (access) changed. */
  version(): Promise<{ data: string; access: string }> {
    return this.request('GET', '/v1/version');
  }

  /** One signed request. The answer is returned as it came; the callers below turn it into a value or an error. */
  private async send(method: string, path: string, body: string | Uint8Array, contentType: string): Promise<Response> {
    const headers = { ...(await signRequest({ method, path, body, key: this.o.key })), ...(body.length ? { 'content-type': contentType } : {}) };
    try {
      return await this.o.fetchFn(`${this.o.url}${path}`, { method, headers, ...(body.length ? { body: body as BodyInit } : {}) });
    } catch (e) {
      throw new StudioOfflineError('Could not reach the Studio. Check your internet connection.', { cause: e });
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body === undefined ? '' : JSON.stringify(body), 'application/json');
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new StudioApiError(data.error ?? `The Studio answered with status ${res.status}.`);
    return data as T;
  }

  /** A call whose answer (or refusal) is the service's own: values keep their sets and maps, errors come back as the kind they were. */
  private async wire<T>(path: string, payload?: unknown, method = 'POST'): Promise<T> {
    const res = await this.send(method, path, payload === undefined ? '' : encodeValue(payload), 'application/json');
    const text = await res.text();
    let data: { result?: T } & Partial<WireError>;
    try {
      data = decodeValue(text) as typeof data;
    } catch {
      throw new StudioApiError(`The Studio answered with status ${res.status}.`);
    }
    if (!res.ok) throw data.kind ? decodeError(data as WireError) : new StudioApiError(data.error ?? `The Studio answered with status ${res.status}.`);
    return data.result as T;
  }

  /** A call to the Studio's service, as the person this computer's key belongs to (the server decides who that is, and what they may do). */
  async rpc<T>(path: string[], args: unknown[]): Promise<T> {
    const name = path.join('.');
    if (!READS.has(name) || this.unversioned) {
      try {
        return await this.wire<T>('/v1/call', { path, args });
      } finally {
        this.forget(); // even a refusal or a dropped connection: the change may have gone through
      }
    }
    if (this.now() - this.checkedAt >= FRESH_MS) await this.check();
    if (this.unversioned) return this.wire<T>('/v1/call', { path, args });
    const key = `${name}|${encodeValue(args)}`;
    const hit = this.kept.get(key);
    if (hit && this.now() - hit.at < KEEP_MS) return structuredClone(hit.value) as T;
    const generation = this.generation;
    const value = await this.wire<T>('/v1/call', { path, args });
    if (generation === this.generation) this.kept.set(key, { at: this.now(), value: structuredClone(value) });
    return value;
  }
  /** An operation of the Studio's vault, as that person. */
  async vault<T>(method: string, arg?: unknown): Promise<T> {
    try {
      return await this.wire<T>('/v1/vault', { method, args: [arg] });
    } finally {
      this.forget();
    }
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const res = await this.send('PUT', `/v1/blobs/${hash}`, bytes, 'application/octet-stream');
    if (!res.ok) throw new StudioApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The Studio answered with status ${res.status}.`);
  }
  async getBlob(hash: string): Promise<Uint8Array | null> {
    const res = await this.send('GET', `/v1/blobs/${hash}`, '', 'application/json');
    if (res.status === 404) return null;
    if (!res.ok) throw new StudioApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The Studio answered with status ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }
  /** The names of the captures the Studio holds, a page at a time (`next` is null on the last). */
  captures(cursor?: string): Promise<{ files: { path: string; size: number }[]; next: string | null }> {
    return this.request('GET', `/v1/captures${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  }
  async putCapture(rel: string, bytes: Uint8Array): Promise<void> {
    const res = await this.send('PUT', `/v1/captures/${rel}`, bytes, 'application/octet-stream');
    if (!res.ok) throw new StudioApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The Studio answered with status ${res.status}.`);
  }
  async getCapture(rel: string): Promise<Uint8Array | null> {
    const res = await this.send('GET', `/v1/captures/${rel}`, '', 'application/json');
    if (res.status === 404) return null;
    if (!res.ok) throw new StudioApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The Studio answered with status ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }
  /** The project tree as this person may see it. */
  tree(): Promise<ProjectTree> {
    return this.wire<ProjectTree>('/v1/tree', undefined, 'GET');
  }
  /** The owner publishes the Studio's projects, which is what everyone else sees (each their own part). */
  async publishTree(tree: ProjectTree): Promise<void> {
    try {
      await this.wire<boolean>('/v1/tree', tree, 'PUT');
    } finally {
      this.forget();
    }
  }

  async info() {
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.url}/v1/info`);
    } catch (e) {
      throw new StudioOfflineError('Could not reach the Studio. Check your internet connection.', { cause: e });
    }
    return (await res.json()) as { studioId: string; ownerFingerprint: string; apiVersion: number; schemaVersion: number };
  }
  me() {
    return this.request<{ kind: 'owner' | 'member'; role: string; name: string; studioId: string; personId: string }>('GET', '/v1/me');
  }
  async people(): Promise<{ members: StudioMember[]; invites: StudioInvite[] }> {
    const [m, i] = await Promise.all([this.request<{ members: StudioMember[] }>('GET', '/v1/members'), this.request<{ invites: StudioInvite[] }>('GET', '/v1/invites')]);
    return { members: m.members, invites: i.invites };
  }
  /** Makes an invitation and the link to send. The code is shown once: the Studio keeps only a hash of it. */
  async invite(role: string, label: string, studioName: string, grant: { projectId?: string | null; days?: number | null } = {}): Promise<{ link: string; expiresAt: string }> {
    const r = await this.request<{ code: string; expiresAt: string }>('POST', '/v1/invites', { role, label, ...(grant.projectId ? { projectId: grant.projectId } : {}), ...(grant.days ? { days: grant.days } : {}) });
    return { link: invitationLink({ url: this.o.url, code: r.code, fingerprint: await fingerprint(this.o.key.publicKey), studioName }), expiresAt: r.expiresAt }; // an owner's key is the Studio's key
  }
  revokeInvite(id: string) {
    return this.request('DELETE', `/v1/invites/${encodeURIComponent(id)}`);
  }
  removeMember(id: string) {
    return this.request('DELETE', `/v1/members/${encodeURIComponent(id)}`);
  }
}

/**
 * Joins a Studio from an invitation link: checks the Studio at that address really belongs to the owner the link names, then registers a
 * new key made here. Nothing is sent to an address that did not first prove who owns it.
 */
export async function joinStudio(o: { link: string; yourName: string; fetchFn: typeof fetch }): Promise<{ url: string; fingerprint: string; role: string; studioId: string; studioName: string | null; key: KeyPair }> {
  const inv = parseInvitation(o.link);
  if (!inv) throw new StudioApiError('That is not a Cadrel invitation link. It starts with cadrel://join');
  let info: { studioId: string; ownerFingerprint: string; apiVersion: number };
  try {
    info = (await (await o.fetchFn(`${inv.url}/v1/info`)).json()) as typeof info;
  } catch {
    throw new StudioApiError('Could not reach that Studio. Check your internet connection and the link.');
  }
  if (info.ownerFingerprint !== inv.fingerprint) throw new StudioApiError('That address does not belong to the owner the invitation names, so nothing was sent. Ask for a new invitation.');
  const key = await generateKeyPair();
  const joined = await new StudioClient({ url: inv.url, key, fetchFn: o.fetchFn }).request<{ role: string; studioId: string }>('POST', '/v1/join', { code: inv.code, name: o.yourName.trim() });
  return { url: inv.url, fingerprint: inv.fingerprint, role: joined.role, studioId: joined.studioId, studioName: inv.studioName ?? null, key };
}
