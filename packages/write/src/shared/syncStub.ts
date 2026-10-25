import type { ReviewSharingApi, SyncApi, SyncStatus } from './api';

export const syncOffStatus: SyncStatus = { connected: false, state: 'off', lastSyncAt: null, message: null, summary: null, pendingDeletes: [], localChanges: 0, progress: null };

/** `SyncApi` for platforms where sync isn't available (yet): always "off". */
export const syncOff: SyncApi = {
  getSyncStatus: async () => syncOffStatus,
  connectSync: async () => syncOffStatus,
  syncNow: async () => syncOffStatus,
  confirmDeletes: async () => syncOffStatus,
  disconnectSync: async () => undefined,
  onSyncStatus: () => () => undefined,
};

const off = async (): Promise<never> => {
  throw new Error('Sharing for review needs Google Drive sync.');
};

/** `ReviewSharingApi` for platforms without it. */
export const reviewOff: ReviewSharingApi = {
  getShareStatus: async () => ({ shared: false, publishedAt: null, reviewers: [] }),
  listShares: async () => [],
  stopSharing: off,
  inviteReviewer: off,
  getShareChapters: async () => ({ manuscript: null, chapters: [], selected: [] }),
  revokeReviewer: off,
  exchangeReviews: async () => ({ changed: false, revoked: false, errors: [] }),
  listShared: async () => [],
  pickerToken: off,
  joinReview: off,
};
