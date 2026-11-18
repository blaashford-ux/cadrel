// The Canon page's main-process side on a Studio's own records: what it assembles for the page, and the calls it carries.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAnchor } from '@cadrel/kernel';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';
import { Canon, CanonError, describeChange } from '../src/main/canon';
import type { EditorialFiles } from '../src/main/editorial';
import { ProjectManager, type WriteFolders } from '../src/main/manage';
import { PeopleHost } from '../src/main/people';
import { ProjectStages } from '../src/main/stages';
import { StudioService } from '../src/main/studio';

let dir: string, host: PeopleHost, studio: StudioService, series: string, book1: string, book4: string, page: Canon;
const BOOK4 = ['Mara walked to the ford with her green eyes narrowed.', 'She counted nine days since the battle.'].join('\n\n');
const texts: Record<string, string> = { 'f4:1': BOOK4, 'f4:2': BOOK4.replace('green eyes', 'grey eyes') };
const files: EditorialFiles = {
  manuscripts: async () => [{ fileId: 'f4', path: 'Book Four/book.md', version: 2 }],
  textOf: async (id, v) => texts[`${id}:${v}`] ?? '',
  versionsOf: async () => [{ n: 2 }, { n: 1 }] as never
};
const write: WriteFolders = {
  projectsRoot: () => '/w', templates: () => [{ id: 'novel', name: 'Novel', description: '' }], listFolders: async () => ({ projects: [], others: [] }),
  createProject: async (n) => ({ path: `/w/${n}` }), renameProject: async (p) => p, duplicateProject: async (_p, n) => ({ path: `/w/${n}` }), deleteProject: async () => undefined,
  readProject: async () => null, updateProject: async () => undefined, convertFolder: async () => undefined, addMissingTemplateParts: async () => [], openProject: () => undefined
};
const me = () => host.service!.as(host.me);
const db = () => (host as unknown as { db: { run(sql: string, p?: unknown[]): Promise<unknown> } }).db;
const ready = async () => {
  const s = await page.state();
  if (!s.available) throw new Error(`canon unavailable: ${s.reason}`);
  return s;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-canon-'));
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  studio = new StudioService({ file: path.join(dir, 'studio.json'), author: () => 'Ana', writeRoot: async () => null, fs: new MemoryFs() });
  host.setProjects(async () => studio.tree()); // as the app does: the records follow the project tree
  const mgr = new ProjectManager(studio, write, new ProjectStages(studio, () => host.workflows, () => host.work));
  series = (await mgr.create({ name: 'Dragon Rider', kind: 'Series', template: null })).id;
  book1 = (await mgr.create({ name: 'Book One', parentId: series, kind: 'Book', template: null })).id;
  book4 = (await mgr.create({ name: 'Book Four', parentId: series, kind: 'Book', template: null })).id;
  await db().run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f4', 'local', 'Book Four/book.md', 2)");
  for (const n of [1, 2]) await db().run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f4', ?, ?, 1, 'x', '2026-11-01T00:00:00.000Z')", [n, `h${n}`]);
  await db().run("INSERT INTO file_card (file_id, project_id, fields, updated_at, updated_by) VALUES ('f4', ?, '{}', 'x', 'x')", [book4]);
  page = new Canon(studio, host, files);
});
afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the Canon page', () => {
  it('starts empty, then shows entries with their facts, where each was established, and the proposals waiting', async () => {
    const empty = await ready();
    expect(empty).toMatchObject({ current: { id: series, name: 'Dragon Rider' }, entries: [], proposals: [], waitingOnMe: 0, may: { read: true, propose: true, approve: true } });
    expect(empty.books.map((b) => b.name).sort()).toEqual(['Book Four', 'Book One']); // both books are offered, for saying where a fact was established
    await page.call('apply', [series, { change: 'add_entry', kind: 'character', name: 'Mara', aliases: ['the Ferrywoman'], summary: 'A ferrywoman.' }]);
    const mara = (await ready()).entries[0]!;
    await page.call('apply', [series, { change: 'add_fact', entryId: mara.id, text: 'Mara has grey eyes.', bookProjectId: book1, chapter: 1 }]);
    await page.call('propose', [series, { change: 'add_fact', entryId: mara.id, text: 'Mara limps.' }]);
    const s = await ready();
    expect(s.entries[0]).toMatchObject({ name: 'Mara', aliases: ['the Ferrywoman'], pending: 1 });
    expect(s.entries[0]!.facts.map((f) => [f.text, f.established])).toEqual([['Mara has grey eyes.', 'Dragon Rider / Book One, chapter 1']]);
    const open = s.proposals.filter((p) => p.state === 'open');
    expect(open.map((p) => [p.summary, p.proposerName])).toEqual([['Add a fact about Mara: Mara limps.', 'you']]);
    expect(s.waitingOnMe).toBe(1);
    expect(s.proposals.filter((p) => p.state === 'approved').length).toBe(2); // the two changes made in one step
  });

  it('approves and rejects through the page’s calls, and says why a bad change is refused', async () => {
    await page.call('apply', [series, { change: 'add_entry', kind: 'place', name: 'Harrow', summary: 'A town.' }]);
    const p = await me().canon.propose(series, { change: 'add_entry', kind: 'place', name: 'The ford', summary: 'x' });
    const q = await me().canon.propose(series, { change: 'add_entry', kind: 'place', name: 'Nowhere', summary: 'x' });
    await page.call('approve', [p.id]);
    await page.call('reject', [q.id, 'Not a place in this series.']);
    const s = await ready();
    expect(s.entries.map((e) => e.name)).toEqual(['Harrow', 'The ford']);
    expect(s.proposals.find((x) => x.id === q.id)).toMatchObject({ state: 'rejected', reason: 'Not a place in this series.' });
    await expect(page.call('apply', [series, { change: 'add_entry', kind: 'place', name: 'harrow', summary: 'again' }])).rejects.toThrow(/already has a place called harrow/);
    await expect(page.call('delete', [series])).rejects.toBeInstanceOf(CanonError); // only the page's own calls
    await expect(page.call('approve', [''])).rejects.toBeInstanceOf(CanonError);
  });

  it('describes each kind of change in a sentence', () => {
    const entries = [{ id: 'e1', name: 'Mara' }] as never;
    const facts = [{ id: 'f1', entryId: 'e1', text: 'Mara has grey eyes.' }] as never;
    expect(describeChange({ change: 'add_entry', kind: 'rule', name: 'The price', summary: 'x' }, entries, facts)).toBe('Add the rule The price');
    expect(describeChange({ change: 'supersede_fact', factId: 'f1', text: 'Mara has green eyes.' }, entries, facts)).toBe('Replace “Mara has grey eyes.” with “Mara has green eyes.” (Mara)');
    expect(describeChange({ change: 'retire_fact', factId: 'f1', reason: 'Wrong' }, entries, facts)).toBe('Retire “Mara has grey eyes.”: Wrong');
    expect(describeChange({ change: 'retire_entry', entryId: 'e1', reason: 'Merged' }, entries, facts)).toBe('Retire Mara: Merged');
  });
});

describe('the continuity checks on the page', () => {
  let eyes: string;
  beforeEach(async () => {
    await page.call('apply', [series, { change: 'add_entry', kind: 'character', name: 'Mara', summary: 'x' }]);
    await page.call('apply', [series, { change: 'add_fact', entryId: (await ready()).entries[0]!.id, text: 'Mara has grey eyes.', bookProjectId: book1, chapter: 1 }]);
    eyes = (await ready()).entries[0]!.facts[0]!.id;
  });
  const finding = () => ({ kind: 'contradiction' as const, severity: 'high' as const, confidence: 'high' as const, body: 'Grey, not green.', anchor: makeAnchor(BOOK4, BOOK4.indexOf('green eyes'), BOOK4.indexOf('green eyes') + 10), factIds: [eyes] });

  it('offers the books and manuscripts a check can be started on, starts one, and shows its findings with the passage in its surroundings and the cited canon', async () => {
    const before = await page.continuity();
    if (!before.available) throw new Error('unavailable');
    expect(before.books.map((b) => b.name)).toEqual(['Dragon Rider', 'Dragon Rider / Book Four', 'Dragon Rider / Book One']);
    expect(before.manuscripts).toEqual([{ fileId: 'f4', path: 'Book Four/book.md', version: 2 }]);
    // the page starts a check on version 2 (the newest); here the pinned text is version 1, so pin it that way
    const k = (await page.continuityCall('start', [book4, 'f4'])) as { id: string };
    await db().run("UPDATE continuity_check SET file_version = 1 WHERE id = ?", [k.id]);
    await me().continuity.raise(k.id, [finding()]);
    await me().continuity.deliver(k.id);
    const v = await page.check(k.id);
    if (!v.available) throw new Error('unavailable');
    expect(v.check).toMatchObject({ projectName: 'Dragon Rider / Book Four', runByName: 'you', state: 'delivered', counts: { open: 1 } });
    expect(v.findings[0]!.context).toEqual({ before: 'Mara walked to the ford with her ', quote: 'green eyes', after: ' narrowed.\n\nShe counted nine days since the battle.' });
    expect(v.findings[0]!.facts).toEqual([{ id: eyes, entry: 'Mara', text: 'Mara has grey eyes.', status: 'canon', established: 'Dragon Rider / Book One, chapter 1', sourcePath: null, passage: null }]);
    expect(v.may).toEqual({ decide: true, deliver: true, close: true });
    expect(v.newerVersion).toBe(2); // the file has a version after the one checked
    expect((await page.continuity() as { checks: unknown[] }).checks).toHaveLength(1);
  });

  it('re-checks a later version from the vault’s text: the finding whose passage is gone is fixed; deciding and closing carry through the page', async () => {
    const k = (await page.continuityCall('start', [book4, 'f4'])) as { id: string };
    await db().run('UPDATE continuity_check SET file_version = 1 WHERE id = ?', [k.id]);
    const { raised } = await me().continuity.raise(k.id, [finding(), { ...finding(), anchor: makeAnchor(BOOK4, BOOK4.indexOf('nine days'), BOOK4.indexOf('nine days') + 9), body: 'Nine days is too few.' }]);
    await me().continuity.deliver(k.id);
    const r = (await page.continuityCall('verify', [k.id, 2])) as { fixed: { id: string }[]; remaining: { id: string }[] };
    expect(r.fixed.map((f) => f.id)).toEqual([raised[0]!.id]); // version 2 says "grey eyes"
    expect(r.remaining.map((f) => f.id)).toEqual([raised[1]!.id]);
    await expect(page.continuityCall('close', [k.id])).rejects.toThrow(/still open/);
    await page.continuityCall('decide', [raised[1]!.id, { outcome: 'dismiss', reason: 'It is fast travel.' }]);
    await page.continuityCall('close', [k.id]);
    const v = await page.check(k.id);
    expect(v.available && v.check.state).toBe('closed');
    await expect(page.continuityCall('verify', [k.id, 'x'])).rejects.toBeInstanceOf(CanonError);
    await expect(page.continuityCall('wipe', [k.id])).rejects.toBeInstanceOf(CanonError);
  });

  it('says so for a check that is not there', async () => {
    expect(await page.check('nope')).toMatchObject({ available: false });
  });
});
