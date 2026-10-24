/**
 * Assembles Google Drive sync for the Windows app: the sign-in (googleAuth), an encrypted token vault, the shared
 * `SyncService` over Node's fs, and the Recycle Bin for files that another device deleted. Electron-specific pieces
 * (opening the browser, encryption, the Recycle Bin) are passed in, so this is testable without Electron.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriveApi } from '../src/shared/sync/drive';
import { SyncService } from '../src/shared/sync/service';
import { GoogleAuth, type TokenVault } from './googleAuth';
import { nodeFs } from './nodeFs';

/** The app's Desktop OAuth client. The id is public; the secret is injected at build time (see scripts/build-electron.mjs). */
export const GOOGLE_DESKTOP_CLIENT_ID = '312461756737-h4ibil8t5hm5d2ajuorjma36e18u7jup.apps.googleusercontent.com';

export interface DesktopSyncOptions {
  /** App data folder: holds `sync.json` and the encrypted token. */
  userData: string;
  /** The Root Folder to sync. */
  root: string;
  clientId?: string;
  clientSecret: string;
  device: string;
  openUrl(url: string): Promise<void> | void;
  /** OS-level encryption (Electron's safeStorage); null/throw when the OS can't protect the token. */
  encrypt(plain: string): Buffer | null;
  decrypt(data: Buffer): string;
  /** Sends a file to the Recycle Bin. */
  trash(file: string): Promise<void>;
  /** For tests. */
  fetch?: typeof fetch;
  makeDrive?(getToken: (force?: boolean) => Promise<string>): DriveApi;
  now?: () => Date;
}

/** The refresh token, encrypted with the OS (DPAPI on Windows) and stored beside the app's settings. */
export function tokenVault(file: string, o: Pick<DesktopSyncOptions, 'encrypt' | 'decrypt'>): TokenVault {
  return {
    async load() {
      try {
        return o.decrypt(await fs.readFile(file));
      } catch {
        return null; // missing or unreadable (for example, from another Windows account): treat as signed out
      }
    },
    async save(token) {
      if (token === null) return void (await fs.rm(file, { force: true }));
      const sealed = o.encrypt(token);
      if (!sealed) throw new Error('Windows can’t protect the Google sign-in on this device, so MDEdit won’t store it.');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, sealed);
    },
  };
}

export function createDesktopSync(o: DesktopSyncOptions): SyncService {
  const auth = new GoogleAuth({
    clientId: o.clientId ?? GOOGLE_DESKTOP_CLIENT_ID,
    clientSecret: o.clientSecret,
    openUrl: o.openUrl,
    vault: tokenVault(path.join(o.userData, 'google-token.bin'), o),
    fetch: o.fetch,
  });
  return new SyncService({
    fs: nodeFs,
    root: o.root,
    stateFile: path.join(o.userData, 'sync.json'),
    device: o.device,
    authorize: () => auth.accessToken(),
    signOut: () => auth.signOut(),
    trashLocal: o.trash,
    makeDrive: o.makeDrive,
    now: o.now,
  });
}
