// Not type-checked with the shell: it runs the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
import { describe, expect, it } from 'vitest';
import { generateKeyPair, parseInvitation } from '@cadrel/kernel';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { remoteService } from '../src/main/remote';
import { inviteMailto } from '../src/main/inviteMail';

async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn: cf.fetchFn });
  await owner.publishTree({ projects: [{ id: 'pB1', name: 'Book 1', parentId: null, kind: 'Book', status: 'active', order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, { id: 'pB2', name: 'Book 2', parentId: null, kind: 'Book', status: 'active', order: 1, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] });
  return { cf, owner, url: built.url };
}

describe('inviting a person with no role', () => {
  it('makes a link for the app the owner chose, and the person sees nothing until given a role on a project', async () => {
    const s = await studio();
    const a = await s.owner.invitePerson({ name: 'Tristan', email: 'tristan@example.com' }, 'Acme', 'studio');
    expect(a.link.startsWith('cadrel://join?')).toBe(true);
    const r = await s.owner.invitePerson({ id: a.personId }, 'Acme', 'reader');
    expect(r.link.startsWith('cadrel-reader://join?')).toBe(true);
    expect(r.personId).toBe(a.personId); // the same person, not a second one
    expect(parseInvitation(r.link)).toMatchObject({ studioName: 'Acme' });

    const joined = await joinStudio({ link: a.link, yourName: 'Tristan', fetchFn: s.cf.fetchFn });
    expect(joined.role).toBe('_none');
    const tris = new StudioClient({ url: s.url, key: joined.key, fetchFn: s.cf.fetchFn });
    const me = await tris.me();
    expect(me.personId).toBe(a.personId);

    const ownerSvc = remoteService(s.owner).as('ignored');
    const trisSvc = remoteService(tris).as('ignored');
    expect((await ownerSvc.people.list()).filter((p) => p.email === 'tristan@example.com')).toHaveLength(1);
    expect(await trisSvc.can('manuscript.read')).toBe(false);
    expect((await trisSvc.visibleProjects({ projects: [], links: [] })).all).toBe(false);

    // the owner lists them as joined, linked to the person, and the second invitation is still waiting
    const list = await s.owner.people();
    expect(list.members.find((m) => m.personId === a.personId)).toMatchObject({ name: 'Tristan', role: '_none' });
    expect(list.invites.map((i) => i.personId)).toEqual([a.personId]);
  });

  it('writes the invitation as an email for the person’s own mail app, and refuses anything that is not an address and a Cadrel link', () => {
    const link = 'cadrel://join?s=https%3A%2F%2Fstudio.example.workers.dev&c=AAAAAAAAAAAAAAAAAAAAAA&f=0123-4567-89AB-CDEF';
    const url = inviteMailto('tristan@example.com', link, 'Acme Books', 'Ann');
    expect(url.startsWith('mailto:tristan@example.com?subject=')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('subject')).toBe('You are invited to Acme Books on Cadrel');
    expect(q.get('body')).toContain(link);
    expect(q.get('body')).toContain('Ann has invited you');
    expect(q.get('body')).toContain('see nothing');
    expect(inviteMailto('r@example.com', link.replace('cadrel://', 'cadrel-reader://'), 'Acme').includes(encodeURIComponent('Cadrel Reader'))).toBe(true);
    expect(() => inviteMailto('not an address', link, 'Acme')).toThrow('not an email address');
    expect(() => inviteMailto('a@b.com,evil@x.com', link, 'Acme')).toThrow('not an email address'); // one recipient only
    expect(() => inviteMailto('a@b.com', 'https://evil.example/', 'Acme')).toThrow('not a Cadrel invitation link');
    expect(() => inviteMailto('a@b.com', link + '\r\nBcc: x@y.com', 'Acme')).toThrow('not a Cadrel invitation link');
  });
});
