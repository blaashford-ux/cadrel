import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeDrive } from '../src/shared/sync/fakeDrive';
import { createDesktopSync, tokenVault } from './syncHost';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'mdedit-sync-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

/** A reversible "encryption" so tests can check the token is not stored in the clear. */
const crypt = { encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b: Buffer) => Buffer.from(b.toString().replace(/^enc:/, ''), 'base64').toString() };

describe('token vault', () => {
  it('stores the token encrypted and reads it back; null clears it', async () => {
    const file = path.join(tmp(), 'google-token.bin');
    const vault = tokenVault(file, crypt);
    expect(await vault.load()).toBeNull();
    await vault.save('refresh-123');
    expect((await fs.readFile(file, 'utf8')).includes('refresh-123')).toBe(false);
    expect(await vault.load()).toBe('refresh-123');
    await vault.save(null);
    expect(await vault.load()).toBeNull();
  });

  it('refuses to store a token it cannot encrypt', async () => {
    const vault = tokenVault(path.join(tmp(), 't.bin'), { encrypt: () => null, decrypt: crypt.decrypt });
    await expect(vault.save('x')).rejects.toThrow(/can’t protect/);
  });

  it('treats an unreadable token file as signed out', async () => {
    const file = path.join(tmp(), 't.bin');
    await fs.writeFile(file, 'garbage');
    const vault = tokenVault(file, { encrypt: crypt.encrypt, decrypt: () => { throw new Error('wrong user'); } });
    expect(await vault.load()).toBeNull();
  });
});

describe('desktop sync host', () => {
  it('connects through the browser flow, syncs the Root Folder to Drive, and signs out on disconnect', async () => {
    const userData = tmp();
    const root = tmp();
    await fs.mkdir(path.join(root, 'Novel', 'Manuscript'), { recursive: true });
    await fs.writeFile(path.join(root, 'Novel', 'Manuscript', 'Ch 1.md'), '# One\r\nhello');
    const drive = new FakeDrive();
    const trashed: string[] = [];

    const opened: string[] = [];
    const fetched: string[] = [];
    const sync = createDesktopSync({
      userData, root, clientSecret: 'shh', device: 'GGPC', ...crypt,
      openUrl: async (url) => {
        opened.push(url);
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'c');
        back.searchParams.set('state', u.searchParams.get('state')!);
        setTimeout(() => void fetch(back), 5);
      },
      trash: async (p) => void trashed.push(p),
      fetch: (async (url: string) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch,
      makeDrive: () => drive,
    });
    await sync.load();
    const status = await sync.connectSync();

    expect(opened).toHaveLength(1);
    expect(status).toMatchObject({ connected: true, state: 'idle', summary: { uploaded: 1 } });
    expect(drive.read('Novel/Manuscript/Ch 1.md')).toBe('# One\r\nhello');
    expect(await fs.readFile(path.join(userData, 'google-token.bin'))).toBeTruthy(); // the refresh token was kept

    await sync.disconnectSync();
    await expect(fs.stat(path.join(userData, 'google-token.bin'))).rejects.toThrow(); // and is gone after disconnect
    expect(fetched.some((u) => u.includes('/revoke'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'Novel', 'Manuscript', 'Ch 1.md'), 'utf8')).toBe('# One\r\nhello'); // files untouched
  });
});
