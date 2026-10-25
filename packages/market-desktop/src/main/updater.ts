import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Where releases are published. Fixed in code so the renderer can never point the updater somewhere else. */
export const RELEASE_REPO = 'blaashford-ux/cadrel';
/** The only file name the updater will download and run. */
export const INSTALLER_NAME = /^Cadrel-Setup-\d+\.\d+\.\d+\.exe$/;

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  /** "sha256:<hex>" as reported by GitHub, when it has one. */
  digest: string | null;
  /** API URL of the asset (downloaded with Accept: application/octet-stream). */
  apiUrl: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  tag: string;
  releaseUrl: string;
  notes: string;
  publishedAt: string | null;
  checkedAt: string;
  updateAvailable: boolean;
  /** The Windows installer in the release; null if the release has none (then it can only be opened in the browser). */
  installer: ReleaseAsset | null;
}

export class UpdateError extends Error {}

type Fetch = typeof fetch;

/** Numeric comparison of "1.2.3" style versions (a leading "v" and any "-suffix" are ignored; a suffix sorts below the bare version). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v.trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new UpdateError(`cannot compare versions "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]! ? -1 : 1;
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

const headers = (token: string | null, accept = 'application/vnd.github+json'): Record<string, string> => ({
  accept,
  'user-agent': 'Cadrel Market-updater',
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

function explain(status: number, hasToken: boolean, remaining: string | null): string {
  if (status === 404 || status === 401) {
    return hasToken
      ? 'GitHub says the release is not visible with this token. Check that the token can read the "Contents" of the Cadrel Market repository, and has not expired.'
      : 'GitHub shows no release to anonymous visitors. If the repository is private, add a read-only GitHub token below.';
  }
  if (status === 403 && remaining === '0') return 'GitHub’s request limit has been reached; try again later (a token raises the limit).';
  if (status === 403) return 'GitHub refused the request (403). The token may lack permission to read the repository.';
  return `GitHub answered with an error (${status}).`;
}

export async function checkForUpdate(current: string, opts: { token: string | null; fetch?: Fetch; now?: () => Date }): Promise<UpdateInfo> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: headers(opts.token) });
  } catch (e) {
    throw new UpdateError(`Could not reach GitHub: ${(e as Error).message ?? e}`);
  }
  if (!res.ok) throw new UpdateError(explain(res.status, !!opts.token, res.headers.get('x-ratelimit-remaining')));
  const r = (await res.json()) as {
    tag_name?: string; html_url?: string; body?: string | null; published_at?: string | null; draft?: boolean; prerelease?: boolean;
    assets?: { id: number; name: string; size: number; url: string; digest?: string | null }[];
  };
  if (typeof r.tag_name !== 'string') throw new UpdateError('GitHub’s answer had no version in it.');
  const latest = r.tag_name.replace(/^v/, '');
  const asset = (r.assets ?? []).find((a) => INSTALLER_NAME.test(a.name));
  return {
    current,
    latest,
    tag: r.tag_name,
    releaseUrl: `https://github.com/${RELEASE_REPO}/releases/tag/${encodeURIComponent(r.tag_name)}`,
    notes: (r.body ?? '').slice(0, 4000),
    publishedAt: r.published_at ?? null,
    checkedAt: (opts.now?.() ?? new Date()).toISOString(),
    updateAvailable: compareVersions(latest, current) > 0,
    installer: asset ? { id: asset.id, name: asset.name, size: asset.size, digest: typeof asset.digest === 'string' ? asset.digest : null, apiUrl: `https://api.github.com/repos/${RELEASE_REPO}/releases/assets/${asset.id}` } : null,
  };
}

/**
 * Download the installer into `dir`, checking its size and (when GitHub gives one) its SHA-256. Returns the final path.
 * The check shows the file arrived intact; it does not prove who built it, because the digest comes from the same place.
 */
export async function downloadInstaller(asset: ReleaseAsset, opts: { token: string | null; dir: string; fetch?: Fetch; onProgress?: (done: number, total: number) => void }): Promise<string> {
  if (!INSTALLER_NAME.test(asset.name)) throw new UpdateError('refusing to download a file that is not a Cadrel Market installer');
  if (asset.apiUrl !== `https://api.github.com/repos/${RELEASE_REPO}/releases/assets/${asset.id}`) throw new UpdateError('unexpected download address');
  const f = opts.fetch ?? fetch;
  fs.mkdirSync(opts.dir, { recursive: true });
  const final = path.join(opts.dir, asset.name);
  const part = final + '.part';
  let res: Response;
  try {
    res = await f(asset.apiUrl, { headers: headers(opts.token, 'application/octet-stream'), redirect: 'follow' });
  } catch (e) {
    throw new UpdateError(`Could not reach GitHub: ${(e as Error).message ?? e}`);
  }
  if (!res.ok || !res.body) throw new UpdateError(explain(res.status, !!opts.token, res.headers.get('x-ratelimit-remaining')));
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      hash.update(value);
      done += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      opts.onProgress?.(done, asset.size);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw new UpdateError(`The download was interrupted: ${(e as Error).message ?? e}`);
  }
  const fail = (msg: string) => {
    fs.rmSync(part, { force: true });
    throw new UpdateError(msg);
  };
  if (done !== asset.size) fail(`The download is incomplete (${done} of ${asset.size} bytes).`);
  const sum = hash.digest('hex');
  if (asset.digest && asset.digest.toLowerCase() !== `sha256:${sum}`) fail('The downloaded file does not match the checksum GitHub lists for it, so it was discarded.');
  fs.renameSync(part, final);
  return final;
}
