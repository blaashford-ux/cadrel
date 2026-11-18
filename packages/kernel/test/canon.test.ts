import { beforeEach, describe, expect, it } from 'vitest';
import { WorkError, canonStamp, decideProposal, entryVersions, getEntry, getFact, listEntries, listFacts, listProposals, makeAnchor, proposeChange, withdrawProposal, type Ctx, type Db } from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
const ctx = (actor: string): Ctx => ({ studioId: 's1', actor, now: `2026-11-18T10:00:${String(clock++).padStart(2, '0')}Z` });
const TEXT = 'Mara had grey eyes and walked with a limp since the fall at Harrow.';
const src = (quote: string) => ({ fileId: 'book1', version: 2, anchor: makeAnchor(TEXT, TEXT.indexOf(quote), TEXT.indexOf(quote) + quote.length) });
const SERIES = 'series1';

const approved = async (change: unknown, project = SERIES) => {
  const p = await proposeChange(db, ctx('ann'), project, change);
  return decideProposal(db, ctx('lea'), p.id, { approve: true });
};
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('book1', 's1', 'Book One/book.md', 3)");
});

describe('canon: entries and facts only change through approved proposals', () => {
  it('a proposal changes nothing until it is approved; approving makes the entry, its first version and an audit row', async () => {
    const p = await proposeChange(db, ctx('ann'), SERIES, { change: 'add_entry', kind: 'character', name: 'Mara Quinn', aliases: ['Mara', 'the Ferrywoman'], summary: 'A ferrywoman.' });
    expect(p).toMatchObject({ state: 'open', change: 'add_entry', proposedBy: 'ann' });
    expect(await listEntries(db, ctx('x'), { projectId: SERIES })).toEqual([]);
    const done = await decideProposal(db, ctx('lea'), p.id, { approve: true });
    expect(done).toMatchObject({ state: 'approved', decidedBy: 'lea' });
    const [e] = await listEntries(db, ctx('x'), { projectId: SERIES });
    expect(e).toMatchObject({ name: 'Mara Quinn', kind: 'character', aliases: ['Mara', 'the Ferrywoman'], summary: 'A ferrywoman.', version: 1, state: 'active' });
    expect((await db.all("SELECT 1 FROM audit WHERE action = 'canon.approve'")).length).toBe(1);
  });

  it('names are unique within a series and kind, ignoring case; another series or kind may reuse one', async () => {
    await approved({ change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'add_entry', kind: 'character', name: 'MARA', summary: 'y' }))).toBe('exists');
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'add_entry', kind: 'place', name: 'Mara', summary: 'y' }))).toBe('ok');
    expect(await code(proposeChange(db, ctx('ann'), 'series2', { change: 'add_entry', kind: 'character', name: 'Mara', summary: 'y' }))).toBe('ok');
  });

  it('two proposals for the same name: the second approval is refused', async () => {
    const a = await proposeChange(db, ctx('ann'), SERIES, { change: 'add_entry', kind: 'place', name: 'Harrow', summary: 'a' });
    const b = await proposeChange(db, ctx('eve'), SERIES, { change: 'add_entry', kind: 'place', name: 'Harrow', summary: 'b' });
    await decideProposal(db, ctx('lea'), a.id, { approve: true });
    expect(await code(decideProposal(db, ctx('lea'), b.id, { approve: true }))).toBe('exists');
    expect((await listEntries(db, ctx('x'), { projectId: SERIES })).length).toBe(1);
    expect((await listProposals(db, ctx('x'), { projectId: SERIES, state: 'open' })).map((p) => p.id)).toEqual([b.id]); // still open, to be withdrawn
  });

  it('a revision is a new numbered version, and one made from a stale version is refused', async () => {
    await approved({ change: 'add_entry', kind: 'character', name: 'Mara', summary: 'v1' });
    const [e] = await listEntries(db, ctx('x'), { projectId: SERIES });
    await approved({ change: 'edit_entry', entryId: e!.id, summary: 'v2', basedOn: 1 });
    expect(await getEntry(db, ctx('x'), e!.id)).toMatchObject({ summary: 'v2', version: 2 });
    expect((await entryVersions(db, ctx('x'), e!.id)).map((v) => v.summary)).toEqual(['v1', 'v2']);
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'edit_entry', entryId: e!.id, summary: 'v3', basedOn: 1 }))).toBe('conflict');
    // proposed from the newest version, but someone else's revision is approved first
    const mine = await proposeChange(db, ctx('ann'), SERIES, { change: 'edit_entry', entryId: e!.id, summary: 'mine', basedOn: 2 });
    await approved({ change: 'edit_entry', entryId: e!.id, summary: 'theirs', basedOn: 2 });
    expect(await code(decideProposal(db, ctx('lea'), mine.id, { approve: true }))).toBe('conflict');
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'edit_entry', entryId: e!.id, basedOn: 3 }))).toBe('invalid'); // nothing changed
  });

  it('finds an entry by a part of its name or an alias', async () => {
    await approved({ change: 'add_entry', kind: 'character', name: 'Mara Quinn', aliases: ['the Ferrywoman'], summary: 'x' });
    await approved({ change: 'add_entry', kind: 'place', name: 'Harrow', summary: 'x' });
    expect((await listEntries(db, ctx('x'), { projectId: SERIES, search: 'ferry' })).map((e) => e.name)).toEqual(['Mara Quinn']);
    expect((await listEntries(db, ctx('x'), { projectId: SERIES, kind: 'place' })).map((e) => e.name)).toEqual(['Harrow']);
  });
});

describe('canon: facts are never edited, only superseded or retired', () => {
  let entryId: string;
  beforeEach(async () => {
    await approved({ change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
    entryId = (await listEntries(db, ctx('x'), { projectId: SERIES }))[0]!.id;
  });

  it('keeps the passage that established a fact, and where in the series that was', async () => {
    await approved({ change: 'add_fact', entryId, text: 'Mara has grey eyes.', source: src('grey eyes'), bookProjectId: 'book-one', chapter: 1 });
    const [f] = await listFacts(db, ctx('x'), { entryId });
    expect(f).toMatchObject({ text: 'Mara has grey eyes.', status: 'canon', bookProjectId: 'book-one', chapter: 1, source: { fileId: 'book1', version: 2, anchor: { quote: 'grey eyes' } } });
    expect(f!.source!.anchor.start).toBe(TEXT.indexOf('grey eyes'));
  });

  it('refuses a source whose file or version is not there, an empty quote, and a bad chapter', async () => {
    const add = (o: object) => proposeChange(db, ctx('ann'), SERIES, { change: 'add_fact', entryId, text: 'x', ...o });
    expect(await code(add({ source: { ...src('grey'), fileId: 'nope' } }))).toBe('not-found');
    expect(await code(add({ source: { ...src('grey'), version: 9 } }))).toBe('not-found');
    expect(await code(add({ source: { ...src('grey'), anchor: { quote: '  ', prefix: '', suffix: '', start: 0 } } }))).toBe('invalid');
    expect(await code(add({ chapter: 0 }))).toBe('invalid');
    expect(await code(add({ text: '   ' }))).toBe('invalid');
  });

  it('superseding retires the old fact, keeps it, and links the new one to it', async () => {
    await approved({ change: 'add_fact', entryId, text: 'Mara has grey eyes.' });
    const [old] = await listFacts(db, ctx('x'), { entryId });
    await approved({ change: 'supersede_fact', factId: old!.id, text: 'Mara has green eyes.' });
    const live = await listFacts(db, ctx('x'), { entryId });
    expect(live.map((f) => f.text)).toEqual(['Mara has green eyes.']);
    expect(live[0]!.supersedesId).toBe(old!.id);
    expect(await getFact(db, ctx('x'), old!.id)).toMatchObject({ status: 'retired', retiredBy: 'lea', retiredReason: 'Superseded by a newer fact.' });
    expect((await listFacts(db, ctx('x'), { entryId, status: 'any' })).length).toBe(2);
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'supersede_fact', factId: old!.id, text: 'again' }))).toBe('conflict'); // no longer canon
  });

  it('refuses to supersede with the same words, and two proposals on one fact: the second approval is refused', async () => {
    await approved({ change: 'add_fact', entryId, text: 'Mara limps.' });
    const [f] = await listFacts(db, ctx('x'), { entryId });
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'supersede_fact', factId: f!.id, text: 'Mara limps.' }))).toBe('invalid');
    const a = await proposeChange(db, ctx('ann'), SERIES, { change: 'supersede_fact', factId: f!.id, text: 'Mara limps on her left leg.' });
    const b = await proposeChange(db, ctx('eve'), SERIES, { change: 'retire_fact', factId: f!.id, reason: 'no longer true' });
    await decideProposal(db, ctx('lea'), a.id, { approve: true });
    expect(await code(decideProposal(db, ctx('lea'), b.id, { approve: true }))).toBe('conflict');
  });

  it('retiring an entry retires its facts with the reason', async () => {
    await approved({ change: 'add_fact', entryId, text: 'Mara is a ferrywoman.' });
    await approved({ change: 'retire_entry', entryId, reason: 'Merged into another character' });
    expect(await listFacts(db, ctx('x'), { entryId })).toEqual([]);
    expect((await listFacts(db, ctx('x'), { entryId, status: 'retired' }))[0]!.retiredReason).toMatch(/Merged into another character/);
    expect(await listEntries(db, ctx('x'), { projectId: SERIES })).toEqual([]);
    expect((await listEntries(db, ctx('x'), { projectId: SERIES, state: 'retired' })).length).toBe(1);
    expect(await code(proposeChange(db, ctx('ann'), SERIES, { change: 'add_fact', entryId, text: 'more' }))).toBe('conflict');
  });

  it('does not reach into another series', async () => {
    expect(await code(proposeChange(db, ctx('ann'), 'series2', { change: 'add_fact', entryId, text: 'x' }))).toBe('invalid');
  });
});

describe('canon: deciding, withdrawing, and the stamp', () => {
  it('a rejection needs a reason and is final; an approved proposal cannot be decided again; the proposer can withdraw an open one', async () => {
    const a = await proposeChange(db, ctx('ann'), SERIES, { change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    expect(await code(decideProposal(db, ctx('lea'), a.id, { approve: false }))).toBe('invalid');
    expect(await decideProposal(db, ctx('lea'), a.id, { approve: false, reason: 'Not a term' })).toMatchObject({ state: 'rejected', reason: 'Not a term', decidedBy: 'lea' });
    expect(await code(decideProposal(db, ctx('lea'), a.id, { approve: true }))).toBe('conflict');
    const b = await proposeChange(db, ctx('ann'), SERIES, { change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    expect(await withdrawProposal(db, ctx('ann'), b.id)).toMatchObject({ state: 'withdrawn' });
    expect(await code(withdrawProposal(db, ctx('ann'), b.id))).toBe('conflict');
    expect(await listEntries(db, ctx('x'), { projectId: SERIES })).toEqual([]);
  });

  it('the stamp is the time of the last canon change, and empty before any', async () => {
    expect(await canonStamp(db, ctx('x'), SERIES)).toBe('');
    await approved({ change: 'add_entry', kind: 'term', name: 'Quiet', summary: 'x' });
    const first = await canonStamp(db, ctx('x'), SERIES);
    expect(first).toMatch(/^2026-11-18T/);
    const [e] = await listEntries(db, ctx('x'), { projectId: SERIES });
    await approved({ change: 'add_fact', entryId: e!.id, text: 'A word.' });
    expect((await canonStamp(db, ctx('x'), SERIES)) > first).toBe(true);
    expect(await canonStamp(db, ctx('x'), 'series2')).toBe('');
  });

  it('refuses a change it does not understand', async () => {
    for (const bad of [null, {}, { change: 'delete_everything' }, 'x']) expect(await code(proposeChange(db, ctx('ann'), SERIES, bad))).toBe('invalid');
    expect(await code(proposeChange(db, ctx('ann'), '', { change: 'add_entry', kind: 'term', name: 'x', summary: 'x' }))).toBe('invalid');
  });
});
