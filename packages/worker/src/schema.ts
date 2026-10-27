import { MIGRATIONS } from './migrations';

export { statementsOf } from '@cadrel/kernel';
import { statementsOf } from '@cadrel/kernel';

const done = new WeakMap<object, Promise<number>>();

/**
 * Brings the Studio's database up to date, once per running instance, and resolves to its schema version. Safe to call on every request:
 * it does nothing when the database is current, and two instances starting together cannot apply a step twice (the version is recorded
 * in the same batch as the step, and a step that is already there fails and is then read as applied).
 */
export function ensureSchema(db: D1Database): Promise<number> {
  const known = done.get(db);
  if (known) return known;
  const run = migrate(db).catch((e) => {
    done.delete(db);
    throw e;
  });
  done.set(db, run);
  return run;
}

async function migrate(db: D1Database): Promise<number> {
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_version (n INTEGER NOT NULL)').run();
  const row = await db.prepare('SELECT MAX(n) AS n FROM schema_version').first<{ n: number | null }>();
  let at = row?.n ?? 0;
  for (let i = at; i < MIGRATIONS.length; i++) {
    const steps = statementsOf(MIGRATIONS[i]!).map((s) => db.prepare(s));
    try {
      await db.batch([...steps, db.prepare('INSERT INTO schema_version (n) VALUES (?)').bind(i + 1)]);
    } catch (e) {
      // Another instance got there first: if the step is now recorded, carry on.
      const now = await db.prepare('SELECT MAX(n) AS n FROM schema_version').first<{ n: number | null }>();
      if ((now?.n ?? 0) <= i) throw e;
    }
    at = i + 1;
  }
  return at;
}
