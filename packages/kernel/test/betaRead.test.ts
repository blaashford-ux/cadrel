import { beforeEach, describe, expect, it } from 'vitest';
import { BetaReadError, DbVaultStore, defaultRole, getBetaRead, setBetaRead, type Db } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
const who = { actor: 'ana', now: '2026-11-10T10:00:00Z' };
beforeEach(async () => {
  db = memoryDb();
  await db.run('INSERT INTO vault_file (id, studio_id, path) VALUES (?, ?, ?)', ['ms', 's1', 'Book/ms.md']);
});

describe('beta reading chapters', () => {
  it('has no chapter on until the author turns some on', async () => {
    expect(await getBetaRead(db, 'ms')).toEqual({ fileId: 'ms', level: 1, chapters: [] });
  });
  it('keeps exactly the chapters switched on, replaces them, and turns off with an empty list', async () => {
    await setBetaRead(db, { fileId: 'ms', level: 2, chapters: ['One', 'Three', 'One'], ...who });
    expect(await getBetaRead(db, 'ms')).toEqual({ fileId: 'ms', level: 2, chapters: ['One', 'Three'] });
    await setBetaRead(db, { fileId: 'ms', level: 2, chapters: ['Two'], ...who });
    expect((await getBetaRead(db, 'ms')).chapters).toEqual(['Two']);
    await setBetaRead(db, { fileId: 'ms', level: 2, chapters: [], ...who });
    expect((await getBetaRead(db, 'ms')).chapters).toEqual([]);
    expect((await db.all('SELECT action FROM audit WHERE action = ?', ['file.beta-read'])).length).toBe(3);
  });
  it('refuses a file that is not in the vault and a bad level', async () => {
    await expect(setBetaRead(db, { fileId: 'nope', level: 1, chapters: [], ...who })).rejects.toBeInstanceOf(BetaReadError);
    await expect(setBetaRead(db, { fileId: 'ms', level: 9, chapters: [], ...who })).rejects.toBeInstanceOf(BetaReadError);
  });
  it('is reached through the vault store as the person', async () => {
    const store = new DbVaultStore({ db, studioId: 's1', personId: 'ana' });
    await store.setBetaRead({ fileId: 'ms', level: 1, chapters: ['A'] });
    expect(await store.betaRead('ms')).toMatchObject({ chapters: ['A'] });
  });
});

describe('the Beta Reader role', () => {
  it('can read and comment on manuscripts and holds nothing else', () => {
    const caps = defaultRole('beta_reader').capabilities;
    expect(caps.sort()).toEqual(['manuscript.comment', 'manuscript.read']);
  });
});
