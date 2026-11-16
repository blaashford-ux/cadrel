import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyError, checkPolicyChange, getPolicy, setPolicy, type Db } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
const who = { studioId: 's1', actor: 'ana', now: '2026-11-16T10:00:00Z' };
beforeEach(() => {
  db = memoryDb();
});

describe('the Studio’s security policy', () => {
  it('is the defaults until somebody saves one, so a Studio behaves as it always did', async () => {
    expect(await getPolicy(db, 's1')).toEqual({ inviteDays: 7, guestDays: null, staleCheckoutDays: 7, assistantEnabled: true });
    expect(await getPolicy(db, 's1')).toEqual(DEFAULT_POLICY);
  });

  it('keeps what was saved, changes only the fields given, and can clear the guest default', async () => {
    await setPolicy(db, { ...who, change: { inviteDays: 14, guestDays: 90 } });
    expect(await getPolicy(db, 's1')).toEqual({ inviteDays: 14, guestDays: 90, staleCheckoutDays: 7, assistantEnabled: true });
    await setPolicy(db, { ...who, change: { assistantEnabled: false } });
    expect(await getPolicy(db, 's1')).toEqual({ inviteDays: 14, guestDays: 90, staleCheckoutDays: 7, assistantEnabled: false });
    await setPolicy(db, { ...who, change: { guestDays: null } });
    expect((await getPolicy(db, 's1')).guestDays).toBeNull();
  });

  it('leaves an audit row saying what changed, from and to, and none when nothing changed', async () => {
    await setPolicy(db, { ...who, change: { staleCheckoutDays: 3 } });
    const rows = await db.all<{ actor: string; detail: string }>("SELECT actor, detail FROM audit WHERE action = 'policy.set'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('ana');
    expect(JSON.parse(rows[0]!.detail)).toEqual({ staleCheckoutDays: { from: 7, to: 3 } });
    await setPolicy(db, { ...who, change: { staleCheckoutDays: 3 } }); // the same again
    expect(await db.all("SELECT 1 FROM audit WHERE action = 'policy.set'")).toHaveLength(1);
  });

  it('refuses a value outside its range, a fraction, a string, a setting that does not exist, and a change that is not an object', () => {
    for (const bad of [{ inviteDays: 0 }, { inviteDays: 31 }, { inviteDays: 2.5 }, { inviteDays: '7' }, { guestDays: 0 }, { guestDays: 366 }, { staleCheckoutDays: 91 }, { assistantEnabled: 'yes' }, { secret: 1 }, null, [], 'x']) {
      expect(() => checkPolicyChange(bad), JSON.stringify(bad)).toThrow(PolicyError);
    }
    expect(checkPolicyChange({ inviteDays: 30, guestDays: 365, staleCheckoutDays: 1, assistantEnabled: false })).toEqual({ inviteDays: 30, guestDays: 365, staleCheckoutDays: 1, assistantEnabled: false });
  });

  it('a refused change saves nothing', async () => {
    await expect(setPolicy(db, { ...who, change: { inviteDays: 14, staleCheckoutDays: 500 } })).rejects.toBeInstanceOf(PolicyError);
    expect(await getPolicy(db, 's1')).toEqual(DEFAULT_POLICY);
  });

  it('is one Studio’s own', async () => {
    await setPolicy(db, { ...who, change: { inviteDays: 20 } });
    expect((await getPolicy(db, 's2')).inviteDays).toBe(7);
  });
});
