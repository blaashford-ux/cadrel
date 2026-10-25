import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_ID, sanitizeStudios, StudioRegistry, StudioRegistryError } from '../src/main/studios';

async function registry() {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'cadrel-studios-')), 'studios.json');
  const r = new StudioRegistry(file);
  await r.load();
  return { r, file };
}
const ACCOUNT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN = 'cf-token-0123456789abcdefghijklmnopqrstuv';
const FP = '0123-4567-89AB-CDEF';

describe('StudioRegistry', () => {
  it('starts with the Studio on this computer, active and connected, and the Studio Manager off', async () => {
    const { r } = await registry();
    const v = r.view();
    expect(v).toMatchObject({ managerEnabled: false, activeId: LOCAL_ID, connected: true });
    expect(v.studios).toHaveLength(1);
    expect(v.studios[0]).toMatchObject({ id: LOCAL_ID, role: 'owner', status: 'local', folderName: 'My Studio' });
  });

  it('creates owned Studios with unique names and a folder of that name, and one that is not built is not connected', async () => {
    const { r } = await registry();
    r.create('  Acme Books ');
    const acme = r.view().studios[1]!;
    expect(acme).toMatchObject({ name: 'Acme Books', folderName: 'Acme Books', role: 'owner', status: 'not-provisioned' });
    expect(acme.id).toMatch(/^s[0-9a-f]{10}$/); // letters and digits: it becomes part of a Worker's name
    expect(() => r.create('acme books')).toThrow(/already a Studio/);
    expect(() => r.create('   ')).toThrow(/name/);
    expect(() => r.create('a/b')).toThrow(); // it is a folder name
    expect(r.setActive(acme.id).connected).toBe(false);
    expect(r.setActive(LOCAL_ID).connected).toBe(true);
    expect(() => r.setActive('nope')).toThrow(StudioRegistryError);
  });

  it('a rename changes the name but not the folder, and the folder name stays reserved', async () => {
    const { r } = await registry();
    r.create('Acme');
    const id = r.view().studios[1]!.id;
    expect(r.rename(id, 'Acme Press').studios[1]).toMatchObject({ name: 'Acme Press', folderName: 'Acme' });
    expect(() => r.create('Acme')).toThrow(/already/); // would share the folder
    expect(() => r.rename(id, 'My Studio')).toThrow(/already/);
  });

  it('checks Cloudflare details by their shape only', () => {
    expect(() => StudioRegistry.checkCredentials({ accountId: 'short', apiToken: TOKEN })).toThrow(/account ID/);
    expect(() => StudioRegistry.checkCredentials({ accountId: ACCOUNT, apiToken: 'too short' })).toThrow(/API token/);
    expect(StudioRegistry.checkCredentials({ accountId: ACCOUNT.toUpperCase(), apiToken: ` ${TOKEN} ` })).toEqual({ accountId: ACCOUNT, apiToken: TOKEN });
  });

  it('records what a build reports, and a Studio is connected once it is ready', async () => {
    const { r, file } = await registry();
    r.create('Acme');
    const id = r.view().studios[1]!.id;
    r.update(id, { status: 'ready', url: 'https://cadrel-studio-x.me.workers.dev', accountId: ACCOUNT, fingerprint: FP, tokenKept: true, resources: { worker: 'w', d1Id: 'd', d1Name: 'dn', bucket: 'b' }, server: { api: 1, schema: 2 } });
    expect(r.setActive(id).connected).toBe(true);
    await r.flush();
    const again = new StudioRegistry(file);
    await again.load();
    expect(again.get(id)).toMatchObject({ status: 'ready', accountId: ACCOUNT, fingerprint: FP, tokenKept: true, resources: { worker: 'w' }, server: { api: 1, schema: 2 } });
    expect(await readFile(file, 'utf8')).not.toContain('apiToken');
  });

  it('adds a Studio the person joined, as a member who cannot manage it', async () => {
    const { r } = await registry();
    r.addMember({ name: 'Their Studio', url: 'https://t.workers.dev', fingerprint: FP, memberRole: 'author', studioId: 'x' });
    const s = r.view().studios[1]!;
    expect(s).toMatchObject({ role: 'member', status: 'ready', memberRole: 'author', folderName: 'Their Studio' });
    expect(() => r.addMember({ name: 'Again', url: 'https://t.workers.dev', fingerprint: FP, memberRole: 'author', studioId: 'x' })).toThrow(/already in that Studio/);
    expect(() => r.rename(s.id, 'Mine')).toThrow(/Studios you own/);
    expect(() => r.update(s.id, { note: 'x' })).toThrow(/Studios you own/);
    expect(r.setActive(s.id).connected).toBe(true);
  });

  it('removes Studios, keeps the local one, and falls back to it when the active one goes', async () => {
    const { r } = await registry();
    r.create('Acme');
    const id = r.view().studios[1]!.id;
    r.setActive(id);
    expect(() => r.remove(LOCAL_ID)).toThrow(/cannot be removed/);
    expect(r.remove(id)).toMatchObject({ activeId: LOCAL_ID, connected: true });
    expect(r.view().studios).toHaveLength(1);
  });

  it('keeps everything across a restart, and reads a damaged file as a fresh start', async () => {
    const { r, file } = await registry();
    r.enableManager(true);
    r.create('Acme');
    r.setActive(r.view().studios[1]!.id);
    await r.flush();
    const again = new StudioRegistry(file);
    await again.load();
    expect(again.view()).toMatchObject({ managerEnabled: true, studios: [{ id: LOCAL_ID }, { name: 'Acme' }] });
    expect(again.view().activeId).toBe(again.view().studios[1]!.id);
    expect(sanitizeStudios('garbage')).toMatchObject({ managerEnabled: false, activeId: LOCAL_ID });
    expect(sanitizeStudios({ activeId: 'gone', studios: [{ id: 'x y' }] }).activeId).toBe(LOCAL_ID);
    // two Studios that would share a folder are kept apart
    const clash = sanitizeStudios({ studios: [{ id: 'a', name: 'Same', folderName: 'Same' }, { id: 'b', name: 'Same', folderName: 'same' }] });
    expect(clash.studios.map((s) => s.folderName)).toEqual(['My Studio', 'Same', 'b']);
  });
});
