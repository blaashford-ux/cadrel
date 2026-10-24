import { describe, expect, it } from 'vitest';
import { compareVersions, expectedSha256, fetchLatestRelease, isReleaseDownloadUrl, parseRelease } from './update';

const release = {
  tag_name: 'v0.5.0',
  html_url: 'https://github.com/blaashford-ux/MDEdit/releases/tag/v0.5.0',
  body: 'Notes',
  assets: [
    { name: 'MDEdit-Setup-0.5.0.exe', browser_download_url: 'https://github.com/blaashford-ux/MDEdit/releases/download/v0.5.0/MDEdit-Setup-0.5.0.exe', size: 100 },
    { name: 'MDEdit-0.5.0.apk', browser_download_url: 'https://github.com/blaashford-ux/MDEdit/releases/download/v0.5.0/MDEdit-0.5.0.apk', size: 50 },
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/blaashford-ux/MDEdit/releases/download/v0.5.0/SHA256SUMS.txt', size: 1 }
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
    expect(parseRelease(release, 'windows', '0.4.3').asset?.name).toBe('MDEdit-Setup-0.5.0.exe');
    expect(parseRelease(release, 'android', '0.4.3').asset?.name).toBe('MDEdit-0.5.0.apk');
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
    expect(isReleaseDownloadUrl('https://example.com/MDEdit-Setup-9.9.9.exe')).toBe(false);
    expect(isReleaseDownloadUrl('https://github.com/someone-else/MDEdit/releases/download/v1/x.exe')).toBe(false);
  });
  it('reads a hash out of SHA256SUMS.txt', () => {
    const h = 'a'.repeat(64);
    const sums = `${h}  MDEdit-Setup-0.5.0.exe\n${'B'.repeat(64)} *MDEdit-0.5.0.apk\n`;
    expect(expectedSha256(sums, 'MDEdit-Setup-0.5.0.exe')).toBe(h);
    expect(expectedSha256(sums, 'MDEdit-0.5.0.apk')).toBe('b'.repeat(64));
    expect(expectedSha256(sums, 'other.exe')).toBeNull();
  });
});
