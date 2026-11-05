// Editorial passes through the composed server: reading them, reading the pinned text, and raising items as the editor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_KEYS, bootstrapStudio, defaultRole, type Ctx } from '@cadrel/kernel';
import { StudioService, dbAccess } from '@cadrel/service';
import { DirBlobs, memoryStudioDb, type StudioDb } from '@cadrel/store';
import { Studio } from '@cadrel/studio';
import { createCadrelServer, editorialModule, findQuote } from '../src/index.js';

const S = 'studio1';
const NOW = () => new Date('2026-11-10T10:00:00.000Z');
const TEXT = 'The river ran cold.\n\nShe walked slowly to the river and stopped.\n\nThe river was loud, and she walked slowly home.';

let db: StudioDb, svc: StudioService, studio: Studio, ana: ReturnType<StudioService['as']>, dir: string, projectId: string, passId: string;

beforeEach(async () => {
  db = memoryStudioDb();
  await bootstrapStudio(db, { studioId: S, actor: 'ana', now: NOW().toISOString() } as Ctx, { id: 'ana', name: 'Ana' });
  svc = new StudioService({ db, studioId: S, access: dbAccess(db, S), now: NOW });
  ana = svc.as('ana');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-edit-mcp-'));
  studio = new Studio(path.join(dir, 'studio.json'));
  projectId = (await studio.createProject({ name: 'Lead Me', kind: 'Book' })).id;
  const hash = await new DirBlobs(path.join(dir, 'blobs')).put(new TextEncoder().encode(TEXT));
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', ?, 'Lead Me/book.md', 1)", [S]);
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 1, ?, ?, 'ana', '2026-11-01T00:00:00.000Z')", [hash, TEXT.length]);
  passId = (await ana.passes.create({ projectId, kind: 'line', fileId: 'f1', editorId: 'ana' })).id;
  await ana.passes.start(passId);
});

async function connect(personId = 'ana', blobs: string | null = path.join(dir, 'blobs')) {
  const server = createCadrelServer({ modules: [editorialModule({ service: svc, personId, studio, db, ...(blobs ? { blobsDir: blobs } : {}) })] });
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
const person = async (name: string, roleKey: string) => {
  const p = await ana.people.create({ name });
  await ana.people.grant({ subject: { kind: 'person', id: p.id }, roleId: `role_${roleKey}`, scope: { kind: 'studio', id: S } });
  return p.id;
};

describe('the editorial tools', () => {
  it('offers four tools, and none that moves a pass along, answers, decides or closes', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['edit_items', 'edit_passes', 'edit_raise', 'edit_read']);
  });

  it('lists passes by project, kind and who edits them, with the counts of items', async () => {
    const { call } = await connect();
    await ana.queries.raise(passId, [{ kind: 'query', body: 'Why?' }, { kind: 'comment', body: 'Nice.' }]);
    const all = (await call('edit_passes')).json();
    expect(all).toEqual([expect.objectContaining({ id: passId, title: 'Line edit', kind: 'line', state: 'in_progress', project: 'Lead Me', file: 'Lead Me/book.md', version: 1, editor: 'me', items: { open: 2, answered: 0, resolved: 0, withdrawn: 0 } })]);
    expect((await call('edit_passes', { project: 'Lead Me' })).json()).toHaveLength(1);
    expect((await call('edit_passes', { project: 'Nope' })).text).toMatch(/There is no project "Nope"/);
    expect((await call('edit_passes', { kind: 'copy' })).json()).toEqual([]);
    expect((await call('edit_passes', { mine: true })).json()).toHaveLength(1);
    const bo = await person('Bo', 'editor');
    await ana.passes.assign(passId, bo);
    expect((await call('edit_passes', { mine: true })).json()).toEqual([]);
    expect((await call('edit_passes', { state: 'closed' })).json()).toEqual([]);
  });

  it('reads the exact text of the version the pass covers, in pieces', async () => {
    const { call } = await connect();
    const first = (await call('edit_read', { pass: passId, length: 25 })).json();
    expect(first).toMatchObject({ file: 'Lead Me/book.md', version: 1, from: 0, to: 25, total: TEXT.length, text: TEXT.slice(0, 25) });
    expect(first.more).toContain('from=25');
    const rest = (await call('edit_read', { pass: passId, from: 25 })).json();
    expect(rest.text).toBe(TEXT.slice(25));
    expect(rest.more).toBeUndefined();
    expect((await call('edit_read', { pass: 'nope' })).text).toMatch(/That pass is not there/);
  });

  it('raises items anchored to the quoted text, numbered, and tells them apart when a quote repeats', async () => {
    const { call } = await connect();
    const r = await call('edit_raise', {
      pass: passId,
      items: [
        { kind: 'query', quote: 'ran cold', text: 'Cold how?', category: 'Clarity' },
        { kind: 'suggestion', quote: 'walked slowly', before: 'She ', replacement: 'crept' },
        { kind: 'comment', text: 'Strong ending overall.' }
      ]
    });
    expect(r.isError).toBe(false);
    expect(r.json().raised.map((x: { n: number; kind: string; passage?: string }) => [x.n, x.kind, x.passage])).toEqual([[1, 'query', 'ran cold'], [2, 'suggestion', 'walked slowly'], [3, 'comment', undefined]]);
    const stored = await ana.queries.list({ passId });
    expect(stored[1]!.anchor).toMatchObject({ quote: 'walked slowly', start: TEXT.indexOf('walked slowly'), prefix: expect.stringContaining('She ') });
    expect(stored[1]!.replacement).toBe('crept');
    expect(stored[0]!.category).toBe('clarity');
    const items = (await call('edit_items', { pass: passId })).json();
    expect(items.items.map((i: { n: number; passage?: string }) => [i.n, i.passage])).toEqual([[1, 'ran cold'], [2, 'walked slowly'], [3, undefined]]);
    const audit = await db.all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'assistant'");
    expect(audit.map((a) => JSON.parse(a.detail).tool)).toEqual(['edit_raise']);
  });

  it('says exactly what is wrong with a quote, and raises nothing if any item is wrong', async () => {
    const { call } = await connect();
    const dup = await call('edit_raise', { pass: passId, items: [{ kind: 'comment', text: 'ok' }, { kind: 'comment', quote: 'walked slowly', text: 'x' }] });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/^Item 2: Quote occurs 2 times/);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'comment', quote: 'walked slowly', after: ' home', text: 'x' }] })).isError).toBe(false);
    const missing = await call('edit_raise', { pass: passId, items: [{ kind: 'comment', quote: 'a quote that is not there', text: 'x' }] });
    expect(missing.text).toMatch(/Quote not found/);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'comment', quote: 'walked slowly', before: 'never', text: 'x' }] })).text).toMatch(/not with the text before\/after/);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'suggestion', replacement: 'x' }] })).text).toMatch(/needs the passage it changes/);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'query' }] })).isError).toBe(true); // a query needs its text
    expect((await ana.queries.list({ passId })).length).toBe(1); // only the one good call above
  });

  it('will not raise in a pass that is not in progress or that someone else edits', async () => {
    const { call } = await connect();
    await ana.passes.deliver(passId);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'comment', text: 'late' }] })).text).toMatch(/while the pass is in progress/);
    const other = (await ana.passes.create({ projectId, kind: 'copy', fileId: 'f1', editorId: await person('Bo', 'editor') })).id;
    await ana.passes.start(other);
    const r = await call('edit_raise', { pass: other, items: [{ kind: 'comment', text: "Ana is not Bo" }] });
    expect(r.isError).toBe(false); // the Owner may act for the editor (edit.assign)
    // someone who runs passes but does not assign editors may not raise items on a pass that is another person's
    const runner = ROLE_KEYS.find((k) => { const c = new Set(defaultRole(k).capabilities); return k !== 'owner' && c.has('edit.read') && c.has('edit.run') && !c.has('edit.assign') && c.has('assistant.use'); });
    if (runner) {
      const denied = await (await connect(await person('Runner', runner))).call('edit_raise', { pass: other, items: [{ kind: 'comment', text: 'x' }] });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/edit\.assign/);
    }
    // and the editor of a pass raises on it as themselves
    const editor = await person('Cy', 'editor');
    const mine = (await ana.passes.create({ projectId, kind: 'proof', fileId: 'f1', editorId: editor })).id;
    await ana.passes.start(mine);
    expect((await (await connect(editor)).call('edit_raise', { pass: mine, items: [{ kind: 'comment', text: 'Mine to raise.' }] })).isError).toBe(false);
  });

  it('cannot read a manuscript where this computer does not say where the vault keeps its files', async () => {
    const { call } = await connect('ana', null);
    expect((await call('edit_read', { pass: passId })).text).toMatch(/did not say where the vault keeps its files/);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'comment', quote: 'ran cold', text: 'x' }] })).isError).toBe(true);
    expect((await call('edit_raise', { pass: passId, items: [{ kind: 'comment', text: 'a point about the whole pass' }] })).isError).toBe(false); // needs no text
    expect((await call('edit_passes')).isError).toBe(false);
  });

  it('says so when the text of that version is not on this computer', async () => {
    fs.rmSync(path.join(dir, 'blobs'), { recursive: true });
    expect((await (await connect()).call('edit_read', { pass: passId })).text).toMatch(/not on this computer/);
  });

  it('shows the author’s answers and decisions, and what the check of the revision found', async () => {
    const { call } = await connect();
    const [q, s] = await ana.queries.raise(passId, [{ kind: 'query', body: 'Why?' }, { kind: 'suggestion', anchor: { quote: 'walked slowly', prefix: '', suffix: '', start: 30 }, replacement: 'crept' }]);
    await ana.passes.deliver(passId);
    await ana.queries.answer(q!.id, 'Because.');
    await ana.queries.decide(s!.id, { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' });
    await ana.passes.respond(passId);
    await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', 2, 'h2', 1, 'ana', '2026-11-12T00:00:00.000Z')");
    await ana.queries.verify(passId, { revisedVersion: 2, revisedText: TEXT });
    const items = (await call('edit_items', { pass: passId })).json().items;
    expect(items[0]).toMatchObject({ n: 1, state: 'answered', answer: 'Because.' });
    expect(items[1]).toMatchObject({ n: 2, decision: { outcome: 'defer', reason: 'Later.', revisit: '2026-12-01' } });
    expect((await call('edit_items', { pass: passId, state: 'answered' })).json().items).toHaveLength(1);
  });

  it('follows the role: no assistant use, no tools; no manuscript right, no text', async () => {
    const guest = await person('Guest', 'guest');
    expect(defaultRole('guest').capabilities).not.toContain('assistant.use');
    expect((await (await connect(guest)).call('edit_passes')).text).toMatch(/assistant\.use/);
    // a role that sees passes and may use the assistant but may not read manuscripts cannot read the text through a tool either
    const gap = ROLE_KEYS.find((k) => { const c = new Set(defaultRole(k).capabilities); return k !== 'owner' && c.has('edit.read') && c.has('assistant.use') && !c.has('manuscript.read'); });
    if (gap) {
      const p = await person('Gap', gap);
      expect((await (await connect(p)).call('edit_read', { pass: passId })).text).toMatch(/manuscript\.read/);
    }
  });
});

describe('finding a quote', () => {
  it('is exact, and says how many it found', () => {
    expect(findQuote(TEXT, 'ran cold')).toBe(TEXT.indexOf('ran cold'));
    expect(() => findQuote(TEXT, '')).toThrow(/must not be empty/);
    expect(() => findQuote(TEXT, 'river')).toThrow(/3 times/);
    expect(findQuote(TEXT, 'river', 'The ', ' was')).toBe(TEXT.lastIndexOf('river'));
    expect(() => findQuote(TEXT, 'Zebra')).toThrow(/not found/);
  });
});
