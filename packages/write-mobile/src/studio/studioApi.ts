import { generateKeyPair, signRequest } from '@cadrel/kernel';
import { joinStudio } from '@cadrel/studio-client';
import type { StudioApi, StudioInfo } from '@cadrel/write/src/shared/api';
import type { FsPort } from '@cadrel/write/src/shared/fsPort';
import type { JoinedStudio, StudioRegistry } from './registry';

const info = (s: JoinedStudio, activeId: string | null): StudioInfo => ({ id: s.id, name: s.name, role: s.role, me: s.me, fingerprint: s.fingerprint, url: s.url, active: s.id === activeId });

/**
 * Signing in is a public-key signature (Ed25519 through the browser's Web Crypto). Android System WebView has had it only since 2025: on an
 * older one say so in words, instead of a join that fails with a technical message.
 */
export async function checkSigning(): Promise<void> {
  try {
    const key = await generateKeyPair();
    await signRequest({ method: 'GET', path: '/v1/me', key });
  } catch {
    throw new Error('This phone’s web engine (Android System WebView) is too old to sign in to a Studio. Update “Android System WebView” and “Chrome” in the Play Store, then try again.');
  }
}

/**
 * Joining, switching and leaving Studios. Opening another Studio restarts the app into it (`reload`), as Cadrel on the desktop does, so
 * the files, the sync and the editor never hold two Studios at once.
 */
export function createStudioApi(o: { registry: StudioRegistry; fs: FsPort; fetchFn: typeof fetch; reload(): void; folderOf(studioId: string): string }): StudioApi {
  return {
    list: async () => o.registry.list().map((s) => info(s, o.registry.active()?.id ?? null)),
    join: async (link, yourName) => {
      await checkSigning();
      const j = await joinStudio({ link, yourName, fetchFn: o.fetchFn });
      const studio: JoinedStudio = { id: j.studioId, name: j.studioName ?? 'Studio', url: j.url, fingerprint: j.fingerprint, role: j.role, me: yourName.trim() || (j.device ? 'You' : 'Studio member'), key: j.key, joinedAt: new Date().toISOString() };
      await o.registry.add(studio);
      o.reload();
      return info(studio, studio.id);
    },
    switchTo: async (id) => {
      await o.registry.setActive(id);
      o.reload();
    },
    leave: async (id) => {
      await o.registry.remove(id);
      await o.fs.rm(o.folderOf(id), { recursive: true, force: true });
      o.reload();
    }
  };
}
