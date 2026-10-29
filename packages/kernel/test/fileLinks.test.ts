import { beforeEach, describe, expect, it } from 'vitest';
import { FileLinkError, addReference, checkIn, checkOut, cleanFields, findByCard, getCard, referencesOf, removeReference, setCard, setReferenceVersion, whereUsed, type Db } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
const who = { actor: 'ana', now: '2026-11-10T10:00:00Z' };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof FileLinkError ? e.code : `other:${e}`));
async function version(id: string, n: number) {
  for (let i = 0; i < n; i++) {
    await checkOut(db, { fileId: id, personId: 'ana', machine: 'm', now: `2026-11-0${i + 1}T00:00:00Z` });
    await checkIn(db, { fileId: id, personId: 'ana', machine: 'm', hash: `${id}-${i}`, size: 1, comment: '', now: `2026-11-0${i + 1}T01:00:00Z` });
  }
}
beforeEach(async () => {
  db = memoryDb();
  for (const [id, p] of [['epub', 'Book/book.epub'], ['ms', 'Book/ms.md'], ['cover', 'Book/cover.psd']]) await db.run('INSERT INTO vault_file (id, studio_id, path) VALUES (?, ?, ?)', [id, 's1', p]);
  await version('ms', 3);
  await version('cover', 1);
});

describe('references and where-used', () => {
  it('records what a file uses, and reads the same rows backwards as where-used', async () => {
    await addReference(db, { fileId: 'epub', refersToId: 'ms', version: 2, ...who });
    await addReference(db, { fileId: 'epub', refersToId: 'cover', ...who, note: 'front cover' });
    expect((await referencesOf(db, 'epub')).map((r) => [r.path, r.version, r.currentVersion, r.stale, r.note])).toEqual([['Book/cover.psd', null, 1, false, 'front cover'], ['Book/ms.md', 2, 3, true, '']]);
    expect((await whereUsed(db, 'ms')).map((r) => [r.path, r.version, r.stale])).toEqual([['Book/book.epub', 2, true]]);
    expect(await whereUsed(db, 'epub')).toEqual([]);
  });
  it('is explicit about versions: a reference goes stale when the file moves on, and only a person updates it', async () => {
    await addReference(db, { fileId: 'epub', refersToId: 'ms', version: 3, ...who });
    expect((await referencesOf(db, 'epub'))[0]!.stale).toBe(false);
    await version('ms', 1); // check-in of a newer version: n restarts the loop's names but current_version counts up
    expect((await referencesOf(db, 'epub'))[0]).toMatchObject({ stale: true, currentVersion: 4 });
    await setReferenceVersion(db, { fileId: 'epub', refersToId: 'ms', version: 4, ...who });
    expect((await referencesOf(db, 'epub'))[0]!.stale).toBe(false);
    await setReferenceVersion(db, { fileId: 'epub', refersToId: 'ms', version: null, ...who });
    expect((await referencesOf(db, 'epub'))[0]).toMatchObject({ version: null, stale: false }); // "latest" is never stale
  });
  it('refuses a reference to itself, to nothing, twice, or to a version that does not exist; removes cleanly', async () => {
    expect(await code(addReference(db, { fileId: 'ms', refersToId: 'ms', ...who }))).toBe('invalid');
    expect(await code(addReference(db, { fileId: 'epub', refersToId: 'ghost', ...who }))).toBe('not-found');
    expect(await code(addReference(db, { fileId: 'ghost', refersToId: 'ms', ...who }))).toBe('not-found');
    expect(await code(addReference(db, { fileId: 'epub', refersToId: 'ms', version: 9, ...who }))).toBe('invalid');
    expect(await code(addReference(db, { fileId: 'epub', refersToId: 'ms', version: 0, ...who }))).toBe('invalid');
    await addReference(db, { fileId: 'epub', refersToId: 'ms', ...who });
    expect(await code(addReference(db, { fileId: 'epub', refersToId: 'ms', ...who }))).toBe('exists');
    expect(await code(setReferenceVersion(db, { fileId: 'cover', refersToId: 'ms', version: 1, ...who }))).toBe('not-found');
    await removeReference(db, { fileId: 'epub', refersToId: 'ms', ...who });
    expect(await referencesOf(db, 'epub')).toEqual([]);
    expect((await db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'file.%reference%' OR action = 'file.unreference'")).length).toBeGreaterThan(2);
  });
});

describe('data cards', () => {
  it('keeps a few text facts and a project, replaced as a whole, and finds files by them', async () => {
    expect(await getCard(db, 'cover')).toMatchObject({ fields: {}, projectId: null, updatedAt: null });
    await setCard(db, { fileId: 'cover', fields: { 'Trim size': ' 6 x 9 ', Licence: 'Commissioned', Empty: '' }, projectId: 'p1', ...who });
    expect(await getCard(db, 'cover')).toMatchObject({ fields: { 'Trim size': '6 x 9', Licence: 'Commissioned' }, projectId: 'p1', updatedBy: 'ana' });
    await setCard(db, { fileId: 'ms', fields: { licence: 'Own work' }, ...who });
    expect((await findByCard(db, 's1', { field: 'licence', value: 'commissioned' })).map((f) => f.path)).toEqual(['Book/cover.psd']);
    expect((await findByCard(db, 's1', { field: 'LICENCE' })).map((f) => f.path)).toEqual(['Book/cover.psd', 'Book/ms.md']);
    expect((await findByCard(db, 's1', { projectId: 'p1' })).map((f) => f.path)).toEqual(['Book/cover.psd']);
    await setCard(db, { fileId: 'cover', fields: {}, ...who });
    expect((await getCard(db, 'cover')).fields).toEqual({});
  });
  it('checks what it is given', async () => {
    expect(() => cleanFields([])).toThrow(FileLinkError);
    expect(() => cleanFields({ a: 5 })).toThrow(/needs text/);
    expect(() => cleanFields({ '': 'x' })).toThrow(/1 to 40/);
    expect(() => cleanFields({ ['x'.repeat(41)]: 'x' })).toThrow(/1 to 40/);
    expect(() => cleanFields({ a: 'x'.repeat(501) })).toThrow(/too long/);
    expect(() => cleanFields(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'x'])))).toThrow(/at most 30/);
    expect(() => cleanFields(JSON.parse('{"__proto__":"x"}'))).toThrow(/1 to 40/);
    expect(await code(setCard(db, { fileId: 'ghost', fields: {}, ...who }))).toBe('not-found');
  });
});
