import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeopleHost } from '../src/main/people';
import { VAULT_CALL_NAMES, VaultHost, VaultHostError } from '../src/main/vaultHost';

let dir: string, host: PeopleHost, v: VaultHost;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cadrel-vh-'));
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  v = new VaultHost(host, { dir: path.join(dir, 'Vault'), blobsDir: path.join(dir, 'blobs'), machine: 'pc-a' });
});
afterEach(async () => {
  await host.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('the Files page’s vault', () => {
  it('shows the working folder, makes it, and walks a file through add, check-out and check-in', async () => {
    const empty = await v.state();
    if (!empty.available) throw new Error('expected a vault');
    expect(empty).toMatchObject({ dir: path.join(dir, 'Vault'), machine: 'pc-a', entries: [], kept: [], may: { force: true } });
    await fsp.writeFile(path.join(dir, 'Vault', 'ch1.md'), 'one');
    expect((await v.state()).available && (await v.state() as { entries: { status: string }[] }).entries[0]!.status).toBe('untracked');
    await v.call('add', ['ch1.md', 'first']);
    await v.call('checkOut', ['ch1.md']);
    await fsp.writeFile(path.join(dir, 'Vault', 'ch1.md'), 'two');
    expect(await v.call('checkIn', ['ch1.md', 'second'])).toMatchObject({ unchanged: false, version: 2 });
    const st = await v.state();
    if (!st.available) throw new Error('x');
    expect(st.entries[0]).toMatchObject({ path: 'ch1.md', status: 'latest', version: 2 });
    expect((await v.history('ch1.md')).map((h) => h.comment)).toEqual(['second', 'first']);
    expect(st.people.map((p) => p.name)).toEqual(['Ana Reyes']);
  });

  it('gives a file’s versions, references both ways and data card in one read', async () => {
    await v.state(); // makes the working folder
    for (const f of ['book.epub', 'cover.psd']) await fsp.writeFile(path.join(dir, 'Vault', f), f);
    await v.call('add', ['book.epub']);
    await v.call('add', ['cover.psd']);
    await v.call('addReference', ['book.epub', 'cover.psd', 1, 'front cover']);
    await v.call('setCard', ['cover.psd', { Licence: 'Commissioned' }, null]);
    expect(await v.detail('book.epub')).toMatchObject({ uses: [{ path: 'cover.psd', version: 1, note: 'front cover', stale: false }], usedBy: [], card: { fields: {} } });
    expect(await v.detail('cover.psd')).toMatchObject({ usedBy: [{ path: 'book.epub' }], card: { fields: { Licence: 'Commissioned' } }, versions: [{ n: 1 }] });
  });

  it('offers only the changes it lists', async () => {
    for (const bad of ['constructor', '__proto__', 'list', 'read', 'keepOrphansAside', 'orphans']) await expect(v.call(bad, [])).rejects.toThrow(VaultHostError);
    expect(VAULT_CALL_NAMES).toContain('forceRelease');
  });

  it('says so where this computer holds no records', async () => {
    const joined = new PeopleHost();
    await joined.open({ file: path.join(dir, 'j.db'), studioId: 'x', owned: false, ownerName: 'Ana' });
    const j = new VaultHost(joined, { dir: path.join(dir, 'V2'), blobsDir: path.join(dir, 'b2'), machine: 'm' });
    expect(await j.state()).toMatchObject({ available: false, reason: expect.stringMatching(/owner/) });
    await expect(j.call('add', ['x.md'])).rejects.toThrow(/owner/);
  });
});
