/**
 * The desktop shell's client for a Studio's server: the shared client (`@cadrel/studio-client`, also used by the phone app) plus the calls only
 * the Studio Manager makes (people, invitations). Electron-free, so it is tested against the real Worker code (test/provisioning.test.ts).
 */
import { fingerprint, invitationLink } from '@cadrel/kernel';
import { StudioClient as BaseClient } from '@cadrel/studio-client';
import type { StudioInvite, StudioMember } from '../shared/api';

export { FRESH_MS, KEEP_MS, joinStudio, StudioApiError, StudioOfflineError } from '@cadrel/studio-client';

export class StudioClient extends BaseClient {
  async people(): Promise<{ members: StudioMember[]; invites: StudioInvite[] }> {
    const [m, i] = await Promise.all([this.request<{ members: StudioMember[] }>('GET', '/v1/members'), this.request<{ invites: StudioInvite[] }>('GET', '/v1/invites')]);
    return { members: m.members, invites: i.invites };
  }
  /** Makes an invitation and the link to send. The code is shown once: the Studio keeps only a hash of it. */
  async invite(role: string, label: string, studioName: string, grant: { projectId?: string | null; days?: number | null } = {}): Promise<{ link: string; expiresAt: string }> {
    const r = await this.request<{ code: string; expiresAt: string }>('POST', '/v1/invites', { role, label, ...(grant.projectId ? { projectId: grant.projectId } : {}), ...(grant.days ? { days: grant.days } : {}) });
    return { link: invitationLink({ url: this.o.url, code: r.code, fingerprint: await fingerprint(this.o.key.publicKey), studioName }), expiresAt: r.expiresAt }; // an owner's key is the Studio's key
  }
  /** A one-hour, one-use link that makes another device of the owner's (a phone) the owner too, with its own key. The code is shown once. */
  async linkDevice(label: string, studioName: string): Promise<{ link: string; expiresAt: string }> {
    const r = await this.request<{ code: string; expiresAt: string }>('POST', '/v1/devices', { label });
    return { link: invitationLink({ url: this.o.url, code: r.code, fingerprint: await fingerprint(this.o.key.publicKey), studioName, device: true }), expiresAt: r.expiresAt };
  }
  async devices(): Promise<{ id: string; label: string; linkedAt: string }[]> {
    return (await this.request<{ devices: { id: string; label: string; linkedAt: string }[] }>('GET', '/v1/devices')).devices;
  }
  removeDevice(id: string) {
    return this.request('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
  }
  revokeInvite(id: string) {
    return this.request('DELETE', `/v1/invites/${encodeURIComponent(id)}`);
  }
  removeMember(id: string) {
    return this.request('DELETE', `/v1/members/${encodeURIComponent(id)}`);
  }
}
