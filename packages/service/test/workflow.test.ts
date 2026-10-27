import { describe, expect, it } from 'vitest';
import { ROLE_KEYS, bootstrapStudio, defaultRole, type Ctx, type ProjectFacts, type WorkflowDraft } from '@cadrel/kernel';
import { memoryStudioDb } from '@cadrel/store';
import { PermissionDenied, StudioService, dbAccess } from '../src/index';

const S = 'studio1';
const STUDIO = { kind: 'studio' as const, id: S };
const NOW = () => new Date('2026-10-27T10:00:00.000Z');
const denied = (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof PermissionDenied); // any other error means the permission check passed
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ hasManuscript: false, openNotes: 0, subprojects: [], openTasks: 0, approved: [], ...over });

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

describe('the workflow builder and stage moves behind the permission check', () => {
  it.each(ROLE_KEYS)('%s: builds workflows only with workflow.design, sees them with task.read, moves projects with project.stage', async (key) => {
    const { svc, ana, person } = await studio();
    const id = key === 'owner' ? 'ana' : await person(`P-${key}`, `role_${key}`);
    const me = svc.as(id).workflows;
    const caps = new Set(defaultRole(key).capabilities);
    const has = (c: string) => key === 'owner' || caps.has(c);
    const w = (await ana.workflows.list())[0]!;
    const draft: WorkflowDraft = { name: w.name, stages: w.stages, transitions: w.transitions };
    expect(await denied(me.list()), 'read').toBe(!has('task.read'));
    expect(await denied(me.defaultFor('project')), 'default').toBe(!has('task.read'));
    expect(await denied(me.stageOptions(w.id, 'planning', facts())), 'options').toBe(!has('task.read'));
    expect(await denied(me.allowMove(w.id, 'planning', 'drafting', facts())), 'move').toBe(!has('project.stage'));
    expect(await denied(me.create({ name: `w-${key}` })), 'create').toBe(!has('workflow.design'));
    expect(await denied(me.save(w.id, draft)), 'save').toBe(!has('workflow.design'));
    expect(await denied(me.setDefault(w.id, ['project'])), 'set default').toBe(!has('workflow.design'));
    expect(await denied(me.delete('nope')), 'delete').toBe(!has('workflow.design'));
  });

  it('a new studio has the MDEdit workflow as the default for projects and subprojects', async () => {
    const { ana } = await studio();
    const [w] = await ana.workflows.list();
    expect(w).toMatchObject({ name: 'Writing and publishing', defaultFor: ['project', 'subproject'] });
    expect((await ana.workflows.defaultFor('subproject'))!.id).toBe(w!.id);
    const { options, current } = await ana.workflows.stageOptions(w!.id, 'planning', facts());
    expect(current).toMatchObject({ key: 'planning' });
    expect(options.map((o) => o.name)).toEqual(['Drafting', 'Revising', 'Editing', 'Published', 'On hold']);
  });

  it('a Series and its Books can be given different workflows, each with its own default', async () => {
    const { ana } = await studio();
    const series = await ana.workflows.create({ name: 'Series lifecycle', copyFrom: (await ana.workflows.list())[0]!.id });
    const books = await ana.workflows.create({ name: 'Book production' });
    await ana.workflows.setDefault(series.id, ['project']);
    await ana.workflows.setDefault(books.id, ['subproject']);
    expect((await ana.workflows.defaultFor('project'))!.name).toBe('Series lifecycle');
    expect((await ana.workflows.defaultFor('subproject'))!.name).toBe('Book production');
  });

  it('the roles a gate names are the roles this person holds: directly or through a team; an Owner holds them all; a role on one book does not count at the studio', async () => {
    const { svc, ana, person } = await studio();
    const w = (await ana.workflows.list())[0]!;
    await ana.workflows.save(w.id, { name: w.name, stages: w.stages, transitions: w.transitions.map((t) => (t.to === 'published' ? { ...t, roleIds: ['role_series_lead'] } : t)) });
    const author = await person('Author', 'role_author'); // may move projects, but does not hold the gate's role
    const lead = await person('Lead', 'role_series_lead');
    const ed = await ana.people.create({ name: 'Ed' });
    await ana.people.grant({ subject: { kind: 'person', id: ed.id }, roleId: 'role_series_lead', scope: { kind: 'project', id: 'book-1' } });
    await ana.people.grant({ subject: { kind: 'person', id: ed.id }, roleId: 'role_editor', scope: STUDIO });
    const t = await ana.people.createTeam('Leads');
    await ana.people.grant({ subject: { kind: 'team', id: t.id }, roleId: 'role_series_lead', scope: STUDIO });
    const viaTeam = await person('Via team', 'role_editor');
    await ana.people.setTeamMember(t.id, viaTeam, true);
    const open = (id: string) => svc.as(id).workflows.stageOptions(w.id, 'editing', facts()).then((r) => r.options.find((o) => o.key === 'published')!);
    expect(await open(author)).toMatchObject({ allowed: false, reasons: ['Only people with certain roles can make this move'] });
    expect((await open(lead)).allowed).toBe(true);
    expect((await open('ana')).allowed).toBe(true); // Owner
    expect((await open(viaTeam)).allowed).toBe(true); // through the team
    expect((await open(ed.id)).allowed).toBe(false); // Series Lead on one book only
    await expect(svc.as(author).workflows.allowMove(w.id, 'editing', 'published', facts())).rejects.toThrow(/Published is not open yet/);
    await expect(svc.as(lead).workflows.allowMove(w.id, 'editing', 'published', facts())).resolves.toBeUndefined();
    await expect(svc.as(author).workflows.allowMove(w.id, 'editing', 'revising', facts())).resolves.toBeUndefined(); // an open move
  });

  it('a gate that is not open says why through the service', async () => {
    const { ana } = await studio();
    const w = (await ana.workflows.list())[0]!;
    await ana.workflows.save(w.id, { name: w.name, stages: w.stages, transitions: w.transitions.map((t) => (t.to === 'published' ? { ...t, conditions: [{ kind: 'no_open_notes' as const }, { kind: 'has_manuscript' as const }] } : t)) });
    await expect(ana.workflows.allowMove(w.id, 'editing', 'published', facts({ openNotes: 2 }))).rejects.toThrow(/A manuscript is linked to it; 2 open notes|2 open notes to resolve first.*A manuscript is linked to it|A manuscript is linked to it/);
    await expect(ana.workflows.allowMove(w.id, 'editing', 'published', facts({ hasManuscript: true }))).resolves.toBeUndefined();
  });
});
