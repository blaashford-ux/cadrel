import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STUDIO_SCHEMA_VERSION, addEdition, bookByAsin, createBook, createSeries, listBooks } from '@cadrel/kernel';
import { MIGRATIONS } from '@cadrel/worker/src/migrations';
import { StoreError, memoryStudioDb, migrate, openStudioDb, type StudioDb } from '../src/index';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const open: StudioDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  open.splice(0).forEach((d) => d.close());
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-store-'));
  dirs.push(d);
  return d;
};
const ctx = { studioId: 's1', actor: 'ana', now: '2026-10-27T10:00:00.000Z' };

describe('the Studio database file', () => {
  it('creates itself at the schema version the kernel names, with every table the Worker has', async () => {
    const dir = await tmp();
    const db = await openStudioDb(path.join(dir, 'nested', 'records.db'));
    open.push(db);
    expect(await db.version()).toBe(STUDIO_SCHEMA_VERSION);
    expect(MIGRATIONS.length).toBe(STUDIO_SCHEMA_VERSION);
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name);
    for (const t of ['vault_file', 'checkout', 'audit', 'member', 'ip', 'series', 'book', 'edition', 'schema_version']) expect(tables).toContain(t);
  });

  it('keeps the records across a close and reopen, and does not migrate twice', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'records.db');
    const a = await openStudioDb(file);
    const book = await createBook(a, ctx, { title: 'Landfall' });
    await addEdition(a, ctx, book.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    a.close();
    const b = await openStudioDb(file);
    open.push(b);
    expect(await b.version()).toBe(STUDIO_SCHEMA_VERSION);
    expect((await b.all('SELECT n FROM schema_version')).length).toBe(STUDIO_SCHEMA_VERSION);
    expect((await bookByAsin(b, ctx, 'B0AAAAAAA1'))!.book.title).toBe('Landfall');
  });

  it('brings an older file forward without losing what is in it', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'records.db');
    const raw = new DatabaseSync(file);
    migrate(raw, MIGRATIONS.slice(0, 2)); // a Studio from before the catalogue existed
    raw.close();
    const db = await openStudioDb(file);
    open.push(db);
    expect(await db.version()).toBe(STUDIO_SCHEMA_VERSION);
    expect((await createSeries(db, ctx, { name: 'S' })).name).toBe('S');
  });

  it('refuses a file from a newer Cadrel and leaves it as it was', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'records.db');
    const raw = new DatabaseSync(file);
    migrate(raw);
    raw.prepare('INSERT INTO schema_version (n) VALUES (?)').run(MIGRATIONS.length + 4);
    raw.close();
    await expect(openStudioDb(file)).rejects.toThrow(StoreError);
    await expect(openStudioDb(file)).rejects.toThrow(/Update Cadrel/);
    const again = new DatabaseSync(file);
    expect((again.prepare('SELECT MAX(n) AS n FROM schema_version').get() as { n: number }).n).toBe(MIGRATIONS.length + 4);
    again.close();
  });

  it('rolls back a step that fails, so the file is not left half-migrated', () => {
    const raw = new DatabaseSync(':memory:');
    expect(() => migrate(raw, ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (x INTEGER); CREATE TABLE a (x INTEGER)'])).toThrow(/schema 2/);
    expect((raw.prepare('SELECT MAX(n) AS n FROM schema_version').get() as { n: number }).n).toBe(1);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
    raw.close();
  });

  it('is atomic: a batch whose second statement fails changes nothing, and foreign keys are enforced', async () => {
    const db = memoryStudioDb();
    open.push(db);
    await createBook(db, ctx, { title: 'One' });
    await expect(createBook(db, ctx, { title: 'one' })).rejects.toThrow(/already a book/);
    expect((await listBooks(db, ctx)).length).toBe(1);
    expect((await db.all("SELECT 1 FROM audit WHERE action = 'catalogue.book.create'")).length).toBe(1); // the failed attempt left no audit row
    await expect(db.run("INSERT INTO edition (id, studio_id, book_id, format, created_at, created_by, updated_at, updated_by) VALUES ('e', 's1', 'missing', 'ebook', 'x', 'x', 'x', 'x')")).rejects.toThrow(/FOREIGN KEY/);
  });
});
