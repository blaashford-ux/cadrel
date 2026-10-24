import type { ReviewSharingApi } from '../api';
import type { FsPort } from '../fsPort';
import { basename } from '../paths';
import type { DriveApi } from '../sync/drive';
import { SHARED_WITH_ME } from '../sync/rules';
import { parseInviteLink } from './link';
import { readMarker } from './package';
import { ReviewJoin, ReviewShare } from './share';

export interface ReviewHostOptions {
  fs: FsPort;
  /** The local Root Folder; shared projects live in `<root>/Shared With Me`. */
  root: string;
  /** Where this device remembers what it shared. */
  stateFile: string;
  drive(): DriveApi;
  connected(): boolean;
  accessToken(): Promise<string>;
}

const NOT_CONNECTED = 'Connect Google Drive first (File → Google Drive Sync…).';

/** `ReviewSharingApi` for one device: the owner and reviewer services plus the checks the UI relies on. */
export function createReviewHost(o: ReviewHostOptions): ReviewSharingApi {
  const share = new ReviewShare({ fs: o.fs, drive: o.drive, stateFile: o.stateFile });
  const join = new ReviewJoin({ fs: o.fs, drive: o.drive, sharedRoot: `${o.root.replace(/[\\/]+$/, '')}/${SHARED_WITH_ME}` });
  const need = () => {
    if (!o.connected()) throw new Error(NOT_CONNECTED);
  };
  const norm = (p: string) => p.replace(/\\/g, '/');

  return {
    getShareStatus: (project) => share.status(basename(project)),
    listShares: () => share.list(),

    async stopSharing(project) {
      need();
      await share.revokeAll(norm(project), basename(project));
    },

    async inviteReviewer(project, name, chapters, role) {
      need();
      return share.invite(norm(project), basename(project), name, chapters, role);
    },

    getShareChapters: (project, level) => share.chapters(norm(project), basename(project), level),

    async revokeReviewer(project, id) {
      need();
      await share.revoke(norm(project), basename(project), id);
    },

    async exchangeReviews(project) {
      const idle = { changed: false, revoked: false, errors: [] as string[] };
      if (!o.connected()) return idle;
      const dir = norm(project);
      try {
        if (await readMarker(o.fs, dir)) {
          const { errors, ...r } = await join.sync(dir);
          return { ...idle, ...r, errors: errors ?? [] };
        }
        const status = await share.status(basename(dir));
        if (!status.reviewers.length) return idle;
        return { ...idle, ...(await share.sync(dir, basename(dir))) };
      } catch (e) {
        return { ...idle, errors: [e instanceof Error ? e.message : String(e)] };
      }
    },

    listShared: () => join.list(),

    async pickerToken() {
      need();
      return o.accessToken();
    },

    async joinReview(link, name) {
      need();
      const invite = parseInviteLink(link);
      if (!invite) throw new Error('That doesn’t look like a MDEdit invitation link.');
      return join.join(invite, name.trim() || 'Reviewer');
    },
  };
}
