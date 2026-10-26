import { createRequire } from 'node:module';

// Loaded through require because Vite's resolver strips the `node:` prefix from `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Param = string | number | null;

class Stmt {
  constructor(private readonly db: InstanceType<typeof DatabaseSync>, readonly sql: string, readonly params: Param[] = []) {}
  bind(...p: unknown[]) {
    return new Stmt(this.db, this.sql, p as Param[]);
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T>() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params) as T[], meta: { changes: 0 } };
  }
}

/** SQLite behind the parts of D1's API the Worker uses. D1 is SQLite, so the same SQL is exercised. */
export function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } as unknown as D1Database;
}
