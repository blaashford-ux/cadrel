import { describe, expect, it } from 'vitest';
import { compareVersions, expectedSha256, fetchLatestRelease, fetchReleaseFor, isDevBuild, isReleaseDownloadUrl, parseRelease, productOfTag } from './update';

const release = {
  tag_name: 'v0.5.0',
  html_url: 'https://github.com/blaashford-ux/cadrel/releases/tag/v0.5.0',
  body: 'Notes',
  assets: [
    { name: 'Cadrel-Setup-0.5.0.exe', browser_download_url: 'https://github.com/blaashford-ux/cadrel/releases/download/v0.5.0/Cadrel-Setup-0.5.0.exe', size: 100 },
    { name: 'Cadrel-Write-0.5.0.apk', browser_download_url: 'https://github.com/blaashford-ux/cadrel/releases/download/v0.5.0/Cadrel-Write-0.5.0.apk', size: 50 },
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/blaashford-ux/cadrel/releases/download/v0.5.0/SHA256SUMS.txt', size: 1 }
  ]
};

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.4.3', '0.4.3')).toBe(0);
    expect(compareVersions('v0.4.2', '0.4.3')).toBeLessThan(0);
  });
  it('puts a pre-release before its release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });
});

describe('parseRelease', () => {
  it('picks the file for each platform', () => {
    expect(parseRelease(release, 'windows', '0.4.3').asset?.name).toBe('Cadrel-Setup-0.5.0.exe');
    expect(parseRelease(release, 'android', '0.4.3').asset?.name).toBe('Cadrel-Write-0.5.0.apk');
  });
  it('says whether it is newer', () => {
    expect(parseRelease(release, 'windows', '0.4.3').available).toBe(true);
    expect(parseRelease(release, 'windows', '0.5.0').available).toBe(false);
    expect(parseRelease(release, 'windows', '0.6.0').available).toBe(false);
  });
  it('finds the checksum file and tolerates a release without the platform file', () => {
    const info = parseRelease({ ...release, assets: release.assets.slice(1, 3) }, 'windows', '0.4.3');
    expect(info.asset).toBeNull();
    expect(info.sumsUrl).toMatch(/SHA256SUMS\.txt$/);
  });
  it('rejects JSON that is not a release', () => {
    expect(() => parseRelease({ message: 'Not Found' }, 'windows', '0.4.3')).toThrow();
  });
});

describe('fetchLatestRelease', () => {
  it('reports a missing release and server errors', async () => {
    const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(fetchLatestRelease(reply(404), 'windows', '0.4.3')).rejects.toThrow(/No release/);
    await expect(fetchLatestRelease(reply(500), 'windows', '0.4.3')).rejects.toThrow(/500/);
    expect((await fetchLatestRelease(reply(200, release), 'android', '0.4.3')).latest).toBe('0.5.0');
  });
});

describe('download safety', () => {
  it('only accepts this project’s release downloads', () => {
    expect(isReleaseDownloadUrl(release.assets[0].browser_download_url)).toBe(true);
    expect(isReleaseDownloadUrl('https://example.com/Cadrel-Setup-9.9.9.exe')).toBe(false);
    expect(isReleaseDownloadUrl('https://github.com/someone-else/cadrel/releases/download/v1/x.exe')).toBe(false);
  });
  it('reads a hash out of SHA256SUMS.txt', () => {
    const h = 'a'.repeat(64);
    const sums = `${h}  Cadrel-Setup-0.5.0.exe\n${'B'.repeat(64)} *Cadrel-Write-0.5.0.apk\n`;
    expect(expectedSha256(sums, 'Cadrel-Setup-0.5.0.exe')).toBe(h);
    expect(expectedSha256(sums, 'Cadrel-Write-0.5.0.apk')).toBe('b'.repeat(64));
    expect(expectedSha256(sums, 'other.exe')).toBeNull();
  });
});

describe('development builds follow development releases', () => {
  it('knows a dev build and orders dev numbers as numbers', () => {
    expect(isDevBuild('0.2.0-dev.14')).toBe(true);
    expect(isDevBuild('0.2.0')).toBe(false);
    expect(compareVersions('0.2.0-dev.10', '0.2.0-dev.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-dev.3', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0-dev.3', '0.1.9')).toBeGreaterThan(0);
  });

  const rel = (tag: string, prerelease: boolean, draft = false) => ({ tag_name: tag, prerelease, draft, html_url: `https://x/${tag}`, assets: [{ name: `Cadrel-Setup-${tag}.exe`, browser_download_url: `https://github.com/blaashford-ux/cadrel/releases/download/${tag}/Cadrel-Setup.exe`, size: 1 }] });
  const fetchWith = (list: unknown[]) => (async (url: string) => (String(url).includes('/releases/latest') ? { ok: true, status: 200, json: async () => rel('v0.1.0', false) } : { ok: true, status: 200, json: async () => list })) as unknown as typeof fetch;

  it('a dev build is offered the newest dev release, never a stable one or a draft', async () => {
    const f = fetchWith([rel('v0.3.0', false), rel('v0.2.0-dev.9', true), rel('v0.2.0-dev.12', true), rel('v0.2.0-dev.99', true, true)]);
    const info = await fetchReleaseFor(f, 'windows', '0.2.0-dev.9');
    expect(info.latest).toBe('0.2.0-dev.12');
    expect(info.available).toBe(true);
    expect((await fetchReleaseFor(f, 'windows', '0.2.0-dev.12')).available).toBe(false);
  });

  it('a stable build looks only at the latest stable release', async () => {
    const info = await fetchReleaseFor(fetchWith([rel('v0.2.0-dev.12', true)]), 'windows', '0.0.9');
    expect(info.latest).toBe('0.1.0');
  });

  it('says so when no dev release exists', async () => {
    await expect(fetchReleaseFor(fetchWith([rel('v0.3.0', false)]), 'windows', '0.2.0-dev.1')).rejects.toThrow(/No development release/);
  });
});

describe('Cadrel and Cadrel Reader update separately', () => {
  const rel = (tag: string, prerelease = false, asset = tag.startsWith('reader-') ? `CadrelReader-Setup-${tag.replace(/^reader-v/, '')}.exe` : `Cadrel-Setup-${tag.replace(/^v/, '')}.exe`) => ({
    tag_name: tag,
    prerelease,
    draft: false,
    html_url: `https://github.com/blaashford-ux/cadrel/releases/tag/${tag}`,
    body: '',
    assets: [{ name: asset, browser_download_url: `https://github.com/blaashford-ux/cadrel/releases/download/${tag}/${asset}`, size: 1 }]
  });
  const listing = (rs: object[]) => (async () => ({ ok: true, status: 200, json: async () => rs })) as unknown as typeof fetch;
  const mixed = [rel('reader-v0.9.1'), rel('v0.6.0'), rel('reader-v0.9.0'), rel('v0.5.0'), rel('reader-v0.10.0-dev.4', true), rel('v0.7.0-dev.2', true)];

  it('tells a release’s product from its tag', () => {
    expect(productOfTag('reader-v0.9.0')).toBe('reader');
    expect(productOfTag('v0.5.0')).toBe('cadrel');
    expect(productOfTag('nightly')).toBeNull();
  });

  it('Reader is offered only Reader releases, the newest first by version', async () => {
    const info = await fetchReleaseFor(listing(mixed), 'windows', '0.9.0', 'reader');
    expect(info.latest).toBe('0.9.1');
    expect(info.available).toBe(true);
    expect(info.asset?.name).toBe('CadrelReader-Setup-0.9.1.exe');
  });

  it('Reader’s development builds follow Reader’s development releases only', async () => {
    const info = await fetchReleaseFor(listing(mixed), 'windows', '0.10.0-dev.1', 'reader');
    expect(info.latest).toBe('0.10.0-dev.4');
  });

  it('Cadrel’s development builds never see Reader’s development releases', async () => {
    const info = await fetchReleaseFor(listing(mixed), 'windows', '0.7.0-dev.1');
    expect(info.latest).toBe('0.7.0-dev.2');
  });

  it('Cadrel’s installer pattern does not match Reader’s file, nor the other way round', () => {
    expect(parseRelease(rel('v0.6.0', false, 'CadrelReader-Setup-0.6.0.exe'), 'windows', '0.5.0').asset).toBeNull();
    expect(parseRelease(rel('reader-v0.9.0', false, 'Cadrel-Setup-0.9.0.exe'), 'windows', '0.8.0', 'reader').asset).toBeNull();
  });

  it('refuses a release of the other product', () => {
    expect(() => parseRelease(rel('reader-v0.9.0'), 'windows', '0.8.0')).toThrow(/not for this app/);
    expect(() => parseRelease(rel('v0.6.0'), 'windows', '0.5.0', 'reader')).toThrow(/not for this app/);
  });

  it('says so when Reader has no release yet', async () => {
    await expect(fetchReleaseFor(listing([rel('v0.6.0')]), 'windows', '0.9.0', 'reader')).rejects.toThrow(/No release has been published/);
  });
});
