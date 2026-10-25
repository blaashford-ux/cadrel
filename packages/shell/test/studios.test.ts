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

describe('StudioRegistry', () => {
  it('starts with the Studio on this computer, active and connected, and the Studio Manager off', async () => {
    const { r } = await registry();
    const v = r.view();
    expect(v).toMatchObject({ managerEnabled: false, activeId: LOCAL_ID, connected: true });
    expect(v.studios).toHaveLength(1);
    expect(v.studios[0]).toMatchObject({ id: LOCAL_ID, role: 'owner', status: 'local' });
  });

  it('creates owned Studios with unique names, and switching to one that has no data here says it is not connected', async () => {
    const { r } = await registry();
    r.create('  Acme Books ');
    const acme = r.view().studios[1]!;
    expect(acme).toMatchObject({ name: 'Acme Books', role: 'owner', status: 'not-provisioned' });
    expect(() => r.create('acme books')).toThrow(/already a Studio/);
    expect(() => r.create('   ')).toThrow(/name/);
    expect(r.setActive(acme.id).connected).toBe(false);
    expect(r.setActive(LOCAL_ID).connected).toBe(true);
    expect(() => r.setActive('nope')).toThrow(StudioRegistryError);
  });

  it('checks the Cloudflare details, records only the account, and never writes the token down', async () => {
    const { r, file } = await registry();
    r.create('Acme');
    const id = r.view().studios[1]!.id;
    expect(() => r.provision(id, { accountId: 'short', apiToken: TOKEN })).toThrow(/account ID/);
    expect(() => r.provision(id, { accountId: ACCOUNT, apiToken: 'too short' })).toThrow(/API token/);
    const v = r.provision(id, { accountId: ACCOUNT.toUpperCase(), apiToken: TOKEN });
    expect(v.studios[1]).toMatchObject({ accountId: ACCOUNT, status: 'not-provisioned' });
    expect(v.studios[1]!.note).toMatch(/not connected/);
    await r.flush();
    const disk = await readFile(file, 'utf8');
    expect(disk).not.toContain(TOKEN);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(() => r.provision(LOCAL_ID, { accountId: ACCOUNT, apiToken: TOKEN })).toThrow(/no server/);
  });

  it('renames and removes Studios, keeps the local one, and falls back to it when the active one goes', async () => {
    const { r } = await registry();
    r.create('Acme');
    const id = r.view().studios[1]!.id;
    r.setActive(id);
    expect(r.rename(id, 'Acme Press').studios[1]!.name).toBe('Acme Press');
    expect(() => r.rename(id, 'My Studio')).toThrow(/already/);
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
  });

  it('only lets an owner manage a Studio', async () => {
    const { r } = await registry();
    const f = sanitizeStudios({ studios: [{ id: 'invited', name: 'Their Studio', role: 'member', status: 'ready' }] });
    expect(f.studios[1]).toMatchObject({ role: 'member' });
    (r as unknown as { data: unknown }).data = f;
    expect(() => r.rename('invited', 'Mine')).toThrow(/Studios you own/);
    expect(() => r.provision('invited', { accountId: ACCOUNT, apiToken: TOKEN })).toThrow(/Studios you own/);
    expect(r.setActive('invited').connected).toBe(true);
  });
});
