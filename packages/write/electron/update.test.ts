import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateInfo } from '../src/shared/update';
import { checkBeforeLaunch, downloadInstaller } from './update';

const BASE = 'https://github.com/blaashford-ux/MDEdit/releases/download/v0.5.0/';
const bytes = Buffer.from('pretend installer');
const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: '0.4.3',
  latest: '0.5.0',
  available: true,
  notes: '',
  pageUrl: '',
  asset: { name: 'MDEdit-Setup-0.5.0.exe', url: BASE + 'MDEdit-Setup-0.5.0.exe', size: bytes.length },
  sumsUrl: BASE + 'SHA256SUMS.txt',
  ...over
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const server = (sums: string) =>
  (async (url: string) => (String(url).endsWith('SHA256SUMS.txt') ? new Response(sums) : new Response(bytes))) as unknown as typeof fetch;

let dir: string;
beforeEach(async () => void (dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdedit-upd-'))));
afterEach(async () => fsp.rm(dir, { recursive: true, force: true }));

describe('downloadInstaller', () => {
  it('saves the installer when its checksum matches, reporting progress', async () => {
    const seen: number[] = [];
    const file = await downloadInstaller(info(), { fetchFn: server(`${sha(bytes)}  MDEdit-Setup-0.5.0.exe\n`), dir, onProgress: (p) => seen.push(p.received) });
    expect(await fsp.readFile(file)).toEqual(bytes);
    expect(seen.at(-1)).toBe(bytes.length);
  });
  it('deletes a download that fails the checksum', async () => {
    await expect(downloadInstaller(info(), { fetchFn: server(`${'0'.repeat(64)}  MDEdit-Setup-0.5.0.exe\n`), dir, onProgress: () => undefined })).rejects.toThrow(/checksum/);
    expect(await fsp.readdir(dir)).toEqual([]);
  });
  it('refuses a download that arrives short, and leaves nothing behind', async () => {
    const short = info({ asset: { name: 'MDEdit-Setup-0.5.0.exe', url: BASE + 'MDEdit-Setup-0.5.0.exe', size: bytes.length + 10 } });
    await expect(downloadInstaller(short, { fetchFn: server(`${sha(bytes)}  MDEdit-Setup-0.5.0.exe\n`), dir, onProgress: () => undefined })).rejects.toThrow(/cut short/);
    expect(await fsp.readdir(dir)).toEqual([]);
  });
  it('only gives the installer its real name once it is complete and verified', async () => {
    const during: string[][] = [];
    const file = await downloadInstaller(info(), {
      fetchFn: server(`${sha(bytes)}  MDEdit-Setup-0.5.0.exe\n`),
      dir,
      onProgress: () => void fsp.readdir(dir).then((names) => during.push(names))
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(during.flat().some((n) => n === 'MDEdit-Setup-0.5.0.exe')).toBe(false);
    expect(during.flat().some((n) => n.endsWith('.partial'))).toBe(true);
    expect(await fsp.readdir(dir)).toEqual([path.basename(file)]);
  });
  it('joins a download that is already running instead of writing the same file twice', async () => {
    let installerFetches = 0;
    const counting = (async (url: string) => {
      if (String(url).endsWith('SHA256SUMS.txt')) return new Response(`${sha(bytes)}  MDEdit-Setup-0.5.0.exe\n`);
      installerFetches += 1;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(bytes);
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([downloadInstaller(info(), { fetchFn: counting, dir, onProgress: () => undefined }), downloadInstaller(info(), { fetchFn: counting, dir, onProgress: () => undefined })]);
    expect(a).toBe(b);
    expect(installerFetches).toBe(1);
    expect(await fsp.readFile(a)).toEqual(bytes);
  });
  it('clears out earlier installers and abandoned partial downloads', async () => {
    await fsp.writeFile(path.join(dir, 'MDEdit-Setup-0.4.3.exe'), 'old');
    await fsp.writeFile(path.join(dir, 'MDEdit-Setup-0.5.0.exe.deadbeef.partial'), 'half');
    const file = await downloadInstaller(info(), { fetchFn: server(`${sha(bytes)}  MDEdit-Setup-0.5.0.exe\n`), dir, onProgress: () => undefined });
    expect(await fsp.readdir(dir)).toEqual([path.basename(file)]);
  });
  it('refuses files from anywhere but the project’s releases', async () => {
    const bad = info({ asset: { name: 'x.exe', url: 'https://example.com/x.exe', size: 1 } });
    await expect(downloadInstaller(bad, { fetchFn: server(''), dir, onProgress: () => undefined })).rejects.toThrow(/outside/);
  });
  it('needs an installer in the release', async () => {
    await expect(downloadInstaller(info({ asset: null }), { fetchFn: server(''), dir, onProgress: () => undefined })).rejects.toThrow(/no Windows installer/);
  });
});

describe('checkBeforeLaunch', () => {
  it('accepts the file that was downloaded and refuses one that changed afterwards', async () => {
    const file = await downloadInstaller(info(), { fetchFn: server(`${sha(bytes)}  MDEdit-Setup-0.5.0.exe\n`), dir, onProgress: () => undefined });
    await expect(checkBeforeLaunch(file)).resolves.toContain(sha(bytes));
    await fsp.appendFile(file, 'x');
    await expect(checkBeforeLaunch(file)).rejects.toThrow(/changed after it was downloaded/);
  });
});
