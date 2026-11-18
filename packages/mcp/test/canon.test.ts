// Canon and continuity through the composed server: reading canon, proposing, seeding from ledgers, and running a check as the assistant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DbVaultStore, bootstrapStudio, type Ctx } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { DirBlobs, memoryStudioDb, type StudioDb } from '@cadrel/store';
import { Studio } from '@cadrel/studio';
import { emptyLedger } from '@cadrel/write/src/shared/agent/litrpg';
import { createCadrelServer, canonModule } from '../src/index.js';

const S = 'studio1';
const NOW = () => new Date('2026-11-18T10:00:00.000Z');
const BOOK1 = 'Mara had grey eyes and walked with a limp.\n\nShe left Harrow on the first day of the war.';
const BOOK4 = 'Mara walked to the ford with her green eyes narrowed.\n\nThe battle of Harrow was three years behind her.\n\nShe left Harrow on the first day of the war.';

let db: StudioDb, svc: StudioService, studio: Studio, ana: ReturnType<StudioService['as']>, dir: string;
let seriesId: string, b1: string, b4: string;
let seedBooks: Parameters<NonNullable<Parameters<typeof canonModule>[0]['ledgers']>>[0] extends string ? Awaited<ReturnType<NonNullable<Parameters<typeof canonModule>[0]['ledgers']>>> : never = [];

beforeEach(async () => {
  db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-canon-mcp-'));
  studio = new Studio(path.join(dir, 'studio.json'));
  seriesId = (await studio.createProject({ name: 'Dragon Rider', kind: 'Series' })).id;
  b1 = (await studio.createProject({ name: 'Book One', kind: 'Book', parentId: seriesId })).id;
  b4 = (await studio.createProject({ name: 'Book Four', kind: 'Book', parentId: seriesId })).id;
  svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => (await studio.read()).tree });
  ana = svc.as('ana');
  const blobs = new DirBlobs(path.join(dir, 'blobs'));
  for (const [id, p, text, proj] of [['f1', 'Book One/book.md', BOOK1, b1], ['f4', 'Book Four/book.md', BOOK4, b4]] as const) {
    const hash = await blobs.put(new TextEncoder().encode(text));
    await db.run('INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, ?, ?, 1)', [id, S, p]);
    await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, 1, ?, ?, 'ana', '2026-11-01T00:00:00.000Z')", [id, hash, text.length]);
    await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES (?, ?, '{}', 'x', 'x')", [id, proj]);
  }
  seedBooks = [];
});

async function connect(personId = 'ana') {
  const server = createCadrelServer({ modules: [canonModule({ service: svc, personId, studio, vault: new DbVaultStore({ db, studioId: S, personId }), blobs: new DirBlobs(path.join(dir, 'blobs')), ledgers: async () => seedBooks })] });
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
const approveAll = async () => {
  for (const p of await ana.canon.listProposals({ projectId: seriesId, state: 'open' })) await ana.canon.approve(p.id);
};

describe('the canon tools', () => {
  it('offers tools to read, propose and check, and none that approves, rejects, dismisses, accepts or closes anything', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['canon_entries', 'canon_facts', 'canon_for_chapter', 'canon_proposals', 'canon_propose', 'canon_search', 'canon_seed', 'continuity_checks', 'continuity_deliver', 'continuity_findings', 'continuity_raise', 'continuity_read', 'continuity_start']);
  });

  it('proposes an entry and a sourced fact; nothing is canon until a person approves; the fact shows where it was established and the passage', async () => {
    const { call } = await connect();
    const added = await call('canon_propose', { series: 'Dragon Rider', change: 'add_entry', kind: 'character', name: 'Mara', aliases: ['the Ferrywoman'], summary: 'A ferrywoman.' });
    expect(added.isError).toBe(false);
    expect((await call('canon_entries', { series: 'Dragon Rider' })).json().entries).toEqual([]); // proposed, not canon
    expect((await call('canon_proposals', { series: 'Dragon Rider' })).json()).toMatchObject([{ change: 'add_entry', state: 'open', by: 'me' }]);
    await approveAll();
    expect((await call('canon_entries', { series: 'Book One', search: 'ferry' })).json().entries).toMatchObject([{ kind: 'character', name: 'Mara', aliases: ['the Ferrywoman'] }]); // a book of the series reads the series' canon
    const fact = await call('canon_propose', { series: 'Dragon Rider', change: 'add_fact', entry: 'mara', text: 'Mara has grey eyes.', book: 'Dragon Rider / Book One', chapter: 1, source_file: 'Book One/book.md', source_quote: 'grey eyes' });
    expect(fact.isError).toBe(false);
    await approveAll();
    const facts = (await call('canon_facts', { series: 'Dragon Rider' })).json().facts;
    expect(facts).toMatchObject([{ entry: 'Mara', kind: 'character', text: 'Mara has grey eyes.', established: 'Dragon Rider / Book One, chapter 1', source: { file: 'Book One/book.md', version: 1, passage: 'grey eyes' } }]);
  });

  it('refuses a source quote that is not in the text, and a duplicate name', async () => {
    const { call } = await connect();
    await call('canon_propose', { series: 'Dragon Rider', change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
    await approveAll();
    const bad = await call('canon_propose', { series: 'Dragon Rider', change: 'add_fact', entry: 'Mara', text: 'x', source_file: 'Book One/book.md', source_quote: 'blue eyes' });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/Quote not found/);
    expect((await call('canon_propose', { series: 'Dragon Rider', change: 'add_entry', kind: 'character', name: 'MARA', summary: 'x' })).text).toMatch(/already has a character called MARA/);
    expect((await call('canon_propose', { series: 'Dragon Rider', change: 'add_fact', entry: 'Nobody', text: 'x' })).text).toMatch(/There is no entry "Nobody"/);
  });

  it('canon_for_chapter gives what the series had established by that point, not what comes later', async () => {
    const { call } = await connect();
    await call('canon_propose', { series: 'Dragon Rider', change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
    await approveAll();
    for (const [text, book, chapter] of [['Mara has grey eyes.', 'Book One', 1], ['Mara limps.', 'Book One', 5], ['Mara is a queen.', 'Book Four', 9], ['Mara is tall.', undefined, undefined]] as const)
      await call('canon_propose', { series: 'Dragon Rider', change: 'add_fact', entry: 'Mara', text, ...(book ? { book: `Dragon Rider / ${book}`, chapter } : {}) });
    await approveAll();
    const texts = async (args: Record<string, unknown>) => ((await call('canon_for_chapter', args)).json().facts as { text: string }[]).map((f) => f.text).sort();
    expect(await texts({ book: 'Dragon Rider / Book One', chapter: 2 })).toEqual(['Mara has grey eyes.', 'Mara is tall.']); // this book up to chapter 2; not chapter 5, not Book Four
    expect(await texts({ book: 'Dragon Rider / Book One' })).toEqual(['Mara has grey eyes.', 'Mara is tall.', 'Mara limps.']);
    expect(await texts({ book: 'Dragon Rider / Book Four', chapter: 3 })).toEqual(['Mara has grey eyes.', 'Mara is tall.', 'Mara limps.']); // all of Book One, and Book Four's own only up to chapter 3
    expect(await texts({ book: 'Dragon Rider / Book Four', chapter: 9 })).toHaveLength(4);
  });

  it('seeds proposals from the tracker ledgers: entries first, facts once the entries are approved, and nothing twice', async () => {
    const l = emptyLedger('Book One');
    l.characters['Mara'] = { current_state: undefined as never, event_log: [{ id: 'e1', type: 'level_up', chapter: 2, details: { resulting_level: 2 } }, { id: 'e2', type: 'skill_gained', chapter: 3, details: { name: 'Shadow Step' } }] };
    seedBooks = [{ book: b1, name: 'Book One', litrpg: l, timeline: null }];
    const { call } = await connect();
    const dry = (await call('canon_seed', { series: 'Dragon Rider' })).json();
    expect(dry).toMatchObject({ wouldPropose: 1, showing: ['character: Mara'] });
    expect(await ana.canon.listProposals({ projectId: seriesId, state: 'open' })).toHaveLength(0); // a dry run proposes nothing
    expect((await call('canon_seed', { series: 'Dragon Rider', apply: true })).json()).toMatchObject({ proposed: 1 });
    expect((await call('canon_seed', { series: 'Dragon Rider', apply: true })).json()).toMatchObject({ proposed: 0 }); // the entry is already proposed
    await approveAll();
    expect((await call('canon_seed', { series: 'Dragon Rider', apply: true })).json()).toMatchObject({ proposed: 2 }); // now its two facts
    await approveAll();
    const facts = (await ana.canon.listFacts({ projectId: seriesId })).map((f) => [f.text, f.bookProjectId, f.chapter]);
    expect(facts).toEqual([['Reached level 2.', b1, 2], ['Learned Shadow Step.', b1, 3]]);
    expect((await call('canon_seed', { series: 'Dragon Rider', apply: true })).json()).toMatchObject({ proposed: 0 });
  });

  it('says so when there are no ledgers to seed from', async () => {
    const { call } = await connect();
    expect((await call('canon_seed', { series: 'Dragon Rider' })).json().note).toMatch(/no tracker ledgers/);
  });
});

describe('a continuity check as the assistant', () => {
  let eyes: string;
  beforeEach(async () => {
    await ana.canon.apply(seriesId, { change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' });
    const [e] = await ana.canon.listEntries({ projectId: seriesId });
    await ana.canon.apply(seriesId, { change: 'add_fact', entryId: e!.id, text: 'Mara has grey eyes.', bookProjectId: b1, chapter: 1 });
    eyes = (await ana.canon.listFacts({ projectId: seriesId }))[0]!.id;
  });

  it('starts a check, reads the pinned text, raises a finding that quotes the passage and cites the fact, and delivers; the finding is open for a person to decide', async () => {
    const { call } = await connect();
    const started = (await call('continuity_start', { book: 'Dragon Rider / Book Four', file: 'Book Four/book.md' })).json();
    expect(started).toMatchObject({ book: 'Dragon Rider / Book Four', file: 'Book Four/book.md', version: 1 });
    const read = (await call('continuity_read', { check: started.check })).json();
    expect(read.text).toContain('green eyes narrowed');
    const raised = await call('continuity_raise', { check: started.check, findings: [{ kind: 'contradiction', severity: 'high', confidence: 'high', quote: 'green eyes', text: 'Canon says grey.', facts: [eyes] }] });
    expect(raised.isError).toBe(false);
    expect(raised.json().raised).toMatchObject([{ n: 1, kind: 'contradiction', passage: 'green eyes' }]);
    expect((await call('continuity_deliver', { check: started.check })).json()).toMatchObject({ state: 'delivered' });
    const findings = (await call('continuity_findings', { check: started.check })).json();
    expect(findings.findings).toMatchObject([{ n: 1, state: 'open', passage: 'green eyes', facts: [eyes], severity: 'high', confidence: 'high' }]);
    expect((await call('continuity_checks', {})).json()).toMatchObject([{ state: 'delivered', findings: { open: 1 } }]);
    // nothing more can be added after it is handed over
    expect((await call('continuity_raise', { check: started.check, findings: [{ kind: 'other', severity: 'low', confidence: 'low', quote: 'ford', text: 'x', facts: [eyes] }] })).isError).toBe(true);
  });

  it('refuses a finding whose quote is not in the text, one that cites no real fact, and an ambiguous quote; none of the batch goes in', async () => {
    const { call } = await connect();
    const k = (await call('continuity_start', { book: 'Dragon Rider / Book Four', file: 'Book Four/book.md' })).json().check;
    const ok = { kind: 'contradiction', severity: 'high', confidence: 'high', quote: 'green eyes', text: 'x', facts: [eyes] };
    const notThere = await call('continuity_raise', { check: k, findings: [ok, { ...ok, quote: 'blue eyes' }] });
    expect(notThere).toMatchObject({ isError: true });
    expect(notThere.text).toMatch(/Finding 2: Quote not found/);
    expect((await call('continuity_raise', { check: k, findings: [{ ...ok, facts: ['made-up-id'] }] })).text).toMatch(/not canon in this series/);
    expect((await call('continuity_raise', { check: k, findings: [{ ...ok, quote: 'Harrow' }] })).text).toMatch(/occurs 2 times/); // "Harrow" is in two sentences: it says to give before or after
    expect((await call('continuity_raise', { check: k, findings: [{ ...ok, quote: 'Harrow', before: 'The battle of ' }] })).isError).toBe(false);
    expect((await call('continuity_findings', { check: k })).json().findings).toHaveLength(1);
  });

  it('is refused, with the reason, when the Studio has turned the assistant off', async () => {
    const { call } = await connect();
    await ana.policy.set({ assistantEnabled: false });
    for (const [tool, args] of [['canon_entries', { series: 'Dragon Rider' }], ['continuity_checks', {}], ['continuity_start', { book: 'Book Four', file: 'Book Four/book.md' }]] as const) {
      const r = await call(tool, args as Record<string, unknown>);
      expect(r.isError, tool).toBe(true);
      expect(r.text).toMatch(/turned the assistant off/);
    }
  });
});
