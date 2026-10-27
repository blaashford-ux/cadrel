// A whole Studio backed up and restored as a new Studio: the records (people, books, tasks, the vault's versions) and the vault's working
// folder must come back, under the new Studio's own id.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, describeBackup, restoreBackup, studioBackupSources, studioRestoreTargets } from '../src/main/backup';
import { PeopleHost } from '../src/main/people';
import { VaultHost } from '../src/main/vaultHost';
import { ProjectWork } from '../src/main/projectWork';
import { StudioService } from '../src/main/studio';
import { MemoryFs } from '@cadrel/write/src/shared/memoryFs';

const dirs: string[] = [];
const hosts: PeopleHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'cadrel-bk-'));
  dirs.push(d);
  return d;
};
const exists = (p: string) => stat(p).then(() => true, () => false);

describe('a whole Studio, backed up and restored as a new Studio', () => {
  it('brings back the records, the vault’s versions and its working folder, under the new Studio’s id', async () => {
    // the Studio as it was: records, a project with a task, a book, a vault file checked in and one checked out with unsaved work
    const old = await tmp();
    const studioDir = path.join(old, 'userdata', 'studios', 'old-id');
    const studioFolder = path.join(old, 'Cadrel', 'Old');
    const people = new PeopleHost();
    hosts.push(people);
    await people.open({ file: path.join(studioDir, 'records.db'), studioId: 'old-id', owned: true, ownerName: 'Ana Reyes' });
    const svc = new StudioService({ file: path.join(studioDir, 'studio.json'), author: () => 'Ana', writeRoot: async () => null, fs: new MemoryFs() });
    const project = await svc.createProject({ name: 'Dragon Rider' });
    await new ProjectWork(svc, people).call('createTask', [{ projectId: project.id, title: 'Edit pass', due: '2026-12-01' }]);
    const as = people.service!.as(people.me);
    const book = await as.catalogue.createBook({ title: 'Lead Me', penName: 'Blake' });
    await as.catalogue.addEdition(book.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    await as.business.addShare({ subject: { kind: 'book', id: book.id }, personId: people.me, shareBp: 5000, fromDate: '2026-01-01' });
    const vault = new VaultHost(people, { dir: path.join(studioFolder, 'Vault'), blobsDir: path.join(studioDir, 'vault-blobs'), machine: 'pc' });
    await vault.state();
    await writeFile(path.join(studioFolder, 'Vault', 'ch1.md'), 'chapter one');
    await vault.call('add', ['ch1.md', 'first']);
    await vault.call('checkOut', ['ch1.md']);
    await writeFile(path.join(studioFolder, 'Vault', 'ch1.md'), 'unsaved edits');
    await mkdir(path.join(old, 'Projects', 'Dragon Rider'), { recursive: true });
    await writeFile(path.join(old, 'Projects', 'Dragon Rider', 'Book.md'), '# One');

    // back up exactly as the app does: a snapshot of the records, not the live file and its log
    const stage = await tmp();
    expect(await people.snapshot(path.join(stage, 'records.db'))).toBe(true);
    const file = path.join(old, 'studio.cadrel-backup');
    await createBackup({ file, studio: { id: 'old-id', name: 'Old' }, appVersion: 't', schema: 1, recordsSchema: 10, sources: studioBackupSources({ studioDir, stage, vaultDir: path.join(studioFolder, 'Vault'), projectsDir: path.join(old, 'Projects') }) });
    const d = await describeBackup(file);
    expect(d.sources).toEqual(['data', 'records', 'Vault', 'Projects']);
    expect(d.records).toBe(10);
    expect(d.entries.map((e) => e.path).filter((p) => /records\.db/.test(p))).toEqual(['records/records.db']); // no live file, no -wal, no -shm

    // restore as a new Studio with a different id
    const fresh = await tmp();
    const newDir = path.join(fresh, 'userdata', 'studios', 'new-id');
    const newFolder = path.join(fresh, 'Cadrel', 'Restored');
    await restoreBackup({ file, maxSchema: 99, targets: studioRestoreTargets(d.sources, { studioDir: newDir, studioFolder: newFolder }) });
    expect(await exists(path.join(newDir, 'records.db'))).toBe(true);
    expect(await readFile(path.join(newFolder, 'Projects', 'Dragon Rider', 'Book.md'), 'utf8')).toBe('# One');
    expect(await readFile(path.join(newFolder, 'Vault', 'ch1.md'), 'utf8')).toBe('unsaved edits'); // the checked-out work is in the backup

    // the restored Studio opens with its own new id and finds everything (this used to start a second, empty Studio in the file and fail)
    const restored = new PeopleHost();
    hosts.push(restored);
    await restored.open({ file: path.join(newDir, 'records.db'), studioId: 'new-id', owned: true, ownerName: 'Someone Else' });
    expect(restored.me).toBe(people.me);
    const again = restored.service!.as(restored.me);
    expect((await again.catalogue.books()).map((b) => [b.title, b.editions[0]?.asin])).toEqual([['Lead Me', 'B0AAAAAAA1']]);
    expect((await again.people.list()).map((p) => p.name)).toEqual(['Ana Reyes']); // not "Someone Else"
    expect((await again.work.tasks({})).map((t) => t.title)).toEqual(['Edit pass']);
    expect((await again.business.shares({})).map((s) => s.shareBp)).toEqual([5000]);
    const rv = new VaultHost(restored, { dir: path.join(newFolder, 'Vault'), blobsDir: path.join(newDir, 'vault-blobs'), machine: 'pc' });
    const st = await rv.state();
    if (!st.available) throw new Error('expected a vault');
    expect(st.entries.map((e) => [e.path, e.status, e.modified])).toEqual([['ch1.md', 'checked-out-by-me', true]]);
    expect((await rv.history('ch1.md')).map((v) => v.comment)).toEqual(['first']);
    expect(new TextDecoder().decode(await (restored.vault({ dir: path.join(newFolder, 'Vault'), blobsDir: path.join(newDir, 'vault-blobs'), machine: 'pc' })!.read('ch1.md')))).toBe('chapter one');
    expect(await restored.workflowState()).toMatchObject({ available: true, workflows: [{ name: 'Writing and publishing' }] });
  });

  it('restores an older backup that has no records or vault part', () => {
    expect(studioRestoreTargets(['data', 'Projects'], { studioDir: '/d', studioFolder: '/f' })).toEqual({ data: '/d', Projects: '/f/Projects' });
  });
});
