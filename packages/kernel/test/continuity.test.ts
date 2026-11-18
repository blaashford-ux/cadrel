import { beforeEach, describe, expect, it } from 'vitest';
import {
  WorkError, closeCheck, decideFinding, decideProposal, deliverCheck, findingCounts, getCheck, getFact, listEntries, listFacts, listFindings, listProposals, makeAnchor, proposeChange,
  raiseFindings, startCheck, verifyFindings, type Ctx, type Db, type NewFinding
} from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
const ctx = (actor: string): Ctx => ({ studioId: 's1', actor, now: `2026-11-18T10:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock++ % 60).padStart(2, '0')}Z` });
const SERIES = 'series1';
const BOOK = 'book4';
const BOOK4 = ['Mara walked to the ford with her green eyes narrowed.', 'She counted nine days since the battle of Harrow.', 'The old rule held: a spell cost a year of the caster’s life.'].join('\n\n');
const at = (text: string, quote: string) => makeAnchor(text, text.indexOf(quote), text.indexOf(quote) + quote.length);
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
let eyes: string, battle: string;

const addCanon = async (change: unknown) => {
  const p = await proposeChange(db, ctx('ann'), SERIES, change);
  await decideProposal(db, ctx('lea'), p.id, { approve: true });
};
const finding = (quote: string, facts: string[], o: Partial<NewFinding> = {}): NewFinding => ({ kind: 'contradiction', severity: 'high', confidence: 'high', body: 'Conflicts with canon.', anchor: at(BOOK4, quote), factIds: facts, ...o });

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f4', 's1', 'Book Four/book.md', 2)");
  await addCanon({ change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
  const entryId = (await listEntries(db, ctx('x'), { projectId: SERIES }))[0]!.id;
  await addCanon({ change: 'add_fact', entryId, text: 'Mara has grey eyes.' });
  await addCanon({ change: 'add_fact', entryId, text: 'The battle of Harrow was fought on day 1 of the war.' });
  const facts = await listFacts(db, ctx('x'), { projectId: SERIES });
  eyes = facts.find((f) => /grey/.test(f.text))!.id;
  battle = facts.find((f) => /Harrow/.test(f.text))!.id;
});

const start = () => startCheck(db, ctx('eve'), { projectId: BOOK, seriesId: SERIES, fileId: 'f4' });

describe('a continuity check is pinned to the manuscript version and to the canon', () => {
  it('records the exact version and the canon stamp, and allows one live check of a manuscript at a time', async () => {
    const k = await start();
    expect(k).toMatchObject({ state: 'open', fileVersion: 2, filePath: 'Book Four/book.md', runBy: 'eve', seriesId: SERIES });
    expect(k.canonStamp).toMatch(/^2026-11-18T/);
    expect(await code(start())).toBe('conflict');
    expect(await code(startCheck(db, ctx('eve'), { projectId: BOOK, seriesId: SERIES, fileId: 'f4', fileVersion: 1 }))).toBe('conflict'); // still one at a time
    expect(await code(startCheck(db, ctx('eve'), { projectId: BOOK, seriesId: 'other', fileId: 'f4' }))).toBe('ok'); // another series' canon is another check
    expect(await code(startCheck(db, ctx('eve'), { projectId: BOOK, seriesId: SERIES, fileId: 'nope' }))).toBe('not-found');
    expect(await code(startCheck(db, ctx('eve'), { projectId: BOOK, seriesId: SERIES, fileId: 'f4', fileVersion: 9 }))).toBe('not-found');
  });
});

describe('a finding must quote a passage and cite canon', () => {
  it('raises findings in the strict form, numbered within the check', async () => {
    const k = await start();
    const { raised, skipped } = await raiseFindings(db, ctx('eve'), k.id, [finding('green eyes', [eyes]), finding('nine days since the battle of Harrow', [battle], { kind: 'timeline', severity: 'medium', confidence: 'low' })]);
    expect(skipped).toEqual([]);
    expect(raised.map((f) => [f.seq, f.kind, f.severity, f.confidence, f.anchor.quote, f.factIds])).toEqual([
      [1, 'contradiction', 'high', 'high', 'green eyes', [eyes]],
      [2, 'timeline', 'medium', 'low', 'nine days since the battle of Harrow', [battle]]
    ]);
    expect(raised[0]!.anchor.start).toBe(BOOK4.indexOf('green eyes'));
    expect((await raiseFindings(db, ctx('eve'), k.id, [finding('spell cost', [eyes])])).raised[0]!.seq).toBe(3);
  });

  it('refuses a finding with no passage, no cited fact, a made-up fact, a retired fact, or no severity or confidence; all or none', async () => {
    const k = await start();
    const bad = (o: object) => raiseFindings(db, ctx('eve'), k.id, [finding('green eyes', [eyes]), { ...finding('nine days', [eyes]), ...o } as NewFinding]);
    expect(await code(bad({ anchor: { quote: ' ', prefix: '', suffix: '', start: 0 } }))).toBe('invalid');
    expect(await code(bad({ anchor: undefined }))).toBe('invalid');
    expect(await code(bad({ factIds: [] }))).toBe('invalid');
    expect(await code(bad({ factIds: ['made-up'] }))).toBe('invalid');
    expect(await code(bad({ severity: 'huge' }))).toBe('invalid');
    expect(await code(bad({ confidence: undefined }))).toBe('invalid');
    expect(await code(bad({ body: '' }))).toBe('invalid');
    expect(await code(raiseFindings(db, ctx('eve'), k.id, []))).toBe('invalid');
    expect(await listFindings(db, ctx('x'), { checkId: k.id })).toEqual([]); // none of the batch went in
    // a fact that has been retired is no longer canon to cite
    await addCanon({ change: 'retire_fact', factId: eyes, reason: 'Changed' });
    expect(await code(raiseFindings(db, ctx('eve'), k.id, [finding('green eyes', [eyes])]))).toBe('invalid');
  });

  it('refuses a fact that belongs to another series', async () => {
    const k = await startCheck(db, ctx('eve'), { projectId: BOOK, seriesId: 'series2', fileId: 'f4' });
    expect(await code(raiseFindings(db, ctx('eve'), k.id, [finding('green eyes', [eyes])]))).toBe('invalid');
  });

  it('is raised only while the check is open', async () => {
    const k = await start();
    await raiseFindings(db, ctx('eve'), k.id, [finding('green eyes', [eyes])]);
    await deliverCheck(db, ctx('eve'), k.id);
    expect(await code(raiseFindings(db, ctx('eve'), k.id, [finding('spell cost', [eyes])]))).toBe('conflict');
    expect(await code(deliverCheck(db, ctx('eve'), k.id))).toBe('conflict');
  });
});

describe('a person decides every finding', () => {
  let checkId: string, f1: string, f2: string, f3: string;
  beforeEach(async () => {
    const k = await start();
    checkId = k.id;
    const { raised } = await raiseFindings(db, ctx('eve'), k.id, [finding('green eyes', [eyes]), finding('nine days since the battle of Harrow', [battle], { kind: 'timeline' }), finding('spell cost a year', [eyes], { kind: 'rule' })]);
    [f1, f2, f3] = raised.map((r) => r.id) as [string, string, string];
  });

  it('cannot be decided before the check is delivered, and a check cannot be closed with findings open', async () => {
    expect(await code(decideFinding(db, ctx('ann'), f1, { outcome: 'dismiss', reason: 'No' }))).toBe('conflict');
    expect(await code(closeCheck(db, ctx('ann'), checkId))).toBe('conflict'); // not delivered
    await deliverCheck(db, ctx('eve'), checkId);
    expect(await code(closeCheck(db, ctx('ann'), checkId))).toBe('blocked');
  });

  it('dismissing needs a reason and is final; the same finding is not raised again against the same manuscript', async () => {
    await deliverCheck(db, ctx('eve'), checkId);
    expect(await code(decideFinding(db, ctx('ann'), f1, { outcome: 'dismiss', reason: '  ' }))).toBe('invalid');
    const { finding: d } = await decideFinding(db, ctx('ann'), f1, { outcome: 'dismiss', reason: 'She changed eye colour on purpose.' });
    expect(d).toMatchObject({ state: 'dismissed', response: 'She changed eye colour on purpose.', decidedBy: 'ann' });
    expect(await code(decideFinding(db, ctx('ann'), f1, { outcome: 'dismiss', reason: 'again' }))).toBe('conflict');
    // finish this check, and re-check the same manuscript: the dismissed finding is skipped, a different one is raised
    await decideFinding(db, ctx('ann'), f2, { outcome: 'dismiss', reason: 'ok' });
    await decideFinding(db, ctx('ann'), f3, { outcome: 'dismiss', reason: 'ok' });
    await closeCheck(db, ctx('ann'), checkId);
    const again = await start();
    const r = await raiseFindings(db, ctx('eve'), again.id, [finding('green eyes', [eyes]), finding('walked to the ford', [eyes])]);
    expect(r.skipped).toEqual([{ index: 0, why: 'A person dismissed this finding for this manuscript.' }]);
    expect(r.raised.map((f) => f.anchor.quote)).toEqual(['walked to the ford']);
  });

  it('accepting the manuscript as right makes a canon proposal sourced from the passage; approving it makes the fact canon', async () => {
    await deliverCheck(db, ctx('eve'), checkId);
    const change = { change: 'supersede_fact', factId: eyes, text: 'Mara’s eyes are green.', source: { fileId: 'f4', version: 2, anchor: at(BOOK4, 'green eyes') }, bookProjectId: BOOK, chapter: 4 };
    const { finding: f, proposal } = await decideFinding(db, ctx('ann'), f1, { outcome: 'accept_as_canon', change, note: 'The first book was wrong.' });
    expect(f).toMatchObject({ state: 'accepted_as_canon', proposalId: proposal!.id, response: 'The first book was wrong.' });
    expect(proposal).toMatchObject({ state: 'open', findingId: f1, change: 'supersede_fact', proposedBy: 'ann' });
    expect((await getFact(db, ctx('x'), eyes))!.status).toBe('canon'); // nothing changes until the Series Lead approves
    await decideProposal(db, ctx('lea'), proposal!.id, { approve: true });
    expect((await getFact(db, ctx('x'), eyes))!.status).toBe('retired');
    const live = await listFacts(db, ctx('x'), { projectId: SERIES });
    expect(live.find((x) => /green/.test(x.text))).toMatchObject({ bookProjectId: BOOK, chapter: 4, source: { fileId: 'f4', version: 2, anchor: { quote: 'green eyes' } } });
    expect(await listProposals(db, ctx('x'), { projectId: SERIES, state: 'approved' })).toHaveLength(4); // three canon changes made at set-up, then this one
  });

  it('refuses to accept as canon with a change that does not fit, and leaves the finding open', async () => {
    await deliverCheck(db, ctx('eve'), checkId);
    expect(await code(decideFinding(db, ctx('ann'), f1, { outcome: 'accept_as_canon', change: { change: 'retire_fact', factId: 'made-up', reason: 'x' } }))).toBe('not-found');
    expect(await code(decideFinding(db, ctx('ann'), f1, { outcome: 'accept_as_canon', change: undefined }))).toBe('invalid');
    expect(await code(decideFinding(db, ctx('ann'), f1, { outcome: 'ponder' } as unknown as Parameters<typeof decideFinding>[3]))).toBe('invalid');
    expect((await listFindings(db, ctx('x'), { checkId, state: 'live' })).length).toBe(3);
  });

  it('a finding is fixed once a later version no longer has the passage; one still there stays open', async () => {
    const fixedText = BOOK4.replace('green eyes', 'grey eyes');
    await db.run("UPDATE vault_file SET current_version = 3 WHERE id = 'f4'");
    expect(await code(verifyFindings(db, ctx('eve'), checkId, { version: 2, text: fixedText }))).toBe('invalid'); // not a later version
    expect(await code(verifyFindings(db, ctx('eve'), checkId, { version: 4, text: fixedText }))).toBe('invalid'); // not a version there is
    const r = await verifyFindings(db, ctx('eve'), checkId, { version: 3, text: fixedText });
    expect(r.fixed.map((f) => [f.id, f.state, f.fixedInVersion])).toEqual([[f1, 'fixed', 3]]);
    expect(r.remaining.map((f) => f.id).sort()).toEqual([f2, f3].sort());
    expect(await findingCounts(db, ctx('x'), [checkId])).toEqual({ [checkId]: { open: 2, fixed: 1, accepted_as_canon: 0, dismissed: 0 } });
  });

  it('closes once every finding is decided, and nothing more can be done to it', async () => {
    await deliverCheck(db, ctx('eve'), checkId);
    for (const id of [f1, f2, f3]) await decideFinding(db, ctx('ann'), id, { outcome: 'dismiss', reason: 'Checked.' });
    const k = await closeCheck(db, ctx('ann'), checkId);
    expect(k).toMatchObject({ state: 'closed', closedBy: 'ann' });
    expect(await code(closeCheck(db, ctx('ann'), checkId))).toBe('conflict');
    expect(await code(verifyFindings(db, ctx('eve'), checkId, { version: 3, text: '' }))).toBe('conflict');
    expect((await getCheck(db, ctx('x'), checkId))!.state).toBe('closed');
  });
});
