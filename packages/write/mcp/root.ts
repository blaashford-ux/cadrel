import { homedir } from 'node:os';
import path from 'node:path';
import type { FsPort } from '../src/shared/fsPort';

/** Where Write keeps `settings.json`: the `write` folder inside Cadrel's own data folder (Electron's per-user data folder, or CADREL_USER_DATA). */
export function settingsCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  if (env.CADREL_USER_DATA) return [path.join(env.CADREL_USER_DATA, 'write', 'settings.json')];
  const bases =
    platform === 'win32'
      ? [env.APPDATA ?? path.join(home, 'AppData', 'Roaming')]
      : platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support')]
        : [env.XDG_CONFIG_HOME ?? path.join(home, '.config')];
  return bases.map((b) => path.join(b, 'Cadrel', 'write', 'settings.json'));
}

/** A `--root` / `CADREL_WRITE_ROOT` value that is really "not set": blank, or a placeholder the client never filled in (`${user_config.root_folder}`). */
const unset = (v: string | undefined): boolean => !v?.trim() || /^\$\{.*\}$/.test(v.trim());

export interface RootCandidate {
  root: string;
  source: string;
}

/**
 * Every place the projects might be, in order of trust: `--root`, `CADREL_WRITE_ROOT`, the Root Folder chosen in Cadrel Write, then the
 * default (`~/Cadrel`). A source that is blank or an unfilled placeholder is skipped, and repeats are dropped.
 */
export async function rootCandidates(
  o: { flag?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; fs: FsPort }
): Promise<RootCandidate[]> {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const out: RootCandidate[] = [];
  if (!unset(o.flag)) out.push({ root: path.resolve(o.flag!.trim()), source: '--root' });
  if (!unset(env.CADREL_WRITE_ROOT)) out.push({ root: path.resolve(env.CADREL_WRITE_ROOT!.trim()), source: 'CADREL_WRITE_ROOT' });
  for (const file of settingsCandidates(env, o.platform ?? process.platform, home)) {
    try {
      const root = (JSON.parse(await o.fs.readText(file)) as { projects?: { rootFolder?: unknown } }).projects?.rootFolder;
      if (typeof root === 'string' && root.trim()) {
        out.push({ root: root.trim(), source: `Cadrel Write settings (${file})` });
        break;
      }
    } catch {
      /* not there: try the next */
    }
  }
  out.push({ root: path.join(home, 'Cadrel'), source: 'default' });
  return out.filter((c, i) => out.findIndex((d) => path.resolve(d.root) === path.resolve(c.root)) === i);
}

/** The first place the projects might be (see `rootCandidates`). */
export async function resolveRoot(o: Parameters<typeof rootCandidates>[0]): Promise<RootCandidate> {
  return (await rootCandidates(o))[0];
}

/**
 * Picks the folder to serve. The first candidate wins unless it holds no projects and a later one does, so a stale or
 * mistyped setting (say the extension's "Projects folder" pointing at the old default) doesn't hide the author's books.
 * `tried` lists what was looked at, for the "no projects found" message.
 */
export async function chooseRoot(
  candidates: RootCandidate[],
  hasProjects: (root: string) => Promise<boolean>
): Promise<RootCandidate & { tried: RootCandidate[] }> {
  for (const c of candidates) if (await hasProjects(c.root)) return { ...c, tried: candidates };
  return { ...candidates[0], tried: candidates };
}
