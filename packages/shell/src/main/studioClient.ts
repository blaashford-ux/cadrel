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

export class StudioClient {
  constructor(private readonly o: { url: string; key: KeyPair; fetchFn: typeof fetch }) {}

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
  rpc<T>(path: string[], args: unknown[]): Promise<T> {
    return this.wire<T>('/v1/call', { path, args });
  }
  /** An operation of the Studio's vault, as that person. */
  vault<T>(method: string, arg?: unknown): Promise<T> {
    return this.wire<T>('/v1/vault', { method, args: [arg] });
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
    await this.wire<boolean>('/v1/tree', tree, 'PUT');
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
