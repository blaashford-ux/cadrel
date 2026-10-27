/**
 * The Studio's records in a SQLite file on this computer, behind the kernel's async `Db` (the same interface the Worker gets from D1). The
 * schema is the Worker's own migrations, applied in order and recorded in the same `schema_version` table, so the desktop copy and the
 * server can never disagree about what a version means. node:sqlite ships inside Node and Electron: no native module to rebuild.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { statementsOf, STUDIO_SCHEMA_VERSION, type Db } from '@cadrel/kernel';
import { MIGRATIONS } from '@cadrel/worker/src/migrations';

// Loaded through require because Vite's resolver strips the `node:` prefix from `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Sqlite = InstanceType<typeof DatabaseSync>;
type Param = string | number | null;
const bind = (p?: unknown[]) => (p ?? []) as Param[];

export class StoreError extends Error {}

export interface StudioDb extends Db {
  /** The schema version the file is at (equal to the number of migrations applied). */
  version(): Promise<number>;
  close(): void;
}

function wrap(sqlite: Sqlite): StudioDb {
  const version = async () => {
    const row = sqlite.prepare('SELECT MAX(n) AS n FROM schema_version').get() as { n: number | null } | undefined;
    return row?.n ?? 0;
  };
  return {
    version,
    close: () => sqlite.close(),
    async run(sql, params) {
      return { changes: Number(sqlite.prepare(sql).run(...bind(params)).changes) };
    },
    async first<T>(sql: string, params?: unknown[]) {
      return (sqlite.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
    },
    async all<T>(sql: string, params?: unknown[]) {
      return sqlite.prepare(sql).all(...bind(params)) as T[];
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => ({ changes: Number(sqlite.prepare(s.sql).run(...bind(s.params)).changes) }));
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    }
  };
}

/** Applies each migration this file has not had, one transaction per step with its version recorded in it. A file from a newer app is refused, not touched. */
export function migrate(sqlite: Sqlite, steps: readonly string[] = MIGRATIONS): number {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_version (n INTEGER NOT NULL)');
  const at = (sqlite.prepare('SELECT MAX(n) AS n FROM schema_version').get() as { n: number | null }).n ?? 0;
  if (at > steps.length) throw new StoreError(`This Studio's records are from a newer Cadrel (schema ${at}; this one knows ${steps.length}). Update Cadrel.`);
  for (let i = at; i < steps.length; i++) {
    sqlite.exec('BEGIN');
    try {
      for (const stmt of statementsOf(steps[i]!)) sqlite.exec(stmt);
      sqlite.prepare('INSERT INTO schema_version (n) VALUES (?)').run(i + 1);
      sqlite.exec('COMMIT');
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw new StoreError(`Could not bring the Studio's records to schema ${i + 1}: ${(e as Error).message}`);
    }
  }
  return steps.length;
}

/** Opens (creating it if need be) the Studio's records file and brings it up to date. Foreign keys are on and writes wait a little for each other. */
export async function openStudioDb(file: string): Promise<StudioDb> {
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  try {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec('PRAGMA busy_timeout = 5000');
    migrate(sqlite);
  } catch (e) {
    sqlite.close();
    throw e;
  }
  return wrap(sqlite);
}

/** A throwaway database in memory, migrated: for tests and previews. */
export function memoryStudioDb(): StudioDb {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  migrate(sqlite);
  return wrap(sqlite);
}

export { STUDIO_SCHEMA_VERSION };
