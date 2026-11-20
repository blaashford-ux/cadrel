// Launch and market through the composed server: plans and what is outstanding, ARC counts without names, figures and comps with their dates, briefs, reports; and what the assistant may not do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapStudio, type Ctx } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { memoryStudioDb, type StudioDb } from '@cadrel/store';
import { Studio } from '@cadrel/studio';
import { createCadrelServer, launchModule } from '../src/index.js';

const S = 'studio1';
const NOW = () => new Date('2026-11-20T10:00:00.000Z');
const ASIN = 'B0ABCDEF12';
let db: StudioDb, svc: StudioService, studio: Studio, ana: ReturnType<StudioService['as']>, dir: string;
let b4: string, planId: string;

beforeEach(async () => {
  db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-launch-mcp-'));
  studio = new Studio(path.join(dir, 'studio.json'));
  const series = (await studio.createProject({ name: 'Dragon Rider', kind: 'Series' })).id;
  b4 = (await studio.createProject({ name: 'Book Four', kind: 'Book', parentId: series })).id;
  svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => (await studio.read()).tree });
  ana = svc.as('ana');
  const tpl = (await ana.launch.templates()).find((t) => t.key === 'ebook_launch')!;
  planId = (await ana.launch.create({ projectId: b4, templateId: tpl.id, releaseDate: '2027-03-31', name: 'Book Four launch' })).plan.id;
  const k = await ana.launch.createCampaign({ planId, name: 'Round one', targetReaders: 10, reviewTarget: 4 });
  const r = await ana.launch.addReader(k.id, { name: 'Rae Reader', email: 'rae@example.com' });
  await ana.launch.setReader(r.id, 'sent');
  await ana.marketing.publish([{ asin: ASIN, capturedAt: '2026-11-10T08:00:00Z', rank: 1200, price: 4.99, ratings: 40 }]);
});

async function connect(personId = 'ana') {
  const server = createCadrelServer({ modules: [launchModule({ service: svc, personId, studio })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = r.content[0]?.text ?? '';
    return { isError: !!r.isError, text, json: () => JSON.parse(text) };
  };
  return { client, call };
}

describe('the launch tools', () => {
  it('lists the plans with what is outstanding, late and blocked; says what is still to do and why', async () => {
    const { call } = await connect();
    const plans = (await call('launch_plans', { project: 'Dragon Rider / Book Four' })).json();
    expect(plans).toEqual([expect.objectContaining({ id: planId, name: 'Book Four launch', book: 'Dragon Rider / Book Four', releaseDate: '2027-03-31', state: 'draft', daysToRelease: 131, late: 0 })]);
    expect(plans[0].outstanding).toBeGreaterThan(5);
    const out = (await call('launch_outstanding', { plan: 'Book Four launch' })).json();
    expect(out).toMatchObject({ releaseDate: '2027-03-31', daysToRelease: 131 });
    const cover = out.items.find((i: { key: string }) => i.key === 'cover');
    expect(cover).toMatchObject({ status: 'blocked', why: ['The cover is not approved yet.'], required: true });
    expect(cover.due).toBe('2027-02-03');
    expect((await call('launch_outstanding', { plan: 'nothing like it' })).isError).toBe(true);
    expect((await call('launch_outstanding', { plan: planId, all: true })).json().items.length).toBeGreaterThan(out.items.length - 1);
  });

  it('gives ARC counts and never a name or an email', async () => {
    const { call } = await connect();
    const r = await call('arc_status', { plan: planId });
    expect(r.json()).toEqual([expect.objectContaining({ round: 'Round one', haveTheFile: 1, wanted: 10, reviewsHopedFor: 4, reportedByTheStudio: 0, measuredRatingsCount: 'no figure published' })]);
    expect(r.text).not.toMatch(/Rae|rae@example/);
  });

  it('gives figures with the date each was captured, and the comps a brief saw with how old they were and whether newer ones exist', async () => {
    const { call } = await connect();
    expect((await call('market_figures', { asin: ASIN })).json()).toEqual([{ capturedAt: '2026-11-10T08:00:00.000Z', price: 4.99, rank: 1200, ratings: 40 }]);
    const d = (await call('launch_brief_draft', { project: 'Book Four', title: 'Launch brief', body: 'Position against the comps.', comps: [ASIN] })).json();
    expect(d).toMatchObject({ version: 1, comps: 1 });
    await ana.marketing.publish([{ asin: ASIN, capturedAt: '2026-11-19T08:00:00Z', rank: 300 }]);
    const comps = (await call('market_comps', { brief: 'Launch brief' })).json();
    expect(comps).toMatchObject({ brief: 'Launch brief', version: 1 });
    expect(comps.comps[0]).toMatchObject({ asin: ASIN, role: 'comp', seen: { capturedAt: '2026-11-10T08:00:00.000Z', rank: 1200, ageDaysWhenToday: 10 }, newerFigure: { capturedAt: '2026-11-19T08:00:00.000Z', rank: 300 } });
  });

  it('writes a new version of a brief without overwriting; reads briefs; keeps a report', async () => {
    const { call } = await connect();
    const first = (await call('launch_brief_draft', { project: 'Book Four', title: 'Launch brief', body: 'Version one.' })).json();
    const second = (await call('launch_brief_draft', { project: 'Book Four', brief: first.brief, body: 'Version two.', note: 'Sharper hook.' })).json();
    expect(second).toMatchObject({ brief: first.brief, version: 2 });
    const read = (await call('launch_brief_read', { brief: 'Launch brief' })).json();
    expect(read).toMatchObject({ version: 2, brief: 'Version two.', earlier: [{ version: 1, brief: 'Version one.' }] });
    expect((await call('launch_brief_draft', { project: 'Book Four', body: 'No title.' })).isError).toBe(true);
    const rep = (await call('report_save', { project: 'Book Four', kind: 'category', title: 'Dragon Fantasy, November', asOf: '2026-11-15', payload: { top: [{ asin: ASIN, rank: 3 }] } })).json();
    expect(rep.asOf).toBe('2026-11-15');
    expect((await ana.marketing.reports()).map((r) => r.title)).toEqual(['Dragon Fantasy, November']);
    expect((await call('report_save', { project: 'Book Four', kind: 'category', title: 'x', asOf: 'later', payload: {} })).isError).toBe(true);
  });

  it('has no way to approve, apply, change a reader or publish', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['arc_status', 'launch_brief_draft', 'launch_brief_read', 'launch_outstanding', 'launch_plans', 'market_comps', 'market_figures', 'report_save']);
  });

  it('is refused for a role without the assistant, when the Studio has turned it off, and for what the role may not read', async () => {
    const guest = await ana.people.create({ name: 'Gus' });
    await ana.people.grant({ subject: { kind: 'person', id: guest.id }, roleId: 'role_beta_reader', scope: { kind: 'project', id: b4 } });
    expect((await (await connect(guest.id)).call('launch_plans')).isError).toBe(true);
    const fin = await ana.people.create({ name: 'Fin' });
    await ana.people.grant({ subject: { kind: 'person', id: fin.id }, roleId: 'role_finance', scope: { kind: 'studio', id: S } });
    expect((await (await connect(fin.id)).call('launch_plans')).isError).toBe(true); // finance holds no launch role
    await ana.policy.set({ assistantEnabled: false } as never);
    expect((await (await connect()).call('launch_plans')).isError).toBe(true);
  });
});
