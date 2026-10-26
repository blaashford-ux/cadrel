import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, downloadInstaller, INSTALLER_NAME, type ReleaseAsset } from '../src/main/updater.js';

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-upd-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const release = (tag: string, assets: object[] = [{ id: 7, name: `Cadrel-Setup-${tag.replace('v', '')}.exe`, size: 10, url: 'x', digest: null }]) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: 'x', body: 'Notes', published_at: '2026-10-19T00:00:00Z', assets }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.1.1', '0.2.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });
  it('refuses what it cannot read', () => {
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/cannot compare/);
  });
});

describe('checkForUpdate', () => {
  it('finds a newer release and its installer, sending the token only to GitHub', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const info = await checkForUpdate('0.2.0', {
      token: 'github_pat_abcdefghijklmnopqrstuv',
      fetch: (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string> }; return release('v0.3.0'); }) as unknown as typeof fetch,
    });
    expect(seen!.url).toBe('https://api.github.com/repos/blaashford-ux/cadrel/releases/latest');
    expect(seen!.headers.authorization).toBe('Bearer github_pat_abcdefghijklmnopqrstuv');
    expect(info).toMatchObject({ current: '0.2.0', latest: '0.3.0', updateAvailable: true, notes: 'Notes' });
    expect(info.installer).toMatchObject({ name: 'Cadrel-Setup-0.3.0.exe', apiUrl: 'https://api.github.com/repos/blaashford-ux/cadrel/releases/assets/7' });
    expect(info.releaseUrl).toBe('https://github.com/blaashford-ux/cadrel/releases/tag/v0.3.0');
  });
  it('says there is nothing newer, and tolerates a release with no installer', async () => {
    const same = await checkForUpdate('0.2.0', { token: null, fetch: (async () => release('v0.2.0')) as unknown as typeof fetch });
    expect(same.updateAvailable).toBe(false);
    const none = await checkForUpdate('0.2.0', { token: null, fetch: (async () => release('v0.3.0', [{ id: 1, name: 'cadrel-market-extension.zip', size: 5, url: 'x' }])) as unknown as typeof fetch });
    expect(none.installer).toBeNull();
  });
  it('explains a private repository, a bad token, a rate limit and a dead network', async () => {
    const status = (n: number, h: Record<string, string> = {}) => (async () => new Response('{}', { status: n, headers: h })) as unknown as typeof fetch;
    await expect(checkForUpdate('0.2.0', { token: null, fetch: status(404) })).rejects.toThrow(/private.*token/);
    await expect(checkForUpdate('0.2.0', { token: 'x'.repeat(30), fetch: status(404) })).rejects.toThrow(/not visible with this token/);
    await expect(checkForUpdate('0.2.0', { token: null, fetch: status(403, { 'x-ratelimit-remaining': '0' }) })).rejects.toThrow(/limit/);
    await expect(checkForUpdate('0.2.0', { token: null, fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch })).rejects.toThrow(/Could not reach GitHub/);
  });
});

describe('downloadInstaller', () => {
  const body = Buffer.from('MZ pretend installer '.repeat(50));
  const asset = (over: Partial<ReleaseAsset> = {}): ReleaseAsset => ({ id: 7, name: 'Cadrel-Setup-0.3.0.exe', size: body.length, digest: 'sha256:' + crypto.createHash('sha256').update(body).digest('hex'), apiUrl: 'https://api.github.com/repos/blaashford-ux/cadrel/releases/assets/7', ...over });
  const serve = (b: Buffer, calls: { url: string; headers: Record<string, string> }[] = []) => (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return new Response(new Uint8Array(b), { status: 200 }); }) as unknown as typeof fetch;

  it('downloads, reports progress, verifies the checksum and leaves one file', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const progress: number[] = [];
    const file = await downloadInstaller(asset(), { token: 'tok', dir, fetch: serve(body, calls), onProgress: (d) => progress.push(d) });
    expect(file).toBe(path.join(dir, 'Cadrel-Setup-0.3.0.exe'));
    expect(fs.readFileSync(file).equals(body)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['Cadrel-Setup-0.3.0.exe']);
    expect(progress.at(-1)).toBe(body.length);
    expect(calls[0]!.headers.accept).toBe('application/octet-stream');
  });
  it('discards a file whose checksum or size is wrong', async () => {
    await expect(downloadInstaller(asset({ digest: 'sha256:' + '0'.repeat(64) }), { token: null, dir, fetch: serve(body) })).rejects.toThrow(/does not match the checksum/);
    await expect(downloadInstaller(asset({ size: body.length + 5 }), { token: null, dir, fetch: serve(body) })).rejects.toThrow(/incomplete/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('accepts a release without a checksum, but only checks size then', async () => {
    const file = await downloadInstaller(asset({ digest: null }), { token: null, dir, fetch: serve(body) });
    expect(fs.existsSync(file)).toBe(true);
  });
  it('refuses anything that is not a Cadrel Market installer from the expected address', async () => {
    expect(INSTALLER_NAME.test('Cadrel-Setup-0.3.0.exe')).toBe(true);
    expect(INSTALLER_NAME.test('evil.exe')).toBe(false);
    await expect(downloadInstaller(asset({ name: 'evil.exe' }), { token: null, dir, fetch: serve(body) })).rejects.toThrow(/not a Cadrel Market installer/);
    await expect(downloadInstaller(asset({ name: '..\\Cadrel-Setup-0.3.0.exe' }), { token: null, dir, fetch: serve(body) })).rejects.toThrow();
    await expect(downloadInstaller(asset({ apiUrl: 'https://evil.example/a' }), { token: null, dir, fetch: serve(body) })).rejects.toThrow(/unexpected download address/);
  });
  it('reports a failed request', async () => {
    await expect(downloadInstaller(asset(), { token: 'tok', dir, fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch })).rejects.toThrow(/not visible with this token/);
  });
});
