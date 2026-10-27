import { beforeEach, describe, expect, it } from 'vitest';
import {
  MDEDIT_STAGES, WorkflowError, newStageKey, addEdition, bootstrapStudio, createBook, createRole, createSeries, createWorkflow, defaultWorkflow, deleteRole, deleteWorkflow, ensureDefaultWorkflow, getBook, grantRole,
  listWorkflows, saveWorkflow, setBookStage, setDefaultWorkflow, stageOptions, unmetConditions, updateBook, type Ctx, type WorkflowDraft, type WorkflowRecord
} from '../src/index';
import type { Db } from '../src/vault';
import { memoryDb } from './sqlite';

let db: Db;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ studioId: 's1', actor: 'ana', now: '2026-10-27T10:00:00.000Z', ...over });
beforeEach(async () => {
  db = memoryDb();
  await ensureDefaultWorkflow(db, ctx());
});
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof WorkflowError ? e.code : `other:${(e as Error).message}`));
const anyone = () => true;
const nobody = () => false;
/** A draft that keeps a workflow as it is. */
const asDraft = (w: WorkflowRecord): WorkflowDraft => ({ name: w.name, description: w.description, stages: w.stages.map((s) => ({ key: s.key, name: s.name, category: s.category, color: s.color })), transitions: w.transitions });

describe('the shipped default', () => {
  it('is MDEdit’s stages in its order, with every move open, and is the default', async () => {
    const [w] = await listWorkflows(db, ctx());
    expect(w).toMatchObject({ name: 'Writing and publishing', isDefault: true, templateKey: 'mdedit', books: 0 });
    expect(w!.stages.map((s) => [s.key, s.name])).toEqual([['planning', 'Planning'], ['drafting', 'Drafting'], ['revising', 'Revising'], ['editing', 'Editing'], ['published', 'Published'], ['paused', 'On hold']]);
    expect(w!.stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(w!.transitions).toHaveLength(30); // each of six stages to the five others
    expect(w!.transitions.every((t) => t.roleIds.length === 0 && t.conditions.length === 0)).toBe(true);
    expect((await defaultWorkflow(db, ctx()))!.id).toBe(w!.id);
    expect(MDEDIT_STAGES.map((s) => s.key)).toEqual(w!.stages.map((s) => s.key));
  });

  it('is made once: asking again does nothing, and a studio that deleted or replaced it does not get it back', async () => {
    expect(await ensureDefaultWorkflow(db, ctx())).toBe(false);
    const mine = await createWorkflow(db, ctx(), { name: 'Mine' });
    await setDefaultWorkflow(db, ctx(), mine.id);
    const old = (await listWorkflows(db, ctx())).find((w) => w.templateKey === 'mdedit')!;
    await deleteWorkflow(db, ctx(), old.id);
    expect(await ensureDefaultWorkflow(db, ctx())).toBe(false);
    expect((await listWorkflows(db, ctx())).map((w) => w.name)).toEqual(['Mine']);
  });

  it('starts a new book at the first stage of the default, and a book keeps its workflow when the default changes', async () => {
    const b = await createBook(db, ctx(), { title: 'Landfall' });
    expect(b).toMatchObject({ stage: 'planning', workflowId: 'workflow_default' });
    const other = await createWorkflow(db, ctx(), { name: 'Short run', copyFrom: 'workflow_default' });
    await setDefaultWorkflow(db, ctx(), other.id);
    expect((await createBook(db, ctx(), { title: 'Second' })).workflowId).toBe(other.id);
    expect((await getBook(db, ctx(), b.id))!.workflowId).toBe('workflow_default');
    expect((await listWorkflows(db, ctx())).find((w) => w.id === 'workflow_default')!.books).toBe(1);
  });
});

describe('building workflows', () => {
  it('makes a blank one with a single stage, or a copy, never the default until chosen, with unique names', async () => {
    const blank = await createWorkflow(db, ctx(), { name: 'Audio', description: 'Narration' });
    expect(blank).toMatchObject({ isDefault: false, templateKey: null, stages: [{ key: 'start', name: 'Start', category: 'start' }], transitions: [] });
    const copy = await createWorkflow(db, ctx(), { name: 'Copy', copyFrom: 'workflow_default' });
    expect(copy.stages).toHaveLength(6);
    expect(copy.transitions).toHaveLength(30);
    expect(await code(createWorkflow(db, ctx(), { name: 'audio' }))).toBe('exists');
    expect(await code(createWorkflow(db, ctx(), { name: ' ' }))).toBe('invalid');
    expect(await code(createWorkflow(db, ctx(), { name: 'X', copyFrom: 'nope' }))).toBe('not-found');
    expect((await listWorkflows(db, ctx())).filter((w) => w.isDefault)).toHaveLength(1);
  });

  it('keeps exactly one default, and refuses to delete it or a workflow with books in it', async () => {
    const a = await createWorkflow(db, ctx(), { name: 'A' });
    await setDefaultWorkflow(db, ctx(), a.id);
    expect((await listWorkflows(db, ctx())).filter((w) => w.isDefault).map((w) => w.name)).toEqual(['A']);
    expect(await code(deleteWorkflow(db, ctx(), a.id))).toBe('conflict');
    await createBook(db, ctx(), { title: 'In A' });
    await setDefaultWorkflow(db, ctx(), 'workflow_default');
    expect(await code(deleteWorkflow(db, ctx(), a.id))).toBe('conflict'); // a book is in it
    const empty = await createWorkflow(db, ctx(), { name: 'Empty' });
    await deleteWorkflow(db, ctx(), empty.id);
    expect(await db.all('SELECT 1 FROM workflow_stage WHERE workflow_id = ?', [empty.id])).toEqual([]);
    expect(await code(setDefaultWorkflow(db, ctx(), 'nope'))).toBe('not-found');
  });

  it('saves a whole definition: new stages get keys from their names, existing keys are kept, renaming and reordering move no book', async () => {
    const book = await createBook(db, ctx(), { title: 'Landfall' });
    const w = (await defaultWorkflow(db, ctx()))!;
    const draft = asDraft(w);
    draft.stages = [{ key: 'planning', name: 'Concept' }, { name: 'Proof reading', category: 'review', color: '#aabbcc' }, ...draft.stages.slice(1)];
    draft.transitions = [...w.transitions, { from: 'planning', to: 'proof-reading' }, { from: 'proof-reading', to: 'drafting' }];
    const saved = await saveWorkflow(db, ctx(), w.id, draft);
    expect(saved.stages.map((s) => [s.key, s.name])).toEqual([['planning', 'Concept'], ['proof-reading', 'Proof reading'], ['drafting', 'Drafting'], ['revising', 'Revising'], ['editing', 'Editing'], ['published', 'Published'], ['paused', 'On hold']]);
    expect(saved.stages[1]).toMatchObject({ category: 'review', color: '#aabbcc', position: 1 });
    expect((await getBook(db, ctx(), book.id))!.stage).toBe('planning'); // still the same stage, now called Concept
    // a second stage with the same name gets a different key
    const again = await saveWorkflow(db, ctx(), w.id, { ...asDraft(saved), stages: [...asDraft(saved).stages, { name: 'Proof-reading' }].slice(0, 7) });
    expect(again.stages).toHaveLength(7);
  });

  it('lets a new stage bring its own key, so a move can name it in the same save, and gives clashing names different keys', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const d = asDraft(w);
    const saved = await saveWorkflow(db, ctx(), w.id, { ...d, stages: [...d.stages, { key: 'proof', name: 'Proofing' }, { name: 'Drafting 2' }], transitions: [...d.transitions, { from: 'editing', to: 'proof' }] });
    expect(saved.stages.map((s) => s.key).slice(-2)).toEqual(['proof', 'drafting-2']);
    expect(saved.transitions.some((t) => t.from === 'editing' && t.to === 'proof')).toBe(true);
    expect(newStageKey('Drafting', ['drafting', 'drafting-2'])).toBe('drafting-3');
    expect(newStageKey('  ', [])).toBe('stage');
  });

  it('validates a draft: names, keys, moves, colours, categories and sizes', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const d = asDraft(w);
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [...d.stages, { name: 'drafting' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [{ key: 'Not A Key', name: 'Ghost' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, transitions: [{ from: 'planning', to: 'nowhere' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, transitions: [{ from: 'planning', to: 'planning' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, transitions: [{ from: 'planning', to: 'drafting' }, { from: 'planning', to: 'drafting' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [{ key: 'planning', name: 'A', color: 'red' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: [{ key: 'planning', name: 'A', category: 'nope' }] }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, stages: Array.from({ length: 31 }, (_, i) => ({ name: `S${i}` })) }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...d, name: '' }))).toBe('invalid');
    expect(await code(saveWorkflow(db, ctx(), 'nope', d))).toBe('not-found');
    const other = await createWorkflow(db, ctx(), { name: 'Other' });
    expect(await code(saveWorkflow(db, ctx(), other.id, { ...asDraft(other), name: 'Writing and publishing' }))).toBe('exists');
    expect((await defaultWorkflow(db, ctx()))!.stages).toHaveLength(6); // a refused save changed nothing
  });

  it('removing a stage that has books needs a stage to move them to, and does move them', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    const b = await createBook(db, ctx(), { title: 'Landfall' }); // in planning
    const without = { ...asDraft(w), stages: asDraft(w).stages.filter((s) => s.key !== 'planning'), transitions: w.transitions.filter((t) => t.from !== 'planning' && t.to !== 'planning') };
    expect(await code(saveWorkflow(db, ctx(), w.id, without))).toBe('conflict');
    expect(await code(saveWorkflow(db, ctx(), w.id, { ...without, moveBooks: { planning: 'nowhere' } }))).toBe('invalid');
    await saveWorkflow(db, ctx(), w.id, { ...without, moveBooks: { planning: 'drafting' } });
    expect((await getBook(db, ctx(), b.id))!.stage).toBe('drafting');
    expect((await defaultWorkflow(db, ctx()))!.stages.map((s) => s.key)).not.toContain('planning');
  });

  it('keeps a gate’s roles and conditions, validates them, and one saved workflow does not touch another', async () => {
    const role = await createRole(db, ctx(), { name: 'Series Lead', capabilities: ['catalogue.read'] });
    const a = await createWorkflow(db, ctx(), { name: 'A', copyFrom: 'workflow_default' });
    const b = await createWorkflow(db, ctx(), { name: 'B', copyFrom: 'workflow_default' });
    const d = asDraft(a);
    d.transitions = d.transitions.map((t) => (t.from === 'editing' && t.to === 'published' ? { ...t, roleIds: [role.id], conditions: [{ kind: 'asin' as const }, { kind: 'published_date' as const, format: 'ebook' }, { kind: 'asin' as const }] } : t));
    const saved = await saveWorkflow(db, ctx(), a.id, d);
    const gate = saved.transitions.find((t) => t.from === 'editing' && t.to === 'published')!;
    expect(gate.roleIds).toEqual([role.id]);
    expect(gate.conditions).toEqual([{ kind: 'asin' }, { kind: 'published_date', format: 'ebook' }]); // the repeat was dropped
    expect((await listWorkflows(db, ctx())).find((w) => w.id === b.id)!.transitions.find((t) => t.from === 'editing' && t.to === 'published')).toMatchObject({ roleIds: [], conditions: [] });
    const bad = (conditions: unknown, roleIds: string[] = []) => code(saveWorkflow(db, ctx(), a.id, { ...d, transitions: [{ from: 'editing', to: 'published', roleIds, conditions: conditions as never }] }));
    expect(await bad([{ kind: 'vibes' }])).toBe('invalid');
    expect(await bad([{ kind: 'series', format: 'ebook' }])).toBe('invalid');
    expect(await bad([{ kind: 'asin', format: 'vinyl' }])).toBe('invalid');
    expect(await bad('asin')).toBe('invalid');
    expect(await bad([], ['no-such-role'])).toBe('not-found');
    expect(await bad([{ kind: 'constructor' }])).toBe('invalid');
  });

  it('a role a gate names is replaced, not dropped, when the role is deleted (dropping it would open the gate to everyone)', async () => {
    const lead = await createRole(db, ctx(), { name: 'Lead', capabilities: ['catalogue.read'] });
    const other = await createRole(db, ctx(), { name: 'Other', capabilities: ['catalogue.read'] });
    const w = (await defaultWorkflow(db, ctx()))!;
    await saveWorkflow(db, ctx(), w.id, { ...asDraft(w), transitions: w.transitions.map((t) => (t.to === 'published' ? { ...t, roleIds: [lead.id] } : t)) });
    await expect(deleteRole(db, ctx(), lead.id)).rejects.toThrow(/named in 5 workflow gates/);
    await deleteRole(db, ctx(), lead.id, other.id);
    const after = (await defaultWorkflow(db, ctx()))!;
    expect(after.transitions.filter((t) => t.to === 'published').every((t) => t.roleIds.length === 1 && t.roleIds[0] === other.id)).toBe(true);
  });
});

describe('moving a book through its stages', () => {
  it('moves freely in the shipped workflow, as MDEdit did, and records each move', async () => {
    const b = await createBook(db, ctx(), { title: 'Landfall' });
    expect(await setBookStage(db, ctx({ actor: 'bo' }), b.id, 'drafting', anyone)).toMatchObject({ from: 'planning', to: 'drafting' });
    await setBookStage(db, ctx(), b.id, 'published', anyone);
    await setBookStage(db, ctx(), b.id, 'planning', anyone); // backwards is fine too
    expect((await getBook(db, ctx(), b.id))!.stage).toBe('planning');
    const log = await db.all<{ actor: string; detail: string }>("SELECT actor, detail FROM audit WHERE action = 'catalogue.book.stage' ORDER BY id");
    expect(log).toHaveLength(3);
    expect(log[0]!.actor).toBe('bo');
    expect(JSON.parse(log[0]!.detail)).toMatchObject({ from: 'planning', to: 'drafting' });
    expect(await code(setBookStage(db, ctx(), b.id, 'planning', anyone))).toBe('invalid'); // already there
    expect(await code(setBookStage(db, ctx(), b.id, 'nowhere', anyone))).toBe('gated');
    expect(await code(setBookStage(db, ctx(), 'nope', 'drafting', anyone))).toBe('not-found');
  });

  it('refuses a move the workflow does not have, and one whose gate is closed, saying every reason', async () => {
    const w = (await defaultWorkflow(db, ctx()))!;
    await saveWorkflow(db, ctx(), w.id, {
      ...asDraft(w),
      transitions: [
        { from: 'planning', to: 'drafting' }, { from: 'drafting', to: 'editing' },
        { from: 'editing', to: 'published', conditions: [{ kind: 'edition' }, { kind: 'asin', format: 'ebook' }, { kind: 'series' }, { kind: 'pen_name' }] }
      ]
    });
    const b = await createBook(db, ctx(), { title: 'Landfall' });
    await expect(setBookStage(db, ctx(), b.id, 'published', anyone)).rejects.toThrow(/no move from Planning to Published/);
    await setBookStage(db, ctx(), b.id, 'drafting', anyone);
    await setBookStage(db, ctx(), b.id, 'editing', anyone);
    const err = await setBookStage(db, ctx(), b.id, 'published', anyone).then(() => null, (e) => e as WorkflowError);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err!.code).toBe('gated');
    expect(err!.reasons).toEqual(['The book has at least one edition', 'An edition has an ASIN on the ebook edition', 'The book is in a series', 'The book has a pen name']);
    expect(err!.message).toMatch(/Published is not open yet/);
    // meeting them one by one opens the gate
    const s = await createSeries(db, ctx(), { name: 'Salt Road' });
    const b2 = await createBook(db, ctx(), { title: 'Tidewater', seriesId: s.id, penName: 'A. Reyes' });
    await setBookStage(db, ctx(), b2.id, 'drafting', anyone);
    await setBookStage(db, ctx(), b2.id, 'editing', anyone);
    await addEdition(db, ctx(), b2.id, { format: 'paperback', asin: 'B0AAAAAAA1' });
    await expect(setBookStage(db, ctx(), b2.id, 'published', anyone)).rejects.toThrow(/ASIN on the ebook edition/); // the paperback's ASIN is not the ebook's
    await addEdition(db, ctx(), b2.id, { format: 'ebook', asin: 'B0BBBBBBB2' });
    await setBookStage(db, ctx(), b2.id, 'published', anyone);
    expect((await getBook(db, ctx(), b2.id))!.stage).toBe('published');
  });

  it('lets only the roles a gate names make the move, and says so in the options', async () => {
    const role = await createRole(db, ctx(), { name: 'Series Lead', capabilities: ['catalogue.read'] });
    const w = (await defaultWorkflow(db, ctx()))!;
    await saveWorkflow(db, ctx(), w.id, { ...asDraft(w), transitions: w.transitions.map((t) => (t.from === 'editing' && t.to === 'published' ? { ...t, roleIds: [role.id] } : t)) });
    const b = await createBook(db, ctx(), { title: 'Landfall' });
    await setBookStage(db, ctx(), b.id, 'editing', anyone);
    const asOther = await stageOptions(db, ctx(), b.id, nobody);
    expect(asOther.current).toMatchObject({ key: 'editing', name: 'Editing' });
    expect(asOther.options.find((o) => o.key === 'published')).toMatchObject({ allowed: false, reasons: ['Only people with certain roles can make this move'] });
    expect(asOther.options.find((o) => o.key === 'revising')!.allowed).toBe(true);
    expect(await code(setBookStage(db, ctx(), b.id, 'published', nobody))).toBe('gated');
    expect((await stageOptions(db, ctx(), b.id, (ids) => ids.includes(role.id))).options.find((o) => o.key === 'published')!.allowed).toBe(true);
    await setBookStage(db, ctx(), b.id, 'published', (ids) => ids.includes(role.id));
  });

  it('cannot be walked around: changing a book’s details leaves its stage alone, and an archived book cannot move', async () => {
    const b = await createBook(db, ctx(), { title: 'Landfall' });
    await updateBook(db, ctx(), b.id, { title: 'Landfall II', stage: 'published' } as never);
    expect((await getBook(db, ctx(), b.id))!.stage).toBe('planning');
    await db.run('UPDATE book SET archived_at = ? WHERE id = ?', ['2026-10-28T00:00:00.000Z', b.id]);
    expect(await code(setBookStage(db, ctx(), b.id, 'drafting', anyone))).toBe('conflict');
  });

  it('checks conditions the same way whatever the gate: pure and in words', () => {
    const book = { seriesId: null, penName: '  ', editions: [{ format: 'ebook', asin: 'B0AAAAAAA1', isbn: null, publishedOn: null }] };
    expect(unmetConditions(book, [])).toEqual([]);
    expect(unmetConditions(book, [{ kind: 'asin' }, { kind: 'edition', format: 'ebook' }])).toEqual([]);
    expect(unmetConditions(book, [{ kind: 'isbn' }, { kind: 'published_date' }, { kind: 'series' }, { kind: 'pen_name' }, { kind: 'edition', format: 'audiobook' }])).toEqual([
      'An edition has an ISBN', 'An edition has a publication date', 'The book is in a series', 'The book has a pen name', 'The book has at least one edition on the audiobook edition'
    ]);
  });

  it('keeps one studio’s workflows from another’s', async () => {
    const other = ctx({ studioId: 's2' });
    expect(await listWorkflows(db, other)).toEqual([]);
    expect(await code(saveWorkflow(db, other, 'workflow_default', { name: 'Hijack', stages: [{ name: 'X' }], transitions: [] }))).toBe('not-found');
    expect(await code(setDefaultWorkflow(db, other, 'workflow_default'))).toBe('not-found');
    expect(await code(deleteWorkflow(db, other, 'workflow_default'))).toBe('not-found');
    expect(await createBook(db, other, { title: 'Theirs' })).toMatchObject({ workflowId: null, stage: 'planning' });
    void bootstrapStudio;
    void grantRole;
  });
});
