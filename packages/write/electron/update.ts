import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expectedSha256, isReleaseDownloadUrl, type UpdateInfo, type UpdateProgress } from '../src/shared/update';

export interface DownloadDeps {
  fetchFn: typeof fetch;
  /** Where the installer is saved (created if missing). */
  dir: string;
  onProgress(p: UpdateProgress): void;
}

/** SHA-256 of a file as it is on disk (reading all of it also lets an antivirus finish scanning it before it is run). */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest('hex');
}

const downloads = new Map<string, Promise<string>>();
/** What each installer looked like when it was verified, to check again just before it is run. */
const verified = new Map<string, { sha256: string; size: number }>();

/**
 * Run just before the installer is started. Reads the whole file again (which also waits out any antivirus scan of the
 * newly renamed file) and compares it with what was verified after the download. Resolves to a one-line description for
 * the update log; rejects when the file is no longer what was downloaded, so a damaged installer is never started.
 */
export async function checkBeforeLaunch(file: string): Promise<string> {
  const before = verified.get(file);
  const st = await fsp.stat(file);
  const sha = await hashFile(file);
  const now = `${st.size} bytes, sha256 ${sha}`;
  if (!before) return `${now} (not downloaded by this session)`;
  if (before.sha256 !== sha || before.size !== st.size) {
    throw new Error(`The installer changed after it was downloaded (${before.size} bytes, sha256 ${before.sha256} then; ${now} now), so it was not run.`);
  }
  return now;
}

/**
 * Downloads the release's installer into `dir`, checks it, and resolves to its path. Only files from this project's
 * releases are fetched. The installer is saved under a temporary name and given its real name only once it is complete
 * and verified, so a half-written or damaged file can never be started. Verified means: all the bytes arrived, the saved
 * file (read back from disk, not just the data as it came in) matches `SHA256SUMS.txt`, and matches what was received.
 * Asking again while a download of the same file is running joins it instead of writing the same file twice.
 */
export function downloadInstaller(info: UpdateInfo, deps: DownloadDeps): Promise<string> {
  const asset = info.asset;
  if (!asset) return Promise.reject(new Error('This release has no Windows installer.'));
  const running = downloads.get(asset.url);
  if (running) return running;
  const job = download(info, deps).finally(() => downloads.delete(asset.url));
  downloads.set(asset.url, job);
  return job;
}

async function download(info: UpdateInfo, deps: DownloadDeps): Promise<string> {
  const asset = info.asset!;
  if (!isReleaseDownloadUrl(asset.url) || (info.sumsUrl && !isReleaseDownloadUrl(info.sumsUrl))) {
    throw new Error('Refusing to download from outside the MDEdit releases.');
  }
  if (path.basename(asset.name) !== asset.name) throw new Error('The installer has an unexpected name.');

  let expected: string | null = null;
  if (info.sumsUrl) {
    const sums = await deps.fetchFn(info.sumsUrl);
    if (sums.ok) expected = expectedSha256(await sums.text(), asset.name);
  }

  await fsp.mkdir(deps.dir, { recursive: true });
  // Earlier installers and abandoned partial downloads are of no use any more.
  for (const old of await fsp.readdir(deps.dir).catch(() => [] as string[])) await fsp.rm(path.join(deps.dir, old), { force: true }).catch(() => undefined);

  const target = path.join(deps.dir, asset.name);
  const partial = `${target}.${randomBytes(4).toString('hex')}.partial`;
  const res = await deps.fetchFn(asset.url);
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  let received = 0;
  const hash = createHash('sha256');
  const tally = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      deps.onProgress({ received, total });
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), tally, createWriteStream(partial));
    if (total && received !== total) throw new Error(`The download was cut short (${received} of ${total} bytes). Check your connection and try again.`);
    const received256 = hash.digest('hex');
    const onDisk = await hashFile(partial);
    if (onDisk !== received256) throw new Error('The installer was changed while it was being saved (an antivirus program may have interfered), so it was not run. Try again, or download it from the releases page.');
    if (expected && onDisk !== expected) throw new Error('The downloaded installer does not match its checksum, so it was not run.');
    await fsp.rm(target, { force: true });
    await fsp.rename(partial, target);
    verified.set(target, { sha256: onDisk, size: received });
  } catch (e) {
    await fsp.rm(partial, { force: true });
    throw e;
  }
  return target;
}
