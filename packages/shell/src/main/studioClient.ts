/**
 * The app's side of a Studio's own API: signing every request with this computer's key for that Studio. Electron-free (`fetch` is passed
 * in) so it is tested against the real Worker code (test/provisioning.test.ts).
 */
import { fingerprint, generateKeyPair, invitationLink, parseInvitation, signRequest, type KeyPair } from '@cadrel/kernel';
import type { StudioInvite, StudioMember } from '../shared/api';

export class StudioApiError extends Error {}

export class StudioClient {
  constructor(private readonly o: { url: string; key: KeyPair; fetchFn: typeof fetch }) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { ...(await signRequest({ method, path, body: text, key: this.o.key })), ...(text ? { 'content-type': 'application/json' } : {}) };
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.url}${path}`, { method, headers, ...(text ? { body: text } : {}) });
    } catch {
      throw new StudioApiError('Could not reach the Studio. Check your internet connection.');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new StudioApiError(data.error ?? `The Studio answered with status ${res.status}.`);
    return data as T;
  }

  info() {
    return this.o.fetchFn(`${this.o.url}/v1/info`).then((r) => r.json() as Promise<{ studioId: string; ownerFingerprint: string; apiVersion: number; schemaVersion: number }>);
  }
  me() {
    return this.request<{ kind: 'owner' | 'member'; role: string; name: string; studioId: string }>('GET', '/v1/me');
  }
  async people(): Promise<{ members: StudioMember[]; invites: StudioInvite[] }> {
    const [m, i] = await Promise.all([this.request<{ members: StudioMember[] }>('GET', '/v1/members'), this.request<{ invites: StudioInvite[] }>('GET', '/v1/invites')]);
    return { members: m.members, invites: i.invites };
  }
  /** Makes an invitation and the link to send. The code is shown once: the Studio keeps only a hash of it. */
  async invite(role: string, label: string, studioName: string): Promise<{ link: string; expiresAt: string }> {
    const r = await this.request<{ code: string; expiresAt: string }>('POST', '/v1/invites', { role, label });
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
