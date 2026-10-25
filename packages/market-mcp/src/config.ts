import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where Market keeps its settings: the `market` folder inside Cadrel's own data folder (CADREL_USER_DATA moves that folder). */
export function appDataDir(): string {
  if (process.env.CADREL_USER_DATA) return path.join(process.env.CADREL_USER_DATA, 'market');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Cadrel', 'market');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cadrel', 'market');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Cadrel', 'market');
}

/** --library <dir>, then CADREL_MARKET_LIBRARY, then whatever library the desktop app last used. */
export function resolveLibraryRoot(argv: string[], env: NodeJS.ProcessEnv, configDir = appDataDir()): string | null {
  const i = argv.indexOf('--library');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]!);
  if (env.CADREL_MARKET_LIBRARY) return path.resolve(env.CADREL_MARKET_LIBRARY);
  try {
    const c = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')) as { libraryRoot?: string };
    return c.libraryRoot ?? null;
  } catch {
    return null;
  }
}
