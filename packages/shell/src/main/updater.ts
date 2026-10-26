/**
 * Updating Cadrel as a whole. A development build (version like 0.2.0-dev.14) is offered only development releases, a stable build only
 * stable ones. Windows downloads, verifies and runs the installer once the app has closed; elsewhere the person is given the release page.
 * Electron-free, so it is tested with a fake network (test/updater.test.ts).
 */
import { fetchReleaseFor, isDevBuild, type UpdateInfo, type UpdateProgress } from '@cadrel/write/src/shared/update';
import { checkBeforeLaunch, downloadInstaller } from '@cadrel/write/electron/update';
import type { UpdateStatus } from '../shared/api';

export interface UpdaterOptions {
  version: string;
  platform: string;
  fetchFn: typeof fetch;
  /** Where the installer is saved. */
  dir: string;
  log(line: string): void;
  onProgress(p: UpdateProgress): void;
  /** Hand the verified installer over to run after the app has exited, and start closing. */
  runAfterQuit(file: string): void;
}

export class Updater {
  private info: UpdateInfo | null = null;
  private status: UpdateStatus | null = null;

  constructor(private readonly o: UpdaterOptions) {}

  last(): UpdateStatus | null {
    return this.status;
  }

  async check(): Promise<UpdateStatus> {
    const base = { current: this.o.version, channel: isDevBuild(this.o.version) ? ('dev' as const) : ('stable' as const) };
    try {
      this.info = await fetchReleaseFor(this.o.fetchFn, 'windows', this.o.version);
      this.status = { ...base, latest: this.info.latest, available: this.info.available, notes: this.info.notes, pageUrl: this.info.pageUrl, canInstall: this.o.platform === 'win32' && !!this.info.asset, error: null };
    } catch (e) {
      this.info = null;
      this.status = { ...base, latest: null, available: false, notes: '', pageUrl: '', canInstall: false, error: e instanceof Error ? e.message : String(e) };
    }
    return this.status;
  }

  async install(): Promise<void> {
    if (this.o.platform !== 'win32') throw new Error('Cadrel installs updates on Windows. Download the new version from the release page.');
    if (!this.info?.available) throw new Error('There is no update to install. Check for updates first.');
    const file = await downloadInstaller(this.info, { fetchFn: this.o.fetchFn, dir: this.o.dir, onProgress: this.o.onProgress });
    // Read it back once more right before running it: waits out an antivirus scan, and refuses a file that has changed.
    try {
      this.o.log(`downloaded ${file}: ${await checkBeforeLaunch(file)}`);
    } catch (e) {
      this.o.log(`not run: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    this.o.runAfterQuit(file);
  }
}
