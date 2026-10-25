/**
 * The user: the person using this copy of Cadrel. One object at the shell level that every module can ask "who is this?"
 * of (their name on notes, their pen names, a photo), with files attached to it (a photo, a contract, an author bio, a
 * tax form). Today it is local; with the vault it becomes the person's record in the studio and the attachments become
 * vault files that only the person and people allowed to read the people directory (`people.read`) can open.
 */
import { newId } from './projects';

export const USER_VERSION = 1;
export const NAME_LIMIT = 80;
export const BIO_LIMIT = 2000;
export const PEN_NAME_LIMIT = 20;
export const ATTACHMENT_LIMIT = 200;
/** The largest file that can be attached, in bytes. */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

export interface Attachment {
  id: string;
  /** The file's name as it was attached ("Contract 2026.pdf"); what the person sees. */
  name: string;
  size: number;
  /** SHA-256 of the content, hex. Lets the same file be recognised and a damaged copy be noticed. */
  hash: string;
  mime: string;
  addedAt: string;
  /** What it is for, in the person's words ("Signed contract with Acme"). */
  note: string;
}

export interface UserProfile {
  version: number;
  id: string;
  /** The name notes and comments are written under. Empty means "use the computer's user name". */
  displayName: string;
  email: string;
  /** Names they write under. Credited identities are separate records in the vault; these are the person's own list. */
  penNames: string[];
  /** A short "about me" the person (and, if allowed, the assistant) can use for author bios and voice. */
  bio: string;
  /** The attachment used as the photo, or null. Must be an image. */
  avatarId: string | null;
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
}

export class UserError extends Error {}
const fail = (m: string): never => {
  throw new UserError(m);
};

export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|tiff?)$/i;

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip'
};

export function mimeFor(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return (i > 0 && MIME[fileName.slice(i).toLowerCase()]) || 'application/octet-stream';
}

/** A file name safe to show and to keep on disk: no folders, no control characters, not empty, not too long. */
export function cleanFileName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const t = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
  return (t || 'file').slice(0, 120);
}

export function newUser(now = new Date().toISOString(), id = newId('u')): UserProfile {
  return { version: USER_VERSION, id, displayName: '', email: '', penNames: [], bio: '', avatarId: null, attachments: [], createdAt: now, updatedAt: now };
}

const line = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');

export function cleanEmail(v: unknown): string {
  const t = line(v, 200);
  if (t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return fail('That does not look like an email address.');
  return t;
}

export function cleanPenNames(v: unknown): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const t = line(x, NAME_LIMIT);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > PEN_NAME_LIMIT) return fail(`At most ${PEN_NAME_LIMIT} pen names.`);
  return out;
}

export interface ProfilePatch {
  displayName?: string;
  email?: string;
  penNames?: string[];
  bio?: string;
}

export function updateProfile(u: UserProfile, patch: ProfilePatch, now = new Date().toISOString()): UserProfile {
  const next = { ...u, updatedAt: now };
  if (patch.displayName !== undefined) next.displayName = line(patch.displayName, NAME_LIMIT);
  if (patch.email !== undefined) next.email = cleanEmail(patch.email);
  if (patch.penNames !== undefined) next.penNames = cleanPenNames(patch.penNames);
  if (patch.bio !== undefined) next.bio = typeof patch.bio === 'string' ? patch.bio.replace(/\r\n/g, '\n').trim().slice(0, BIO_LIMIT) : '';
  return next;
}

/** The name to put on a note or a comment. */
export const nameOf = (u: UserProfile, fallback: string): string => u.displayName || fallback;

export interface NewAttachment {
  name: string;
  size: number;
  hash: string;
  note?: string;
  id?: string;
  now?: string;
}

export function addAttachment(u: UserProfile, a: NewAttachment): { user: UserProfile; attachment: Attachment } {
  if (a.size > ATTACHMENT_MAX_BYTES) fail(`"${cleanFileName(a.name)}" is larger than ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB.`);
  if (a.size < 0 || !Number.isFinite(a.size)) fail('A file has no size.');
  if (u.attachments.length >= ATTACHMENT_LIMIT) fail(`At most ${ATTACHMENT_LIMIT} files can be attached.`);
  const name = cleanFileName(a.name);
  const now = a.now ?? new Date().toISOString();
  const attachment: Attachment = { id: a.id ?? newId('a'), name, size: a.size, hash: a.hash, mime: mimeFor(name), addedAt: now, note: line(a.note, 300) };
  return { user: { ...u, attachments: [...u.attachments, attachment], updatedAt: now }, attachment };
}

const need = (u: UserProfile, id: string): Attachment => u.attachments.find((a) => a.id === id) ?? fail('There is no such attachment.');

export function editAttachment(u: UserProfile, id: string, patch: { note?: string; name?: string }): UserProfile {
  need(u, id);
  return {
    ...u,
    updatedAt: new Date().toISOString(),
    attachments: u.attachments.map((a) => (a.id === id ? { ...a, ...(patch.note !== undefined ? { note: line(patch.note, 300) } : {}), ...(patch.name !== undefined ? { name: cleanFileName(patch.name), mime: mimeFor(cleanFileName(patch.name)) } : {}) } : a))
  };
}

export function removeAttachment(u: UserProfile, id: string): UserProfile {
  need(u, id);
  return { ...u, avatarId: u.avatarId === id ? null : u.avatarId, attachments: u.attachments.filter((a) => a.id !== id), updatedAt: new Date().toISOString() };
}

/** The photo must be one of the attached files, and a picture. `null` clears it. */
export function setAvatar(u: UserProfile, id: string | null): UserProfile {
  if (id !== null && !IMAGE_MIME.test(need(u, id).mime)) fail('The photo has to be a picture (PNG, JPG, GIF, WebP).');
  return { ...u, avatarId: id, updatedAt: new Date().toISOString() };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Reads a stored profile defensively: a damaged or hand-edited file never stops the app starting. */
export function sanitizeUser(raw: unknown, now = new Date().toISOString()): UserProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const x of Array.isArray(r.attachments) ? r.attachments : []) {
    const a = x as Partial<Attachment> | null;
    if (!a || !isStr(a.id) || !isStr(a.name) || seen.has(a.id) || attachments.length >= ATTACHMENT_LIMIT) continue;
    seen.add(a.id);
    const name = cleanFileName(a.name);
    attachments.push({
      id: a.id, name, size: Number.isFinite(a.size) && (a.size as number) >= 0 ? (a.size as number) : 0, hash: isStr(a.hash) ? a.hash : '',
      mime: mimeFor(name), addedAt: isStr(a.addedAt) ? a.addedAt : now, note: line(a.note, 300)
    });
  }
  let penNames: string[] = [];
  try {
    penNames = cleanPenNames(r.penNames);
  } catch {
    penNames = cleanPenNames((r.penNames as unknown[]).slice(0, PEN_NAME_LIMIT));
  }
  let email = '';
  try {
    email = cleanEmail(r.email);
  } catch {
    email = '';
  }
  const avatar = isStr(r.avatarId) ? attachments.find((a) => a.id === r.avatarId) : undefined;
  return {
    version: USER_VERSION,
    id: isStr(r.id) ? r.id : newId('u'),
    displayName: line(r.displayName, NAME_LIMIT),
    email,
    penNames,
    bio: typeof r.bio === 'string' ? r.bio.slice(0, BIO_LIMIT) : '',
    avatarId: avatar && IMAGE_MIME.test(avatar.mime) ? avatar.id : null,
    attachments,
    createdAt: isStr(r.createdAt) ? r.createdAt : now,
    updatedAt: isStr(r.updatedAt) ? r.updatedAt : now
  };
}
