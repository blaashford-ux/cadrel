import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, bootstrapStudio, defaultRole, type Ctx, type WorkflowDraft } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
const STUDIO = { kind: 'studio' as const, id: S };
const NOW = () => new Date('2026-10-27T10:00:00.000Z');
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied); // any other error means the permission check passed

async function studio() {
  const db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  const svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  const ana = svc.as('ana');
  const person = async (name: string, roleId: string) => {
    const p = await ana.people.create({ name });
    await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId, scope: STUDIO });
    return p.id;
  };
  return { db, svc, ana, person };
}

describe('the workflow builder behind the permission check', () => {
  it.each(ROLE_KEYS)('%s: may build workflows only if its role holds workflow.design, and anyone who reads the catalogue can see them', async (key) => {
    const { svc, ana, person } = await studio();
    const id = key === 'owner' ? 'ana' : await person(`P-${key}`, `role_${key}`);
    const me = svc.as(id).workflows;
    const caps = new Set(defaultRole(key).capabilities);
    const design = key === 'owner' || caps.has('workflow.design');
    const read = key === 'owner' || caps.has('catalogue.read');
    expect(await denied(me.list()), 'read').toBe(!read);
    const draft = async (): Promise<WorkflowDraft> => { const w = (await ana.workflows.list())[0]!; return { name: w.name, stages: w.stages, transitions: w.transitions }; };
    expect(await denied(me.create({ name: `w-${key}` })), 'create').toBe(!design);
    expect(await denied(me.save((await ana.workflows.list())[0]!.id, await draft())), 'save').toBe(!design);
    expect(await denied(me.setDefault((await ana.workflows.list())[0]!.id)), 'default').toBe(!design);
    expect(await denied(me.delete('nope')), 'delete').toBe(!design);
  });

  it('a new studio has the MDEdit workflow as its default, and a book made through the service starts in it', async () => {
    const { ana } = await studio();
    const [w] = await ana.workflows.list();
    expect(w).toMatchObject({ isDefault: true, name: 'Writing and publishing' });
    const book = await ana.catalogue.createBook({ title: 'Landfall' });
    expect(book).toMatchObject({ stage: 'planning', workflowId: w!.id });
    const { options, current } = await ana.catalogue.stageOptions(book.id);
    expect(current).toMatchObject({ key: 'planning' });
    expect(options.map((o) => o.name)).toEqual(['Drafting', 'Revising', 'Editing', 'Published', 'On hold']);
    expect(options.every((o) => o.allowed)).toBe(true);
  });

  it('the roles a gate names are the roles this person holds: held directly or through a team, and an Owner holds them all', async () => {
    const { svc, ana, person } = await studio();
    const w = (await ana.workflows.list())[0]!;
    await ana.workflows.save(w.id, { name: w.name, stages: w.stages, transitions: w.transitions.map((t) => (t.to === 'published' ? { ...t, roleIds: ['role_series_lead'] } : t)) });
    const book = await ana.catalogue.createBook({ title: 'Landfall' });
    const author = await person('Author', 'role_author'); // may read the catalogue but not edit it
    const lead = await person('Lead', 'role_series_lead'); // may edit; holds the gate's role
    const editor = await ana.people.create({ name: 'Ed' });
    await ana.people.grant({ subject: { kind: 'person', id: editor.id }, roleId: 'role_series_lead', scope: { kind: 'project', id: 'book-1' } }); // a role on one book is not the studio's
    const t = await ana.people.createTeam('Leads');
    await ana.people.grant({ subject: { kind: 'team', id: t.id }, roleId: 'role_series_lead', scope: STUDIO });
    const viaTeam = await person('Via team', 'role_editor');
    await ana.people.setTeamMember(t.id, viaTeam, true);
    expect(await denied(svc.as(author).catalogue.setStage(book.id, 'drafting'))).toBe(true); // no catalogue.edit
    expect((await svc.as(author).catalogue.stageOptions(book.id)).options.find((o) => o.key === 'published')).toMatchObject({ allowed: false, reasons: ['Only people with certain roles can make this move'] });
    expect((await svc.as(lead).catalogue.stageOptions(book.id)).options.find((o) => o.key === 'published')!.allowed).toBe(true);
    expect((await svc.as('ana').catalogue.stageOptions(book.id)).options.find((o) => o.key === 'published')!.allowed).toBe(true); // Owner
    expect(await svc.as(lead).catalogue.setStage(book.id, 'published')).toMatchObject({ from: 'planning', to: 'published' });
    expect((await svc.as(lead).catalogue.book(book.id))!.stage).toBe('published');
    // through a team: the Editor role alone cannot edit, but the team's Series Lead role can, and it is also the gate's role
    const second = await ana.catalogue.createBook({ title: 'Tidewater' });
    expect(await svc.as(viaTeam).catalogue.setStage(second.id, 'published')).toMatchObject({ to: 'published' });
    // a Series Lead on one book only does not hold the role at the studio, so it opens no studio-wide gate
    expect(await denied(svc.as(editor.id).catalogue.stageOptions(second.id))).toBe(true);
  });

  it('a gate that is not open says why through the service, and a refused move changes nothing', async () => {
    const { ana, db } = await studio();
    const w = (await ana.workflows.list())[0]!;
    await ana.workflows.save(w.id, { name: w.name, stages: w.stages, transitions: w.transitions.map((t) => (t.to === 'published' ? { ...t, conditions: [{ kind: 'asin' as const }] } : t)) });
    const book = await ana.catalogue.createBook({ title: 'Landfall' });
    await expect(ana.catalogue.setStage(book.id, 'published')).rejects.toThrow(/An edition has an ASIN/);
    expect((await ana.catalogue.book(book.id))!.stage).toBe('planning');
    expect(await db.all("SELECT 1 FROM audit WHERE action = 'catalogue.book.stage'")).toEqual([]);
    await ana.catalogue.addEdition(book.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    await ana.catalogue.setStage(book.id, 'published');
    expect((await ana.catalogue.book(book.id))!.stage).toBe('published');
  });
});
