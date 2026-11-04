import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, answerQuery, createPass, createPerson, getQuery, listQueries, makeAnchor, movePass, queriesFromNotes, queryCounts, raiseQueries, resolveQuery, withdrawQuery, type Ctx, type QueryRecord
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db, ana: string, bo: string, pass: string;
const TEXT = 'The river ran cold. She walked slowly to the river.';
const at = (actor = 'bo', now = '2026-11-03T10:00:00.000Z'): Ctx => ({ studioId: 's1', actor, now });
const anchor = (q: string) => makeAnchor(TEXT, TEXT.indexOf(q), TEXT.indexOf(q) + q.length);
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
const to = (state: Parameters<typeof movePass>[3], id = pass) => movePass(db, at(), id, state);

beforeEach(async () => {
  db = memoryDb();
  const c = { studioId: 's1', actor: 'system', now: '2026-11-03T09:00:00.000Z' };
  ana = (await createPerson(db, c, { name: 'Ana' })).id;
  bo = (await createPerson(db, c, { name: 'Bo' })).id;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 's1', 'book.md', 1)");
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 1, 'h', 1, 'ana', '2026-11-01T00:00:00.000Z')");
  pass = (await createPass(db, at(), { projectId: 'p1', kind: 'line', fileId: 'f1', editorId: bo })).id;
  await to('in_progress');
});

describe('queries in a pass', () => {
  it('raises numbered items in an in-progress pass, anchored to the version’s text', async () => {
    const [q, c, s] = (await raiseQueries(db, at(), pass, [
      { kind: 'query', body: 'Cold how? Name the temperature.', anchor: anchor('ran cold'), category: ' Clarity ' },
      { kind: 'comment', body: 'Nice rhythm.' },
      { kind: 'suggestion', anchor: anchor('walked slowly'), replacement: 'crept' }
    ])) as [QueryRecord, QueryRecord, QueryRecord];
    expect([q.seq, c.seq, s.seq]).toEqual([1, 2, 3]);
    expect(q).toMatchObject({ kind: 'query', state: 'open', category: 'clarity', raisedBy: 'bo', anchor: { quote: 'ran cold', start: TEXT.indexOf('ran cold') } });
    expect(c.anchor).toBeNull();
    expect(s).toMatchObject({ replacement: 'crept', body: '' });
    const more = await raiseQueries(db, at(), pass, [{ kind: 'comment', body: 'Later.' }]);
    expect(more[0]!.seq).toBe(4);
  });

  it('checks what it is given, and raises all or none', async () => {
    const ok = { kind: 'comment' as const, body: 'x' };
    expect(await code(raiseQueries(db, at(), pass, []))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ kind: 'note' as never, body: 'x' }]))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ kind: 'query', body: ' ' }]))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ kind: 'comment', body: 'x'.repeat(4001) }]))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ ...ok, anchor: { quote: '', prefix: '', suffix: '', start: 0 } }]))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ ...ok, anchor: { quote: 'x'.repeat(2001), prefix: '', suffix: '', start: 0 } }]))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ ...ok, anchor: { quote: 'a', prefix: '', suffix: '', start: -1 } }]))).toBe('invalid');
    expect(await code(raiseQueries(db, at(), pass, [{ kind: 'suggestion', replacement: 'x' }]))).toBe('invalid'); // no passage
    expect(await code(raiseQueries(db, at(), pass, [{ kind: 'suggestion', anchor: anchor('cold') }]))).toBe('invalid'); // no replacement
    expect(await code(raiseQueries(db, at(), pass, [{ ...ok, replacement: 'x' }]))).toBe('invalid'); // only suggestions replace
    expect(await code(raiseQueries(db, at(), 'nope', [ok]))).toBe('not-found');
    expect(await code(raiseQueries(db, at(), pass, Array.from({ length: 201 }, () => ok)))).toBe('invalid');
    // the second item is bad, so the first is not kept either
    expect(await code(raiseQueries(db, at(), pass, [ok, { kind: 'query', body: '' }]))).toBe('invalid');
    expect(await listQueries(db, at(), { passId: pass })).toEqual([]);
  });

  it('only raises while the pass is in progress', async () => {
    await to('delivered');
    expect(await code(raiseQueries(db, at(), pass, [{ kind: 'comment', body: 'late' }]))).toBe('conflict');
    const other = (await createPass(db, at(), { projectId: 'p1', kind: 'copy', fileId: 'f1', editorId: bo })).id;
    expect(await code(raiseQueries(db, at(), other, [{ kind: 'comment', body: 'early' }]))).toBe('conflict'); // still planned
  });

  it('the author answers after delivery; the pass cannot be marked responded while a query is unanswered', async () => {
    const [q, c] = await raiseQueries(db, at(), pass, [{ kind: 'query', body: 'Why?' }, { kind: 'comment', body: 'FYI' }]);
    expect(await code(answerQuery(db, at('ana'), q!.id, 'Because.'))).toBe('conflict'); // not delivered yet
    await to('delivered');
    const err = (await to('responded').catch((e) => e)) as WorkError;
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err.message).toContain('1 query is still unanswered');
    const a = await answerQuery(db, at('ana', '2026-11-05T10:00:00.000Z'), q!.id, ' Because the river is a river. ');
    expect(a).toMatchObject({ state: 'answered', response: 'Because the river is a river.', respondedBy: 'ana', respondedAt: '2026-11-05T10:00:00.000Z' });
    expect((await answerQuery(db, at('ana'), q!.id, 'A better answer.')).response).toBe('A better answer.'); // rewritable until responded
    expect(await code(to('responded'))).toBe('ok'); // an open comment does not hold it up
    expect((await getQuery(db, at(), c!.id))!.state).toBe('open');
    expect(await code(answerQuery(db, at('ana'), q!.id, 'Too late'))).toBe('conflict');
    expect(await code(answerQuery(db, at('ana'), q!.id, ' '))).toBe('conflict'); // pass state is checked first
  });

  it('checks the answer text', async () => {
    const [q] = await raiseQueries(db, at(), pass, [{ kind: 'query', body: 'Why?' }]);
    await to('delivered');
    expect(await code(answerQuery(db, at('ana'), q!.id, '  '))).toBe('invalid');
    expect(await code(answerQuery(db, at('ana'), q!.id, 'x'.repeat(4001)))).toBe('invalid');
    expect(await code(answerQuery(db, at('ana'), 'nope', 'x'))).toBe('not-found');
  });

  it('resolves open or answered items once delivered, and never again', async () => {
    const [q, c] = await raiseQueries(db, at(), pass, [{ kind: 'query', body: 'Why?' }, { kind: 'comment', body: 'FYI' }]);
    expect(await code(resolveQuery(db, at(), c!.id))).toBe('conflict'); // still in progress
    await to('delivered');
    await answerQuery(db, at('ana'), q!.id, 'Because.');
    expect(await resolveQuery(db, at(), q!.id)).toMatchObject({ state: 'resolved', resolvedBy: 'bo' });
    expect((await resolveQuery(db, at(), c!.id)).state).toBe('resolved');
    expect(await code(resolveQuery(db, at(), c!.id))).toBe('conflict');
    expect(await code(answerQuery(db, at('ana'), c!.id, 'x'))).toBe('conflict');
  });

  it('withdraws only an open item, and never deletes it', async () => {
    const [q, c] = await raiseQueries(db, at(), pass, [{ kind: 'query', body: 'Why?' }, { kind: 'comment', body: 'FYI' }]);
    expect((await withdrawQuery(db, at(), c!.id)).state).toBe('withdrawn');
    expect(await code(withdrawQuery(db, at(), c!.id))).toBe('conflict');
    await to('delivered');
    await answerQuery(db, at('ana'), q!.id, 'Because.');
    expect(await code(withdrawQuery(db, at(), q!.id))).toBe('conflict'); // answered
    expect((await listQueries(db, at(), { passId: pass })).length).toBe(2);
    expect((await listQueries(db, at(), { passId: pass, state: 'live' })).map((x) => x.id)).toEqual([q!.id]);
  });

  it('counts by pass and state, lists by filter, and stays inside its studio', async () => {
    await raiseQueries(db, at(), pass, [{ kind: 'query', body: 'a' }, { kind: 'comment', body: 'b' }, { kind: 'comment', body: 'c' }]);
    const [first] = await listQueries(db, at(), { passId: pass, kind: 'query' });
    await withdrawQuery(db, at(), first!.id);
    expect(await queryCounts(db, at(), [pass, 'none'])).toEqual({ [pass]: { open: 2, answered: 0, resolved: 0, withdrawn: 1 } });
    expect(await queryCounts(db, at(), [])).toEqual({});
    expect(await listQueries(db, at(), { passIds: [] })).toEqual([]);
    expect(await listQueries(db, { studioId: 's2' }, { passId: pass })).toEqual([]);
    expect(await getQuery(db, { studioId: 's2' }, first!.id)).toBeNull();
    const log = await db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'query.%' ORDER BY rowid");
    expect(log.map((l) => l.action)).toEqual(['query.raise', 'query.withdraw']);
  });

  it('turns Write’s notes into items, counting the ones it cannot place', () => {
    const { items, skipped } = queriesFromNotes([
      { kind: 'comment', body: 'Adverb.', category: 'style', anchor: { quote: 'slowly', prefix: 'walked ', suffix: ' to', start: 8 } },
      { kind: 'suggestion', replacement: 'crept', anchor: { quote: 'walked slowly', prefix: '', suffix: '', start: 2 } },
      { kind: 'comment', body: 'No anchor' },
      { kind: 'comment', body: 'Empty quote', anchor: { quote: ' ', start: 0 } },
      { kind: 'reply', body: 'x', anchor: { quote: 'a', start: 0 } }
    ]);
    expect(skipped).toBe(3);
    expect(items.map((i) => i.kind)).toEqual(['comment', 'suggestion']);
    expect(items[1]).toMatchObject({ replacement: 'crept', anchor: { quote: 'walked slowly', start: 2 } });
  });
});
