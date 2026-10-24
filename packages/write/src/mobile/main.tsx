import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { createRoot } from 'react-dom/client';
import { MOBILE_CAPABILITIES, type CoreApi, type MdeditApi, type UpdateApi } from '../shared/api';
import { createReviewHost } from '../shared/review/host';
import { fetchLatestRelease, type UpdateProgress } from '../shared/update';
import { createCoreApi } from '../shared/backend/coreApi';
import type { FsPort } from '../shared/fsPort';
import { FakeDrive } from '../shared/sync/fakeDrive';
import { SyncService } from '../shared/sync/service';
import { App } from '../renderer/App';
import { createCapacitorFs, type FilesystemLike } from './capacitorFs';
import { DialogHost, mobileDialogs } from './dialogs';
import { AppUpdate } from './appUpdate';
import { DriveAuth } from './driveAuth';
import { pickInBrowser } from './externalBrowser';
import { seededPreviewFs } from './sampleProject';
import { desktopOnlyStubs } from './stubs';

const ROOT = '/MDEdit';
const STATE = '/state';

const native = Capacitor.isNativePlatform();

/** On the phone: app-private storage. In a plain browser (development): an in-memory library, so the UI can be tried without a device. */
function storage(): FsPort {
  return native ? createCapacitorFs(Filesystem as unknown as FilesystemLike) : seededPreviewFs();
}

/** "Pixel 8" from the Android user agent, for naming conflict copies. */
const deviceName = (): string => /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent)?.[1]?.trim() || 'Phone';

/** Calls `after` once any of these changes something, so a sync can follow an edit. */
function onChange(api: CoreApi, after: () => void): CoreApi {
  const watched = ['writeFile', 'createFile', 'createFolder', 'renameNode', 'trashNode', 'createProject', 'renameProject', 'duplicateProject', 'deleteProject', 'convertFolder', 'updateProject', 'recordProgress'] as const;
  const out = { ...api } as Record<string, unknown>;
  for (const name of watched) {
    const original = api[name] as (...a: unknown[]) => Promise<unknown>;
    out[name] = async (...args: unknown[]) => {
      const result = await original.apply(api, args);
      after();
      return result;
    };
  }
  return out as unknown as CoreApi;
}

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
    dialogs: mobileDialogs,
  });
  await backend.load();

  // Google Drive sync. In a browser preview there is no Google, so a throwaway in-memory Drive stands in.
  const previewDrive = new FakeDrive();
  const sync = new SyncService({
    fs,
    root: ROOT,
    stateFile: `${STATE}/sync.json`,
    device: deviceName(),
    authorize: native ? async () => (await DriveAuth.authorize()).accessToken : async () => 'preview',
    makeDrive: native ? undefined : () => previewDrive,
    trashLocal: backend.trash,
  });
  await sync.load();

  const reviews = createReviewHost({
    fs,
    root: ROOT,
    stateFile: `${STATE}/shares.json`,
    drive: () => sync.driveApi(),
    connected: () => sync.isConnected(),
    accessToken: () => sync.accessToken(),
  });
  const core = onChange(backend.api, () => sync.syncSoon());
  window.mdedit = { ...core, ...desktopOnlyStubs, ...bindSync(sync), ...reviews, ...(native ? { pickInBrowser } : {}), ...androidUpdates(), capabilities: MOBILE_CAPABILITIES } satisfies MdeditApi;

  // Keep the latest version available: on start, when the app comes back to the front, and every minute while it is open.
  const visible = () => document.visibilityState === 'visible';
  void sync.syncNow();
  document.addEventListener('visibilitychange', () => visible() && sync.syncSoon(500));
  void CapacitorApp.addListener('resume', () => sync.syncSoon(500));
  sync.startPolling(60_000, visible);

  // Going to the background must not lose recent settings or autosaved drafts.
  void CapacitorApp.addListener('pause', () => void backend.flush());

  createRoot(document.getElementById('root')!).render(
    <>
      <App />
      <DialogHost />
    </>
  );
}

/** Update from the latest GitHub release. In a browser preview there is no installer, so only checking works. */
function androidUpdates(): UpdateApi {
  const version = async () => (native ? (await CapacitorApp.getInfo()).version : 'preview');
  return {
    getAppVersion: version,
    checkForUpdate: async () => fetchLatestRelease(fetch, 'android', await version()),
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
    onSyncStatus: s.onSyncStatus,
  };
}

void start();
