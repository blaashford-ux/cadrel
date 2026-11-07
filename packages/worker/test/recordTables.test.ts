import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RECORD_TABLES } from '../src/import';
import { MIGRATIONS } from '../src/migrations';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Tables that are not records a backup or a move to the server carries: the Studio's own settings and sign-in keys, and SQLite's. */
const NOT_RECORDS = new Set(['studio_meta', 'member', 'invite', 'request_nonce', 'sqlite_sequence']);

describe('the tables a backup and a move carry', () => {
  it('are every table in the schema, apart from the few that are not records', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS) db.exec(m);
    const all = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    const missing = all.filter((t) => !RECORD_TABLES.includes(t as never) && !NOT_RECORDS.has(t));
    expect(missing, `add these to RECORD_TABLES (worker/src/import.ts) and TABLES (shell/src/main/moveRecords.ts), or to NOT_RECORDS here if they are not records`).toEqual([]);
    expect(RECORD_TABLES.filter((t) => !all.includes(t))).toEqual([]);
  });

  it('are the same list the app uses when it moves records to the server', () => {
    const src = readFileSync(new URL('../../shell/src/main/moveRecords.ts', import.meta.url), 'utf8');
    const body = /const TABLES = \[([\s\S]*?)\];/.exec(src)![1]!;
    const names = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...RECORD_TABLES]);
  });

  it('list a table after every table it refers to', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS) db.exec(m);
    const at = (t: string) => RECORD_TABLES.indexOf(t as never);
    for (const t of RECORD_TABLES) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[];
      for (const fk of fks) if (fk.table !== t) expect(at(fk.table), `${t} refers to ${fk.table}, which must come first`).toBeLessThan(at(t));
    }
  });
});
