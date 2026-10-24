/** The invitation link a reviewer opens in MDEdit. It carries only Drive file ids and a display name. */
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

/** Where the small page that hands the link to MDEdit (and runs Google's file picker) is published. */
export const JOIN_PAGE = 'https://blaashford-ux.github.io/MDEdit/join/';

export function buildInviteLink(i: Invite): string {
  const q = new URLSearchParams({ v: '1', p: i.packageId, c: i.commentsId, r: i.reviewerId, n: i.project });
  if (i.role === 'edit') q.set('m', 'edit');
  return `${JOIN_PAGE}#${q}`;
}

/**
 * Reads an invitation pasted as a link (the web page address or an `mdedit:` link). A whole invitation message can be
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
  if (at < 0 || !/^(https?:\/\/|mdedit:)/i.test(t)) return null;
  const q = new URLSearchParams(t.slice(at + 1));
  const packageId = q.get('p');
  const commentsId = q.get('c');
  const reviewerId = q.get('r');
  const idOk = (s: string | null): s is string => !!s && /^[A-Za-z0-9_-]{2,128}$/.test(s);
  if (!idOk(packageId) || !idOk(commentsId) || !/^[A-Za-z0-9_-]{4,64}$/.test(reviewerId ?? '')) return null;
  return { packageId, commentsId, reviewerId: reviewerId!, project: (q.get('n') ?? 'Shared project').slice(0, 120), ...(q.get('m') === 'edit' ? { role: 'edit' as const } : {}) };
}

/** Where reviewers get the app. */
export const LATEST_RELEASE = 'https://github.com/blaashford-ux/MDEdit/releases/latest';

/** The invitation link wrapped in a short note for someone who doesn't have MDEdit yet. */
export function inviteMessage(project: string, link: string, reviewerName?: string, role?: 'edit'): string {
  const hello = reviewerName?.trim() ? `Hi ${reviewerName.trim()},\n\n` : '';
  const ask =
    role === 'edit'
      ? `I'd like you to work on “${project}” with me. I'm using MDEdit, a free writing app for Windows and Android, and you can edit the same manuscript there: your changes and mine are merged each time either of us syncs.`
      : `I'd like your feedback on “${project}”. I'm using MDEdit, a free writing app for Windows and Android, and you can read it and leave comments and suggestions there.`;
  return (
    `${hello}${ask}\n\n` +
    `1. Get MDEdit (Windows installer or Android app): ${LATEST_RELEASE}\n` +
    `2. Open MDEdit, go to Projects → Shared with me → Open invitation…, and paste this link:\n${link}\n\n` +
    `Google will ask you to pick two files; that's how MDEdit is allowed to open this one project, and nothing else in your Drive.`
  );
}
