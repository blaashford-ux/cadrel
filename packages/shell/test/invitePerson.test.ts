// Not type-checked with the shell: it runs the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
import { describe, expect, it } from 'vitest';
import { generateKeyPair, parseInvitation } from '@cadrel/kernel';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio, upgradeStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { remoteService } from '../src/main/remote';
import { inviteMailto } from '../src/main/inviteMail';

async function studio(mailFrom?: string) {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const o = { fetchFn: cf.fetchFn, sleep: async () => undefined };
  const build = { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' };
  const built = await buildStudio(o, { ...build, ...(mailFrom ? { mailFrom } : {}) });
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn: cf.fetchFn });
  await owner.publishTree({ projects: [{ id: 'pB1', name: 'Book 1', parentId: null, kind: 'Book', status: 'active', order: 0, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, { id: 'pB2', name: 'Book 2', parentId: null, kind: 'Book', status: 'active', order: 1, workflowId: null, stage: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], links: [] });
  return { cf, owner, url: built.url, o, build, built };
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

  it('uploads the Worker with the email binding only when the owner turned email on, and an upgrade keeps it', async () => {
    const plain = await studio();
    expect(plain.cf.workers.get('cadrel-studio-sabc123def4')!.bindings.map((b) => (b as { name: string }).name)).not.toContain('EMAIL');
    const s = await studio('invites@books.example');
    const bindings = s.cf.workers.get('cadrel-studio-sabc123def4')!.bindings as { type: string; name: string; text?: string }[];
    expect(bindings).toContainEqual({ type: 'send_email', name: 'EMAIL' });
    expect(bindings).toContainEqual({ type: 'plain_text', name: 'INVITE_FROM', text: 'invites@books.example' });
    // turning it off (an upload without it) takes the binding away; an upgrade that passes it keeps it
    await upgradeStudio(s.o, { ...s.build, mailFrom: 'invites@books.example' }, { url: s.built.url, resources: s.built.resources });
    expect((s.cf.workers.get('cadrel-studio-sabc123def4')!.bindings as { name: string }[]).map((b) => b.name)).toContain('EMAIL');
    await upgradeStudio(s.o, { ...s.build, mailFrom: null }, { url: s.built.url, resources: s.built.resources });
    expect((s.cf.workers.get('cadrel-studio-sabc123def4')!.bindings as { name: string }[]).map((b) => b.name)).not.toContain('EMAIL');
  });

  it('has the Studio’s server email an invitation just made, through the real Worker, to the address on the person’s record', async () => {
    const s = await studio('invites@books.example');
    expect(((await (await s.cf.fetchFn(`${s.url}/v1/info`)).json()) as { mail: boolean }).mail).toBe(true);
    const made = await s.owner.invitePerson({ name: 'Tristan', email: 'tristan@example.com' }, 'Acme Books', 'reader');
    const sent = await s.owner.mailInvite(parseInvitation(made.link)!.code, 'reader', 'Acme Books', 'Ann');
    expect(sent).toMatchObject({ to: 'tristan@example.com' });
    expect(s.cf.mail).toHaveLength(1);
    expect(s.cf.mail[0]).toMatchObject({ to: { email: 'tristan@example.com' }, from: { email: 'invites@books.example', name: 'Acme Books' }, subject: 'You are invited to Acme Books on Cadrel Reader' });
    const sentLink = /cadrel-reader:\/\/join\?\S+/.exec(s.cf.mail[0]!.text)![0];
    expect(parseInvitation(sentLink)).toMatchObject({ code: parseInvitation(made.link)!.code, studioName: 'Acme Books' });
    // the emailed link works: it joins as the person invited
    const joined = await joinStudio({ link: sentLink, yourName: 'Tristan', fetchFn: s.cf.fetchFn });
    expect(joined.role).toBe('_none');
  });
});
