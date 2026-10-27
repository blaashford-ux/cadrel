/**
 * Backup and restore of a Studio, and import of a project from MDEdit. Electron-free, tested in test/backup.test.ts.
 *
 * A backup is one `.cadrel-backup` file: a zip whose `manifest.json` lists every other entry with its size and SHA-256. It is made
 * beside its destination and moved into place only after it has been read back and every checksum matched, so a backup that exists
 * is a backup that verified. Restoring never overwrites: a target that is not empty is refused.
 *
 * The files are held in memory one at a time (not the whole archive at once on the way in); a Studio's manuscripts are small. Market's
 * library is large and has its own backup, so it is not one of the sources unless the caller adds it.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { unzipSync, Zip, ZipDeflate, type Unzipped } from 'fflate';
import { sanitizeMarks } from '@cadrel/write/src/shared/editedMarks';
import { sanitizeProjectMeta, uniqueName, PROJECT_DIR, PROJECT_FILE } from '@cadrel/write/src/shared/projects';

export class BackupError extends Error {}
const fail = (m: string): never => {
  throw new BackupError(m);
};

export const BACKUP_EXTENSION = '.cadrel-backup';
export const MANIFEST = 'manifest.json';
/** The archive layout this build writes and the newest it reads. A newer one is refused with "update Cadrel". */
export const BACKUP_FORMAT = 1;

export interface BackupSource {
  /** The top-level folder in the archive, and the key a restore maps to a folder: `data`, `Projects`, `Write`. */
  name: string;
  dir: string;
  /** Only these top-level entries of `dir` (projects chosen by the person). Omitted: everything. */
  only?: string[];
  /** Relative paths ("/" separated) to leave out, over and above what is never backed up. */
  exclude?: (rel: string, isDir: boolean) => boolean;
}

export interface BackupEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: number;
  app: string;
  created: string;
  studio: { id: string; name: string };
  /** The studio.json schema this was made with; a restore by an older app refuses. */
  schema: number;
  sources: string[];
  entries: BackupEntry[];
}

/** Never in a backup, whatever the caller asks for: keys and tokens do not leave the machine in an archive someone might email. */
export function isSecret(rel: string, isDir: boolean): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => p.toLowerCase() === 'secrets')) return true;
  const base = parts[parts.length - 1]!.toLowerCase();
  return !isDir && (/token.*\.bin$/.test(base) || /\.(key|pem)$/.test(base) || base === 'pairing.json');
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const transient = (name: string) => /\.tmp$/i.test(name) || /\.lock$/i.test(name) || name === 'Thumbs.db';

async function* walk(root: string, rel = ''): AsyncGenerator<{ rel: string; abs: string; isDir: boolean }> {
  let list;
  try {
    list = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isSymbolicLink()) continue; // a link could lead out of the folder
    if (d.isDirectory()) {
      yield { rel: r, abs: path.join(root, r), isDir: true };
      yield* walk(root, r);
    } else if (d.isFile()) yield { rel: r, abs: path.join(root, r), isDir: false };
  }
}

export interface CreateOptions {
  /** Where the backup goes; it must end in `.cadrel-backup` and must not exist. */
  file: string;
  studio: { id: string; name: string };
  appVersion: string;
  schema: number;
  sources: BackupSource[];
  now?: Date;
}

export async function createBackup(o: CreateOptions): Promise<{ manifest: BackupManifest; files: number; bytes: number }> {
  if (!o.file.endsWith(BACKUP_EXTENSION)) fail(`A backup file name ends in ${BACKUP_EXTENSION}.`);
  if (await fsp.stat(o.file).then(() => true, () => false)) fail('There is already a file with that name. Choose another so no backup is overwritten.');
  const names = o.sources.map((s) => s.name);
  if (new Set(names).size !== names.length || names.some((n) => !/^[\w ()-]+$/.test(n))) fail('The backup sources need distinct, plain names.');

  await fsp.mkdir(path.dirname(o.file), { recursive: true });
  const tmp = `${o.file}.${process.pid}.tmp`;
  const out = createWriteStream(tmp);
  const failed = new Promise<never>((_, rej) => out.on('error', rej));
  const zip = new Zip((err, chunk, final) => {
    if (err) return void out.destroy(err);
    out.write(chunk);
    if (final) out.end();
  });
  const entries: BackupEntry[] = [];
  let bytes = 0;
  const add = (name: string, data: Uint8Array) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(data, true);
  };
  try {
    for (const src of o.sources) {
      const only = src.only ? new Set(src.only.map((x) => x.toLowerCase())) : null;
      for await (const e of walk(src.dir)) {
        const top = e.rel.split('/')[0]!;
        if (only && !only.has(top.toLowerCase())) continue;
        if (isSecret(e.rel, e.isDir) || src.exclude?.(e.rel, e.isDir)) continue;
        if (e.isDir) continue;
        if (transient(path.basename(e.rel))) continue;
        const data = new Uint8Array(await fsp.readFile(e.abs));
        const name = `${src.name}/${e.rel}`;
        add(name, data);
        entries.push({ path: name, size: data.length, sha256: sha256(data) });
        bytes += data.length;
      }
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, app: o.appVersion, created: (o.now ?? new Date()).toISOString(), studio: o.studio, schema: o.schema, sources: names, entries
    };
    add(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    zip.end();
    await Promise.race([once(out, 'close'), failed]);
    await verifyBackup(tmp); // the file the person will rely on has been read back before it is called a backup
    await fsp.rename(tmp, o.file);
    return { manifest, files: entries.length, bytes };
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

function parseManifest(raw: Uint8Array | undefined): BackupManifest {
  if (!raw) return fail('That is not a Cadrel backup (it has no manifest).');
  let m: Partial<BackupManifest>;
  try {
    m = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fail('That backup’s manifest is damaged.');
  }
  if (typeof m.format !== 'number' || !Array.isArray(m.entries) || !Array.isArray(m.sources) || !m.studio || typeof m.studio.id !== 'string') return fail('That is not a Cadrel backup.');
  if (m.format > BACKUP_FORMAT) fail('That backup was made by a newer Cadrel. Update Cadrel to read it.');
  const entries: BackupEntry[] = [];
  for (const e of m.entries) {
    if (!e || typeof e.path !== 'string' || typeof e.sha256 !== 'string' || typeof e.size !== 'number') return fail('That backup’s manifest is damaged.');
    entries.push({ path: e.path, size: e.size, sha256: e.sha256 });
  }
  return {
    format: m.format, app: String(m.app ?? ''), created: String(m.created ?? ''), studio: { id: m.studio.id, name: String(m.studio.name ?? '') },
    schema: typeof m.schema === 'number' ? m.schema : 0, sources: m.sources.filter((s): s is string => typeof s === 'string'), entries
  };
}

async function open(file: string): Promise<{ manifest: BackupManifest; files: Unzipped }> {
  let files: Unzipped;
  try {
    files = unzipSync(new Uint8Array(await fsp.readFile(file)));
  } catch (e) {
    if (e instanceof BackupError) throw e;
    return fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'That backup file is not there.' : 'That file is damaged or is not a backup.');
  }
  return { manifest: parseManifest(files[MANIFEST]), files };
}

/** Reads the whole archive back and checks every entry against the manifest, and the manifest against the entries. */
export async function verifyBackup(file: string): Promise<BackupManifest> {
  const { manifest, files } = await open(file);
  const listed = new Set<string>();
  for (const e of manifest.entries) {
    if (!safeEntry(e.path)) fail(`The backup lists a path it must not: ${e.path}`);
    const data = files[e.path];
    if (!data) fail(`The backup is missing ${e.path}.`);
    if (data!.length !== e.size || sha256(data!) !== e.sha256) fail(`The backup is damaged: ${e.path} does not match its checksum.`);
    listed.add(e.path);
  }
  for (const name of Object.keys(files)) if (name !== MANIFEST && !listed.has(name)) fail(`The backup holds a file its manifest does not list: ${name}.`);
  return manifest;
}

/** What the backup holds, for the person to see before restoring. Verifies as it goes. */
export async function describeBackup(file: string): Promise<BackupManifest & { projects: string[] }> {
  const manifest = await verifyBackup(file);
  const projects = [...new Set(manifest.entries.filter((e) => e.path.startsWith('Projects/')).map((e) => e.path.split('/')[1]!))].sort();
  return { ...manifest, projects };
}

/** Entry names are written by us, but a hand-made archive could try `..` or an absolute path. */
function safeEntry(name: string): boolean {
  return !!name && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && !name.includes('\\') && !name.split('/').some((p) => p === '..' || p === '.' || p === '');
}

const isEmptyDir = async (dir: string) => (await fsp.readdir(dir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : fail(`Cannot read ${dir}.`)))).length === 0;

export interface RestoreOptions {
  file: string;
  /** Source name → the folder to restore it into. A source with no target is not restored. Each target must be missing or empty. */
  targets: Record<string, string>;
  /** The newest studio.json schema this app understands. */
  maxSchema: number;
}

export async function restoreBackup(o: RestoreOptions): Promise<{ restored: number; manifest: BackupManifest }> {
  const manifest = await verifyBackup(o.file);
  if (manifest.schema > o.maxSchema) fail('That backup is from a newer Cadrel than this one. Update Cadrel to restore it.');
  for (const name of Object.keys(o.targets)) if (!manifest.sources.includes(name)) fail(`The backup has no “${name}” to restore.`);
  for (const dir of Object.values(o.targets)) if (!(await isEmptyDir(dir))) fail(`${dir} is not empty. Restore into an empty folder, so nothing is overwritten.`);
  const { files } = await open(o.file);
  let restored = 0;
  for (const e of manifest.entries) {
    const [source, ...rest] = e.path.split('/');
    const dir = o.targets[source!];
    if (!dir) continue;
    const dest = path.join(dir, ...rest);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, files[e.path]!, { flag: 'wx' });
    restored += 1;
  }
  return { restored, manifest };
}

/** Restores one project of a backup into a Projects folder under a name nothing else has; returns where it went. */
export async function restoreProject(o: { file: string; project: string; projectsDir: string }): Promise<{ name: string; dir: string; files: number }> {
  const manifest = await verifyBackup(o.file);
  const prefix = `Projects/${o.project}/`;
  const mine = manifest.entries.filter((e) => e.path.startsWith(prefix));
  if (!mine.length) fail(`The backup has no project called “${o.project}”.`);
  const existing = await fsp.readdir(o.projectsDir).catch(() => [] as string[]);
  const name = uniqueName(o.project, existing);
  const { files } = await open(o.file);
  const dir = path.join(o.projectsDir, name);
  for (const e of mine) {
    const dest = path.join(dir, ...e.path.slice(prefix.length).split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, files[e.path]!, { flag: 'wx' });
  }
  return { name, dir, files: mine.length };
}

// ---- importing a project made by MDEdit ------------------------------------------------------------------------------------

const MDEDIT_DIR = '.mdedit';
export const IMPORT_RECORD = 'imported-from.json';
/** MDEdit state that only made sense with its Google Drive sync: not carried over. */
const SYNC_STATE = (rel: string) => rel === `${MDEDIT_DIR}/collab-base.json` || /\.bak$/i.test(rel) || /(^|\/)Thumbs\.db$/.test(rel);

export interface ImportPreview {
  /** The folder the project was found in. */
  source: string;
  /** The project's id in MDEdit, which is how a second import of it is recognised. */
  sourceId: string;
  name: string;
  /** The name it will have in Cadrel (the same unless that is taken). */
  asName: string;
  files: number;
  bytes: number;
  chapterFiles: number;
  hasGoal: boolean;
  reviewFiles: number;
  editedMarks: number;
  /** An earlier import of this project already in Cadrel, if any: importing again is refused unless asked for as a new copy. */
  alreadyImportedAs: string | null;
  /** What was left behind and why, shown before anything is written. */
  notCarried: string[];
}

const isMdeditProject = (dir: string) => fsp.stat(path.join(dir, MDEDIT_DIR, PROJECT_FILE)).then((s) => s.isFile(), () => false);

/** Project folders found at `dir`: the folder itself if it is one, else the ones directly inside it (an MDEdit Root Folder). */
export async function findMdeditProjects(dir: string): Promise<string[]> {
  if (await isMdeditProject(dir)) return [dir];
  const out: string[] = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && !d.name.startsWith('.') && (await isMdeditProject(path.join(dir, d.name)))) out.push(path.join(dir, d.name));
  }
  return out.sort();
}

async function importedIds(projectsDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of await fsp.readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(projectsDir, d.name, PROJECT_DIR, IMPORT_RECORD), 'utf8')) as { sourceId?: unknown };
      if (typeof rec.sourceId === 'string') out.set(rec.sourceId, d.name);
    } catch {
      /* not an imported project */
    }
  }
  return out;
}

async function readMeta(dir: string) {
  const raw = JSON.parse(await fsp.readFile(path.join(dir, MDEDIT_DIR, PROJECT_FILE), 'utf8').catch(() => fail('That project’s settings file is missing or unreadable.')));
  return sanitizeProjectMeta(raw, path.basename(dir), new Date().toISOString().slice(0, 10));
}

export async function previewMdeditImport(source: string, projectsDir: string): Promise<ImportPreview> {
  if (!(await isMdeditProject(source))) fail('That folder is not an MDEdit project (it has no .mdedit/project.json).');
  const meta = await readMeta(source);
  const existing = await fsp.readdir(projectsDir).catch(() => [] as string[]);
  const notCarried: string[] = [];
  let files = 0;
  let bytes = 0;
  let chapterFiles = 0;
  let reviewFiles = 0;
  for await (const e of walk(source)) {
    if (e.isDir) continue;
    if (SYNC_STATE(e.rel)) {
      notCarried.push(e.rel);
      continue;
    }
    files += 1;
    bytes += (await fsp.stat(e.abs)).size;
    if (/\.(md|markdown)$/i.test(e.rel) && !e.rel.startsWith(`${MDEDIT_DIR}/`)) chapterFiles += 1;
    if (e.rel.startsWith(`${MDEDIT_DIR}/review/`)) reviewFiles += 1;
  }
  const marks = await fsp.readFile(path.join(source, MDEDIT_DIR, 'edited.json'), 'utf8').then((t) => sanitizeMarks(JSON.parse(t)), () => null);
  const prior = (await importedIds(projectsDir)).get(meta.id) ?? null;
  const drive = notCarried.some((n) => n.endsWith('collab-base.json'));
  return {
    source, sourceId: meta.id, name: meta.name, asName: uniqueName(path.basename(source), existing), files, bytes, chapterFiles,
    hasGoal: !!meta.goal || Object.keys(meta.manuscriptGoals).length > 0, reviewFiles,
    editedMarks: marks ? Object.values(marks.files).reduce((n, f) => n + Object.keys(f).length, 0) : Object.values(meta.editedChapters).reduce((n, a) => n + a.length, 0),
    alreadyImportedAs: prior,
    notCarried: [
      ...(drive || notCarried.length ? ['Google Drive sync state and backup copies (Cadrel shares through the vault, not Drive)'] : [])
    ]
  };
}

/**
 * Copies an MDEdit project into `projectsDir` as a Cadrel project: its files are copied (the original is never changed), `.mdedit`
 * becomes `.cadrel` with the project's settings read through the same defensive parser Write uses, and a small record notes where it
 * came from so importing it again is recognised.
 */
export async function importMdeditProject(o: { source: string; projectsDir: string; asNewCopy?: boolean; now?: Date }): Promise<{ name: string; dir: string; meta: ReturnType<typeof sanitizeProjectMeta>; files: number }> {
  const preview = await previewMdeditImport(o.source, o.projectsDir);
  if (preview.alreadyImportedAs && !o.asNewCopy) fail(`“${preview.name}” was already imported as “${preview.alreadyImportedAs}”. Import it as a new copy if you want another.`);
  const meta = await readMeta(o.source);
  const name = preview.asName;
  const dir = path.join(o.projectsDir, name);
  await fsp.mkdir(o.projectsDir, { recursive: true });
  const building = `${dir}.importing`; // the project appears only when it is whole
  await fsp.rm(building, { recursive: true, force: true });
  try {
    let files = 0;
    for await (const e of walk(o.source)) {
      if (e.isDir) continue;
      if (SYNC_STATE(e.rel)) continue;
      const rel = e.rel.startsWith(`${MDEDIT_DIR}/`) ? `${PROJECT_DIR}/${e.rel.slice(MDEDIT_DIR.length + 1)}` : e.rel;
      if (rel === `${PROJECT_DIR}/${PROJECT_FILE}`) continue; // rewritten below
      const dest = path.join(building, ...rel.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(e.abs, dest);
      files += 1;
    }
    // A new id when it is a second copy, so the two do not collide in Cadrel; otherwise the id MDEdit gave it.
    const written = { ...meta, id: preview.alreadyImportedAs ? `${meta.id}-${(o.now ?? new Date()).getTime().toString(36)}` : meta.id, name };
    await fsp.mkdir(path.join(building, PROJECT_DIR), { recursive: true });
    await fsp.writeFile(path.join(building, PROJECT_DIR, PROJECT_FILE), JSON.stringify(written, null, 2) + '\n');
    await fsp.writeFile(
      path.join(building, PROJECT_DIR, IMPORT_RECORD),
      JSON.stringify({ from: 'MDEdit', sourceId: meta.id, sourceFolder: o.source, importedAt: (o.now ?? new Date()).toISOString() }, null, 2) + '\n'
    );
    await fsp.rename(building, dir);
    return { name, dir, meta: written, files: files + 2 };
  } catch (e) {
    await fsp.rm(building, { recursive: true, force: true });
    throw e;
  }
}
