import type { Db } from '@cadrel/kernel';

/**
 * D1 behind the kernel's Db interface, and the one place that knows when the Studio's records change.
 *
 * D1 bills every row it reads, so the Worker must not re-read what has not changed. Two counters in `studio_meta` make that possible:
 *   data_version    changes whenever any record changes. The app asks for it (GET /v1/version) instead of re-fetching everything on a timer.
 *   access_version  changes when who-holds-what changes (people, teams, roles, assignments), so the Worker can keep the permission tables
 *                   it loaded and reuse them until then.
 * A counter is a random value, not a number that counts up, so a restored backup can never land on a value someone already holds.
 * The bump rides in the same batch as the change that caused it, so nobody can see the change without the new counter.
 */

const WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?(\w+)/i;
/** The tables the permission decisions are made from. */
const ACCESS_TABLES = new Set(['person', 'team', 'team_member', 'role', 'role_capability', 'assignment']);

export interface Versions {
  data: string;
  access: string;
}

/** The counters a statement moves: none for a read. A statement that is not recognised as a plain write moves both, so a miss is only ever a reload. */
function movedBy(sql: string): string[] {
  if (/^\s*(?:SELECT|PRAGMA)\b/i.test(sql)) return [];
  const m = WRITE.exec(sql);
  if (!m) return ['data_version', 'access_version'];
  return ACCESS_TABLES.has(m[1]!.toLowerCase()) ? ['data_version', 'access_version'] : ['data_version'];
}

function bump(d1: D1Database, keys: Iterable<string>): D1PreparedStatement {
  const list = [...keys];
  const values = list.map(() => "(?, hex(randomblob(8)))").join(', ');
  return d1.prepare(`INSERT INTO studio_meta (key, value) VALUES ${values} ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(...list);
}

/** Both counters, in one read of two rows. A Studio that has not changed since they were introduced has none: that reads as '0'. */
export async function readVersions(d1: D1Database): Promise<Versions> {
  const rows = (await d1.prepare("SELECT key, value FROM studio_meta WHERE key IN ('data_version', 'access_version')").all<{ key: string; value: string }>()).results;
  const at = (k: string) => rows.find((r) => r.key === k)?.value ?? '0';
  return { data: at('data_version'), access: at('access_version') };
}

/** Records that something changed that this code did not write through `d1Db` (a member added or removed, say). */
export async function touchVersions(d1: D1Database, keys: string[] = ['data_version']): Promise<void> {
  await bump(d1, keys).run();
}

export function d1Db(d1: D1Database): Db {
  const prep = (sql: string, params?: unknown[]) => d1.prepare(sql).bind(...(params ?? []));
  return {
    async run(sql, params) {
      const moved = movedBy(sql);
      if (!moved.length) {
        const r = await prep(sql, params).run();
        return { changes: r.meta.changes ?? 0 };
      }
      const [r] = await d1.batch([prep(sql, params), bump(d1, moved)]);
      return { changes: r!.meta.changes ?? 0 };
    },
    async first<T>(sql: string, params?: unknown[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async all<T>(sql: string, params?: unknown[]) {
      return (await prep(sql, params).all<T>()).results;
    },
    async batch(statements) {
      const moved = new Set(statements.flatMap((s) => movedBy(s.sql)));
      const results = await d1.batch([...statements.map((s) => prep(s.sql, s.params)), ...(moved.size ? [bump(d1, moved)] : [])]);
      return results.slice(0, statements.length).map((r) => ({ changes: r.meta.changes ?? 0 }));
    }
  };
}
