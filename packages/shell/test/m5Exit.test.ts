// Not type-checked with the shell: it imports the Worker (which needs Cloudflare's types, not the DOM ones). vitest checks it by running it.
//
// M5's exit test (docs/M5-PLAN.md): "a cover goes brief → concepts → approval → used in Preflight and visible to Launch", as an automated run against
// the real Worker code, with five people (an Art Director, an Artist, an Editor, a Series Lead and Finance), the Art Director's assistant played by the real MCP tools
// through the app's local door, and an EPUB with planted defects.
//
// The Art Director writes a cover brief (two versions); the Artist offers concepts against version 2; feedback is pinned to a region at an exact version;
// the Art Director chooses one and approves an exact version, which the Artist cannot do. A newer version is not approved until someone approves it. An
// expired licence blocks a new approval. Where-used lists a declared listing and an EPUB; a replacement moves nothing and marks each use "needs update".
// Preflight on the defective EPUB finds the planted errors with what was measured and expected, uses the approved cover (and says when the EPUB carries a
// different one), clears when fixed, and carries a waiver. What Launch will read is there. A person with no asset role sees nothing. The optional gates hold
// a stage move. The manual walk-through that covers what this cannot (the screens, on Windows) is docs/M5-EXIT-TEST.md.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair, type ProjectFacts } from '@cadrel/kernel';
import { LocalVault, DirBlobs, type BlobStore } from '@cadrel/store';
import { DoorClient } from '@cadrel/studio-client';
import { assembleBook } from '@cadrel/write/src/shared/export/assemble';
import { buildEpub } from '@cadrel/write/src/shared/export/epub';
import { defaultBookDetails } from '@cadrel/write/src/shared/export/model';
import { createCadrelServer } from '../../mcp/src/server';
import { artModule } from '../../mcp/src/modules/art';
import { ACCOUNT, TOKEN, fakeCloudflare } from './fakeCloudflare';
import { buildStudio } from '../src/main/cloudflare';
import { joinStudio, StudioClient } from '../src/main/studioClient';
import { OfflineAwareStore, RemoteBlobs, RemoteVaultStore, remoteService } from '../src/main/remote';
import { AssistantDoor } from '../src/main/assistantDoor';
import { Art } from '../src/main/art';
import { Preflight, type PreflightFiles } from '../src/main/preflight';
import { jpeg, psd } from './artFixture';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-m5-'));
  dirs.push(d);
  return d;
};

const T = '2026-01-01T00:00:00.000Z';
const proj = (id: string, name: string, parentId: string | null, kind: string, order: number) => ({ id, name, parentId, kind, status: 'active' as const, order, workflowId: null, stage: null, createdAt: T, updatedAt: T });
const TREE = { projects: [proj('series', 'Dragon Rider', null, 'Series', 0), proj('b4', 'Book Four', 'series', 'Book', 1), proj('b1', 'Book One', 'series', 'Book', 2)], links: [] } as never;

// ---- the book ------------------------------------------------------------------------------------------------------------------

const SRC = '# Chapter 1: Coming Back\n\nShe said so.\n\n# Chapter 2: Leaving\n\nGone.\n';
const epub = (title: string, cover: Uint8Array | null) => {
  const d = defaultBookDetails({ title, author: 'Ash Wilder', year: 2026 });
  d.subtitle = 'Book Four';
  d.copyright.isbn = '978-1-23456-789-7';
  d.back.about = { enabled: true, heading: '', text: 'Bio.' };
  d.back.alsoBy = { enabled: true, heading: '', items: [{ title: 'Book One', url: '', blurb: '' }] };
  const r = assembleBook(SRC, d, { now: new Date('2026-11-19T00:00:00Z'), uuid: () => '123e4567-e89b-12d3-a456-426614174000' });
  return buildEpub(r.build!, cover ? { bytes: cover, ext: 'jpg' } : undefined);
};
const COVER = jpeg(1600, 2560, 1); // the approved cover
const COVER2 = jpeg(1600, 2560, 2); // a newer version of it
const OTHER = jpeg(1600, 2560, 3); // a concept that is not chosen
const CONCEPT_PSD = psd(8, 4); // a layered concept, with the picture saved inside
const SMALL = jpeg(400, 450, 4); // too small to be accepted
const KEYWORDS = ['dragon rider fantasy', 'reverse harem dragons', 'epic fantasy romance', 'fantasy series dragons', 'slow burn dragon rider', 'found family fantasy', 'dragon shifter romance'].map((k, i) => `${i + 1}. ${k}`).join('\n');

// ---- the Studio ----------------------------------------------------------------------------------------------------------------

async function studio() {
  const cf = fakeCloudflare();
  const ownerKey = await generateKeyPair();
  const built = await buildStudio({ fetchFn: cf.fetchFn, sleep: async () => undefined }, { accountId: ACCOUNT, apiToken: TOKEN, studioId: 'sabc123def4', ownerKey: ownerKey.publicKey, workerSource: '// server' });
  const fetchFn = cf.fetchFn as typeof fetch;
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const owner = new StudioClient({ url: built.url, key: ownerKey, fetchFn, now });
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
  await mkdir(path.join(root, 'work'), { recursive: true });
  return { vault, write: async (rel: string, data: string | Uint8Array) => (await mkdir(path.dirname(path.join(root, 'work', rel)), { recursive: true }), writeFile(path.join(root, 'work', rel), data)) };
}
type Pc = Awaited<ReturnType<typeof computer>>;

/** The vault as the app's pages see it, from one person's computer. */
function filesOf(pc: Pc): PreflightFiles {
  const entries = async () => (await pc.vault.list()).filter((e) => e.fileId !== null && (e.version ?? 0) > 0);
  const pathOf = async (id: string) => (await entries()).find((e) => e.fileId === id)!.path;
  return {
    files: async () => (await entries()).map((e) => ({ fileId: e.fileId!, path: e.path, version: e.version!, projectId: e.projectId ?? null, size: e.size })),
    bytesOf: async (id, v) => pc.vault.read(await pathOf(id), v),
    versionsOf: async (id) => pc.vault.history(await pathOf(id)),
    textOf: async (id, v) => new TextDecoder().decode(await pc.vault.read(await pathOf(id), v))
  };
}

/** The assistant's art tools for one person, reached through the app's door and nothing else, as `claude-ai`. */
async function assistantFor(door: AssistantDoor, personId: string) {
  const client = new DoorClient({ url: door.url!, token: door.token, fetchFn: fetch });
  const service = remoteService(client);
  const blobs: BlobStore = { put: () => Promise.reject(new Error('no')), has: async (h) => (await client.getBlob(h)) !== null, get: (h) => client.getBlob(h) };
  const vault = new RemoteVaultStore(client);
  const studioStub = { read: async () => ({ tree: TREE }) } as never;
  const server = createCadrelServer({ modules: [artModule({ service, personId, studio: studioStub, vault, blobs })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; mimeType?: string }[] };
    return { error: !!r.isError, text: r.content[0]!.text ?? '', content: r.content, json: () => { if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`); return JSON.parse(r.content[0]!.text ?? ''); } };
  };
  return { call, tools: async () => (await mcp.listTools()).tools.map((t) => t.name) };
}

describe('M5 exit test: a cover goes brief, concepts, approval, Preflight, and is visible to Launch', () => {
  it('brief and concepts, an exact version approved by someone who may, a replacement that moves nothing, Preflight that uses the approved cover, the contract Launch reads, and gates', async () => {
    const s = await studio();
    await s.owner.publishTree(TREE);
    const owner = remoteService(s.owner).as('x');

    // ---- the people: the Art Director holds the series, the Artist and the Editor Book Four only, the Series Lead the Studio; Finance has no art at all
    const adaClient = await s.person('art_director', 'Ada Art', 'series');
    const artClient = await s.person('artist', 'Artie Artist', 'b4');
    const eveClient = await s.person('editor', 'Eve Editor'); // the Editor holds the Studio: the catalogue is read Studio-wide, and Preflight compares the EPUB with it
    const leaClient = await s.person('series_lead', 'Lena Lead');
    const finClient = await s.person('finance', 'Fin Finance');
    const ada = remoteService(adaClient).as('x');
    const art = remoteService(artClient).as('x');
    const eve = remoteService(eveClient).as('x');
    const lea = remoteService(leaClient).as('x');
    const fin = remoteService(finClient).as('x');
    const [adaId, artId, eveId, leaId] = await Promise.all([adaClient, artClient, eveClient, leaClient].map(async (c) => (await c.me()).personId));
    await owner.people.grant({ subject: { kind: 'person', id: leaId }, roleId: 'role_series_lead', scope: { kind: 'project', id: 'series' } });
    await owner.people.grant({ subject: { kind: 'person', id: eveId }, roleId: 'role_editor', scope: { kind: 'project', id: 'b4' } }); // ... and the Editor is assigned to the book she checks

    // ---- the catalogue: Book Four and its ebook edition, linked to its project
    const series = await owner.catalogue.createSeries({ name: 'Dragon Rider' } as never);
    const book = await owner.catalogue.createBook({ title: 'Dragon Rider', subtitle: 'Book Four', penName: 'Ash Wilder', seriesId: series.id, position: 4 });
    const edition = await owner.catalogue.addEdition(book.id, { format: 'ebook', isbn: '978-1-23456-789-7', price: 4.99 });
    await owner.catalogue.linkProject(book.id, 'b4');

    // ---- the files: the Artist's concepts from her own computer; the book's EPUB and marketing files from the owner's
    const artPc = await computer(artClient, 'art-pc');
    const ownerPc = await computer(s.owner, 'owner-pc');
    const evePc = await computer(eveClient, 'eve-pc');
    await artPc.write('Book Four/Art/concept-a.jpg', COVER);
    await artPc.vault.add('Book Four/Art/concept-a.jpg', 'Concept A', 'b4'); // an Artist may put art in the vault
    await artPc.write('Book Four/Art/concept-b.jpg', OTHER);
    await artPc.vault.add('Book Four/Art/concept-b.jpg', 'Concept B', 'b4');
    await artPc.write('Book Four/Art/concept-c.psd', CONCEPT_PSD);
    await artPc.vault.add('Book Four/Art/concept-c.psd', 'Layered concept', 'b4');
    await ownerPc.write('Book Four/Marketing/Blurb.md', '# Blurb\n\nA dragon rider falls.\n\n---\n\n## Tropes\n\nslow burn');
    await ownerPc.vault.add('Book Four/Marketing/Blurb.md', 'Blurb', 'b4');
    await ownerPc.write('Book Four/Marketing/Keywords.md', `# Keywords\n\n${KEYWORDS}`);
    await ownerPc.vault.add('Book Four/Marketing/Keywords.md', 'Keywords', 'b4');
    const idOf = async (pc: Pc, rel: string) => (await pc.vault.status(rel)).fileId!;
    const [fileA, fileB, fileC] = await Promise.all(['concept-a.jpg', 'concept-b.jpg', 'concept-c.psd'].map((n) => idOf(artPc, `Book Four/Art/${n}`)));
    // the Artist cannot make a brief
    await expect(art.briefs.create({ projectId: 'b4', kind: 'cover', title: 'Mine', body: 'x' })).rejects.toThrow(/not allowed/);

    // ---- the brief: two versions; concepts are offered against the second
    s.advance();
    const brief = await ada.briefs.create({ projectId: 'b4', kind: 'cover', title: 'Cover for Book Four', body: 'A dragon at dusk, the rider small against it.' });
    await ada.briefs.revise(brief.id, { body: 'A dragon at dusk, the rider small against it. Title large enough to read as a thumbnail.', note: 'Thumbnail legibility.', basedOn: 1 });
    expect((await art.briefs.list({ kind: 'cover' })).map((b) => b.current.n)).toEqual([2]); // the Artist reads the brief
    const kA = await art.assets.submitConcept({ briefId: brief.id, fileId: fileA, note: 'Warm.' });
    const kB = await art.assets.submitConcept({ briefId: brief.id, fileId: fileB });
    const kC = await art.assets.submitConcept({ briefId: brief.id, fileId: fileC });
    expect([kA, kB, kC].map((k) => [k.briefVersion, k.fileVersion])).toEqual([[2, 1], [2, 1], [2, 1]]); // each an exact file version against an exact brief version
    // feedback is pinned to a region of the picture at that version
    const pin = await ada.assets.comment({ targetKind: 'concept', targetId: kA.id, region: { x: 0.1, y: 0.7, w: 0.8, h: 0.2 }, body: 'Title is too small.' });
    expect(pin).toMatchObject({ fileVersion: 1, region: { x: 0.1, y: 0.7, w: 0.8, h: 0.2 }, state: 'open' });
    await expect(ada.assets.comment({ targetKind: 'concept', targetId: kA.id, region: { x: 0.9, y: 0, w: 0.5, h: 0.1 }, body: 'x' })).rejects.toThrow(/inside the image/);
    // the Art Director decides; the Artist cannot
    await expect(art.assets.chooseConcept(kA.id)).rejects.toThrow(/not allowed/);
    await ada.assets.decideConcept(kB.id, 'rejected', 'Too dark for the genre.');
    const { asset: cover } = await ada.assets.chooseConcept(kA.id);
    expect(cover).toMatchObject({ fileId: fileA, kind: 'cover', state: 'in_review' });
    expect(await ada.assets.approved(cover.id)).toEqual([]); // choosing is not approving

    // ---- approval is of an exact version and its hash; the Artist cannot approve her own
    s.advance();
    await expect(art.assets.approve(cover.id, 1)).rejects.toThrow(/not allowed/);
    const ap = await ada.assets.approve(cover.id, 1, 'Approved for launch.');
    expect(ap).toMatchObject({ version: 1, state: 'approved', decidedBy: adaId });
    expect(ap.hash).toMatch(/^[0-9a-f]{64}$/);
    // a newer version of the file is not approved until someone approves it
    await artPc.vault.checkOut('Book Four/Art/concept-a.jpg');
    await artPc.write('Book Four/Art/concept-a.jpg', COVER2);
    await artPc.vault.checkIn('Book Four/Art/concept-a.jpg', 'Bigger title');
    s.advance();
    expect((await ada.assets.approved(cover.id)).map((a) => a.version)).toEqual([1]);
    expect((await ada.assets.get(cover.id))!.state).toBe('approved');
    // an expired licence blocks a new approval, and nothing else
    const expired = await ada.assets.create({ projectId: 'b4', fileId: fileC, kind: 'banner', licence: { kind: 'stock', licensor: 'Pixel Co', expires: '2020-01-01' } });
    await expect(ada.assets.approve(expired.id, 1)).rejects.toThrow(/licence ran out/);

    // ---- where it is used, and a replacement that moves nothing
    await ownerPc.write('Book Four/book.epub', epub('Dragon Rider', COVER));
    await ownerPc.vault.add('Book Four/book.epub', 'First export', 'b4');
    await ownerPc.vault.addReference('Book Four/book.epub', 'Book Four/Art/concept-a.jpg', 1, 'embedded');
    await ada.assets.addUse(cover.id, { kind: 'listing', label: 'Amazon US listing' });
    s.advance();
    const where = await ada.assets.whereUsed(cover.id);
    expect(where.declared.map((u) => u.label)).toEqual(['Amazon US listing']);
    expect(where.files).toEqual([expect.objectContaining({ path: 'Book Four/book.epub', version: 1, note: 'embedded' })]);
    await ada.assets.approve(cover.id, 2); // the bigger title is approved too, by the same person who may
    const proposal = await art.assets.proposeReplacement(cover.id, { fromVersion: 1, toVersion: 2, reason: 'A bigger title.' });
    await expect(art.assets.decideReplacement(proposal.id, { approve: true })).rejects.toThrow(/not allowed/);
    expect((await ada.assets.uses(cover.id))[0]!.state).toBe('current'); // a proposal changes nothing
    const decided = await ada.assets.decideReplacement(proposal.id, { approve: true });
    expect(decided.needUpdate.map((u) => u.label)).toEqual(['Amazon US listing']); // marked, not changed
    expect((await ada.assets.approved(cover.id)).map((a) => a.version)).toEqual([1, 2]); // the old one stays approved until someone takes it back
    await ada.assets.revoke(cover.id, 1, 'The listing now shows version 2.');
    await ada.assets.setUseState((await ada.assets.uses(cover.id))[0]!.id, 'done');

    // ---- Preflight: the Editor runs it from her own computer on an EPUB with planted defects
    s.advance();
    const files = filesOf(evePc);
    const peopleStub = { service: remoteService(eveClient), me: eveId, peopleList: async () => [{ id: eveId, name: 'Eve Editor' }], mayOn: async () => true } as never;
    const studioStub = { tree: async () => TREE } as never;
    const pre = new Preflight(studioStub, peopleStub, files, async () => ({ status: 'not installed' }), () => false, () => '2026-12-19T00:00:00Z');
    const epubFile = await idOf(ownerPc, 'Book Four/book.epub');
    // the first export has the version-1 cover (no longer the approved one), a wrong title, and a cover that is small: replace it with the defective build
    await ownerPc.vault.checkOut('Book Four/book.epub');
    await ownerPc.write('Book Four/book.epub', epub('Dragon Rider Three', SMALL));
    await ownerPc.vault.checkIn('Book Four/book.epub', 'Defective export');
    s.advance();
    const first = await pre.run(epubFile, edition.id);
    if (!first.available) throw new Error(first.reason);
    expect(first.run).toMatchObject({ ready: false, packId: 'kdp-ebook', fileVersion: 2, coverAssetId: cover.id, coverVersion: 2, runBy: eveId });
    const by = (id: string) => first.results.find((r) => r.ruleId === id)!;
    expect(by('names.title')).toMatchObject({ grade: 'error', measured: 'Dragon Rider Three', expected: expect.stringContaining('Dragon Rider') });
    expect(by('cover.size')).toMatchObject({ grade: 'error', measured: '400 × 450 pixels', expected: expect.stringContaining('500 pixels') });
    expect(by('cover.approved')).toMatchObject({ grade: 'warning', what: expect.stringContaining('not the approved cover (version 2)') }); // the EPUB carries another cover
    expect(first.results.every((r) => r.what && r.expected !== undefined && r.measured !== undefined)).toBe(true);
    expect(first.results[0]!.grade).toBe('error'); // worst first
    // a waiver needs a reason
    await expect(pre.waive(first.run.id, by('cover.size').seq, ' ')).rejects.toThrow(/reason/);
    // fixed: the EPUB is rebuilt with the right title and the approved cover, and the run clears
    await ownerPc.vault.checkOut('Book Four/book.epub');
    await ownerPc.write('Book Four/book.epub', epub('Dragon Rider', COVER2));
    await ownerPc.vault.checkIn('Book Four/book.epub', 'Fixed export');
    s.advance();
    const second = await pre.run(epubFile, edition.id);
    if (!second.available) throw new Error(second.reason);
    expect(second.run).toMatchObject({ ready: true, errors: 0, fileVersion: 3 });
    expect(second.results.filter((r) => r.grade === 'error')).toEqual([]);
    expect(second.results.map((r) => r.ruleId)).not.toContain('cover.approved'); // the EPUB carries the approved cover
    expect(second.run.notChecked.length).toBeGreaterThan(0); // and says what it did not look at
    // a waiver carries: waive a suggestion, re-run, and it arrives waived
    const sug = second.results.find((r) => r.grade === 'suggestion');
    if (sug) {
      await pre.waive(second.run.id, sug.seq, 'Not for this book.');
      s.advance();
      const third = await pre.run(epubFile, edition.id);
      expect(third.available && third.results.find((r) => r.ruleId === sug.ruleId)).toMatchObject({ state: 'waived', carried: true, waivedReason: 'Not for this book.' });
    }

    // ---- the contract Launch will read: the approved cover, and the newest run
    s.advance();
    const ready = await lea.assets.readiness('b4');
    expect(ready.assets.map((a) => [a.asset.id, a.version, a.licenceExpired])).toEqual([[cover.id, 2, false]]);
    expect(ready.preflight).toMatchObject({ ready: true, fileId: epubFile });
    expect((await ada.assets.readiness('series')).assets.length).toBe(1); // from the series, the books under it

    // ---- a person with no asset role sees nothing: no asset, no brief, no concept, no result
    await expect(fin.assets.list()).rejects.toThrow(/not allowed/);
    await expect(fin.assets.get(cover.id)).rejects.toThrow(/not allowed/);
    await expect(fin.preflight.list()).rejects.toThrow(/not allowed/);
    expect(await fin.briefs.list({ kind: 'cover' }).catch(() => [])).toEqual([]);

    // ---- the Art Director's assistant: reads, looks, pins a note, reads the result; and has no way to decide
    let target: StudioClient | null = adaClient;
    const door = new AssistantDoor(() => target);
    await door.start();
    try {
      s.advance();
      const bot = await assistantFor(door, adaId);
      const names = await bot.tools();
      for (const forbidden of ['approve', 'choose', 'retire', 'waive', 'run', 'decide']) expect(names.filter((n) => n.includes(forbidden)), forbidden).toEqual([]);
      const asset = (await bot.call('asset_read', { asset: 'concept-a.jpg', picture: true, version: 2 }));
      expect(asset.json()).toMatchObject({ id: cover.id, version: 2, approvals: expect.arrayContaining([expect.objectContaining({ version: 2, state: 'approved' })]) });
      expect(asset.content.find((c) => c.type === 'image')!.mimeType).toBe('image/jpeg');
      expect((await bot.call('asset_comment', { kind: 'asset', id: cover.id, version: 2, region: { x: 0.1, y: 0.8, w: 0.8, h: 0.15 }, text: 'The title reads at thumbnail size.' })).json()).toMatchObject({ onVersion: 2, pinned: true });
      const pf = (await bot.call('preflight_read', { file: 'Book Four/book.epub' })).json();
      expect(pf[0]).toMatchObject({ ready: true, fileVersion: 3 });
      expect((await bot.call('asset_where_used', { asset: 'concept-a.jpg' })).json().declared.map((u: { what: string }) => u.what)).toEqual(['Amazon US listing']);
    } finally {
      await door.stop();
    }

    // ---- the optional gates: a stage move holds while there is no approved cover, or an error is open
    const base = (await owner.workflows.list())[0]!;
    const wf = await owner.workflows.create({ name: 'Cover and Preflight before publishing' });
    await owner.workflows.save(wf.id, {
      name: wf.name, description: '',
      stages: base.stages.map((st) => ({ key: st.key, name: st.name, category: st.category, color: st.color })),
      transitions: [{ from: 'editing', to: 'published', roleIds: [], conditions: [{ kind: 'cover_approved' }, { kind: 'preflight_clear' }] }]
    } as never);
    const gate = async (project: string) => {
      s.advance();
      const facts: ProjectFacts = { hasManuscript: true, openNotes: 0, subprojects: [], openTasks: 0, approved: [], art: await lea.work.artFacts([project]) };
      return (await lea.workflows.stageOptions(wf.id, 'editing', facts)).options.find((o) => o.key === 'published')!;
    };
    expect(await gate('b4')).toMatchObject({ allowed: true });
    expect(await gate('b1')).toMatchObject({ allowed: false, reasons: ['Needs an approved cover', 'Needs a Preflight check'] }); // Book One has neither
    // an error in the newest run holds the move on Book Four again
    await ownerPc.vault.checkOut('Book Four/book.epub');
    await ownerPc.write('Book Four/book.epub', epub('Dragon Rider Three', COVER2));
    await ownerPc.vault.checkIn('Book Four/book.epub', 'A regression');
    await pre.run(epubFile, edition.id);
    expect(await gate('b4')).toMatchObject({ allowed: false, reasons: [expect.stringMatching(/1 Preflight error is still open/)] });

    // ---- and the Art page's own assembly of all this, for the Art Director
    const page = new Art(studioStub, { service: remoteService(adaClient), me: adaId, peopleList: async () => [], mayOn: async () => true } as never, filesOf(await computer(adaClient, 'ada-pc')));
    const state = await page.state('b4');
    if (!state.available) throw new Error(state.reason);
    expect(state.assets.find((a) => a.id === cover.id)).toMatchObject({ approvedNow: 2, state: 'approved', uses: 1, needUpdate: 0 });
    expect(state.briefs[0]).toMatchObject({ title: 'Cover for Book Four', version: 2, concepts: 3, chosen: true });
    void [artId, fileB];
  }, 120_000);
});
