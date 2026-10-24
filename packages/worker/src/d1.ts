import type { Db } from '@cadrel/kernel';

/** D1 behind the kernel's Db interface. */
export function d1Db(d1: D1Database): Db {
  const prep = (sql: string, params?: unknown[]) => d1.prepare(sql).bind(...(params ?? []));
  return {
    async run(sql, params) {
      const r = await prep(sql, params).run();
      return { changes: r.meta.changes ?? 0 };
    },
    async first<T>(sql: string, params?: unknown[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async all<T>(sql: string, params?: unknown[]) {
      return (await prep(sql, params).all<T>()).results;
    },
    async batch(statements) {
      const results = await d1.batch(statements.map((s) => prep(s.sql, s.params)));
      return results.map((r) => ({ changes: r.meta.changes ?? 0 }));
    }
  };
}
