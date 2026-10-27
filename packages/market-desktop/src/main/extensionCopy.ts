import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * The Chrome extension is loaded by Chrome from a folder ("Load unpacked"). If that folder is inside the installed app, Chrome keeps using it, and
 * an update has to replace it while Chrome has it open: the install can fail, and the extension breaks when the folder moves. So the extension is
 * kept in a copy outside the install folder, in Cadrel's data folder, which no update touches. The copy is refreshed when the app's own
 * extension is a different version, so an update still brings the new extension (reload it in chrome://extensions).
 */
const versionOf = (dir: string): Promise<string | null> =>
  fsp.readFile(path.join(dir, 'manifest.json'), 'utf8').then(
    (t) => String((JSON.parse(t) as { version?: unknown }).version ?? ''),
    () => null
  );

/** Makes sure `dest` holds the same extension as `src`; returns `dest`. A copy that is already the same version is left alone. */
export async function ensureExtensionCopy(src: string, dest: string): Promise<string> {
  const [want, have] = await Promise.all([versionOf(src), versionOf(dest)]);
  if (want === null) return src; // the app carries no extension (a development build): nothing to copy
  if (have === want) return dest;
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(src, dest, { recursive: true });
  return dest;
}
