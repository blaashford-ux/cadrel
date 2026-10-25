/** Self-update from GitHub Releases: finding the newest release and the file that fits this platform. */

export const RELEASES_REPO = 'blaashford-ux/cadrel';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`.toLowerCase();

export type UpdatePlatform = 'windows' | 'android';

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  /** The newest release is newer than the running app. */
  available: boolean;
  /** Release notes (Markdown), possibly empty. */
  notes: string;
  /** The release's page on GitHub. */
  pageUrl: string;
  /** The file for this platform; null if the release doesn't carry one. */
  asset: UpdateAsset | null;
  /** `SHA256SUMS.txt` from the same release, used to check the download. */
  sumsUrl: string | null;
}

export interface UpdateProgress {
  received: number;
  /** 0 when the server doesn't say. */
  total: number;
}

interface ReleaseJson {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  assets?: unknown;
}

const ASSET_PATTERN: Record<UpdatePlatform, RegExp> = {
  windows: /^Cadrel-Setup-.*\.exe$/i,
  android: /^Cadrel-.*\.apk$/i
};

/** [major, minor, patch] plus the pre-release suffix ("beta.1" in "0.5.0-beta.1"), if any. Null if it isn't a version. */
function parseVersion(v: string): { nums: number[]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** Pre-release parts compared the semver way: numbers as numbers ("dev.10" is after "dev.9"), words as text, a longer list after a shorter. */
function comparePre(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]) ? Number(x[i]) : null;
    const ny = /^\d+$/.test(y[i]) ? Number(y[i]) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Negative if a < b, 0 if equal, positive if a > b. Unparseable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1; // 1.0.0-beta is before 1.0.0
  if (y.pre === null) return -1;
  return comparePre(x.pre, y.pre);
}

/** A development build ("0.2.0-dev.14"): it follows the development releases, not the stable ones. */
export const isDevBuild = (version: string): boolean => /-dev(\.|$)/.test(version);

/** Reads GitHub's "latest release" JSON into what the About dialog needs. Throws if it isn't a usable release. */
export function parseRelease(json: unknown, platform: UpdatePlatform, current: string): UpdateInfo {
  const r = (json ?? {}) as ReleaseJson;
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const latest = tag.replace(/^v/, '');
  if (!parseVersion(latest)) throw new Error('GitHub returned a release without a version number.');
  const assets = (Array.isArray(r.assets) ? r.assets : []).flatMap((a): UpdateAsset[] => {
    const o = a as { name?: unknown; browser_download_url?: unknown; size?: unknown };
    return typeof o.name === 'string' && typeof o.browser_download_url === 'string'
      ? [{ name: o.name, url: o.browser_download_url, size: typeof o.size === 'number' ? o.size : 0 }]
      : [];
  });
  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    notes: typeof r.body === 'string' ? r.body : '',
    pageUrl: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${RELEASES_REPO}/releases/latest`,
    asset: assets.find((a) => ASSET_PATTERN[platform].test(a.name)) ?? null,
    sumsUrl: assets.find((a) => a.name === 'SHA256SUMS.txt')?.url ?? null
  };
}

/** Asks GitHub for the newest published (non-draft, non-pre-release) release. */
export async function fetchLatestRelease(fetchFn: typeof fetch, platform: UpdatePlatform, current: string): Promise<UpdateInfo> {
  const res = await fetchFn(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new Error('No release has been published yet.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when asking for the latest release.`);
  return parseRelease(await res.json(), platform, current);
}

/** Only files from this project's releases may be downloaded and run. */
export function isReleaseDownloadUrl(url: string): boolean {
  return url.toLowerCase().startsWith(DOWNLOAD_PREFIX);
}

/** The hash `SHA256SUMS.txt` lists for `fileName` (`sha256sum` format: "<hex>  <name>"), or null. */
export function expectedSha256(sums: string, fileName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  return null;
}

export const RELEASES_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=40`;

/**
 * The release a build should offer: a development build looks only at development releases (pre-releases tagged "-dev.N"), the newest
 * one; a stable build looks only at the newest stable release. Neither is ever offered the other kind.
 */
export async function fetchReleaseFor(fetchFn: typeof fetch, platform: UpdatePlatform, current: string): Promise<UpdateInfo> {
  if (!isDevBuild(current)) return fetchLatestRelease(fetchFn, platform, current);
  const res = await fetchFn(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when asking for the development releases.`);
  const list = (await res.json()) as unknown;
  const dev = (Array.isArray(list) ? list : []).filter((r): r is Record<string, unknown> => {
    const o = r as { draft?: unknown; prerelease?: unknown; tag_name?: unknown };
    return o.draft !== true && o.prerelease === true && typeof o.tag_name === 'string' && isDevBuild(o.tag_name.replace(/^v/, ''));
  });
  if (!dev.length) throw new Error('No development release has been published yet.');
  const newest = dev.reduce((a, b) => (compareVersions(String(b.tag_name), String(a.tag_name)) > 0 ? b : a));
  return parseRelease(newest, platform, current);
}
