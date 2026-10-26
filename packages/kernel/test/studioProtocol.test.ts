import { describe, expect, it } from 'vitest';
import { fingerprint, generateKeyPair, invitationLink, parseInvitation, signRequest, verifyRequest } from '../src/studioProtocol';

const headersOf = (h: Record<string, string>) => (n: string) => h[n] ?? null;

describe('studio protocol', () => {
  it('signs a request so the other side can check it, and any change breaks it', async () => {
    const k = await generateKeyPair();
    const now = 1_700_000_000_000;
    const h = await signRequest({ method: 'POST', path: '/v1/invites', body: '{"role":"author"}', key: k, now });
    const ok = await verifyRequest({ method: 'POST', path: '/v1/invites', body: '{"role":"author"}', headers: headersOf(h), now: now + 1000 });
    expect(ok).toMatchObject({ ok: true, publicKey: k.publicKey });
    for (const change of [{ method: 'DELETE' }, { path: '/v1/members' }, { body: '{"role":"owner"}' }]) {
      const r = await verifyRequest({ method: 'POST', path: '/v1/invites', body: '{"role":"author"}', headers: headersOf(h), now, ...change });
      expect(r.ok).toBe(false);
    }
  });

  it('refuses unsigned, stale and foreign-key requests', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const now = 1_700_000_000_000;
    const h = await signRequest({ method: 'GET', path: '/v1/me', key: a, now });
    expect(await verifyRequest({ method: 'GET', path: '/v1/me', body: '', headers: () => null, now })).toEqual({ ok: false, reason: 'unsigned' });
    expect(await verifyRequest({ method: 'GET', path: '/v1/me', body: '', headers: headersOf(h), now: now + 6 * 60 * 1000 })).toEqual({ ok: false, reason: 'stale' });
    const swapped = { ...h, 'x-cadrel-key': b.publicKey };
    expect((await verifyRequest({ method: 'GET', path: '/v1/me', body: '', headers: headersOf(swapped), now })).ok).toBe(false);
  });

  it('fingerprints a key in a form people can compare, the same way every time', async () => {
    const k = await generateKeyPair();
    const f = await fingerprint(k.publicKey);
    expect(f).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(await fingerprint(k.publicKey)).toBe(f);
    expect(await fingerprint((await generateKeyPair()).publicKey)).not.toBe(f);
  });

  it('writes and reads an invitation link, and refuses anything that is not one', () => {
    const i = { url: 'https://cadrel-studio-abc.me.workers.dev', code: 'A'.repeat(22), fingerprint: '0123-4567-89AB-CDEF' };
    expect(parseInvitation(invitationLink(i))).toEqual(i);
    expect(parseInvitation(invitationLink({ ...i, studioName: 'Acme Books' }))).toEqual({ ...i, studioName: 'Acme Books' });
    expect(parseInvitation(`  ${invitationLink(i)}\n`)).toEqual(i);
    expect(parseInvitation(invitationLink({ ...i, url: 'http://insecure.example' }))).toBeNull();
    expect(parseInvitation(invitationLink({ ...i, url: 'http://127.0.0.1:8787/w/x' }))?.url).toBe('http://127.0.0.1:8787/w/x'); // a Studio on this computer
    expect(parseInvitation(invitationLink({ ...i, code: 'short' }))).toBeNull();
    expect(parseInvitation('https://example.com')).toBeNull();
  });
});
