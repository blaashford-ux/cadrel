// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
//
// M4's exit test (docs/M4-PLAN.md): "Book 4's manuscript is checked against Books 1 to 3 and the findings are specific and checkable", as an
// automated run against the real Worker code, with three people (an Author, an Editor and a Series Lead), the Editor's assistant played by the real
// MCP tools through the app's local door, and five contradictions planted in Book 4.
//
// The assistant reads the canon that applies, reads the pinned text, and raises findings. Every finding must quote a passage that is exactly in
// that version of Book 4 and cite canon facts that exist; the ones that do not are refused. The Author fixes one (a re-check closes it), dismisses
// one (not raised again), and accepts one as canon (a proposal the Series Lead approves). A gate on Editing to Published holds until nothing high
// is open. The manual walk-through that covers what this cannot (the screens, on Windows) is docs/M4-EXIT-TEST.md.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair, makeAnchor, type ProjectFacts } from '@cadrel/kernel';
import { LocalVault, DirBlobs, type BlobStore } from '@cadrel/store';
import { DoorClient } from '@cadrel/studio-client';
import { createCadrelServer } from '../../mcp/src/server';
import { canonModule } from '../../mcp/src/modules/canon';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';
import { AssistantDoor } from '../src/main/assistantDoor';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-m4-'));
  dirs.push(d);
  return d;
};

const T = '2026-01-01T00:00:00.000Z';
const proj = (id: string, name: string, parentId: string | null, kind: string, order: number) => ({ id, name, parentId, kind, status: 'active' as const, order, workflowId: null, stage: null, createdAt: T, updatedAt: T });
const TREE = { projects: [proj('series', 'Dragon Rider', null, 'Series', 0), proj('b1', 'Book One', 'series', 'Book', 1), proj('b2', 'Book Two', 'series', 'Book', 2), proj('b3', 'Book Three', 'series', 'Book', 3), proj('b4', 'Book Four', 'series', 'Book', 4)], links: [] } as never;

// ---- the books ----------------------------------------------------------------------------------------------------------------

const BOOK1 = [
  'Mara Quinn had grey eyes, the colour of the river in winter.',
  'The war began on the first day of the thaw, and the battle of Harrow was fought that same day.',
  'Old Tam fell at Harrow, and Mara carried his sword home.',
  'Captain Voss held the garrison at Harrow, and no one doubted him.',
  'Every spell the witches cast cost them a year of their life, and so they cast few.'
].join('\n\n');

/** Book Four: five places where it contradicts what Books One to Three established. */
const BOOK4 = [
  'Chapter One',
  'Mara walked to the ford with her green eyes narrowed against the glare.', // 1: eye colour
  'Chapter Two',
  'She remembered the battle of Harrow, fought on the third day of the war, and how the river had run.', // 2: the battle was on day one
  'Chapter Three',
  'She cast the binding freely, and it cost her nothing at all.', // 3: every spell costs a year
  'Chapter Four',
  'Captain Voss, harbour master of Dunmere, met her at the quay.', // 4: Voss commands the garrison at Harrow
  'Chapter Five',
  'Old Tam laughed and passed her the bread, as he always did.', // 5: Old Tam died at Harrow
  'Chapter Six',
  'They slept in the barn, and in the morning the bells rang.'
].join('\n\n');

// ---- the Studio ---------------------------------------------------------------------------------------------------------------

async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  const fetchFn = cf.fetchFn as typeof fetch;
  const clock = { t: 1_000_000 }; // one clock for every client, moved on by `advance`, so one person sees what another just did
  const now = () => clock.t;
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn, now });
  /** `scope`: a book, the whole series, or no limit. */
  const person = async (role: string, name: string, scope: 'b4' | 'series' | null = null) => {
    const { link } = await owner.invite(role, name, 'Acme', scope ? { projectId: scope, days: 60 } : {});
    const j = await joinStudio({ link, yourName: name, fetchFn });
    return new StudioClient({ url: built.url, key: j.key, fetchFn, now });
  };
  return { owner, person, advance: () => (clock.t += 10_000) };
}

async function computer(client: StudioClient, machine: string) {
  const root = await tmp();
  const me = await client.me();
  const store = new OfflineAwareStore(new RemoteVaultStore(client), path.join(root, 'cache.json'));
  const vault = new LocalVault({ store, blobs: new RemoteBlobs(client, new DirBlobs(path.join(root, 'blobs'))), dir: path.join(root, 'work'), personId: me.personId, machine });
  await (await import('node:fs/promises')).mkdir(path.join(root, 'work'), { recursive: true });
  return { vault, write: (rel: string, text: string) => writeFile(path.join(root, 'work', rel), text) };
}

/** The assistant's tools for one person, reached through the app's door and nothing else, as `claude-ai`. */
async function assistantFor(door: AssistantDoor, personId: string) {
  const client = new DoorClient({ url: door.url!, token: door.token, fetchFn: fetch });
  const service = remoteService(client);
  const blobs: BlobStore = { put: () => Promise.reject(new Error('no')), has: async (h) => (await client.getBlob(h)) !== null, get: (h) => client.getBlob(h) };
  const vault = new RemoteVaultStore(client);
  const studioStub = { read: async () => ({ tree: TREE }) } as never;
  const server = createCadrelServer({ modules: [canonModule({ service, personId, studio: studioStub, vault, blobs })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content[0]!.text, json: () => JSON.parse(r.content[0]!.text) };
  };
  return { call, tools: async () => (await mcp.listTools()).tools.map((t) => t.name) };
}

describe('M4 exit test: Book 4 is checked against Books 1 to 3 and the findings are specific and checkable', () => {
  it('seeded canon, five planted contradictions, grounded findings only, decisions by the Author and the Series Lead, a gate, and a re-check that does not repeat what was dismissed', async () => {
    const s = await studio();
    await s.owner.publishTree(TREE);
    const owner = remoteService(s.owner).as('x');

    // ---- the people: the Series Lead holds the Studio; the Author and the Editor hold Book Four only; Finance has no canon at all
    const leaClient = await s.person('series_lead', 'Lena Lead'); // a Series Lead holds the whole Studio, as in the M3 exit test (stage options are read Studio-wide)
    const annClient = await s.person('author', 'Ann Author', 'b4');
    const eveClient = await s.person('editor', 'Eve Editor', 'b4');
    const finClient = await s.person('finance', 'Fin Finance');
    const lea = remoteService(leaClient).as('x');
    const ann = remoteService(annClient).as('x');
    const eve = remoteService(eveClient).as('x');
    const fin = remoteService(finClient).as('x');
    const [leaId, annId, eveId] = await Promise.all([leaClient, annClient, eveClient].map(async (c) => (await c.me()).personId));
    await owner.people.grant({ subject: { kind: 'person', id: leaId }, roleId: 'role_series_lead', scope: { kind: 'project', id: 'series' } }); // ... and is assigned to the series she leads

    // ---- the manuscripts, in the vault: Book One (the canon's source) and Book Four (to be checked)
    const ownerPc = await computer(s.owner, 'owner-pc');
    const annPc = await computer(annClient, 'ann-pc');
    await ownerPc.write('book1.md', BOOK1);
    await ownerPc.vault.add('book1.md', 'Book One');
    await ownerPc.vault.setCard('book1.md', {}, 'b1');
    await ownerPc.write('book4.md', BOOK4);
    await ownerPc.vault.add('book4.md', 'First draft');
    await ownerPc.vault.setCard('book4.md', {}, 'b4');
    const book1File = (await ownerPc.vault.status('book1.md')).fileId!;
    const book4File = (await ownerPc.vault.status('book4.md')).fileId!;
    const at = (text: string, q: string) => makeAnchor(text, text.indexOf(q), text.indexOf(q) + q.length);
    const from = (q: string) => ({ fileId: book1File, version: 1, anchor: at(BOOK1, q) });

    // ---- canon: the Series Lead builds it from Book One (one step each, as someone who may approve)
    const entry = async (kind: string, name: string, summary: string) => (await lea.canon.apply('series', { change: 'add_entry', kind, name, summary })) && (await lea.canon.listEntries({ projectId: 'series' })).find((e) => e.name === name)!.id;
    const mara = await entry('character', 'Mara Quinn', 'A ferrywoman.');
    const tam = await entry('character', 'Old Tam', 'An old soldier.');
    const voss = await entry('character', 'Captain Voss', 'A garrison captain.');
    const battle = await entry('event', 'The battle of Harrow', 'The first battle of the war.');
    const magic = await entry('rule', 'The price of magic', 'What a spell costs.');
    const fact = async (entryId: string, text: string, quote: string) => (await lea.canon.apply('series', { change: 'add_fact', entryId, text, source: from(quote), bookProjectId: 'b1', chapter: 1 })) && (await lea.canon.listFacts({ projectId: 'series' })).find((f) => f.text === text)!.id;
    const eyes = await fact(mara, 'Mara has grey eyes.', 'grey eyes');
    const day1 = await fact(battle, 'The battle of Harrow was fought on the first day of the war.', 'the battle of Harrow was fought that same day');
    const price = await fact(magic, 'Every spell costs the caster a year of their life.', 'cost them a year of their life');
    const garrison = await fact(voss, 'Captain Voss commands the garrison at Harrow.', 'Captain Voss held the garrison at Harrow');
    const died = await fact(tam, 'Old Tam died at the battle of Harrow.', 'Old Tam fell at Harrow');
    expect((await lea.canon.listFacts({ projectId: 'series' })).length).toBe(5);
    // canon is the series' for everyone who reads Book Four, and for no one who may not read canon
    expect((await ann.canon.listFacts({ projectId: 'b4' })).length).toBe(5);
    await expect(fin.canon.listEntries({ projectId: 'series' })).rejects.toThrow(/not allowed/);

    // ---- the Editor's assistant, through the app's door with the Editor's key behind it
    let target: StudioClient | null = eveClient;
    const door = new AssistantDoor(() => target);
    await door.start();
    try {
      s.advance();
      const bot = await assistantFor(door, eveId);
      const names = await bot.tools();
      for (const forbidden of ['approve', 'reject', 'dismiss', 'close', 'decide', 'accept']) expect(names.filter((n) => n.includes(forbidden)), forbidden).toEqual([]); // it can propose and raise, not decide
      expect(names).toContain('continuity_raise');

      const started = (await bot.call('continuity_start', { book: 'Dragon Rider / Book Four', file: 'book4.md' })).json();
      expect(started).toMatchObject({ book: 'Dragon Rider / Book Four', file: 'book4.md', version: 1 });
      const checkId: string = started.check;
      // what the series had established by Book Four: all five facts
      expect((await bot.call('canon_for_chapter', { book: 'Dragon Rider / Book Four' })).json().facts).toHaveLength(5);
      const text: string = (await bot.call('continuity_read', { check: checkId, length: 20000 })).json().text;
      expect(text).toBe(BOOK4);

      // findings that cannot be checked are refused, and none of the batch goes in
      const good = { kind: 'contradiction', severity: 'high', confidence: 'high', quote: 'green eyes', text: 'Canon says grey.', facts: [eyes] };
      const refused = [
        { ...good, quote: 'blue eyes' }, // the passage is not in the text
        { ...good, facts: ['made-up-id'] }, // the fact does not exist
        { ...good, facts: [] }, // no fact cited
        { ...good, text: '' } // nothing said
      ];
      for (const bad of refused) expect((await bot.call('continuity_raise', { check: checkId, findings: [good, bad] })).error, JSON.stringify(bad)).toBe(true);
      expect((await bot.call('continuity_findings', { check: checkId })).json().findings).toEqual([]); // not one of them went in

      // the five real ones, each quoting its passage and citing the fact it breaks
      const raised = await bot.call('continuity_raise', {
        check: checkId,
        findings: [
          good,
          { kind: 'timeline', severity: 'medium', confidence: 'high', quote: 'fought on the third day of the war', text: 'Canon says the first day.', facts: [day1] },
          { kind: 'rule', severity: 'high', confidence: 'medium', quote: 'it cost her nothing at all', text: 'Every spell costs a year of life.', facts: [price] },
          { kind: 'name', severity: 'high', confidence: 'medium', quote: 'Captain Voss, harbour master of Dunmere', text: 'Voss commands the garrison at Harrow.', facts: [garrison] },
          { kind: 'contradiction', severity: 'high', confidence: 'high', quote: 'Old Tam laughed and passed her the bread', text: 'Old Tam died at Harrow.', facts: [died] }
        ]
      });
      expect(raised.error).toBe(false);
      expect(raised.json().raised.map((r: { passage: string }) => r.passage)).toEqual(['green eyes', 'fought on the third day of the war', 'it cost her nothing at all', 'Captain Voss, harbour master of Dunmere', 'Old Tam laughed and passed her the bread']);
      expect((await bot.call('continuity_deliver', { check: checkId })).json()).toMatchObject({ state: 'delivered' });
      expect((await bot.call('continuity_raise', { check: checkId, findings: [good] })).error).toBe(true); // handed over: no more

      // every finding the records hold is specific and checkable: its passage is at the place it says in the pinned version, and its facts are canon
      s.advance();
      const found = await ann.continuity.findings({ checkId });
      expect(found).toHaveLength(5);
      for (const f of found) {
        expect(BOOK4.slice(f.anchor.start, f.anchor.start + f.anchor.quote.length)).toBe(f.anchor.quote);
        for (const id of f.factIds) expect((await ann.canon.getFact(id))!.status).toBe('canon');
      }
      const [fEyes, fDay, fRule, fVoss, fTam] = found as [typeof found[number], ...typeof found];

      // ---- the gate: Editing to Published holds while a high-severity finding is open
      const base = (await owner.workflows.list())[0]!;
      const wf = await owner.workflows.create({ name: 'Checked before publishing' });
      await owner.workflows.save(wf.id, {
        name: wf.name, description: '',
        stages: base.stages.map((st) => ({ key: st.key, name: st.name, category: st.category, color: st.color })),
        transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'continuity_clear' }] }]
      } as never);
      const gate = async () => {
        s.advance();
        const facts: ProjectFacts = { hasManuscript: true, openNotes: 0, subprojects: [], openTasks: 0, approved: [], continuity: await lea.work.continuityFacts(['b4']) };
        return (await lea.workflows.stageOptions(wf.id, 'editing', facts)).options.find((o) => o.key === 'published')!;
      };
      expect(await gate()).toMatchObject({ allowed: false, reasons: [expect.stringMatching(/4 high-severity continuity findings are still open/)] });

      // ---- the Author decides
      // 1. FIX: she changes the eyes in Book Four, checks in a new version, and a re-check finds the passage gone
      await annPc.vault.checkOut('book4.md');
      await annPc.write('book4.md', BOOK4.replace('green eyes', 'grey eyes'));
      expect((await annPc.vault.checkIn('book4.md', 'Mara’s eyes')).unchanged).toBe(false);
      s.advance();
      const v2 = new TextDecoder().decode(await annPc.vault.read('book4.md', 2));
      const re = await ann.continuity.verify(checkId, { version: 2, text: v2 });
      expect(re.fixed.map((f) => f.id)).toEqual([fEyes.id]);
      expect(re.remaining).toHaveLength(4);
      // 2. DISMISS: the timeline finding, with a reason (required)
      await expect(ann.continuity.decide(fDay.id, { outcome: 'dismiss', reason: '  ' })).rejects.toThrow(/cannot be empty/);
      expect((await ann.continuity.decide(fDay.id, { outcome: 'dismiss', reason: 'Mara is misremembering; the narrator says so in Book Five.' })).finding).toMatchObject({ state: 'dismissed' });
      // 3. ACCEPT AS CANON: the manuscript is right about the price of magic; this is a proposal, not a change
      const change = { change: 'supersede_fact', factId: price, text: 'A spell costs the caster a year of life, unless it is bound to a place.', source: { fileId: book4File, version: 1, anchor: fRule.anchor }, bookProjectId: 'b4', chapter: 3 };
      const { proposal } = await ann.continuity.decide(fRule.id, { outcome: 'accept_as_canon', change, note: 'Book Four reveals the exception.' });
      expect(proposal).toMatchObject({ state: 'open', findingId: fRule.id });
      expect((await ann.canon.getFact(price))!.status).toBe('canon'); // nothing has changed yet
      // the Editor and the Author cannot approve it; the Series Lead sees it waiting and does
      s.advance();
      await expect(eve.canon.approve(proposal!.id)).rejects.toThrow(/not allowed/);
      await expect(ann.canon.approve(proposal!.id)).rejects.toThrow(/not allowed/);
      expect((await lea.canon.waitingForMe()).map((p) => p.id)).toEqual([proposal!.id]);
      await lea.canon.approve(proposal!.id);
      s.advance();
      expect((await lea.canon.getFact(price))!.status).toBe('retired');
      const newPrice = (await lea.canon.listFacts({ projectId: 'series' })).find((f) => /unless it is bound/.test(f.text))!;
      expect(newPrice).toMatchObject({ supersedesId: price, bookProjectId: 'b4', chapter: 3, source: { fileId: book4File, version: 1, anchor: { quote: 'it cost her nothing at all' } } });
      expect(await gate()).toMatchObject({ allowed: false, reasons: [expect.stringMatching(/2 high-severity continuity findings are still open/)] }); // Voss and Tam

      // the Series Lead, who may approve canon, decides the other two; nothing high is left open and the gate opens
      await lea.continuity.decide(fVoss.id, { outcome: 'dismiss', reason: 'Another Captain Voss, a cousin, in Dunmere.' });
      await lea.continuity.decide(fTam.id, { outcome: 'dismiss', reason: 'A different old man called Tam: renamed in the next draft.' });
      expect(await gate()).toMatchObject({ allowed: true });
      s.advance();
      expect((await ann.continuity.close(checkId)).state).toBe('closed');

      // ---- a re-check of the same manuscript does not raise again what a person dismissed
      s.advance();
      const second = (await bot.call('continuity_start', { book: 'Dragon Rider / Book Four', file: 'book4.md' })).json();
      expect(second.version).toBe(2);
      const again = await bot.call('continuity_raise', { check: second.check, findings: [{ kind: 'timeline', severity: 'medium', confidence: 'high', quote: 'fought on the third day of the war', text: 'Canon says the first day.', facts: [day1] }, { kind: 'name', severity: 'low', confidence: 'low', quote: 'in the morning the bells rang', text: 'A new one.', facts: [garrison] }] });
      expect(again.json().skipped).toEqual([{ index: 0, why: 'A person dismissed this finding for this manuscript.' }]);
      expect(again.json().raised).toHaveLength(1);
      // and the gate looks at the newest check only: it is being made, so the gate waits for it
      expect(await gate()).toMatchObject({ allowed: false, reasons: [expect.stringMatching(/still being made/)] });
      void [leaId, annId, fin];
    } finally {
      await door.stop();
    }
  }, 60_000);
});
