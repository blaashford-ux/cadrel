/**
 * Cadrel Reader's side of beta reading in a Cadrel Studio. A Beta Reader is invited to the Studio like anyone else (`cadrel-reader://join?...`);
 * this joins it with a key made here, then keeps each manuscript they were given as a project in "Shared With Me": the text is whatever the
 * Studio's server builds from the chapters the author switched on (a chapter that is off never reaches this device), and the reader's notes
 * are exchanged with the Studio in the same review file Write keeps. It answers the same `ReviewSharingApi` the Google Drive path did, so the
 * reading and note-taking screens are unchanged.
 */
import { parseInvitation, type KeyPair } from '@cadrel/kernel';
import { StudioClient, StudioApiError, joinStudio } from '@cadrel/studio-client';
import { makeProjects } from '../backend/projects';
import { makeReviews } from '../backend/reviews';
import type { ReviewSharingApi } from '../api';
import type { FsPort } from '../fsPort';
import { toCompliantName } from '../sync/names';
import { SHARED_WITH_ME } from '../sync/rules';
import { parseReviewFile, serializeReviewFile } from './comments';
import { mergeFiles, type SharedProject } from './sharedProject';

/** Where a project that came from a Studio remembers it. */
export const STUDIO_MARKER = '.cadrel/studio-share.json';

export interface StudioMarker {
  /** The Studio (its id) this project came from, and so whose key to use. */
  studioId: string;
  fileId: string;
  /** This reader's person in that Studio: what their notes file is named. */
  reviewerId: string;
  project: string;
  /** The manuscript's path inside the project folder. */
  file: string;
  /** What the local text was made from: the manuscript's version and the chapters that were on (the Studio's `rev`). */
  rev: string;
}

/** A Studio this reader has joined. The private key is kept sealed by the host (the operating system's store where there is one). */
export interface JoinedStudio {
  studioId: string;
  url: string;
  fingerprint: string;
  name: string;
  /** What the reader called themselves when they joined. */
  me: string;
  personId: string;
  publicKey: string;
  sealedPrivateKey: string;
}

export interface StudioReaderOptions {
  fs: FsPort;
  /** The local Root Folder; projects live in `<root>/Shared With Me`. */
  root: string;
  /** Where the joined Studios are remembered (outside the Root Folder). Not used when the host supplies them with `joined`. */
  stateFile?: string;
  /**
   * The Studios this person has already joined, from the host that holds their keys (Cadrel does: they joined once, there, and the same key
   * reads here). The reader then neither remembers Studios of its own nor joins any: a new invitation is opened in Cadrel's Studio list.
   */
  joined?: () => Promise<JoinedStudio[]>;
  fetchFn: typeof fetch;
  /** Seals and opens the private key at rest. */
  seal(text: string): string;
  unseal(text: string): string;
  appName?: string;
}

export const isRevoked = (e: unknown): boolean => {
  const status = (e as { status?: number } | null)?.status;
  return status === 401 || status === 403 || (e instanceof Error && e.name === 'PermissionDenied') || /not shared with you/i.test(e instanceof Error ? e.message : '');
};

export function createStudioReader(o: StudioReaderOptions): ReviewSharingApi {
  const app = o.appName ?? 'Cadrel Reader';
  const sharedRoot = `${o.root.replace(/[\\/]+$/, '')}/${SHARED_WITH_ME}`;
  const reviews = makeReviews(o.fs);

  const stateFile = o.stateFile ?? '';
  const loadStudios = async (): Promise<JoinedStudio[]> => {
    if (o.joined) return o.joined().catch(() => []); // offline, or not asked yet: what was downloaded before is still listed
    try {
      const raw = JSON.parse(await o.fs.readText(stateFile)) as { studios?: JoinedStudio[] };
      return Array.isArray(raw.studios) ? raw.studios : [];
    } catch {
      return [];
    }
  };
  const saveStudios = async (studios: JoinedStudio[]) => {
    await o.fs.mkdir(stateFile.slice(0, Math.max(stateFile.lastIndexOf('/'), stateFile.lastIndexOf('\\'))), { recursive: true });
    await o.fs.writeText(stateFile, JSON.stringify({ version: 1, studios }));
  };
  const clientFor = (s: JoinedStudio): StudioClient => {
    const key: KeyPair = { publicKey: s.publicKey, privateKey: o.unseal(s.sealedPrivateKey) };
    return new StudioClient({ url: s.url, key, fetchFn: o.fetchFn });
  };

  const markerOf = async (dir: string): Promise<StudioMarker | null> => {
    try {
      const m = JSON.parse(await o.fs.readText(`${dir}/${STUDIO_MARKER}`)) as Partial<StudioMarker>;
      if (typeof m.studioId !== 'string' || typeof m.fileId !== 'string' || typeof m.reviewerId !== 'string' || typeof m.file !== 'string') return null;
      return { studioId: m.studioId, fileId: m.fileId, reviewerId: m.reviewerId, project: String(m.project ?? ''), file: m.file, rev: String(m.rev ?? '') };
    } catch {
      return null;
    }
  };
  const writeMarker = async (dir: string, m: StudioMarker) => {
    await o.fs.mkdir(`${dir}/.cadrel`, { recursive: true });
    await o.fs.writeText(`${dir}/${STUDIO_MARKER}`, JSON.stringify(m, null, 2));
  };

  /** The folder this manuscript already has on this device, or a new unused one named for the project. */
  const folderFor = async (studioId: string, fileId: string, name: string): Promise<string> => {
    await o.fs.mkdir(sharedRoot, { recursive: true });
    for (const e of await o.fs.readdir(sharedRoot)) {
      if (!e.isDirectory) continue;
      const m = await markerOf(`${sharedRoot}/${e.name}`);
      if (m && m.studioId === studioId && m.fileId === fileId) return `${sharedRoot}/${e.name}`;
    }
    for (let n = 1; ; n++) {
      const candidate = `${sharedRoot}/${n === 1 ? name : `${name} (${n})`}`;
      if (!(await o.fs.stat(candidate))) return candidate;
    }
  };

  /** Brings every manuscript the Studio has opened to this reader down as a project; returns the projects. */
  const refreshStudio = async (s: JoinedStudio): Promise<SharedProject[]> => {
    const client = clientFor(s);
    const files = await client.beta<{ fileId: string; path: string; rev: string }[]>('files');
    const out: SharedProject[] = [];
    for (const f of files) {
      const slash = f.path.indexOf('/');
      const project = slash > 0 ? f.path.slice(0, slash) : s.name;
      const rest = slash > 0 ? f.path.slice(slash + 1) : f.path;
      const dir = await folderFor(s.studioId, f.fileId, toCompliantName(project));
      const had = await markerOf(dir);
      if (!had || had.rev !== f.rev) {
        const t = await client.beta<{ text: string; rev: string }>('text', f.fileId);
        await o.fs.mkdir(dir, { recursive: true });
        const at = rest.lastIndexOf('/');
        if (at > 0) await o.fs.mkdir(`${dir}/${rest.slice(0, at)}`, { recursive: true });
        await o.fs.writeText(`${dir}/${rest}`, t.text);
        await writeMarker(dir, { studioId: s.studioId, fileId: f.fileId, reviewerId: s.personId, project, file: rest, rev: t.rev });
        const projects = makeProjects(o.fs);
        if (!(await projects.isProject(dir))) await projects.convertToProject(dir);
      }
      out.push({ dir, project, reviewerId: s.personId });
    }
    return out;
  };

  return {
    async joinReview(link, name) {
      if (o.joined) throw new StudioApiError(`Studios you are invited to are joined from the Studio menu on Home: paste the invitation there, then switch to that Studio to read what is shared with you.`);
      const inv = parseInvitation(link);
      if (!inv) throw new StudioApiError('That is not a Cadrel invitation link. It starts with cadrel-reader://join');
      const who = name.trim() || 'Reader';
      const joined = await joinStudio({ link, yourName: who, fetchFn: o.fetchFn });
      // A Beta Reader invitation, or one with no role at all (the owner gives roles afterwards, per project); a role for the work itself is for Cadrel.
      if (joined.role !== 'beta_reader' && joined.role !== '_none') {
        throw new StudioApiError(`This invitation is for the role “${joined.role}”, which ${app} can’t use. ${app} is for Beta Readers. Ask the Studio’s owner for a Beta Reader invitation.`);
      }
      const client = new StudioClient({ url: joined.url, key: joined.key, fetchFn: o.fetchFn });
      const me = await client.me();
      const studio: JoinedStudio = {
        studioId: joined.studioId,
        url: joined.url,
        fingerprint: joined.fingerprint,
        name: joined.studioName ?? 'Studio',
        me: who,
        personId: me.personId,
        publicKey: joined.key.publicKey,
        sealedPrivateKey: o.seal(joined.key.privateKey)
      };
      await saveStudios([...(await loadStudios()).filter((x) => x.studioId !== studio.studioId), studio]);
      const projects = await refreshStudio(studio);
      const first = projects[0];
      if (!first) throw new StudioApiError('You’re in the Studio, but nothing has been shared with you yet. You are not asked to join again: once the author gives you a project and switches some chapters on, it appears under “Shared with me”.');
      return first;
    },

    async listShared() {
      // what the author has shared since last time comes down first; offline or refused, what is already here is still listed
      for (const s of await loadStudios()) await refreshStudio(s).catch(() => undefined);
      const out: SharedProject[] = [];
      if (!(await o.fs.stat(sharedRoot))) return out;
      for (const e of (await o.fs.readdir(sharedRoot)).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory) continue;
        const m = await markerOf(`${sharedRoot}/${e.name}`);
        if (m) out.push({ dir: `${sharedRoot}/${e.name}`, project: m.project || e.name, reviewerId: m.reviewerId });
      }
      return out;
    },

    /** Latest text down (what the author has switched on now), and this reader's notes exchanged. `revoked` when access has been withdrawn. */
    async exchangeReviews(project) {
      const idle = { changed: false, revoked: false, errors: [] as string[] };
      const dir = project.replace(/\\/g, '/');
      const m = await markerOf(dir);
      if (!m) return idle;
      const studio = (await loadStudios()).find((s) => s.studioId === m.studioId);
      if (!studio) return { ...idle, errors: ['This project’s Studio is not on this device any more. Open the invitation again.'] };
      const client = clientFor(studio);
      let changed = false;
      try {
        // a manuscript the author closed, or a project taken away, is answered as a refusal
        const files = await client.beta<{ fileId: string; rev: string }[]>('files');
        const there = files.find((f) => f.fileId === m.fileId);
        if (!there) return { ...idle, revoked: true };
        if (there.rev !== m.rev || !(await o.fs.stat(`${dir}/${m.file}`))) {
          const t = await client.beta<{ text: string; rev: string }>('text', m.fileId);
          await o.fs.writeText(`${dir}/${m.file}`, t.text);
          await writeMarker(dir, { ...m, rev: t.rev });
          changed = true;
        }
        const local = new Map((await reviews.list(dir)).map((r) => [r.id, r.text]));
        const mine = local.get(m.reviewerId) ?? '';
        const remote = (await client.beta<{ text: string }>('notes', m.fileId)).text;
        const merged = serializeReviewFile(mergeFiles(parseReviewFile(remote), parseReviewFile(mine), m.project, { id: m.reviewerId, name: studio.me }));
        if (merged !== mine) {
          await reviews.save(dir, m.reviewerId, merged);
          changed = true;
        }
        if (merged !== remote) await client.beta('putNotes', { fileId: m.fileId, text: merged });
        return { ...idle, changed };
      } catch (e) {
        if (isRevoked(e)) return { ...idle, changed, revoked: true };
        return { ...idle, changed, errors: [e instanceof Error ? e.message : String(e)] };
      }
    }
  };
}
