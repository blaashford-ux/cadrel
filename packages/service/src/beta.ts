/**
 * Beta reading as one person on the Studio's server. A Beta Reader holds `beta.read` and `beta.comment` and nothing that reaches the vault, so
 * this is the only way they get any text: the manuscripts of the projects they were given, reduced to the chapters the author switched on, built
 * here from the stored file so a chapter that is off never leaves the server. Their notes are kept apart (a row each) and only ever reached by
 * their own person; the people who may write the manuscript can read every reader's notes. The person is fixed when this is made.
 */
import { fileKind, getBetaRead, type Db } from '@cadrel/kernel';
import { PermissionDenied } from './errors';
import type { StudioAs } from './index';

export interface BetaFile {
  fileId: string;
  /** The vault path, from which the app names the project and the file. */
  path: string;
  projectId: string | null;
  /** The newest version of the manuscript: the reader's copy is current while this is. */
  version: number;
  /** How many chapters are on, so an app can say "3 chapters". */
  chapters: number;
  /** Changes whenever the reader's copy would: a new version, or the author switching chapters on or off. */
  rev: string;
}

export interface BetaText {
  fileId: string;
  path: string;
  version: number;
  /** Only the chapters switched on, in their original order. */
  text: string;
  /** See `BetaFile.rev`. */
  rev: string;
}

export interface BetaNotes {
  personId: string;
  name: string;
  text: string;
  updatedAt: string;
}

/** The most one reader's notes on one manuscript may weigh: the file is held as it is given. */
export const MAX_BETA_NOTES = 2 * 1024 * 1024;

export class BetaAs {
  constructor(
    private readonly o: {
      db: Db;
      studioId: string;
      personId: string;
      as: StudioAs;
      now?: () => Date;
      /** The text of a stored version. */
      readBlob(hash: string): Promise<string | null>;
      /** The text of a manuscript reduced to the chapters at these keys. Given by the caller so this package needs no manuscript code. */
      select(text: string, sel: { keys: string[]; level: number }): string;
    }
  ) {}

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  private async row(fileId: string): Promise<{ path: string; projectId: string | null; version: number; hash: string | null } | null> {
    return this.o.db.first(
      `SELECT f.path AS path, c.project_id AS projectId, f.current_version AS version,
              (SELECT hash FROM file_version v WHERE v.file_id = f.id AND v.n = f.current_version) AS hash
         FROM vault_file f LEFT JOIN file_card c ON c.file_id = f.id WHERE f.studio_id = ? AND f.id = ?`,
      [this.o.studioId, fileId]
    );
  }

  /** The manuscript this reader may read, or a refusal that does not say whether it exists. */
  private async readable(fileId: string, cap: 'beta.read' | 'beta.comment') {
    const r = await this.row(fileId);
    if (!r || fileKind(r.path) !== 'manuscript' || !(await this.o.as.canAt(cap, r.projectId))) throw new PermissionDenied(cap, 'that manuscript is not shared with you');
    if ((await getBetaRead(this.o.db, fileId)).chapters.length === 0) throw new PermissionDenied(cap, 'that manuscript is not shared with you');
    return r;
  }

  /** The manuscripts this person is a beta reader of, with at least one chapter on. */
  async files(): Promise<BetaFile[]> {
    const rows = await this.o.db.all<{ id: string; path: string; projectId: string | null; version: number; chapters: string; at: string }>(
      `SELECT f.id AS id, f.path AS path, c.project_id AS projectId, f.current_version AS version, b.chapters AS chapters, b.updated_at AS at
         FROM beta_read b JOIN vault_file f ON f.id = b.file_id LEFT JOIN file_card c ON c.file_id = f.id
        WHERE f.studio_id = ? AND f.current_version > 0 ORDER BY f.path`,
      [this.o.studioId]
    );
    const out: BetaFile[] = [];
    for (const r of rows) {
      let n = 0;
      try {
        n = (JSON.parse(r.chapters) as unknown[]).length;
      } catch {
        /* nothing on */
      }
      if (n > 0 && fileKind(r.path) === 'manuscript' && (await this.o.as.canAt('beta.read', r.projectId))) out.push({ fileId: r.id, path: r.path, projectId: r.projectId, version: r.version, chapters: n, rev: `${r.version}:${r.at}` });
    }
    return out;
  }

  /** The manuscript as the author has opened it to beta readers: the chapters switched on, built from the newest version. */
  async text(fileId: string): Promise<BetaText> {
    const r = await this.readable(fileId, 'beta.read');
    const cfg = await getBetaRead(this.o.db, fileId);
    const whole = r.hash ? await this.o.readBlob(r.hash) : null;
    if (whole === null) throw new Error('That manuscript’s text is not available yet.');
    const at = (await this.o.db.first<{ at: string }>('SELECT updated_at AS at FROM beta_read WHERE file_id = ?', [fileId]))?.at ?? '';
    return { fileId, path: r.path, version: r.version, rev: `${r.version}:${at}`, text: this.o.select(whole, { keys: cfg.chapters, level: cfg.level }) };
  }

  /** This reader's own notes on a manuscript (empty text when they have none). */
  async notes(fileId: string): Promise<{ text: string }> {
    await this.readable(fileId, 'beta.read');
    const row = await this.o.db.first<{ text: string }>('SELECT text FROM beta_note WHERE file_id = ? AND person_id = ?', [fileId, this.o.personId]);
    return { text: row?.text ?? '' };
  }

  /** Replaces this reader's notes. The reader's app merges first, so a second device does not lose the first's notes. */
  async putNotes(a: { fileId: string; text: string }): Promise<void> {
    await this.readable(a.fileId, 'beta.comment');
    if (typeof a.text !== 'string' || a.text.length > MAX_BETA_NOTES) throw new Error('Those notes are too large to keep.');
    await this.o.db.run(
      'INSERT INTO beta_note (file_id, person_id, text, updated_at) VALUES (?,?,?,?) ON CONFLICT (file_id, person_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
      [a.fileId, this.o.personId, a.text, this.now()]
    );
  }

  /** Every reader's notes on a manuscript, for whoever may write it (the author). */
  async allNotes(fileId: string): Promise<BetaNotes[]> {
    const r = await this.row(fileId);
    if (!r || !(await this.o.as.canAt('manuscript.write', r.projectId))) throw new PermissionDenied('manuscript.write', 'no active role grants it here');
    return this.o.db.all<BetaNotes>(
      `SELECT n.person_id AS personId, COALESCE(p.name, 'Beta reader') AS name, n.text AS text, n.updated_at AS updatedAt
         FROM beta_note n LEFT JOIN person p ON p.id = n.person_id WHERE n.file_id = ? ORDER BY n.updated_at`,
      [fileId]
    );
  }
}

/** The names a caller may use on `BetaAs`: a list, so inherited names are not reachable. */
export const BETA_METHODS = ['files', 'text', 'notes', 'putNotes', 'allNotes'] as const;
