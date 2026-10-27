import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PEOPLE_CALLS, PeopleHost } from '../src/main/people';

const hosts: PeopleHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function open(owned = true, dir?: string) {
  const d = dir ?? (await mkdtemp(path.join(os.tmpdir(), 'cadrel-people-')));
  if (!dir) dirs.push(d);
  const h = new PeopleHost();
  hosts.push(h);
  await h.open({ file: path.join(d, 'records.db'), studioId: 'local', owned, ownerName: 'Ana Reyes', now: () => new Date('2026-10-27T10:00:00.000Z') });
  return { h, d };
}

describe('the people and roles of this computer’s Studio', () => {
  it('starts an owned Studio with the twelve default roles and this person as its Owner', async () => {
    const { h } = await open();
    const s = await h.state();
    if (!s.available) throw new Error('expected people to be available');
    expect(s.people.map((p) => p.name)).toEqual(['Ana Reyes']);
    expect(s.me).toBe(s.people[0]!.id);
    expect(s.roles).toHaveLength(12);
    expect(s.roles.find((r) => r.id === 'role_owner')).toMatchObject({ all: true, holders: 1 });
    expect(s.may).toEqual({ people: true, teams: true, roles: true });
    expect(s.assignments).toHaveLength(1);
    expect(s.review).toEqual([]);
  });

  it('keeps everything across a restart, and the same person is still the Owner', async () => {
    const { h, d } = await open();
    const first = await h.state();
    await h.call('createPerson', { name: 'Bo Lin', kind: 'contractor' });
    await h.call('createTeam', 'Editors');
    await h.close();
    const { h: again } = await open(true, d);
    const s = await again.state();
    if (!s.available || !first.available) throw new Error('expected people');
    expect(s.me).toBe(first.me);
    expect(s.people.map((p) => p.name)).toEqual(['Ana Reyes', 'Bo Lin']);
    expect(s.teams.map((t) => t.name)).toEqual(['Editors']);
    expect(s.roles).toHaveLength(12); // not made twice
  });

  it('changes things as the Owner: a person, a custom role, a grant, and explains the result', async () => {
    const { h } = await open();
    const bo = (await h.call('createPerson', { name: 'Bo' })) as { id: string };
    const role = (await h.call('createRole', { name: 'Proofreader', capabilities: ['manuscript.read', 'edit.respond'] })) as { id: string };
    await h.call('grant', { subject: { kind: 'person', id: bo.id }, roleId: role.id, scope: { kind: 'project', id: 'book-1' } });
    const yes = await h.explain(bo.id, 'manuscript.read', 'book-1');
    expect(yes.allowed).toBe(true);
    expect(yes.reason).toMatch(/Proofreader on project book-1/);
    expect((await h.explain(bo.id, 'manuscript.read', 'book-2')).allowed).toBe(false);
    expect(await h.effective(bo.id)).toEqual([]); // nothing at the studio: the role is on one book
    expect(await h.effective(bo.id, 'book-1')).toEqual(['edit.respond', 'manuscript.read']);
  });

  it('refuses what the guardrails refuse, with the reason in words', async () => {
    const { h } = await open();
    const s = await h.state();
    if (!s.available) throw new Error('x');
    const own = s.assignments[0]!;
    await expect(h.call('revoke', own.id)).rejects.toThrow(/at least one Owner/);
    await expect(h.call('setPersonActive', s.me, false)).rejects.toThrow(/at least one Owner/);
    await expect(h.call('updateRole', 'role_owner', { name: 'Boss' })).rejects.toThrow(/Owner role cannot be edited/);
    await expect(h.call('createPerson', { name: 'X', email: 'not-an-email' })).rejects.toThrow(/not an email/);
  });

  it('offers only the changes it lists: nothing else on the service can be reached from the page', async () => {
    const { h } = await open();
    expect(PEOPLE_CALLS).not.toContain('list');
    expect(PEOPLE_CALLS).not.toContain('constructor');
    await expect(h.call('list')).rejects.toThrow(/not something/);
    await expect(h.call('constructor')).rejects.toThrow(/not something/);
    await expect(h.call('__proto__')).rejects.toThrow(/not something/);
  });

  it('has nothing to manage in a Studio this person only joined, and says so', async () => {
    const { h } = await open(false);
    expect(await h.state()).toMatchObject({ available: false, reason: expect.stringMatching(/managed by its owner/) });
    await expect(h.call('createPerson', { name: 'X' })).rejects.toThrow(/managed by its owner/);
    expect(h.service).toBeNull();
  });
});

describe('the workflow builder on this computer', () => {
  it('starts with the MDEdit workflow as the default, and builds, defaults and deletes others as the Owner', async () => {
    const { h } = await open();
    const s = await h.workflowState();
    if (!s.available) throw new Error('expected workflows');
    expect(s.may).toBe(true);
    expect(s.workflows.map((w) => [w.name, w.defaultFor])).toEqual([['Writing and publishing', ['project', 'subproject']]]);
    expect(s.roles).toHaveLength(12);
    const w = (await h.workflowCall('create', { name: 'Audio', copyFrom: s.workflows[0]!.id })) as { id: string };
    await h.workflowCall('setDefault', w.id, ['project']);
    const after = await h.workflowState();
    if (!after.available) throw new Error('x');
    expect(after.workflows.find((x) => x.defaultFor.includes('project'))!.name).toBe('Audio');
    expect(after.workflows.find((x) => x.defaultFor.includes('subproject'))!.name).toBe('Writing and publishing'); // each level has its own default
    await h.workflowCall('setDefault', w.id, ['subproject']);
    expect((await h.workflowState() as { workflows: { defaultFor: string[] }[] }).workflows.find((x) => x.name === 'Writing and publishing')!.defaultFor).toEqual([]);
  });

  it('offers only the changes it lists', async () => {
    const { h } = await open();
    await expect(h.workflowCall('list')).rejects.toThrow(/not something/);
    await expect(h.workflowCall('constructor')).rejects.toThrow(/not something/);
    await expect(h.workflowCall('__proto__')).rejects.toThrow(/not something/);
  });

  it('has nothing to build in a Studio this person only joined', async () => {
    const { h } = await open(false);
    expect(await h.workflowState()).toMatchObject({ available: false });
    await expect(h.workflowCall('create', { name: 'X' })).rejects.toThrow(/managed by its owner/);
  });
});
