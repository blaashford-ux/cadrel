/**
 * The Studio's security policy: the few rules an administrator sets that the Studio itself enforces (docs/PERMISSIONS.md §5). One row per Studio;
 * with no row, or a field the row leaves unset, the defaults below apply, so a Studio behaves as it always did until somebody saves the page.
 * Records over the kernel's `Db`; who may change them is the caller's business (the service needs `studio.settings`).
 */
import type { Db } from './vault';

export class PolicyError extends Error {}

export interface StudioPolicy {
  /** How long an invitation can be used for, in days. */
  inviteDays: number;
  /** For an invitation limited to one project that names no end of its own: how long the access lasts, in days. Null: it does not end. */
  guestDays: number | null;
  /** A check-out older than this many days is flagged to its holder and to anyone who may force a release. Nothing is released automatically. */
  staleCheckoutDays: number;
  /** When false the assistant's record, editorial and project tools refuse for everyone. */
  assistantEnabled: boolean;
}

export const DEFAULT_POLICY: StudioPolicy = { inviteDays: 7, guestDays: null, staleCheckoutDays: 7, assistantEnabled: true };

/** The ranges the page offers, kept here so the server and the page agree. */
export const POLICY_LIMITS = { inviteDays: { min: 1, max: 30 }, guestDays: { min: 1, max: 365 }, staleCheckoutDays: { min: 1, max: 90 } } as const;

const whole = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new PolicyError(`${name} must be a whole number of days from ${min} to ${max}.`);
  return v;
};

/** What a change is allowed to say: a field left out stays as it is; `guestDays: null` says guests' access has no default end. */
export type PolicyChange = Partial<StudioPolicy>;

/** Checks a change and returns it cleaned, or says what is wrong. Unknown fields are refused rather than ignored. */
export function checkPolicyChange(change: unknown): PolicyChange {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new PolicyError('Say which settings to change.');
  const c = change as Record<string, unknown>;
  const known = new Set(['inviteDays', 'guestDays', 'staleCheckoutDays', 'assistantEnabled']);
  for (const k of Object.keys(c)) if (!known.has(k)) throw new PolicyError(`There is no setting called “${k}”.`);
  const out: PolicyChange = {};
  if ('inviteDays' in c) out.inviteDays = whole(c.inviteDays, 'The invitation lifetime', POLICY_LIMITS.inviteDays.min, POLICY_LIMITS.inviteDays.max);
  if ('guestDays' in c) out.guestDays = c.guestDays === null ? null : whole(c.guestDays, 'The guest access period', POLICY_LIMITS.guestDays.min, POLICY_LIMITS.guestDays.max);
  if ('staleCheckoutDays' in c) out.staleCheckoutDays = whole(c.staleCheckoutDays, 'The stale check-out warning', POLICY_LIMITS.staleCheckoutDays.min, POLICY_LIMITS.staleCheckoutDays.max);
  if ('assistantEnabled' in c) {
    if (typeof c.assistantEnabled !== 'boolean') throw new PolicyError('The assistant is either on or off.');
    out.assistantEnabled = c.assistantEnabled;
  }
  return out;
}

interface Row {
  invite_days: number;
  guest_days: number | null;
  stale_checkout_days: number;
  assistant_enabled: number;
}

/** The policy in force. A Studio that has never saved one gets the defaults. */
export async function getPolicy(db: Db, studioId: string): Promise<StudioPolicy> {
  const row = await db.first<Row>('SELECT invite_days, guest_days, stale_checkout_days, assistant_enabled FROM studio_policy WHERE studio_id = ?', [studioId]);
  if (!row) return { ...DEFAULT_POLICY };
  return { inviteDays: row.invite_days, guestDays: row.guest_days, staleCheckoutDays: row.stale_checkout_days, assistantEnabled: row.assistant_enabled !== 0 };
}

/** Saves a change over what is in force and leaves an audit row naming what changed. Returns the policy now in force. */
export async function setPolicy(db: Db, a: { studioId: string; actor: string; now: string; change: PolicyChange }): Promise<StudioPolicy> {
  const change = checkPolicyChange(a.change);
  const before = await getPolicy(db, a.studioId);
  const after: StudioPolicy = { ...before, ...change };
  const changed = (Object.keys(change) as (keyof StudioPolicy)[]).filter((k) => before[k] !== after[k]);
  if (!changed.length) return before;
  await db.batch([
    {
      sql: `INSERT INTO studio_policy (studio_id, invite_days, guest_days, stale_checkout_days, assistant_enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(studio_id) DO UPDATE SET invite_days = excluded.invite_days, guest_days = excluded.guest_days, stale_checkout_days = excluded.stale_checkout_days,
       assistant_enabled = excluded.assistant_enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      params: [a.studioId, after.inviteDays, after.guestDays, after.staleCheckoutDays, after.assistantEnabled ? 1 : 0, a.now, a.actor]
    },
    { sql: 'INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', params: [a.now, a.actor, 'policy.set', a.studioId, JSON.stringify(Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])))] }
  ]);
  return after;
}
