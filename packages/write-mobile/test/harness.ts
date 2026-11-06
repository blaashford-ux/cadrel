// Not type-checked with the app: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
// A Studio as the phone meets it: the real Studio server code (the Worker, with a fake database and file store), a desktop that fills it, and phones.
import { vi } from 'vitest';
import { generateKeyPair, hex, invitationLink, fingerprint, sha256, type KeyPair } from '@cadrel/kernel';
import { joinStudio, StudioClient } from '@cadrel/studio-client';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import worker, { type Env } from '../../worker/src/index';
import { fakeD1 } from '../../worker/test/d1fake';
import { fakeR2 } from '../../worker/test/r2fake';
import { StudioSync } from '../src/studio/vaultSync';

export const enc = new TextEncoder();
export const hashOf = async (t: string) => hex(await sha256(enc.encode(t)));
export const URL_ = 'https://studio.test';

export const TREE = {
  projects: [
    { id: 'pS', name: 'Dragon Rider', parentId: null, kind: 'Series', status: 'active', order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'pB1', name: 'Book 1', parentId: 'pS', kind: 'Book', status: 'active', order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'pB2', name: 'Book 2', parentId: 'pS', kind: 'Book', status: 'active', order: 1, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  ],
  links: []
};

export async function studio() {
  const ownerKey = await generateKeyPair();
  const env: Env = { ENVIRONMENT: 'studio', DB: fakeD1(), FILES: fakeR2(), STUDIO_ID: 'st1', OWNER_KEY: ownerKey.publicKey };
  // The clock is faked so that each request is signed at a different millisecond (the server refuses a signature it has seen) and the
  // server sees the same time the client signed at.
  let now = 1_800_000_000_000;
  vi.setSystemTime(now);
  let offline = false;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new TypeError('network down');
    try {
      return await worker.fetch(new Request(input as string, init), env);
    } finally {
      vi.setSystemTime((now += 1));
    }
  }) as typeof fetch;
  const owner = new StudioClient({ url: URL_, key: ownerKey, fetchFn });
  await owner.publishTree(TREE as never);

  /** The desktop: makes a file (as version 1), or saves a new version (check-out then check-in). */
  const desk = {
    async add(path: string, text: string, projectId?: string) {
      await owner.putBlob(await hashOf(text), enc.encode(text));
      return owner.vault<{ ok: boolean; id: string }>('addFile', { path, hash: await hashOf(text), size: text.length, comment: 'First', machine: 'desk', ...(projectId ? { projectId } : {}) });
    },
    async save(path: string, text: string) {
      const f = (await owner.vault<{ id: string; path: string }[]>('list')).find((x) => x.path === path)!;
      await owner.vault('checkOut', { fileId: f.id, machine: 'desk' });
      await owner.putBlob(await hashOf(text), enc.encode(text));
      return owner.vault('checkIn', { fileId: f.id, machine: 'desk', hash: await hashOf(text), size: text.length, comment: 'Desk edit' });
    },
    async hold(path: string) {
      const f = (await owner.vault<{ id: string; path: string }[]>('list')).find((x) => x.path === path)!;
      return owner.vault('checkOut', { fileId: f.id, machine: 'desk' });
    },
    async text(path: string) {
      const f = (await owner.vault<{ path: string; hash: string | null }[]>('list')).find((x) => x.path === path)!;
      return new TextDecoder().decode((await owner.getBlob(f.hash!))!);
    },
    list: () => owner.vault<{ id: string; path: string; currentVersion: number; lock: unknown }[]>('list')
  };

  const invite = async (role: string, name: string, extra: Record<string, unknown> = {}) => {
    const r = await owner.request<{ code: string }>('POST', '/v1/invites', { role, label: name, ...extra });
    return joinStudio({ link: invitationLink({ url: URL_, code: r.code, fingerprint: await fingerprint(ownerKey.publicKey), studioName: 'Test Studio' }), yourName: name, fetchFn });
  };

  /** A phone: its own storage, signed in as a member. */
  const phone = async (role = 'author', opts: { name?: string; extra?: Record<string, unknown>; device?: string; machine?: string } = {}) => {
    const joined = await invite(role, opts.name ?? 'Ann Author', opts.extra);
    const client = new StudioClient({ url: URL_, key: joined.key as KeyPair, fetchFn });
    const fs = new MemoryFs();
    let revoked: string | null = null;
    const sync = new StudioSync({ fs, port: client, root: '/Studios/st1/Projects', stateFile: '/state/st1.json', machine: opts.machine ?? 'phone-1', device: opts.device ?? 'Pixel 8', now: () => new Date('2026-11-06T10:00:00Z'), onRevoked: (m) => (revoked = m) });
    return { fs, sync, client, key: joined.key as KeyPair, revoked: () => revoked };
  };
  return { owner, ownerKey, desk, phone, setOffline: (v: boolean) => (offline = v), env };
}

