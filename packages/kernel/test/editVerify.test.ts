import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, acceptedItems, createPass, createPerson, decideQuery, listVerification, makeAnchor, movePass, raiseQueries, verifyPass, verifyRevision, type Ctx, type QueryRecord
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

const ORIGINAL = 'The river ran cold.\n\nShe walked slowly to the river and stopped.\n\nHe said nothing at all, which was strange.\n\nThe end.';
const anchorOf = (q: string, text = ORIGINAL) => makeAnchor(text, text.indexOf(q), text.indexOf(q) + q.length);
const sug = (queryId: string, quote: string, replacement: string) => ({ queryId, kind: 'suggestion' as const, anchor: anchorOf(quote), replacement });

describe('verifying a revision (pure)', () => {
  it('made: the replacement is where the passage was', () => {
    const revised = ORIGINAL.replace('walked slowly', 'crept');
    const [r] = verifyRevision(revised, [sug('a', 'walked slowly', 'crept')]);
    expect(r).toMatchObject({ result: 'made', note: '' });
    expect(revised.slice(r!.found!.start, r!.found!.end)).toBe('crept');
  });

  it('missed: the passage is as it was', () => {
    expect(verifyRevision(ORIGINAL, [sug('a', 'walked slowly', 'crept')])[0]).toMatchObject({ result: 'missed' });
  });

  it('missed even when text was added before it and the passage moved', () => {
    const [r] = verifyRevision('A new opening.\n\n' + ORIGINAL, [sug('a', 'walked slowly', 'crept')]);
    expect(r!.result).toBe('missed');
  });

  it('changed: the passage was reworded some other way', () => {
    const revised = ORIGINAL.replace('walked slowly to the river', 'strolled down to the water');
    expect(verifyRevision(revised, [sug('a', 'walked slowly', 'crept')])[0]).toMatchObject({ result: 'changed', found: null });
  });

  it('made, with a note, when the replacement is there but the text around it was rewritten too', () => {
    const revised = 'Intro.\n\nThen suddenly she crept off somewhere else entirely.';
    expect(verifyRevision(revised, [sug('a', 'walked slowly', 'crept')])[0]).toMatchObject({ result: 'made' });
    expect(verifyRevision(revised, [sug('a', 'walked slowly', 'crept')])[0]!.note).toContain('around it');
  });

  it('a replacement that happens to appear elsewhere does not count when the passage itself is untouched', () => {
    const revised = ORIGINAL + '\n\nThe fox crept away.';
    expect(verifyRevision(revised, [sug('a', 'walked slowly', 'crept')])[0]!.result).toBe('missed');
  });

  it('a deletion is made when the passage is gone and missed when it is still there', () => {
    const del = { queryId: 'd', kind: 'suggestion' as const, anchor: anchorOf(', which was strange'), replacement: '' };
    expect(verifyRevision(ORIGINAL.replace(', which was strange', ''), [del])[0]!.result).toBe('made');
    expect(verifyRevision(ORIGINAL, [del])[0]!.result).toBe('missed');
  });

  it('a comment or query that was accepted: missed if the passage is untouched, changed if it was altered or removed', () => {
    const c = { queryId: 'c', kind: 'comment' as const, anchor: anchorOf('He said nothing at all'), replacement: null };
    expect(verifyRevision(ORIGINAL, [c])[0]!.result).toBe('missed');
    expect(verifyRevision(ORIGINAL.replace('He said nothing at all', 'He said nothing'), [c])[0]!.result).toBe('changed');
    expect(verifyRevision('Completely different.', [c])[0]!.result).toBe('changed');
  });

  it('unchecked: an accepted item with no passage', () => {
    expect(verifyRevision(ORIGINAL, [{ queryId: 'n', kind: 'comment', anchor: null, replacement: null }])[0]).toMatchObject({ result: 'unchecked' });
  });

  it('checks several at once and keeps their order', () => {
    const revised = ORIGINAL.replace('walked slowly', 'crept');
    const out = verifyRevision(revised, [sug('a', 'walked slowly', 'crept'), sug('b', 'The end.', 'Fin.')]);
    expect(out.map((r) => [r.queryId, r.result])).toEqual([['a', 'made'], ['b', 'missed']]);
  });
});

describe('verifying a pass (stored)', () => {
  let db: Db, ana: string, bo: string, pass: string, items: QueryRecord[];
  const at = (actor: string, now = '2026-11-03T10:00:00.000Z'): Ctx => ({ studioId: 's1', actor, now });
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
  const REVISED = ORIGINAL.replace('walked slowly', 'crept');

  beforeEach(async () => {
    db = memoryDb();
    const c = { studioId: 's1', actor: 'system', now: '2026-11-03T09:00:00.000Z' };
    ana = (await createPerson(db, c, { name: 'Ana' })).id;
    bo = (await createPerson(db, c, { name: 'Bo' })).id;
    await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 's1', 'book.md', 3)");
    for (const n of [1, 2, 3]) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', ?, ?, 1, 'x', '2026-11-01T00:00:00.000Z')", [n, `h${n}`]);
    pass = (await createPass(db, at(bo), { projectId: 'p1', kind: 'line', fileId: 'f1', fileVersion: 1, editorId: bo })).id;
    await movePass(db, at(bo), pass, 'in_progress');
    items = await raiseQueries(db, at(bo), pass, [
      { kind: 'suggestion', anchor: anchorOf('walked slowly'), replacement: 'crept' },
      { kind: 'suggestion', anchor: anchorOf('The end.'), replacement: 'Fin.' },
      { kind: 'suggestion', anchor: anchorOf('which was strange'), replacement: 'oddly' },
      { kind: 'comment', body: 'Strong ending.', anchor: anchorOf('He said nothing') }
    ]);
    await movePass(db, at(bo), pass, 'delivered');
    await decideQuery(db, at(ana), items[0]!.id, { outcome: 'accept' });
    await decideQuery(db, at(ana), items[1]!.id, { outcome: 'accept' });
    await decideQuery(db, at(ana), items[2]!.id, { outcome: 'reject', reason: 'Keep it.' });
    await decideQuery(db, at(ana), items[3]!.id, { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' });
    await movePass(db, at(ana), pass, 'responded');
  });

  it('looks only at accepted items, as they stand now', async () => {
    expect((await acceptedItems(db, at(ana), pass)).map((i) => i.queryId)).toEqual([items[0]!.id, items[1]!.id]);
  });

  it('checks and keeps the result for each accepted item against the revised version', async () => {
    const r = await verifyPass(db, at(bo, '2026-11-09T10:00:00.000Z'), pass, { revisedVersion: 2, revisedText: REVISED });
    expect(r.map((x) => [x.queryId, x.result])).toEqual([[items[0]!.id, 'made'], [items[1]!.id, 'missed']]);
    expect(r[0]).toMatchObject({ revisedVersion: 2, checkedBy: bo, checkedAt: '2026-11-09T10:00:00.000Z' });
    expect(REVISED.slice(r[0]!.found!.start, r[0]!.found!.end)).toBe('crept');
    expect((await listVerification(db, at(bo), { passId: pass })).map((x) => x.result)).toEqual(['made', 'missed']);
  });

  it('checking again replaces the earlier check of that version and leaves other versions alone', async () => {
    await verifyPass(db, at(bo), pass, { revisedVersion: 2, revisedText: REVISED });
    await verifyPass(db, at(bo), pass, { revisedVersion: 3, revisedText: REVISED.replace('The end.', 'Fin.') });
    const again = await verifyPass(db, at(bo), pass, { revisedVersion: 2, revisedText: REVISED.replace('The end.', 'Fin.') });
    expect(again.map((x) => x.result)).toEqual(['made', 'made']);
    expect((await listVerification(db, at(bo), { passId: pass, revisedVersion: 3 })).length).toBe(2);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM edit_verification"))!.n).toBe(4);
    expect((await listVerification(db, at(bo), { passId: pass })).map((x) => x.revisedVersion)).toEqual([3, 3]); // the latest check by default
    expect(await listVerification(db, at(bo), { passId: 'none' })).toEqual([]);
  });

  it('checks what it is given', async () => {
    expect(await code(verifyPass(db, at(bo), 'nope', { revisedVersion: 2, revisedText: 'x' }))).toBe('not-found');
    expect(await code(verifyPass(db, at(bo), pass, { revisedVersion: 1, revisedText: 'x' }))).toBe('invalid'); // not after the covered version
    expect(await code(verifyPass(db, at(bo), pass, { revisedVersion: 2.5, revisedText: 'x' }))).toBe('invalid');
    expect(await code(verifyPass(db, at(bo), pass, { revisedVersion: 9, revisedText: 'x' }))).toBe('not-found');
    expect(await code(verifyPass(db, at(bo), pass, { revisedVersion: 2, revisedText: 7 as never }))).toBe('invalid');
    const early = (await createPass(db, at(bo), { projectId: 'p1', kind: 'copy', fileId: 'f1', fileVersion: 1, editorId: bo })).id;
    expect(await code(verifyPass(db, at(bo), early, { revisedVersion: 2, revisedText: 'x' }))).toBe('conflict'); // not responded yet
  });

  it('may be done on a closed pass, and is in the audit log', async () => {
    await movePass(db, at(ana), pass, 'closed');
    expect(await code(verifyPass(db, at(bo), pass, { revisedVersion: 2, revisedText: REVISED }))).toBe('ok');
    const log = await db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit WHERE action = 'pass.verify'");
    expect(JSON.parse(log[0]!.detail)).toMatchObject({ revisedVersion: 2, counts: { made: 1, missed: 1, changed: 0, unchecked: 0 } });
  });
});
