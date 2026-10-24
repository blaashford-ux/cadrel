import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the desktop app keeps its settings (it names itself "BookScout"). */
export function appDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'BookScout');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'BookScout');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'BookScout');
}

/** --library <dir>, then BOOKSCOUT_LIBRARY, then whatever library the desktop app last used. */
export function resolveLibraryRoot(argv: string[], env: NodeJS.ProcessEnv, configDir = appDataDir()): string | null {
  const i = argv.indexOf('--library');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]!);
  if (env.BOOKSCOUT_LIBRARY) return path.resolve(env.BOOKSCOUT_LIBRARY);
  try {
    const c = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')) as { libraryRoot?: string };
    return c.libraryRoot ?? null;
  } catch {
    return null;
  }
}
