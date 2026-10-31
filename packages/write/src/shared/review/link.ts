/** The invitation link a reviewer opens in Cadrel Write. It carries only Drive file ids and a display name. */
export interface Invite {
  /** The shared package (the manuscript snapshot). */
  packageId: string;
  /** The reviewer's own comments file. */
  commentsId: string;
  reviewerId: string;
  project: string;
  /** 'edit' for a collaborator: the package is a shared working copy they can change, not a read-only snapshot. */
  role?: 'edit';
}

/** Where the small page that hands the link to Cadrel Write (and runs Google's file picker) is published. */
export const JOIN_PAGE = 'https://blaashford-ux.github.io/cadrel/join/';

export function buildInviteLink(i: Invite): string {
  const q = new URLSearchParams({ v: '1', p: i.packageId, c: i.commentsId, r: i.reviewerId, n: i.project });
  if (i.role === 'edit') q.set('m', 'edit');
  return `${JOIN_PAGE}#${q}`;
}

/**
 * Reads an invitation pasted as a link (the web page address, or a `cadrel-reader:` or older `cadrel-write:` link). A whole invitation message can be
 * pasted too: the first word in it that is an invitation link is used. Null when there is none.
 */
export function parseInviteLink(text: string): Invite | null {
  for (const word of text.trim().split(/\s+/)) {
    const invite = parseOne(word);
    if (invite) return invite;
  }
  return null;
}

function parseOne(t: string): Invite | null {
  const at = t.search(/[#?]/);
  if (at < 0 || !/^(https?:\/\/|cadrel-reader:|cadrel-write:)/i.test(t)) return null;
  const q = new URLSearchParams(t.slice(at + 1));
  const packageId = q.get('p');
  const commentsId = q.get('c');
  const reviewerId = q.get('r');
  const idOk = (s: string | null): s is string => !!s && /^[A-Za-z0-9_-]{2,128}$/.test(s);
  if (!idOk(packageId) || !idOk(commentsId) || !/^[A-Za-z0-9_-]{4,64}$/.test(reviewerId ?? '')) return null;
  return { packageId, commentsId, reviewerId: reviewerId!, project: (q.get('n') ?? 'Shared project').slice(0, 120), ...(q.get('m') === 'edit' ? { role: 'edit' as const } : {}) };
}

/** Where reviewers get Cadrel Reader (its releases are tagged `reader-vX.Y.Z`, apart from Cadrel's own). */
export const LATEST_RELEASE = 'https://github.com/blaashford-ux/cadrel/releases?q=reader-v&expanded=true';
/** Where collaborators (people who edit the manuscript with the author) get Cadrel Write: the full Cadrel app. */
export const WRITE_RELEASE = 'https://github.com/blaashford-ux/cadrel/releases/latest';

/** The scheme Cadrel Reader registers, so an invitation link opens it directly. `cadrel-write:` is the older one, still read. */
export const READER_SCHEME = 'cadrel-reader';

/** The link as a `cadrel-reader:` link, which opens Cadrel Reader directly when it is installed. Null if it is not an invitation. */
export function readerLink(link: string): string | null {
  const invite = parseInviteLink(link);
  if (!invite) return null;
  const q = new URLSearchParams({ v: '1', p: invite.packageId, c: invite.commentsId, r: invite.reviewerId, n: invite.project });
  return `${READER_SCHEME}://join?${q}`;
}

/**
 * The invitation link wrapped in a short note for someone who doesn't have the app yet. A reader is sent to Cadrel Reader; a
 * collaborator, who edits the manuscript, is sent to Cadrel (which has Write).
 */
export function inviteMessage(project: string, link: string, reviewerName?: string, role?: 'edit'): string {
  const hello = reviewerName?.trim() ? `Hi ${reviewerName.trim()},\n\n` : '';
  if (role === 'edit') {
    return (
      `${hello}I'd like you to work on “${project}” with me. I'm using Cadrel, a writing suite for Windows, and you can edit the same manuscript in its Write app: your changes and mine are merged each time either of us syncs.\n\n` +
      `1. Get Cadrel (Windows installer): ${WRITE_RELEASE}\n` +
      `2. Open Cadrel Write, go to Projects → Shared with me → Open invitation…, and paste this link:\n${link}\n\n` +
      `Google will ask you to pick two files; that's how Cadrel Write is allowed to open this one project, and nothing else in your Drive.`
    );
  }
  return (
    `${hello}I'd like your feedback on “${project}”. Cadrel Reader is an app for Windows and Android for reading it and leaving comments and suggestions.\n\n` +
    `1. Get Cadrel Reader (Windows installer or Android app): ${LATEST_RELEASE}\n` +
    `2. Open Cadrel Reader, choose Open invitation…, and paste this link:\n${link}\n\n` +
    `Google will ask you to pick two files; that's how Cadrel Reader is allowed to open this one project, and nothing else in your Drive.`
  );
}
