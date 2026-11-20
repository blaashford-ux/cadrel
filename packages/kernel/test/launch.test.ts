import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES, NO_FACTS, WorkError, addDays, applyDateProposal, approvePlan, archiveTemplate, assignItem, cancelPlan, cleanTemplateItems, createPerson, createPlan, createTemplate, daysBetween,
  dateProposalsOf, ensureDefaultTemplates, getPlan, getTask, goLive, hashText, itemsOf, launchFactsOf, linkItemRequest, listPlans, listTemplates, markItem, planRevision, planView, proposeDate,
  rejectDateProposal, requirementMet, reviseTemplate, setTaskState, updatePlan, type Ctx, type Db, type PlanFacts
} from '../src';
import { memoryDb } from './sqlite';

let db: Db;
let clock = 0;
let ana: string;
let eve: string;
const at = (actor = 'ana'): Ctx => ({ studioId: 's1', actor, now: `2026-11-20T10:00:${String(clock++).padStart(2, '0')}Z` });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkError ? e.code : `other:${(e as Error).message}`));
const facts = (o: Partial<PlanFacts> = {}, today = '2026-11-20'): PlanFacts => ({ ...NO_FACTS(today), ...o });
const ebook = async () => (await listTemplates(db, at())).find((t) => t.key === 'ebook_launch')!;
const make = async (date = '2026-12-31') => createPlan(db, at(), { projectId: 'book', editionId: 'ed1', templateId: (await ebook()).id, releaseDate: date, assignees: { marketing: ana, art: eve } });
const view = async (planId: string, f = facts()) => (await planView(db, at(), planId, f))!;
const pairs = async (planId: string) => Promise.all((await itemsOf(db, planId)).map(async (item) => ({ item, task: (await getTask(db, at(), item.taskId))! })));

beforeEach(async () => {
  db = memoryDb();
  clock = 0;
  ana = (await createPerson(db, { studioId: 's1', actor: 'system', now: '2026-11-01T00:00:00Z' }, { name: 'Ana' })).id;
  eve = (await createPerson(db, { studioId: 's1', actor: 'system', now: '2026-11-01T00:00:00Z' }, { name: 'Eve' })).id;
  await ensureDefaultTemplates(db, at());
});

describe('dates and revisions', () => {
  it('adds days across months and years, and counts them', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2026-11-20', '2026-12-31')).toBe(41);
    expect(daysBetween('2026-12-31', '2026-11-20')).toBe(-41);
  });
  it('hashes the same text to the same revision and different text to another', () => {
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
    expect(hashText('')).toHaveLength(14);
  });
});

describe('release templates', () => {
  it('ships two, once, however often they are ensured; their items wait only for earlier items', async () => {
    await ensureDefaultTemplates(db, at());
    const all = await listTemplates(db, at());
    expect(all.map((t) => t.name)).toEqual(['Ebook launch', 'Series launch']);
    for (const t of DEFAULT_TEMPLATES) expect(() => cleanTemplateItems(t.items)).not.toThrow();
  });

  it('a revision is a new numbered version; a stale one or an unchanged one is refused; the old version stays readable', async () => {
    const t = await ebook();
    const items = [...t.items, { key: 'extra', title: 'Extra', offsetDays: -1, required: false }];
    const v2 = await reviseTemplate(db, at(), t.id, { items, basedOn: 1, note: 'One more.' });
    expect(v2).toMatchObject({ version: 2, note: 'One more.' });
    expect(await code(reviseTemplate(db, at(), t.id, { items, basedOn: 1 }))).toBe('conflict');
    expect(await code(reviseTemplate(db, at(), t.id, { items, basedOn: 2 }))).toBe('invalid');
    expect((await (await import('../src')).getTemplate(db, at(), t.id, 1))!.items.length).toBe(t.items.length);
  });

  it('checks what it is given: unique keys, whole-number offsets, dependencies that come earlier', async () => {
    const ok = { key: 'a', title: 'A', offsetDays: -3, required: true };
    expect(() => cleanTemplateItems([])).toThrow(/at least one/);
    expect(() => cleanTemplateItems([ok, ok])).toThrow(/Two items/);
    expect(() => cleanTemplateItems([{ ...ok, offsetDays: 1.5 }])).toThrow(/whole number/);
    expect(() => cleanTemplateItems([{ ...ok, dependsOn: ['b'] }, { ...ok, key: 'b' }])).toThrow(/earlier item/);
    expect(() => cleanTemplateItems([{ ...ok, key: 'Bad Key' }])).toThrow(/letters, digits/);
    expect(() => cleanTemplateItems([{ ...ok, requirement: { kind: 'telepathy' } as never }])).toThrow(/needs one of/);
    expect(await code(createTemplate(db, at(), { name: 'Ebook launch', items: [ok] }))).toBe('exists');
    const t = await createTemplate(db, at(), { name: 'Mine', items: [ok] });
    await archiveTemplate(db, at(), t.id);
    expect((await listTemplates(db, at())).map((x) => x.name)).not.toContain('Mine');
    expect(await code(createPlan(db, at(), { projectId: 'book', templateId: t.id, releaseDate: '2026-12-31' }))).toBe('not-found');
  });
});

describe('a plan worked backwards from its date', () => {
  it('makes a task for each item, due exactly that many days from the date, waiting on the tasks the template names, for the people given', async () => {
    const { plan, items } = await make('2026-12-31');
    const t = await ebook();
    expect(plan).toMatchObject({ state: 'draft', releaseDate: '2026-12-31', templateVersion: 1, name: 'Ebook launch, 2026-12-31' });
    expect(items).toHaveLength(t.items.length);
    const by = async (key: string) => (await pairs(plan.id)).find((p) => p.item.key === key)!.task;
    expect((await by('cover')).due).toBe(addDays('2026-12-31', -56));
    expect((await by('launch')).due).toBe('2026-12-31');
    expect((await by('review')).due).toBe('2027-01-30');
    expect((await by('launch')).kind).toBe('deadline');
    expect((await by('cover')).assigneeId).toBe(eve);
    expect((await by('arc')).assigneeId).toBe(ana);
    expect((await by('signoff')).assigneeId).toBeNull(); // nobody was named for "director"
    expect((await by('upload')).dependsOn).toEqual([(await by('preflight')).id]);
    expect((await by('launch')).dependsOn).toEqual([(await by('signoff')).id]);
  });

  it('refuses a bad date or a missing book', async () => {
    const t = await ebook();
    expect(await code(createPlan(db, at(), { projectId: 'book', templateId: t.id, releaseDate: '31 December' }))).toBe('invalid');
    expect(await code(createPlan(db, at(), { projectId: '', templateId: t.id, releaseDate: '2026-12-31' }))).toBe('invalid');
    expect(await code(createPlan(db, at(), { projectId: 'book', templateId: t.id, releaseDate: '2026-12-31', targets: { rank: 0 } }))).toBe('invalid');
    expect((await listPlans(db, at())).length).toBe(0);
  });

  it('plans can be listed by book and updated, and a cancelled one cancels its open tasks and cannot change', async () => {
    const { plan } = await make();
    expect((await listPlans(db, at(), { projectIds: ['book'] })).map((p) => p.id)).toEqual([plan.id]);
    expect(await listPlans(db, at(), { projectIds: ['other'] })).toEqual([]);
    expect((await updatePlan(db, at(), plan.id, { name: 'Book Four launch', targets: { rank: 5000, reviews: 25 } })).targets).toEqual({ rank: 5000, reviews: 25 });
    const its = await pairs(plan.id);
    await setTaskState(db, at(), its[0]!.task.id, 'done');
    await cancelPlan(db, at(), plan.id, 'Date dropped.');
    expect((await getPlan(db, at(), plan.id))!.state).toBe('cancelled');
    const after = await pairs(plan.id);
    expect(after.map((p) => p.task.state).sort()).toEqual(['cancelled', ...Array(after.length - 2).fill('cancelled'), 'done'].sort());
    expect(await code(updatePlan(db, at(), plan.id, { name: 'x' }))).toBe('conflict');
    expect(await listPlans(db, at())).toEqual([]);
    expect((await listPlans(db, at(), { state: 'any' })).length).toBe(1);
  });
});

describe('what is outstanding is computed from the records', () => {
  const status = (v: Awaited<ReturnType<typeof view>>, key: string) => v.items.find((i) => i.item.key === key)!;
  const DATE = '2027-03-31'; // far enough off that nothing is late yet

  it('with nothing yet, the cover is blocked and says why; the rest wait on it or on their own record', async () => {
    const { plan } = await make(DATE);
    const v = await view(plan.id);
    expect(status(v, 'cover')).toMatchObject({ status: 'blocked', reasons: ['The cover is not approved yet.'] });
    expect(status(v, 'arc').reasons).toEqual(['Waiting on: Cover approved.', '0 of 10 ARC readers have the file.']);
    expect(status(v, 'brief').reasons).toEqual(['There is no marketing brief yet.']);
    expect(status(v, 'upload')).toMatchObject({ status: 'blocked' });
    expect(v.outstanding.map((o) => o.item.key)).toContain('cover');
    expect(v.outstanding.map((o) => o.item.key)).not.toContain('newsletter'); // not required
    expect(v.daysToRelease).toBe(131);
  });

  it('an approved cover clears the cover item, and what waited on it, with no one marking anything; a Preflight error blocks until it is fixed', async () => {
    const { plan } = await make(DATE);
    let v = await view(plan.id, facts({ cover: { approved: true, licenceExpired: false } }));
    expect(status(v, 'cover').status).toBe('done');
    expect(status(v, 'arc').reasons).toEqual(['0 of 10 ARC readers have the file.']); // no longer waiting on the cover's task
    v = await view(plan.id, facts({ preflight: { checked: 1, openErrors: 2 } }));
    expect(status(v, 'preflight').reasons).toEqual(['Waiting on: Cover approved.', '2 Preflight errors are still open.']);
    v = await view(plan.id, facts({ cover: { approved: true, licenceExpired: false }, preflight: { checked: 1, openErrors: 0 } }));
    expect(status(v, 'preflight').status).toBe('done');
  });

  it('a task marked done whose requirement is not met is blocked, with the reason; an open item past its date is late', async () => {
    const { plan } = await make(DATE);
    const cover = (await pairs(plan.id)).find((p) => p.item.key === 'cover')!;
    await setTaskState(db, at(), cover.task.id, 'done');
    expect(status(await view(plan.id), 'cover')).toMatchObject({ status: 'blocked', reasons: ['Marked done, but the cover is not approved yet.'] });
    const late = await view(plan.id, facts({}, '2027-02-09')); // the brief was due 2027-01-30
    expect(status(late, 'brief')).toMatchObject({ status: 'late', daysLate: 10 });
    expect(status(late, 'brief').reasons).toEqual(['There is no marketing brief yet.']);
    expect(status(late, 'cover')).toMatchObject({ status: 'late', reasons: ['Marked done, but the cover is not approved yet.'] }); // due 2027-02-03: marked done, its record says no
  });

  it('requests, sign-offs, briefs and ARC readers each count, and a manual item is done when its task is', async () => {
    const { plan } = await make(DATE);
    await linkItemRequest(db, at(), plan.id, 'art', 'req1');
    expect(await code(linkItemRequest(db, at(), plan.id, 'cover', 'req1'))).toBe('invalid');
    const f = facts({ requests: { req1: { fulfilled: false, title: 'Banner for the preorder' } }, approvals: ['Ready to publish'], briefs: ['launch'], arcSent: 12 });
    let v = await view(plan.id, f);
    expect(status(v, 'art').reasons).toEqual(['“Banner for the preorder” has not been delivered and approved.']); // the brief it waits for is done by the record
    expect(status(v, 'signoff').status).toBe('done'); // the sign-off exists
    expect(status(v, 'launch')).toMatchObject({ status: 'outstanding', reasons: [] }); // it waited for the sign-off's task; the sign-off exists, so it is free
    expect(status(v, 'brief').status).toBe('done');
    expect(status(v, 'arc').status).toBe('done'); // twelve readers have the file; the record is what counts
    v = await view(plan.id, { ...f, requests: { req1: { fulfilled: true, title: 'Banner for the preorder' } } });
    expect(status(v, 'art').status).toBe('done');
    // a manual item: done when its task is, and then not outstanding
    const pre = (await pairs(plan.id)).find((p) => p.item.key === 'preflight')!;
    await setTaskState(db, at(), pre.task.id, 'done');
    const ready = facts({ cover: { approved: true, licenceExpired: false }, preflight: { checked: 1, openErrors: 0 } });
    expect(status(await view(plan.id, ready), 'upload').status).toBe('outstanding');
    await markItem(db, at(), plan.id, 'upload', true);
    expect(status(await view(plan.id, ready), 'upload').status).toBe('done');
    expect((await view(plan.id, ready)).outstanding.map((o) => o.item.key)).not.toContain('upload');
    await markItem(db, at(), plan.id, 'upload', false);
    expect(status(await view(plan.id, ready), 'upload').status).toBe('outstanding');
  });

  it('judges each requirement on its own, and counts what a gate asks', async () => {
    expect(requirementMet({ kind: 'approval', label: 'ready to publish' }, facts({ approvals: ['Ready to publish'] })).met).toBe(true);
    expect(requirementMet({ kind: 'preflight_clear' }, facts()).missing).toMatch(/not been through Preflight/);
    expect(requirementMet({ kind: 'arc', minReaders: 3 }, facts({ arcSent: 2 })).missing).toBe('2 of 3 ARC readers have the file.');
    expect(requirementMet({ kind: 'manual' }, facts())).toEqual({ met: false, missing: '' });
    const { plan } = await make(DATE);
    const late = await view(plan.id, facts({}, '2027-02-09'));
    const g = launchFactsOf([late]);
    expect(g.plans).toBe(1);
    expect(g.late).toBeGreaterThan(0);
    const early = launchFactsOf([await view(plan.id)]);
    expect(early.late).toBe(0);
    expect(early.blocked).toBeGreaterThan(0);
  });
});

describe('moving the release date', () => {
  it('proposes new dates for open items and changes nothing until it is applied; done items keep theirs', async () => {
    const { plan } = await make('2026-12-31');
    const its = await pairs(plan.id);
    const brief = its.find((p) => p.item.key === 'brief')!;
    await setTaskState(db, at(), brief.task.id, 'done');
    const p = await proposeDate(db, at(), plan.id, '2027-01-14', 'The cover is late.');
    expect(p).toMatchObject({ state: 'open', fromDate: '2026-12-31', newDate: '2027-01-14', reason: 'The cover is late.' });
    expect(p.changes.find((c) => c.key === 'brief')).toBeUndefined(); // done
    expect(p.changes.find((c) => c.key === 'cover')).toMatchObject({ from: '2026-11-05', to: '2026-11-19', past: true, beforeDependency: null });
    expect(p.changes.find((c) => c.key === 'launch')).toMatchObject({ from: '2026-12-31', to: '2027-01-14', past: false });
    expect((await getPlan(db, at(), plan.id))!.releaseDate).toBe('2026-12-31'); // a proposal changes nothing
    expect((await getTask(db, at(), brief.task.id))!.due).toBe('2026-11-01');
    expect(await code(proposeDate(db, at(), plan.id, '2027-02-01'))).toBe('exists'); // one at a time
    const done = await applyDateProposal(db, at(), p.id);
    expect(done.plan.releaseDate).toBe('2027-01-14');
    expect((await getTask(db, at(), brief.task.id))!.due).toBe('2026-11-01'); // done: kept
    expect((await getTask(db, at(), its.find((x) => x.item.key === 'launch')!.task.id))!.due).toBe('2027-01-14');
    expect(await code(applyDateProposal(db, at(), p.id))).toBe('conflict');
    expect((await dateProposalsOf(db, at(), plan.id)).map((x) => x.state)).toEqual(['applied']);
  });

  it('a rejection needs a reason and moves nothing; the same day or a bad day is refused; applying an approved plan sends it back for approval', async () => {
    const { plan } = await make('2026-12-31');
    expect(await code(proposeDate(db, at(), plan.id, '2026-12-31'))).toBe('invalid');
    expect(await code(proposeDate(db, at(), plan.id, 'soon'))).toBe('invalid');
    const p = await proposeDate(db, at(), plan.id, '2027-01-07');
    expect(await code(rejectDateProposal(db, at(), p.id, ' '))).toBe('invalid');
    await rejectDateProposal(db, at(), p.id, 'Holding the date.');
    expect((await getPlan(db, at(), plan.id))!.releaseDate).toBe('2026-12-31');
    await approvePlan(db, at('dir'), plan.id, planRevision(plan, await pairs(plan.id)), await pairs(plan.id));
    const q = await proposeDate(db, at(), plan.id, '2027-01-07');
    const applied = await applyDateProposal(db, at(), q.id);
    expect(applied.plan.state).toBe('draft');
    expect(applied.plan.approvedRevision).not.toBeNull(); // the old approval is on record, and now differs
    const v = await view(plan.id);
    expect(v.changedSinceApproval).toBe(true);
  });

  it('flags a date that falls before something an item waits for (odd offsets in a template)', async () => {
    const t = await createTemplate(db, at(), { name: 'Odd', items: [{ key: 'a', title: 'A', offsetDays: -5, required: true }, { key: 'b', title: 'B', offsetDays: -9, required: true, dependsOn: ['a'] }] });
    const { plan } = await createPlan(db, at(), { projectId: 'book', templateId: t.id, releaseDate: '2026-12-31' });
    const p = await proposeDate(db, at(), plan.id, '2027-01-31');
    expect(p.changes.find((c) => c.key === 'b')).toMatchObject({ beforeDependency: 'A' });
  });
});

describe('approval of an exact revision, and the release', () => {
  it('approves the revision it was shown; a plan changed since is refused, then approved again; going live needs an approved, unchanged plan', async () => {
    const { plan } = await make('2026-12-31');
    expect(await code(goLive(db, at(), plan.id, await pairs(plan.id)))).toBe('conflict'); // not approved
    const shown = planRevision(plan, await pairs(plan.id));
    const [first] = await pairs(plan.id);
    await assignItem(db, at(), plan.id, first!.item.key, eve); // assignment is not part of the revision: dates, requirements and who is required are
    expect(planRevision(plan, await pairs(plan.id))).toBe(shown);
    const approved = await approvePlan(db, at('dir'), plan.id, shown, await pairs(plan.id));
    expect(approved).toMatchObject({ state: 'approved', approvedBy: 'dir', approvedRevision: shown });
    expect((await view(plan.id)).changedSinceApproval).toBe(false);
    // someone changes a date after approval
    const cover = (await pairs(plan.id)).find((p) => p.item.key === 'cover')!;
    await (await import('../src')).updateTask(db, at(), cover.task.id, { due: '2026-11-25' });
    expect((await view(plan.id)).changedSinceApproval).toBe(true);
    expect(await code(goLive(db, at(), plan.id, await pairs(plan.id)))).toBe('conflict');
    expect(await code(approvePlan(db, at('dir'), plan.id, shown, await pairs(plan.id)))).toBe('conflict'); // approving what they saw before
    const now = planRevision(plan, await pairs(plan.id));
    await approvePlan(db, at('dir'), plan.id, now, await pairs(plan.id));
    expect((await goLive(db, at(), plan.id, await pairs(plan.id))).state).toBe('live');
    expect((await goLive(db, at(), plan.id, await pairs(plan.id))).state).toBe('live'); // idempotent
    expect(await code(cancelPlan(db, at(), plan.id, ''))).toBe('invalid');
  });
});
