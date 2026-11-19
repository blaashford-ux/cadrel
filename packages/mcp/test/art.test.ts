// Art and Preflight through the composed server: reading assets and briefs, seeing a picture, pinning a note, reading a Preflight result; and what the assistant may not do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DbVaultStore, bootstrapStudio, type Ctx } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { DirBlobs, memoryStudioDb, type StudioDb } from '@cadrel/store';
import { Studio } from '@cadrel/studio';
import { createCadrelServer, artModule } from '../src/index.js';

const S = 'studio1';
const NOW = () => new Date('2026-11-19T10:00:00.000Z');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x0a, 0x00, 0x06, 0x40, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]); // 1600 × 2560
const PSD = Uint8Array.from([...text('8BPS'), ...be16(1), 0, 0, 0, 0, 0, 0, ...be16(3), ...be32(2), ...be32(2), ...be16(8), ...be16(3), ...be32(0), ...be32(0), ...be32(0), ...be16(0), 10, 200, 30, 90, 20, 120, 40, 60, 150, 70, 30, 220]);

let db: StudioDb, svc: StudioService, studio: Studio, ana: ReturnType<StudioService['as']>, dir: string;
let b4: string, series: string, assetId: string, briefId: string;

beforeEach(async () => {
  db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-art-mcp-'));
  studio = new Studio(path.join(dir, 'studio.json'));
  series = (await studio.createProject({ name: 'Dragon Rider', kind: 'Series' })).id;
  b4 = (await studio.createProject({ name: 'Book Four', kind: 'Book', parentId: series })).id;
  svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW, projects: async () => (await studio.read()).tree });
  ana = svc.as('ana');
  const blobs = new DirBlobs(path.join(dir, 'blobs'));
  for (const [id, p, bytes] of [['cov', 'Book Four/Art/cover.jpg', JPEG], ['psd', 'Book Four/Art/cover.psd', PSD], ['epub', 'Book Four/book.epub', new TextEncoder().encode('not really')]] as const) {
    const hash = await blobs.put(bytes);
    expect(hash).toBe(sha(bytes));
    await db.run('INSERT INTO vault_file (id, studio_id, path, current_version) VALUES (?, ?, ?, 1)', [id, S, p]);
    await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES (?, 1, ?, ?, 'ana', '2026-11-01T00:00:00.000Z')", [id, hash, bytes.length]);
    await db.run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES (?, ?, '{}', 'x', 'x')", [id, b4]);
  }
  assetId = (await ana.assets.create({ projectId: b4, fileId: 'cov', kind: 'cover', name: 'Cover', licence: { kind: 'stock', licensor: 'Pixel Co', expires: '2026-12-01' } })).id;
  await ana.assets.approve(assetId, 1, 'Good.');
  await ana.assets.addUse(assetId, { kind: 'listing', label: 'Amazon US' });
  briefId = (await ana.briefs.create({ projectId: b4, kind: 'cover', title: 'Cover for Book Four', body: 'A dragon at dusk.' })).id;
  await ana.assets.submitConcept({ briefId, fileId: 'psd' });
});

async function connect(personId = 'ana') {
  const server = createCadrelServer({ modules: [artModule({ service: svc, personId, studio, vault: new DbVaultStore({ db, studioId: S, personId }), blobs: new DirBlobs(path.join(dir, 'blobs')) })] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-ai', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
    const t = r.content[0]?.text ?? '';
    return { isError: !!r.isError, text: t, content: r.content, json: () => JSON.parse(t) };
  };
  return { client, call };
}

describe('the art tools', () => {
  it('lists assets with their approved versions and licence, and reads one with who approved what', async () => {
    const { call } = await connect();
    const list = (await call('asset_list', { project: 'Dragon Rider / Book Four' })).json();
    expect(list).toEqual([expect.objectContaining({ id: assetId, name: 'Cover', kind: 'cover', state: 'approved', book: 'Dragon Rider / Book Four', file: 'Book Four/Art/cover.jpg', newestVersion: 1, approvedVersions: [1], licence: expect.objectContaining({ kind: 'stock', expires: '2026-12-01', daysLeft: 12 }) })]);
    const one = (await call('asset_read', { asset: 'Cover' })).json();
    expect(one).toMatchObject({ id: assetId, version: 1, approvals: [{ version: 1, state: 'approved', by: 'me', at: '2026-11-19', note: 'Good.' }] });
    expect((await call('asset_read', { asset: 'nothing like it' })).isError).toBe(true);
  });

  it('shows the picture of a version: a JPEG as it is, a Photoshop file by the picture inside it', async () => {
    const { call } = await connect();
    const r = await call('asset_read', { asset: 'Cover', picture: true });
    const img = r.content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/jpeg');
    expect(Buffer.from(img.data!, 'base64')).toEqual(Buffer.from(JPEG));
    const psdAsset = await ana.assets.create({ projectId: b4, fileId: 'psd', kind: 'cover', name: 'Layered cover' });
    const p = await call('asset_read', { asset: psdAsset.id, picture: true });
    expect(p.content.find((c) => c.type === 'image')!.mimeType).toBe('image/png');
    const none = await call('asset_read', { asset: 'Cover', picture: true, version: 9 });
    expect(none.json().picture).toMatch(/not on this computer/);
  });

  it('says where an asset is used, and reads the briefs with their concepts', async () => {
    const { call } = await connect();
    expect((await call('asset_where_used', { asset: 'Cover' })).json()).toMatchObject({ declared: [{ what: 'Amazon US', kind: 'listing', version: 'the latest approved', state: 'current' }], files: [] });
    const briefs = (await call('brief_read', { project: 'Book Four' })).json();
    expect(briefs).toEqual([expect.objectContaining({ title: 'Cover for Book Four', kind: 'cover', version: 1, brief: 'A dragon at dusk.', concepts: [expect.objectContaining({ file: 'Book Four/Art/cover.psd', fileVersion: 1, againstBriefVersion: 1, state: 'submitted' })] })]);
    expect((await call('brief_read', { brief: 'no such brief' })).isError).toBe(true);
  });

  it('pins a note to a region at an exact version, which a person sees with the assistant noted; a region outside the picture is refused', async () => {
    const { call } = await connect();
    const r = (await call('asset_comment', { kind: 'asset', id: assetId, version: 1, region: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, text: 'The title is low contrast against the sky.' })).json();
    expect(r).toMatchObject({ onVersion: 1, pinned: true });
    expect(await ana.assets.feedback('asset', assetId)).toEqual([expect.objectContaining({ body: 'The title is low contrast against the sky.', fileVersion: 1, region: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } })]);
    const bad = await call('asset_comment', { kind: 'asset', id: assetId, region: { x: 0.9, y: 0, w: 0.5, h: 0.1 }, text: 'x' });
    expect(bad.isError).toBe(true);
    expect((await call('asset_comment', { kind: 'asset', id: 'nope', text: 'x' })).isError).toBe(true);
  });

  it('reads the latest Preflight result for an EPUB, with what was measured and what was not checked; with none run it says so', async () => {
    const { call } = await connect();
    expect((await call('preflight_read', { file: 'Book Four/book.epub' })).json()).toMatchObject({ note: expect.stringContaining('No Preflight run') });
    const run = await ana.preflight.record({ projectId: b4, fileId: 'epub', fileVersion: 1, fileHash: 'h', packId: 'kdp-ebook', packVersion: '1', packVerified: '2026-11-19', notChecked: ['Print interiors'], findings: [{ ruleId: 'cover.size', grade: 'error', what: 'The cover is too small to be accepted.', location: 'OEBPS/cover.jpg', measured: '400 × 450 pixels', expected: 'at least 500 pixels' }] });
    await ana.preflight.waive(run.run.id, 1, 'Accepted.');
    await ana.preflight.record({ projectId: b4, fileId: 'epub', fileVersion: 1, fileHash: 'h', packId: 'kdp-ebook', packVersion: '1', packVerified: '2026-11-19', notChecked: ['Print interiors'], findings: [{ ruleId: 'nav.link', grade: 'error', what: 'A contents entry points nowhere.', measured: 'gone.xhtml', expected: 'a file in the EPUB' }, { ruleId: 'meta.keywords', grade: 'suggestion', what: 'Not all seven keyword slots are used.' }] });
    const out = (await call('preflight_read', { file: 'book.epub' })).json();
    expect(out).toEqual([expect.objectContaining({ file: 'Book Four/book.epub', ready: false, counts: { errors: 1, warnings: 0, suggestions: 1 }, notChecked: ['Print interiors'], rules: expect.stringContaining('kdp-ebook version 1') })]);
    expect(out[0].results.map((x: { rule: string; grade: string }) => [x.grade, x.rule])).toEqual([['error', 'nav.link'], ['suggestion', 'meta.keywords']]);
    expect(out[0].results[0]).toMatchObject({ measured: 'gone.xhtml', expected: 'a file in the EPUB' });
    expect((await call('preflight_read', { project: 'Dragon Rider' })).json()).toHaveLength(1);
  });

  it('has no way to approve, choose, retire, run or waive', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['asset_comment', 'asset_list', 'asset_read', 'asset_where_used', 'brief_read', 'preflight_read']);
  });

  it('is refused for a person whose role does not include the assistant, and when the Studio has turned it off', async () => {
    const guest = await ana.people.create({ name: 'Gus' });
    await ana.people.grant({ subject: { kind: 'person', id: guest.id }, roleId: 'role_beta_reader', scope: { kind: 'project', id: b4 } });
    const g = await connect(guest.id);
    expect((await g.call('asset_list')).isError).toBe(true);
    await ana.policy.set({ assistantEnabled: false } as never);
    const a = await connect();
    const off = await a.call('asset_list');
    expect(off.isError).toBe(true);
  });
});
