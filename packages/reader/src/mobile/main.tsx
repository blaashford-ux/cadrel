/**
 * Cadrel Reader on Android: Cadrel Write's phone app in reader mode. The editor, review panel and Google Drive code are Write's (imported from
 * @cadrel/write); this entry gives them Reader's capabilities, its own storage folder and update feed, and takes the author calls away.
 */
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { createRoot } from 'react-dom/client';
import { READER_MOBILE_CAPABILITIES, type CoreApi, type WriteApi, type UpdateApi } from '@cadrel/write/src/shared/api';
import { createReviewHost } from '@cadrel/write/src/shared/review/host';
import { withoutAuthorCalls } from '@cadrel/write/src/shared/readerApi';
import { fetchReleaseFor, type UpdateProgress } from '@cadrel/write/src/shared/update';
import { createCoreApi } from '@cadrel/write/src/shared/backend/coreApi';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { FakeDrive } from '@cadrel/write/src/shared/sync/fakeDrive';
import { SyncService } from '@cadrel/write/src/shared/sync/service';
import { App } from '@cadrel/write/src/renderer/App';
import { createCapacitorFs, type FilesystemLike } from '@cadrel/write/src/mobile/capacitorFs';
import { DialogHost, mobileDialogs } from '@cadrel/write/src/mobile/dialogs';
import { AppUpdate } from '@cadrel/write/src/mobile/appUpdate';
import { DriveAuth } from '@cadrel/write/src/mobile/driveAuth';
import { pickInBrowser } from '@cadrel/write/src/mobile/externalBrowser';
import { seededPreviewFs } from '@cadrel/write/src/mobile/sampleProject';
import { desktopOnlyStubs } from '@cadrel/write/src/mobile/stubs';

const ROOT = '/Cadrel Reader';
const STATE = '/state';

const native = Capacitor.isNativePlatform();

/** On the phone: app-private storage. In a plain browser (development): an in-memory library, so the UI can be tried without a device. */
function storage(): FsPort {
  return native ? createCapacitorFs(Filesystem as unknown as FilesystemLike) : seededPreviewFs();
}

/** "Pixel 8" from the Android user agent, for naming conflict copies. */
const deviceName = (): string => /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent)?.[1]?.trim() || 'Phone';

async function start(): Promise<void> {
  const fs = storage();
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(STATE, { recursive: true });
  const backend = createCoreApi({
    fs,
    rootFolder: ROOT,
    settingsFile: `${STATE}/settings.json`,
    draftsDir: `${STATE}/drafts`,
    trashDir: `${STATE}/trash`,
    dialogs: mobileDialogs
  });
  await backend.load();

  // Google sign-in is what opens a shared project and sends comments back. In a browser preview a throwaway in-memory Drive stands in.
  const previewDrive = new FakeDrive();
  const sync = new SyncService({
    fs,
    root: ROOT,
    stateFile: `${STATE}/sync.json`,
    device: deviceName(),
    authorize: native ? async () => (await DriveAuth.authorize()).accessToken : async () => 'preview',
    makeDrive: native ? undefined : () => previewDrive,
    trashLocal: backend.trash
  });
  await sync.load();

  const reviews = createReviewHost({
    fs,
    root: ROOT,
    stateFile: `${STATE}/shares.json`,
    drive: () => sync.driveApi(),
    connected: () => sync.isConnected(),
    accessToken: () => sync.accessToken(),
    allowEdit: false,
    appName: 'Cadrel Reader'
  });
  const core: CoreApi = backend.api;
  window.cadrelWrite = withoutAuthorCalls({
    ...core,
    ...desktopOnlyStubs,
    ...bindSync(sync),
    ...reviews,
    ...(native ? { pickInBrowser } : {}),
    ...androidUpdates(),
    capabilities: READER_MOBILE_CAPABILITIES
  } satisfies WriteApi);

  // Keep the latest version available: on start, when the app comes back to the front, and every minute while it is open.
  const visible = () => document.visibilityState === 'visible';
  void sync.syncNow();
  document.addEventListener('visibilitychange', () => visible() && sync.syncSoon(500));
  void CapacitorApp.addListener('resume', () => sync.syncSoon(500));
  sync.startPolling(60_000, visible);

  // Going to the background must not lose recent settings or notes in progress.
  void CapacitorApp.addListener('pause', () => void backend.flush());

  createRoot(document.getElementById('root')!).render(
    <>
      <App />
      <DialogHost />
    </>
  );
}

/** Update from Cadrel Reader's own releases (tagged `reader-vX.Y.Z`). In a browser preview there is no installer, so only checking works. */
function androidUpdates(): UpdateApi {
  const version = async () => (native ? (await CapacitorApp.getInfo()).version : 'preview');
  return {
    getAppVersion: version,
    checkForUpdate: async () => fetchReleaseFor(fetch, 'android', await version(), 'reader'),
    installUpdate: async (info) => {
      if (!native) throw new Error('Updating only works inside the Android app.');
      if (!info.asset) throw new Error('This release has no Android app.');
      await AppUpdate.install({ url: info.asset.url, name: info.asset.name, sumsUrl: info.sumsUrl });
    },
    onUpdateProgress: (cb) => {
      if (!native) return () => undefined;
      const handle = AppUpdate.addListener('progress', (p: UpdateProgress) => cb(p));
      return () => void handle.then((h) => h.remove());
    }
  };
}

/** The service's methods as plain functions (they are passed around detached from the class). */
function bindSync(s: SyncService) {
  return {
    getSyncStatus: () => s.getSyncStatus(),
    connectSync: () => s.connectSync(),
    syncNow: () => s.syncNow(),
    confirmDeletes: () => s.confirmDeletes(),
    disconnectSync: () => s.disconnectSync(),
    onSyncStatus: s.onSyncStatus
  };
}

void start();
