import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Db } from '../src/vault';

/** node:sqlite behind the kernel's Db interface. D1 is SQLite too, so the same SQL is exercised. */
// Loaded through require because Vite's resolver strips the `node:` prefix from `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function memoryDb(): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  // every migration the Studio's database has, in order: the same SQL D1 gets
  const dir = new URL('../../worker/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  const bind = (p?: unknown[]) => (p ?? []) as (string | number | null)[];
  return {
    async run(sql, params) {
      const r = sqlite.prepare(sql).run(...bind(params));
      return { changes: Number(r.changes) };
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
