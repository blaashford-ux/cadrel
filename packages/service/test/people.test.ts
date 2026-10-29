import { describe, expect, it } from 'vitest';
import { GOVERNANCE, ROLE_KEYS, allCapabilities, bootstrapStudio, defaultRole, type Ctx } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
let clock = Date.parse('2026-10-27T10:00:00.000Z');
const NOW = () => new Date(clock);
const STUDIO = { kind: 'studio' as const, id: S };
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied || (console.error(e), false));
const refused = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof PermissionDenied ? 'denied' : `other:${(e as Error).message}`));

/** A studio started the way the app starts one: the person on this computer is its Owner, on the Studio's own records. */
async function studio() {
  const db = memoryStudioDb();
  const c: Ctx = { studioId: S, actor: 'ana', now: NOW().toISOString() };
  await bootstrapStudio(db, c, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  const ana = svc.as('ana');
  /** A person with one role at the studio, made by the Owner. */
  const person = async (name: string, roleId: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId, scope: STUDIO });
    return p.id;
  };
  return { db, svc, ana, person };
}

describe('who may use the people and roles operations', () => {
  it.each(ROLE_KEYS)('%s: reads and changes exactly what its capabilities allow', async (key) => {
    const { svc, ana, person } = await studio();
    const id = key === 'owner' ? 'ana' : await person(`P-${key}`, `role_${key}`);
    const target = await ana.people.create({ name: 'Target' });
    const me = svc.as(id).people;
    const caps = new Set(defaultRole(key).capabilities);
    const owner = key === 'owner';
    const has = (c: string) => owner || caps.has(c);
    expect(await denied(me.list()), 'read').toBe(!has('people.read'));
    expect(await denied(me.roles()), 'read roles').toBe(!has('people.read'));
    expect(await denied(me.create({ name: `n-${key}` })), 'create person').toBe(!has('people.manage'));
    expect(await denied(me.update(target.id, { name: 'Renamed' })), 'update person').toBe(!has('people.manage'));
    expect(await denied(me.createTeam(`t-${key}`)), 'create team').toBe(!has('teams.manage'));
    expect(await denied(me.createRole({ name: `r-${key}`, capabilities: ['manuscript.read'] })), 'create role').toBe(!has('roles.manage'));
    expect(await denied(me.grant({ subject: { kind: 'person', id: target.id }, roleId: 'role_guest', scope: STUDIO })), 'grant').toBe(!has('roles.manage'));
    expect(await denied(me.explainAccess(target.id, 'catalogue.read')), 'explain').toBe(!has('roles.manage'));
    expect(await denied(me.capabilityReview()), 'review').toBe(!has('roles.manage'));
  });

  it('a person with no assignment, or a deactivated one, can do nothing', async () => {
    const { svc, ana, person } = await studio();
    expect(await denied(svc.as('stranger').people.list())).toBe(true);
    const id = await person('Bo', 'role_admin');
    expect(await denied(svc.as(id).people.list())).toBe(false);
    await ana.people.setActive(id, false);
    expect(await denied(svc.as(id).people.list())).toBe(true);
    await ana.people.setActive(id, true);
    expect(await denied(svc.as(id).people.list())).toBe(false);
  });
});

describe('the guardrails', () => {
  it('only an Owner can give, change or take away the Owner role; an Admin cannot, even though they run people and roles', async () => {
    const { svc, ana, person } = await studio();
    const admin = await person('Admin', 'role_admin');
    const bo = await ana.people.create({ name: 'Bo' });
    expect(await refused(svc.as(admin).people.grant({ subject: { kind: 'person', id: bo.id }, roleId: 'role_owner', scope: STUDIO }))).toBe('denied');
    const a = await ana.people.grant({ subject: { kind: 'person', id: bo.id }, roleId: 'role_owner', scope: STUDIO });
    expect(await refused(svc.as(admin).people.revoke(a.id))).toBe('denied');
    expect(await refused(svc.as(admin).people.setExpiry(a.id, '2027-01-01T00:00:00.000Z'))).toBe('denied');
    expect(await refused(svc.as(admin).people.updateRole('role_owner', { name: 'Boss' }))).toBe('denied');
    expect(await refused(ana.people.revoke(a.id))).toBe('ok'); // another Owner remains, so an Owner may remove this one
  });

  it('the last Owner cannot be removed, expired or deactivated, even by themselves; with a second Owner they can', async () => {
    const { ana, db } = await studio();
    const own = (await ana.people.assignments({ subjectId: 'ana' }))[0]!;
    expect(await refused(ana.people.revoke(own.id))).toBe('denied');
    expect(await refused(ana.people.setExpiry(own.id, '2027-01-01T00:00:00.000Z'))).toBe('denied');
    expect(await refused(ana.people.setActive('ana', false))).toBe('denied');
    expect((await db.all('SELECT 1 FROM assignment WHERE id = ?', [own.id])).length).toBe(1);
    const bo = await ana.people.create({ name: 'Bo' });
    await ana.people.grant({ subject: { kind: 'person', id: bo.id }, roleId: 'role_owner', scope: STUDIO });
    expect(await refused(ana.people.setActive('ana', false))).toBe('ok');
  });

  it('nobody grants themselves a role, and a role manager cannot hand out a governance power they lack', async () => {
    const { svc, ana, db } = await studio();
    const manager = await ana.people.createRole({ name: 'Role manager', capabilities: ['roles.manage', 'people.read', 'manuscript.read'] });
    const rm = await ana.people.create({ name: 'Rita' });
    const victim = await ana.people.create({ name: 'Vic' });
    await ana.people.grant({ subject: { kind: 'person', id: rm.id }, roleId: manager.id, scope: STUDIO });
    const me = svc.as(rm.id).people;
    expect(await refused(me.grant({ subject: { kind: 'person', id: rm.id }, roleId: 'role_author', scope: STUDIO }))).toBe('denied'); // to herself
    expect(await refused(me.grant({ subject: { kind: 'person', id: victim.id }, roleId: 'role_author', scope: STUDIO }))).toBe('ok'); // an ordinary role to someone else
    expect(await refused(me.grant({ subject: { kind: 'person', id: victim.id }, roleId: 'role_admin', scope: STUDIO }))).toBe('denied'); // Admin holds governance powers she does not
    expect(await refused(me.createRole({ name: 'Sneaky', capabilities: ['security.policy'] }))).toBe('denied');
    expect(await refused(me.createRole({ name: 'Fine', capabilities: ['manuscript.write', 'roles.manage'] }))).toBe('ok'); // she holds roles.manage herself
    expect(await refused(me.updateRole(manager.id, { capabilities: ['roles.manage', 'vault.force'] }))).toBe('denied');
    expect(await refused(me.updateRole(manager.id, { description: 'Hands out ordinary roles' }))).toBe('ok');
    expect(await db.all("SELECT 1 FROM role WHERE name = 'Sneaky'")).toEqual([]);
  });

  it('deleting an assigned role needs a replacement, and moving people onto it passes the same grant check', async () => {
    const { svc, ana, person } = await studio();
    const temp = await ana.people.createRole({ name: 'Temp', capabilities: ['catalogue.read'] });
    const bo = await person('Bo', temp.id);
    expect(await refused(ana.people.deleteRole(temp.id))).toMatch(/other:.*still assigned/);
    const manager = await ana.people.createRole({ name: 'Role manager', capabilities: ['roles.manage', 'people.read'] });
    const rm = await person('Rita', manager.id);
    expect(await refused(svc.as(rm).people.deleteRole(temp.id, 'role_admin'))).toBe('denied'); // would give Bo governance powers Rita lacks
    expect(await refused(svc.as(rm).people.deleteRole(temp.id, 'role_author'))).toBe('ok');
    expect((await ana.people.assignments({ subjectId: bo })).map((a) => a.roleId)).toEqual(['role_author']);
  });
});

describe('explain access and the interface’s view of it', () => {
  it('says which assignment allows or blocks an action on one book, and agrees with the real check', async () => {
    const { svc, ana } = await studio();
    const bo = await ana.people.create({ name: 'Bo' });
    await ana.people.grant({ subject: { kind: 'person', id: bo.id }, roleId: 'role_author', scope: { kind: 'project', id: 'book-1' } });
    const onBook1 = [STUDIO, { kind: 'project' as const, id: 'book-1' }];
    const onBook2 = [STUDIO, { kind: 'project' as const, id: 'book-2' }];
    const yes = await ana.people.explainAccess(bo.id, 'manuscript.write', onBook1);
    expect(yes.allowed).toBe(true);
    expect(yes.reason).toMatch(/Author on project book-1/);
    const no = await ana.people.explainAccess(bo.id, 'manuscript.write', onBook2);
    expect(no).toMatchObject({ allowed: false, why: 'no-assignment' });
    expect((await ana.people.explainAccess(bo.id, 'manuscript.approve', onBook1)).allowed).toBe(false);
    // a team gives it too, and the reason names the team
    const t = await ana.people.createTeam('Editors');
    await ana.people.setTeamMember(t.id, bo.id, true);
    await ana.people.grant({ subject: { kind: 'team', id: t.id }, roleId: 'role_editor', scope: STUDIO });
    expect((await ana.people.explainAccess(bo.id, 'edit.run', onBook2)).reason).toMatch(/via team/);
    const caps = await ana.people.effectiveCapabilities(bo.id);
    expect(caps).toContain('manuscript.write');
    expect(caps).not.toContain('people.manage');
    expect(await denied(svc.as(bo.id).people.explainAccess('ana', 'catalogue.read'))).toBe(true);
  });

  it('a role edit shows up in who can do what on the next call', async () => {
    const { svc, ana, person } = await studio();
    const r = await ana.people.createRole({ name: 'Reader', capabilities: ['catalogue.read'] });
    const bo = await person('Bo', r.id);
    expect(await denied(svc.as(bo).catalogue.createIp({ name: 'X' }))).toBe(true);
    await ana.people.updateRole(r.id, { capabilities: ['catalogue.read', 'catalogue.create'] });
    expect(await denied(svc.as(bo).catalogue.createIp({ name: 'X' }))).toBe(false);
    await ana.people.revoke((await ana.people.assignments({ subjectId: bo }))[0]!.id);
    expect(await denied(svc.as(bo).catalogue.books())).toBe(true);
  });
});

/** docs/PERMISSIONS.md §8: no sequence of admin actions lets a person gain a capability the granter lacked. */
describe('property: a role manager cannot escalate, whatever they do', () => {
  it('after hundreds of random role and assignment changes, nobody but the Owner holds a governance power the role manager lacked', async () => {
    const { svc, ana, db } = await studio();
    // Rita may manage roles and read people; of the governance powers she holds only roles.manage (and people.read is not one)
    const manager = await ana.people.createRole({ name: 'Role manager', capabilities: ['roles.manage', 'people.read'] });
    const rita = (await ana.people.create({ name: 'Rita' })).id;
    await ana.people.grant({ subject: { kind: 'person', id: rita }, roleId: manager.id, scope: STUDIO });
    const people = [rita, ...(await Promise.all(['A', 'B', 'C'].map((n) => ana.people.create({ name: n })))).map((p) => p.id)];
    const team = await ana.people.createTeam('Crew');
    for (const p of people.slice(1)) await ana.people.setTeamMember(team.id, p, true);

    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)]!;
    const caps = allCapabilities();
    const me = svc.as(rita).people;
    const allowedGovernance = new Set(['roles.manage']);
    let performed = 0;
    for (let i = 0; i < 400; i++) {
      const roles = await ana.people.roles(); // listed as the Owner, so Rita losing her own access mid-run does not end the test
      const custom = roles.filter((r) => !r.templateKey && r.id !== manager.id); // her own role is left alone so she keeps acting for the whole run
      const attempt = rnd(7);
      try {
        if (attempt === 0) await me.createRole({ name: `r${i}`, capabilities: Array.from({ length: 1 + rnd(8) }, () => pick(caps)) });
        else if (attempt === 1 && custom.length) await me.updateRole(pick(custom).id, { capabilities: Array.from({ length: rnd(9) }, () => pick(caps)) });
        else if (attempt === 2) await me.grant({ subject: { kind: 'person', id: pick(people) }, roleId: pick(roles).id, scope: rnd(2) ? STUDIO : { kind: 'project', id: `p${rnd(3)}` }, expiresAt: rnd(2) ? null : '2030-01-01T00:00:00.000Z' });
        else if (attempt === 3) await me.grant({ subject: { kind: 'team', id: team.id }, roleId: pick(roles).id, scope: STUDIO });
        else if (attempt === 4) {
          const as = (await ana.people.assignments()).filter((a) => !(a.subject.id === rita && a.roleId === manager.id));
          if (as.length) await me.revoke(pick(as).id);
        } else if (attempt === 5 && custom.length) await me.deleteRole(pick(custom).id, pick(roles).id);
        else if (attempt === 6) await me.resetRole(pick(roles.filter((r) => r.id !== manager.id)).id);
        performed++;
      } catch (e) {
        if (!(e instanceof PermissionDenied) && !/already|still assigned|Choose a different|not there|cannot be|Only a default|Owner role|expiry|future/i.test((e as Error).message)) throw e;
      }
      // the invariant: look at every person other than the Owner
      for (const p of [...people]) {
        const eff = await ana.people.effectiveCapabilities(p);
        const bad = [...GOVERNANCE].filter((g) => (eff.includes(g) || eff.includes('*')) && !allowedGovernance.has(g));
        expect(bad, `after step ${i} (attempt ${attempt}) ${p} holds ${bad}`).toEqual([]);
      }
    }
    expect(performed).toBeGreaterThan(50); // the run really did things, not only get refused
    // and the Owner is still the Owner, with the role untouched
    expect((await ana.people.effectiveCapabilities('ana'))).toContain('*');
    expect((await db.all<{ all_caps: number }>("SELECT all_caps FROM role WHERE id = 'role_owner'"))[0]!.all_caps).toBe(1);
  }, 60000);
});
