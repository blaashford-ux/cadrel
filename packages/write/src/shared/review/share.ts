/**
 * Sharing a project for review over Google Drive.
 *
 * The owner publishes a snapshot of the project (the "package", readable by anyone with its link) and, for each
 * reviewer, creates a private comments file (writable by anyone with that reviewer's link). Everyone only ever writes
 * files they own or were given the link to, so reviewers can't change the manuscript or see each other's notes.
 */
import { makeProjects } from '../backend/projects';
import { makeReviews } from '../backend/reviews';
import type { FsPort } from '../fsPort';
import { md5Hex } from '../md5';
import { toCompliantName } from '../sync/names';
import { DRIVE_REVIEWS_NAME, type DriveApi, type DriveFile } from '../sync/drive';
import { mergeReviewFiles, newReviewFile, parseReviewFile, serializeReviewFile, type ReviewFile } from './comments';
import { buildInviteLink } from './link';
import { splitChapters } from '../chapters';
import { exchangeCollab } from './collab';
import { mergeTeam, parseTeam, serializeWithTeam, sharedAmongEditors, visibleTo } from './team';
import { buildPackage, chapterKeys, parsePackage, readCollabBase, readMarker, readProseFiles, selectChapters, writeCollabBase, writeMarker, writePackage, type ChapterSelection } from './package';

export interface ReviewerRecord {
  id: string;
  name: string;
  commentsId: string;
  createdAt: string;
  link: string;
  /**
   * 'edit' for a collaborator: they work on the text itself, in a copy of the manuscript (all chapters or the ticked ones) that is
   * merged with the owner's each time either syncs. Absent for a reviewer, who can only read and leave notes.
   */
  role?: 'edit';
  /**
   * Set when this reviewer was given only some chapters: the keys of those chapters, and their own package file in Drive
   * (everyone else shares the project's package). Absent means the whole manuscript.
   */
  chapters?: string[];
  /** Collaborators only: the manuscript `chapters` are chapters of (every other Markdown file is shared whole). */
  chapterFile?: string;
  chapterLevel?: number;
  packageId?: string;
  packageMd5?: string | null;
}

/** The chapters of a project's manuscript as the share dialog lists them. */
export interface ShareChapters {
  manuscript: string | null;
  chapters: { key: string; title: string }[];
  /** Keys ticked by default: what was ticked for this manuscript last time (everything the first time). */
  selected: string[];
}

export interface ShareRecord {
  packageId: string;
  packageMd5: string | null;
  publishedAt: string | null;
  reviewers: ReviewerRecord[];
  /** Reviewers who were removed. Kept so a device that hasn't heard yet doesn't bring them back when the lists are merged. */
  revoked?: string[];
}

interface ShareState {
  version: 1;
  folderId: string | null;
  /** The shared-with-all-devices copy of this state in Drive (see `refresh`). */
  stateId?: string | null;
  projects: Record<string, ShareRecord>;
  /** The chapters last ticked in the share dialog, per manuscript (`project/path`), so the next invitation starts from them. */
  selections?: Record<string, string[]>;
  /** Per collaborator (`project/reviewerId`): the text both sides last agreed on, by file path. Only this device needs it. */
  bases?: Record<string, Record<string, string>>;
}

/** The part of a project's share record that every device of the owner needs to know. */
type SharedRecord = Pick<ShareRecord, 'packageId' | 'publishedAt' | 'reviewers' | 'revoked'>;

/**
 * The reviews folder among everything the app can see. Drive reports a top-level folder's parent as My Drive's own id, which this
 * app can't see (and never lists), so "top level" means no parent or a parent that isn't in the list, as the sync engine does.
 * The oldest wins, so two devices that each made one settle on the same folder.
 */
export function findReviewsFolder(all: DriveFile[]): string | null {
  const ids = new Set(all.map((f) => f.id));
  const found = all.filter((f) => f.isFolder && f.name === DRIVE_REVIEWS_NAME && (f.parentId === null || !ids.has(f.parentId)));
  return found.sort((a, b) => a.modifiedMs - b.modifiedMs || a.id.localeCompare(b.id))[0]?.id ?? null;
}

/** Name of the file in the reviews folder that carries the owner's shares between their devices. */
export const SHARES_FILE_NAME = 'mdedit-shares.json';

/**
 * Two copies of the owner's shares (this device's and the one in Drive) combined: reviewers are united by id, and anyone
 * removed on either side stays removed.
 */
export function mergeShareStates(local: Record<string, ShareRecord>, remote: Record<string, Partial<SharedRecord>>): Record<string, ShareRecord> {
  const out: Record<string, ShareRecord> = {};
  for (const name of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[name];
    const r = remote[name];
    const revoked = [...new Set([...(l?.revoked ?? []), ...(r?.revoked ?? [])])].sort();
    const gone = new Set(revoked);
    const byId = new Map<string, ReviewerRecord>();
    for (const x of [...(r?.reviewers ?? []), ...(l?.reviewers ?? [])]) if (!gone.has(x.id)) byId.set(x.id, x);
    const ids = [l?.packageId, r?.packageId].filter((x): x is string => !!x).sort();
    const packageId = ids[0] ?? '';
    const dates = [l?.publishedAt, r?.publishedAt].filter((x): x is string => !!x).sort();
    out[name] = {
      packageId,
      // the last upload's fingerprint only means something for the package it was made from
      packageMd5: l && l.packageId === packageId ? l.packageMd5 : null,
      publishedAt: dates[dates.length - 1] ?? null,
      reviewers: [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      ...(revoked.length ? { revoked } : {})
    };
  }
  return out;
}

export interface ShareStatus {
  shared: boolean;
  publishedAt: string | null;
  reviewers: ReviewerRecord[];
}

/** A shared project in the owner's list. */
export interface ShareSummary {
  project: string;
  reviewers: ReviewerRecord[];
  publishedAt: string | null;
}

export interface ShareOptions {
  fs: FsPort;
  /** Drive is created on use, because the sign-in may happen after the app starts. */
  drive: () => DriveApi;
  /** Where this device remembers what it has shared (outside the Root Folder). */
  stateFile: string;
  now?: () => Date;
  newId?: () => string;
}

const randomId = () => Array.from({ length: 10 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

/** Owner side. */
export class ReviewShare {
  private state: ShareState = { version: 1, folderId: null, projects: {} };
  private loaded = false;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly o: ShareOptions) {
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? randomId;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await this.o.fs.readText(this.o.stateFile)) as Partial<ShareState>;
      if (raw.version === 1 && raw.projects) this.state = { version: 1, folderId: raw.folderId ?? null, projects: raw.projects, selections: raw.selections ?? {}, bases: raw.bases ?? {} };
    } catch {
      /* first run */
    }
  }

  private async save(): Promise<void> {
    await this.o.fs.mkdir(this.o.stateFile.slice(0, this.o.stateFile.lastIndexOf('/')), { recursive: true });
    await this.o.fs.writeText(this.o.stateFile, JSON.stringify(this.state));
  }

  private lastRefresh = 0;
  private lastDiscovery = 0;

  /**
   * Brings in what the owner's other devices shared (and tells them what this one did): the owner's shares live in a small file
   * in the Drive reviews folder, so the phone and the PC show the same reviewers and both exchange notes with them. Quietly does
   * nothing when Drive can't be reached. Checked at most once a minute unless `force`.
   */
  private async refresh(force = false): Promise<void> {
    const t = this.now().getTime();
    if (!force && t - this.lastRefresh < 60_000) return;
    this.lastRefresh = t;
    try {
      const drive = this.o.drive();
      let remote: Record<string, Partial<SharedRecord>> = {};
      let stateId = this.state.stateId ?? null;
      if (stateId && !(await drive.getFile(stateId))) stateId = null;
      if (!stateId && (force || t - this.lastDiscovery > 600_000)) {
        this.lastDiscovery = t;
        const all = await drive.listAll();
        const folder = this.state.folderId && all.some((f) => f.id === this.state.folderId) ? this.state.folderId : findReviewsFolder(all);
        if (folder) {
          this.state.folderId = folder;
          stateId = all.find((f) => !f.isFolder && f.name === SHARES_FILE_NAME && f.parentId === folder)?.id ?? null;
        }
      }
      if (stateId) {
        try {
          const raw = JSON.parse(await drive.download(stateId)) as { projects?: Record<string, Partial<SharedRecord>> };
          if (raw && typeof raw.projects === 'object' && raw.projects) remote = raw.projects;
        } catch {
          /* unreadable: replaced below */
        }
      }
      const merged = mergeShareStates(this.state.projects, remote);
      const changed = JSON.stringify(merged) !== JSON.stringify(this.state.projects);
      this.state.projects = merged;
      this.state.stateId = stateId;
      if (changed) await this.save();
      const shared = Object.values(merged).some((r) => r.reviewers.length > 0 || (r.revoked?.length ?? 0) > 0);
      const body = JSON.stringify({ version: 1, projects: Object.fromEntries(Object.entries(merged).map(([k, r]) => [k, { packageId: r.packageId, publishedAt: r.publishedAt, reviewers: r.reviewers, revoked: r.revoked ?? [] }])) });
      const same = stateId && JSON.stringify(remote) === JSON.stringify((JSON.parse(body) as { projects: unknown }).projects);
      if (shared && !same) {
        if (stateId) await drive.updateFile(stateId, body);
        else {
          const file = await drive.createFile(SHARES_FILE_NAME, await this.folder(), body);
          this.state.stateId = file.id;
          await this.save();
        }
      }
    } catch {
      /* offline, or not signed in: this device's own record is still right */
    }
  }

  async status(project: string): Promise<ShareStatus> {
    await this.load();
    await this.refresh();
    const r = this.state.projects[project];
    return { shared: !!r && r.reviewers.length > 0, publishedAt: r?.publishedAt ?? null, reviewers: r?.reviewers ?? [] };
  }

  /** Every project that has at least one reviewer. */
  async list(): Promise<ShareSummary[]> {
    await this.load();
    await this.refresh();
    return Object.entries(this.state.projects)
      .filter(([, r]) => r.reviewers.length > 0)
      .map(([project, r]) => ({ project, reviewers: r.reviewers, publishedAt: r.publishedAt }))
      .sort((a, b) => a.project.localeCompare(b.project, undefined, { sensitivity: 'base' }));
  }

  /** Removes every reviewer of a project (their notes are taken first and stay in the project). */
  async revokeAll(dir: string, project: string): Promise<void> {
    await this.load();
    for (const r of [...(this.state.projects[project]?.reviewers ?? [])]) await this.revoke(dir, project, r.id);
  }

  /** The Drive folder that holds shared files, beside (not inside) the sync folder. */
  private async folder(): Promise<string> {
    if (this.state.folderId && (await this.o.drive().getFile(this.state.folderId))) return this.state.folderId;
    const existing = findReviewsFolder(await this.o.drive().listAll());
    this.state.folderId = existing ?? (await this.o.drive().createFolder(DRIVE_REVIEWS_NAME, null)).id;
    return this.state.folderId;
  }

  /**
   * What reviewers get: the project's active manuscript and nothing else (a project may hold other books, notes and drafts that
   * were never meant for them). A project with a single prose file needs no choice; otherwise one has to be made.
   */
  private async packageFor(dir: string, project: string): Promise<ReturnType<typeof buildPackage> extends Promise<infer P> ? P : never> {
    const active = (await makeProjects(this.o.fs).readMeta(dir))?.activeManuscript ?? null;
    if (active) {
      const pkg = await buildPackage(this.o.fs, dir, project, this.now, active);
      if (pkg.files.length === 0) throw new Error(`The active manuscript “${active}” isn’t in this project any more. Choose it again (right-click the file → Active Manuscript) before sharing.`);
      return pkg;
    }
    const all = await buildPackage(this.o.fs, dir, project, this.now);
    if (all.files.length <= 1) return all;
    throw new Error('Choose which file reviewers should see first: right-click it in the file list and pick “Active Manuscript”. Reviewers only ever see that one file.');
  }

  /** Uploads the project's current text for reviewers (only when it has changed since the last upload). */
  async publish(dir: string, project: string): Promise<ShareRecord> {
    await this.load();
    const pkg = await this.packageFor(dir, project);
    // The timestamp would make every snapshot differ; compare the content only.
    const body = JSON.stringify({ ...pkg, publishedAt: '' });
    const md5 = md5Hex(body);
    let rec = this.state.projects[project];
    const stillThere = rec?.packageId ? await this.o.drive().getFile(rec.packageId) : null;
    if (rec && stillThere && rec.packageMd5 === md5) return rec;

    const text = JSON.stringify(pkg);
    if (rec && stillThere) {
      await this.o.drive().updateFile(rec.packageId, text);
    } else {
      const file = await this.o.drive().createFile(`${toCompliantName(project)}.mdedit-review.json`, await this.folder(), text);
      await this.o.drive().shareByLink(file.id, 'reader');
      rec = { packageId: file.id, packageMd5: null, publishedAt: null, reviewers: rec?.reviewers ?? [], ...(rec?.revoked ? { revoked: rec.revoked } : {}) };
    }
    rec = { ...rec!, packageMd5: md5, publishedAt: pkg.publishedAt };
    this.state.projects[project] = rec;
    await this.save();
    return rec;
  }

  /** Projects whose package was confirmed link-readable during this session (so the check is not repeated every minute). */
  private readonly packageChecked = new Set<string>();

  /**
   * Makes sure the package can be opened by link. Removing the last reviewer takes that access away, and a later invitation
   * re-uses the same package, so it has to be given again: without it the reviewer's picker offers only their comments file
   * and the project can't be opened. Harmless when the access is already there.
   */
  private async ensurePackageShared(project: string, packageId: string, force = false, role: 'reader' | 'writer' = 'reader'): Promise<void> {
    if (!force && this.packageChecked.has(`${project}:${packageId}`)) return;
    await this.o.drive().shareByLink(packageId, role);
    this.packageChecked.add(`${project}:${packageId}`);
  }

  /** The manuscript reviewers see: the active one, or the project's only prose file. */
  private async manuscriptOf(dir: string, project: string): Promise<string | null> {
    const active = (await makeProjects(this.o.fs).readMeta(dir))?.activeManuscript ?? null;
    if (active) return active;
    const all = await buildPackage(this.o.fs, dir, project, this.now);
    return all.files.length === 1 ? all.files[0].path : null;
  }

  /** The manuscript's chapters for the share dialog, with the ticks remembered from last time. */
  async chapters(dir: string, project: string, level: number): Promise<ShareChapters> {
    await this.load();
    const manuscript = await this.manuscriptOf(dir, project);
    if (!manuscript) return { manuscript: null, chapters: [], selected: [] };
    const pkg = await buildPackage(this.o.fs, dir, project, this.now, manuscript);
    const chapters = pkg.files[0] ? chapterKeys(splitChapters(pkg.files[0].text, level)) : [];
    const saved = this.state.selections?.[`${project}/${manuscript}`];
    const selected = saved ? chapters.filter((c) => saved.includes(c.key)).map((c) => c.key) : chapters.map((c) => c.key);
    return { manuscript, chapters, selected };
  }

  /** Uploads each chapter-limited reviewer's own copy (only the chapters they were given), when it has changed. */
  private async publishSubsets(dir: string, project: string): Promise<void> {
    const rec = this.state.projects[project];
    if (!rec?.reviewers.some((r) => r.chapters && r.packageId && !r.role)) return;
    const manuscript = await this.manuscriptOf(dir, project);
    if (!manuscript) return;
    let changed = false;
    const reviewers: ReviewerRecord[] = [];
    for (const r of rec.reviewers) {
      if (!r.chapters || !r.packageId || r.role) {
        reviewers.push(r);
        continue;
      }
      const pkg = await buildPackage(this.o.fs, dir, project, this.now, manuscript, { keys: r.chapters, level: r.chapterLevel ?? 1 });
      const md5 = md5Hex(JSON.stringify({ ...pkg, publishedAt: '' }));
      if (md5 !== r.packageMd5 || !(await this.o.drive().getFile(r.packageId))) {
        await this.o.drive().updateFile(r.packageId, JSON.stringify(pkg));
        changed = true;
        reviewers.push({ ...r, packageMd5: md5 });
      } else reviewers.push(r);
    }
    if (changed) {
      this.state.projects[project] = { ...rec, reviewers };
      await this.save();
    }
  }

  /**
   * Adds a reviewer: makes their comments file and returns the link to send them. With `chapters` (fewer than all of them) the
   * reviewer gets a copy of the manuscript holding just those chapters, in a file of their own; the choice is remembered for the
   * manuscript so the next invitation starts from the same ticks.
   *
   * With `role: 'edit'` the person is a collaborator: they get every Markdown file of the project (not just the active
   * manuscript) in a working copy they can write to, and `collaborate` merges it with the owner's files on every sync. `chapters`
   * then limits only the active manuscript; the other files are shared whole.
   */
  async invite(dir: string, project: string, reviewerName: string, chapters?: ChapterSelection | null, role?: 'edit'): Promise<ReviewerRecord> {
    await this.load();
    await this.refresh(true);
    // Collaborators don't use the read-only snapshot, so it is only published (and opened by link) for reviewers.
    const rec = role
      ? (this.state.projects[project] ?? { packageId: '', packageMd5: null, publishedAt: null, reviewers: [] })
      : await this.publish(dir, project);
    if (!role) await this.ensurePackageShared(project, rec.packageId, true);
    const id = this.newId();
    const name = reviewerName.trim() || 'Reviewer';
    let subset: Pick<ReviewerRecord, 'chapters' | 'chapterFile' | 'chapterLevel' | 'packageId' | 'packageMd5'> = {};
    if (role) {
      const files = await readProseFiles(this.o.fs, dir);
      if (files.length === 0) throw new Error('There are no Markdown files in this project to share yet.');
      const manuscript = chapters ? await this.manuscriptOf(dir, project) : null;
      const level = chapters?.level ?? 1;
      let keys: string[] | null = null;
      const text = manuscript ? files.find((f) => f.path === manuscript)?.text : undefined;
      if (chapters && manuscript && text !== undefined) {
        const all = chapterKeys(splitChapters(text, level)).map((c) => c.key);
        const ticked = all.filter((k) => chapters.keys.includes(k));
        if (ticked.length === 0) throw new Error('Tick at least one chapter for this collaborator to edit.');
        this.state.selections = { ...this.state.selections, [`${project}/${manuscript}`]: ticked };
        if (ticked.length < all.length) keys = ticked;
      }
      const shown = files.map((f) => (keys && f.path === manuscript ? { path: f.path, text: selectChapters(f.text, { keys, level }) } : f));
      const file = await this.o.drive().createFile(
        `${toCompliantName(project)} - ${toCompliantName(name)}.mdedit-review.json`,
        await this.folder(),
        JSON.stringify({ version: 1, project, publishedAt: this.now().toISOString(), files: shown, chapterLevel: level })
      );
      await this.o.drive().shareByLink(file.id, 'writer');
      subset = { ...(keys && manuscript ? { chapters: keys, chapterFile: manuscript } : {}), chapterLevel: level, packageId: file.id, packageMd5: null };
      this.state.bases = { ...this.state.bases, [`${project}/${id}`]: Object.fromEntries(shown.map((f) => [f.path, f.text])) };
    } else if (chapters) {
      const manuscript = await this.manuscriptOf(dir, project);
      if (manuscript) {
        const pkg0 = await buildPackage(this.o.fs, dir, project, this.now, manuscript);
        const all = pkg0.files[0] ? chapterKeys(splitChapters(pkg0.files[0].text, chapters.level)).map((c) => c.key) : [];
        const keys = all.filter((k) => chapters.keys.includes(k));
        if (keys.length === 0) throw new Error('Tick at least one chapter for this reviewer to see.');
        this.state.selections = { ...this.state.selections, [`${project}/${manuscript}`]: keys };
        if (keys.length < all.length) {
          const pkg = await buildPackage(this.o.fs, dir, project, this.now, manuscript, { keys, level: chapters.level });
          const file = await this.o.drive().createFile(`${toCompliantName(project)} - ${toCompliantName(name)}.mdedit-review.json`, await this.folder(), JSON.stringify(pkg));
          await this.o.drive().shareByLink(file.id, 'reader');
          subset = { chapters: keys, chapterLevel: chapters.level, packageId: file.id, packageMd5: md5Hex(JSON.stringify({ ...pkg, publishedAt: '' })) };
        }
      }
    }
    const file = await this.o.drive().createFile(
      `${toCompliantName(project)} - ${toCompliantName(name)}.comments.json`,
      await this.folder(),
      serializeReviewFile(newReviewFile(project, { id, name }))
    );
    await this.o.drive().shareByLink(file.id, 'writer');
    const reviewer: ReviewerRecord = {
      id,
      name,
      commentsId: file.id,
      createdAt: this.now().toISOString(),
      link: buildInviteLink({ packageId: subset.packageId ?? rec.packageId, commentsId: file.id, reviewerId: id, project, ...(role ? { role } : {}) }),
      ...(role ? { role } : {}),
      ...subset
    };
    this.state.projects[project] = { ...rec, reviewers: [...rec.reviewers, reviewer] };
    await this.save();
    await this.refresh(true); // tell the owner's other devices
    return reviewer;
  }

  /** Stops a reviewer: takes their notes (one last time), then closes their file. Their notes stay in the project. */
  async revoke(dir: string, project: string, reviewerId: string): Promise<void> {
    await this.load();
    await this.refresh(true);
    const rec = this.state.projects[project];
    const who = rec?.reviewers.find((r) => r.id === reviewerId);
    if (!rec || !who) return;
    await this.collaborate(dir, project).catch(() => undefined);
    await this.pull(dir, project).catch(() => undefined);
    await this.o.drive().unshare(who.commentsId).catch(() => undefined);
    if (who.packageId) await this.o.drive().unshare(who.packageId).catch(() => undefined);
    const left = rec.reviewers.filter((r) => r.id !== reviewerId);
    if (!left.some((r) => !r.role) && rec.packageId) {
      await this.o.drive().unshare(rec.packageId).catch(() => undefined);
      this.packageChecked.delete(`${project}:${rec.packageId}`);
    }
    this.state.projects[project] = { ...rec, reviewers: left, revoked: [...new Set([...(rec.revoked ?? []), reviewerId])] };
    if (this.state.bases) delete this.state.bases[`${project}/${reviewerId}`];
    await this.save();
    await this.refresh(true);
  }

  /** Exchanges notes with every reviewer's file; returns whether anything on this device changed. */
  async pull(dir: string, project: string): Promise<{ changed: boolean; errors: string[] }> {
    await this.load();
    const rec = this.state.projects[project];
    const out = { changed: false, errors: [] as string[] };
    if (!rec) return out;
    // An invitation that was sent while the package was private is repaired here, once per session.
    if (rec.reviewers.some((r) => !r.role) && rec.packageId) await this.ensurePackageShared(project, rec.packageId).catch((e) => out.errors.push(e instanceof Error ? e.message : String(e)));
    for (const who of rec.reviewers) {
      if (who.packageId) await this.ensurePackageShared(`${project}/${who.id}`, who.packageId, false, who.role ? 'writer' : 'reader').catch((e) => out.errors.push(e instanceof Error ? e.message : String(e)));
    }
    const reviews = makeReviews(this.o.fs);
    const local = new Map((await reviews.list(dir)).map((r) => [r.id, r.text]));
    const collaboratorIds = new Set(rec.reviewers.filter((r) => r.role).map((r) => r.id));
    for (const who of rec.reviewers) {
      try {
        const remoteText = await this.o.drive().download(who.commentsId);
        const merged = mergeFiles(parseReviewFile(remoteText), parseReviewFile(local.get(who.id) ?? ''), project, who);
        const text = serializeReviewFile(merged);
        if (text !== local.get(who.id)) {
          await reviews.save(dir, who.id, text);
          local.set(who.id, text);
          out.changed = true;
        }
        let upload = text;
        if (who.role) {
          // Collaborators also swap the editing group's notes (theirs, the owner's, the AI's) with the owner.
          const theirs = parseTeam(remoteText).filter((f) => f.reviewer.id !== who.id && sharedAmongEditors(f.reviewer.id, collaboratorIds));
          for (const f of theirs) {
            const have = parseReviewFile(local.get(f.reviewer.id) ?? '');
            const joined = serializeReviewFile(have ? mergeReviewFiles(have, f) : f);
            if (joined !== local.get(f.reviewer.id)) {
              await reviews.save(dir, f.reviewer.id, joined);
              local.set(f.reviewer.id, joined);
              out.changed = true;
            }
          }
          const mine = [...local].filter(([id]) => id !== who.id && sharedAmongEditors(id, collaboratorIds)).map(([, t]) => parseReviewFile(t)).filter((f): f is ReviewFile => !!f);
          const manuscript = who.chapters ? (who.chapterFile ?? (await this.manuscriptOf(dir, project))) : null;
          const body = manuscript ? { path: manuscript, text: await this.o.fs.readText(`${dir}/${manuscript}`).catch(() => '') } : null;
          const team = visibleTo(mergeTeam(theirs, mine), body, who.chapters ? { keys: who.chapters, level: who.chapterLevel ?? 1 } : null);
          upload = serializeWithTeam(merged, team);
        }
        if (upload !== remoteText) await this.o.drive().updateFile(who.commentsId, upload);
      } catch (e) {
        out.errors.push(`${who.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  /**
   * Merges the owner's text with each collaborator's working copy: what only one side changed is taken, what both changed is
   * merged, and the result goes to the owner's file and to the collaborator's. Because every collaborator is merged in turn,
   * one collaborator's changes reach the others on the same pass.
   */
  async collaborate(dir: string, project: string): Promise<{ changed: boolean; errors: string[] }> {
    await this.load();
    const out = { changed: false, errors: [] as string[] };
    const rec = this.state.projects[project];
    for (const who of rec?.reviewers ?? []) {
      if (!who.role || !who.packageId) continue;
      try {
        const key = `${project}/${who.id}`;
        const r = await exchangeCollab({
          fs: this.o.fs,
          drive: this.o.drive(),
          dir,
          packageId: who.packageId,
          level: who.chapterLevel ?? 1,
          scope: who.chapters ? new Set(who.chapters) : null,
          scopeFile: who.chapterFile ?? null,
          base: this.state.bases?.[key] ?? null,
          labels: { local: 'Yours', remote: who.name },
          now: this.now
        });
        if (r.gone) {
          out.errors.push(`${who.name}: their shared copy is no longer in Drive.`);
          continue;
        }
        if (r.localChanged.length) out.changed = true;
        if (r.conflicts) out.errors.push(`${who.name}: ${r.conflicts} place${r.conflicts === 1 ? '' : 's'} where you both changed the same lines. Both versions are in the text between <<<<<<< and >>>>>>> lines; keep what you want and delete the rest.`);
        if (JSON.stringify(this.state.bases?.[key]) !== JSON.stringify(r.base)) {
          this.state.bases = { ...this.state.bases, [key]: r.base };
          await this.save();
        }
      } catch (e) {
        out.errors.push(`${who.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  /** A full exchange: new text out, notes in and out. */
  async sync(dir: string, project: string): Promise<{ changed: boolean; errors: string[] }> {
    await this.load();
    await this.refresh();
    if (!this.state.projects[project]?.reviewers.length) return { changed: false, errors: [] };
    const collab = await this.collaborate(dir, project);
    if (this.state.projects[project].reviewers.some((r) => !r.role)) await this.publish(dir, project);
    await this.publishSubsets(dir, project);
    const notes = await this.pull(dir, project);
    return { changed: collab.changed || notes.changed, errors: [...collab.errors, ...notes.errors] };
  }
}

function mergeFiles(remote: ReviewFile | null, local: ReviewFile | null, project: string, who: { id: string; name: string }): ReviewFile {
  const base = newReviewFile(project, { id: who.id, name: who.name });
  const r = remote ?? base;
  return local ? mergeReviewFiles(r, local) : r;
}

export interface JoinOptions {
  fs: FsPort;
  drive: () => DriveApi;
  /** Local folder for projects shared with this person ("Shared With Me"). */
  sharedRoot: string;
}

/** A project somebody shared with this person, as it sits on this device. */
export interface SharedProject {
  /** The local folder the project lives in. */
  dir: string;
  project: string;
  reviewerId: string;
  /** 'edit' when this person is a collaborator and may change the text. */
  role?: 'edit';
}

export type JoinResult = SharedProject;

/** Reviewer side. The file picker has already given this app access to the two files by the time these run. */
export class ReviewJoin {
  constructor(private readonly o: JoinOptions) {}

  async join(invite: { packageId: string; commentsId: string; reviewerId: string; project: string; role?: 'edit' }, readerName: string): Promise<JoinResult> {
    const { fs } = this.o;
    const drive = this.o.drive();
    const pkgFile = await drive.getFile(invite.packageId);
    const commentsFile = await drive.getFile(invite.commentsId);
    if (!pkgFile || !commentsFile) throw new Error('MDEdit can’t open that project yet. Pick both files when Google asks, or ask the owner to send the link again.');
    const pkg = parsePackage(await drive.download(invite.packageId));
    if (!pkg) throw new Error('That file isn’t a MDEdit review package.');

    const dir = await this.folderFor(invite.reviewerId, toCompliantName(pkg.project));
    const previous = (await readMarker(fs, dir))?.files ?? [];
    const files = await writePackage(fs, dir, pkg, previous);
    await writeMarker(fs, dir, { packageId: invite.packageId, commentsId: invite.commentsId, reviewerId: invite.reviewerId, project: pkg.project, packageMd5: pkgFile.md5, files, ...(invite.role ? { role: invite.role } : {}) });
    if (invite.role) await writeCollabBase(fs, dir, Object.fromEntries(pkg.files.map((f) => [f.path, f.text])));
    const projects = makeProjects(fs);
    if (!(await projects.isProject(dir))) await projects.convertToProject(dir); // so it opens like any project

    const remote = parseReviewFile(await drive.download(invite.commentsId)) ?? newReviewFile(pkg.project, { id: invite.reviewerId, name: readerName });
    const named: ReviewFile = { ...remote, reviewer: { id: invite.reviewerId, name: readerName || remote.reviewer.name } };
    await makeReviews(fs).save(dir, invite.reviewerId, serializeReviewFile(named));
    if (named.reviewer.name !== remote.reviewer.name) await drive.updateFile(invite.commentsId, serializeReviewFile(named));
    return { dir, project: pkg.project, reviewerId: invite.reviewerId, ...(invite.role ? { role: invite.role } : {}) };
  }

  /** The same folder again when this invitation was joined before; otherwise a new, unused name. */
  private async folderFor(reviewerId: string, name: string): Promise<string> {
    const { fs, sharedRoot } = this.o;
    await fs.mkdir(sharedRoot, { recursive: true });
    for (const e of await fs.readdir(sharedRoot)) {
      if (e.isDirectory && (await readMarker(fs, `${sharedRoot}/${e.name}`))?.reviewerId === reviewerId) return `${sharedRoot}/${e.name}`;
    }
    for (let n = 1; ; n++) {
      const candidate = `${sharedRoot}/${n === 1 ? name : `${name} (${n})`}`;
      if (!(await fs.stat(candidate))) return candidate;
    }
  }

  /** Projects shared with this person, as found on disk. */
  async list(): Promise<SharedProject[]> {
    const { fs, sharedRoot } = this.o;
    if (!(await fs.stat(sharedRoot))) return [];
    const out: SharedProject[] = [];
    for (const e of (await fs.readdir(sharedRoot)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory) continue;
      const m = await readMarker(fs, `${sharedRoot}/${e.name}`);
      if (m) out.push({ dir: `${sharedRoot}/${e.name}`, project: m.project || e.name, reviewerId: m.reviewerId, ...(m.role ? { role: m.role } : {}) });
    }
    return out;
  }

  /** Brings the owner's latest text down and exchanges this reviewer's notes. `revoked` when access has been withdrawn. */
  async sync(dir: string): Promise<{ changed: boolean; revoked: boolean; errors?: string[] }> {
    const { fs } = this.o;
    const drive = this.o.drive();
    const m = await readMarker(fs, dir);
    if (!m) throw new Error('That folder is not a shared project.');
    const pkgFile = await drive.getFile(m.packageId);
    const commentsFile = await drive.getFile(m.commentsId);
    if (!pkgFile || !commentsFile) return { changed: false, revoked: true };
    let changed = false;
    const errors: string[] = [];

    if (m.role === 'edit') {
      // A collaborator's text is merged with the owner's, never replaced by it.
      const r = await exchangeCollab({ fs, drive, dir, packageId: m.packageId, level: 1, scope: null, scopeFile: null, base: await readCollabBase(fs, dir), labels: { local: 'Yours', remote: 'Owner' }, now: () => new Date() });
      if (r.gone) return { changed: false, revoked: true };
      await writeCollabBase(fs, dir, r.base);
      const files = Object.keys(r.base);
      await writeMarker(fs, dir, { ...m, files, packageMd5: (await drive.getFile(m.packageId))?.md5 ?? m.packageMd5 });
      if (r.localChanged.length) changed = true;
      if (r.conflicts) errors.push(`${r.conflicts} place${r.conflicts === 1 ? '' : 's'} where you and the owner changed the same lines. Both versions are in the text between <<<<<<< and >>>>>>> lines; keep what you want and delete the rest.`);
    } else if (pkgFile.md5 !== m.packageMd5) {
      const pkg = parsePackage(await drive.download(m.packageId));
      if (pkg) {
        const files = await writePackage(fs, dir, pkg, m.files);
        await writeMarker(fs, dir, { ...m, project: pkg.project, packageMd5: pkgFile.md5, files });
        changed = true;
      }
    }

    const reviews = makeReviews(fs);
    const files = new Map((await reviews.list(dir)).map((r) => [r.id, r.text]));
    const local = files.get(m.reviewerId) ?? '';
    const remoteText = await drive.download(m.commentsId);
    const merged = mergeFiles(parseReviewFile(remoteText), parseReviewFile(local), m.project, { id: m.reviewerId, name: '' });
    const text = serializeReviewFile(merged);
    if (text !== local) {
      await reviews.save(dir, m.reviewerId, text);
      changed = true;
    }
    let upload = text;
    if (m.role === 'edit') {
      // The editing group's notes (the owner's, the other collaborators', the AI's) come down, and this person's AI notes and
      // replies go up, in the same file.
      const theirs = parseTeam(remoteText).filter((f) => f.reviewer.id !== m.reviewerId);
      for (const f of theirs) {
        const have = parseReviewFile(files.get(f.reviewer.id) ?? '');
        const joined = serializeReviewFile(have ? mergeReviewFiles(have, f) : f);
        if (joined !== files.get(f.reviewer.id)) {
          await reviews.save(dir, f.reviewer.id, joined);
          files.set(f.reviewer.id, joined);
          changed = true;
        }
      }
      const mine = [...files].filter(([id]) => id !== m.reviewerId).map(([, t]) => parseReviewFile(t)).filter((f): f is ReviewFile => !!f);
      upload = serializeWithTeam(merged, mergeTeam(theirs, mine));
    }
    if (upload !== remoteText) await drive.updateFile(m.commentsId, upload);
    return { changed, revoked: false, ...(errors.length ? { errors } : {}) };
  }
}
