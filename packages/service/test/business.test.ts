import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, bootstrapStudio, defaultRole, type Ctx } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
const NOW = () => new Date('2026-11-10T10:00:00.000Z');
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied);

async function studio() {
  const db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  const ana = svc.as('ana');
  const person = async (name: string, roleKey: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId: `role_${roleKey}`, scope: { kind: 'studio', id: S } });
    return p.id;
  };
  const book = await ana.catalogue.createBook({ title: 'Lead Me' });
  return { db, svc, ana, person, subject: { kind: 'book' as const, id: book.id } };
}

describe('the business records behind the permission check', () => {
  it.each(ROLE_KEYS)('%s: reads with business.read (and is logged), changes with business.manage', async (key) => {
    const { svc, ana, person, subject, db } = await studio();
    const id = key === 'owner' ? 'ana' : await person(`P-${key}`, key);
    const me = svc.as(id).business;
    const caps = new Set(defaultRole(key).capabilities);
    const has = (c: string) => key === 'owner' || caps.has(c);
    const target = await ana.people.create({ name: `T-${key}` });

    expect(await denied(me.contributions()), 'read contributions').toBe(!has('business.read'));
    expect(await denied(me.credits({ subject })), 'read credits').toBe(!has('business.read'));
    expect(await denied(me.rights()), 'read rights').toBe(!has('business.read'));
    expect(await denied(me.shares()), 'read shares').toBe(!has('business.read'));
    expect(await denied(me.addContribution({ subject, personId: target.id, role: 'author' })), 'add contribution').toBe(!has('business.manage'));
    expect(await denied(me.addCredit({ subject, personId: target.id, role: 'author', placement: 'cover' })), 'add credit').toBe(!has('business.manage'));
    expect(await denied(me.addRights({ subject, holderName: 'X', kind: 'owned', right: 'all' })), 'add rights').toBe(!has('business.manage'));
    expect(await denied(me.addShare({ subject, personId: target.id, shareBp: 100, fromDate: '2026-01-01' })), 'add share').toBe(!has('business.manage'));
    expect(await denied(me.archive('share', 'nope')), 'archive').toBe(!has('business.manage'));

    const reads = await db.all<{ actor: string; target: string; detail: string }>("SELECT actor, target, detail FROM audit WHERE action = 'read.business'");
    expect(reads.length, 'logged reads').toBe(has('business.read') ? 4 : 0);
    if (has('business.read')) {
      expect(reads.every((r) => r.actor === id)).toBe(true);
      expect(reads.map((r) => JSON.parse(r.detail).what)).toEqual(['contributions', 'credits', 'rights', 'shares']);
      expect(reads[1]!.target).toBe(`book:${subject.id}`);
    }
  });

  it('keeps the four concepts apart through the service: an addition to one never shows up in another', async () => {
    const { ana, subject } = await studio();
    const p = await ana.people.create({ name: 'Bo' });
    await ana.business.addShare({ subject, personId: p.id, shareBp: 2500, fromDate: '2026-01-01' });
    expect(await ana.business.contributions({ subject })).toEqual([]);
    expect(await ana.business.credits({ subject })).toEqual([]);
    expect(await ana.business.rights({ subject })).toEqual([]);
    expect((await ana.business.shares({ subject })).map((s) => s.shareBp)).toEqual([2500]);
  });
});
