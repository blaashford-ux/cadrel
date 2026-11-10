/**
 * Cadrel Write on Android: the writing interface of Cadrel Write, connected to a Cadrel Studio. The editor, projects list and settings are
 * Write's (imported from @cadrel/write); this entry gives them the Studio's projects and files in place of Google Drive, the phone's own
 * storage, and no way to make or manage projects. Joining and switching Studios is the Studio dialog (StudioDialog in Write's renderer).
 */
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { createRoot } from 'react-dom/client';
import { parseInvitation } from '@cadrel/kernel';
import { StudioClient } from '@cadrel/studio-client';
import { STUDIO_MOBILE_CAPABILITIES, type CoreApi, type StudioApi, type UpdateApi, type WriteApi } from '@cadrel/write/src/shared/api';
import { reviewOff } from '@cadrel/write/src/shared/syncStub';
import { fetchReleaseFor, type UpdateProgress } from '@cadrel/write/src/shared/update';
import { createCoreApi } from '@cadrel/write/src/shared/backend/coreApi';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import { App } from '@cadrel/write/src/renderer/App';
import { StudioJoinForm } from '@cadrel/write/src/renderer/StudioDialog';
import { createCapacitorFs, type FilesystemLike } from '@cadrel/write/src/mobile/capacitorFs';
import { DialogHost, mobileDialogs } from '@cadrel/write/src/mobile/dialogs';
import { AppUpdate } from '@cadrel/write/src/mobile/appUpdate';
import { seededPreviewFs } from '@cadrel/write/src/mobile/sampleProject';
import { desktopOnlyStubs } from '@cadrel/write/src/mobile/stubs';
import { studioGuard } from '../studio/guard';
import { StudioRegistry } from '../studio/registry';
import { createStudioApi } from '../studio/studioApi';
import { StudioSync } from '../studio/vaultSync';

const BASE = '/Cadrel Write';
const REGISTRY = `${BASE}/studios.json`;
const native = Capacitor.isNativePlatform();
const PENDING = 'cadrel.pendingInvitation';

const folderOf = (studioId: string) => `${BASE}/Studios/${studioId}`;

/** On the phone: app-private storage. In a plain browser (development): an in-memory library. */
function storage(): FsPort {
  return native ? createCapacitorFs(Filesystem as unknown as FilesystemLike) : seededPreviewFs();
}

/** "Pixel 8" from the Android user agent, for conflict file names and version comments. */
const deviceName = (): string => /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent)?.[1]?.trim() || 'Phone';

/** Calls `after` once any of these changes something, so a sync can follow an edit. */
function onChange(api: CoreApi, after: () => void): CoreApi {
  const watched = ['writeFile', 'createFile', 'createFolder', 'recordProgress'] as const;
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

/** An invitation opened from a message or a browser (cadrel://join?...) is kept for the join screen, which shows it ready to accept. */
function listenForInvitations(): void {
  if (!native) return;
  void CapacitorApp.addListener('appUrlOpen', (e) => {
    if (!parseInvitation(e.url)) return;
    try {
      sessionStorage.setItem(PENDING, e.url);
    } catch {
      /* private mode: the person can paste it */
    }
    location.reload();
  });
}
const takePendingInvitation = (): string => {
  try {
    const v = sessionStorage.getItem(PENDING) ?? '';
    sessionStorage.removeItem(PENDING);
    return v;
  } catch {
    return '';
  }
};

/** The first screen, and the one shown over the app when an invitation arrives: join a Studio. */
function JoinScreen({ initialLink, onCancel }: { initialLink: string; onCancel?: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal studio-dialog" role="dialog" aria-modal="true" aria-label="Join a Studio">
        <h3>Cadrel Write</h3>
        <p className="modal-hint">Write in your Cadrel Studio’s projects. Paste the invitation link its owner sent you, and say what the Studio should call you. If you own the Studio, paste the “Link a phone” link from your computer instead and you are signed in as yourself.</p>
        <StudioJoinForm initialLink={initialLink} onJoined={() => undefined} {...(onCancel ? { onCancel } : {})} />
      </div>
    </div>
  );
}

/** Update from the latest GitHub release (Cadrel Write's APK is on Cadrel's releases). In a browser preview only checking works. */
function androidUpdates(): UpdateApi {
  const version = async () => (native ? (await CapacitorApp.getInfo()).version : 'preview');
  return {
    getAppVersion: version,
    checkForUpdate: async () => fetchReleaseFor(fetch, 'android', await version(), 'cadrel'),
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

async function start(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  const fs = storage();
  await fs.mkdir(BASE, { recursive: true });
  const registry = new StudioRegistry(fs, REGISTRY);
  await registry.load();
  const fetchFn: typeof fetch = (...a) => fetch(...a);
  const studio: StudioApi = createStudioApi({ registry, fs, fetchFn, reload: () => location.reload(), folderOf });
  listenForInvitations();
  const pending = takePendingInvitation();

  const active = registry.active();
  if (!active) {
    // nothing to write in yet: the join screen only needs the Studio calls
    window.cadrelWrite = { studio } as unknown as WriteApi;
    root.render(<JoinScreen initialLink={pending} />);
    return;
  }

  const studioRoot = `${folderOf(active.id)}/Projects`;
  const state = `${BASE}/state/${active.id}`;
  await fs.mkdir(studioRoot, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  const backend = createCoreApi({ fs, rootFolder: studioRoot, settingsFile: `${state}/settings.json`, draftsDir: `${state}/drafts`, trashDir: `${state}/trash`, dialogs: mobileDialogs });
  await backend.load();

  const client = new StudioClient({ url: active.url, key: active.key, fetchFn });
  const sync = new StudioSync({ fs, port: client, root: studioRoot, stateFile: `${state}/sync.json`, machine: `phone-${registry.installId}`, device: deviceName() });
  await sync.load();

  const core = onChange(studioGuard(backend.api, sync), () => sync.syncSoon());
  window.cadrelWrite = {
    ...core,
    ...desktopOnlyStubs,
    getSyncStatus: sync.getSyncStatus,
    connectSync: sync.connectSync,
    syncNow: sync.syncNow,
    confirmDeletes: sync.confirmDeletes,
    disconnectSync: sync.disconnectSync,
    onSyncStatus: sync.onSyncStatus,
    ...reviewOff,
    ...androidUpdates(),
    studio,
    fileLock: sync.fileLock,
    capabilities: STUDIO_MOBILE_CAPABILITIES
  } satisfies WriteApi;

  // Keep up: on start, when the app comes back to the front, and every minute while it is open.
  const visible = () => document.visibilityState === 'visible';
  void sync.syncNow();
  document.addEventListener('visibilitychange', () => visible() && sync.syncSoon(500));
  void CapacitorApp.addListener('resume', () => sync.syncSoon(500));
  sync.startPolling(60_000, visible);

  // Going to the background must not lose recent settings or autosaved drafts, and a pending edit is sent while the phone is still awake.
  void CapacitorApp.addListener('pause', () => {
    void backend.flush();
    sync.syncSoon(300);
  });

  root.render(
    <>
      <App />
      <DialogHost />
      {pending && <JoinScreen initialLink={pending} onCancel={() => root.render(<><App /><DialogHost /></>)} />}
    </>
  );
}

void start();
