import { defaultProjectsSettings, defaultTemplates, newProjectMeta, type ProjectMeta, type ProjectsConfig, type ProjectsSettings } from '../../shared/projects';
import { emptyProgress, recordSnapshot, type Progress } from '../../shared/progress';
import { bookFromDefaults, defaultAppDefaults, type AppDefaults } from '../../shared/appDefaults';
import type { BookDetails } from '../../shared/export/model';
import { defaultBookDetails } from '../../shared/export/model';
import type {
  DirNode,
  DraftRecord,
  FileStamp,
  MdeditApi,
  MenuAction,
  Prefs,
  Session,
  TreeNode,
  UnsavedChoice
} from '../../shared/api';
import { basename, dirname, isInside } from '../../shared/paths';

/** In-memory stand-in for the Electron bridge, with scripted dialog answers. */
export class FakeApi implements MdeditApi {
  files = new Map<string, { text: string; mtime: number }>();
  /** Folders that exist on disk (like a real file system, they survive deleting their files). */
  dirs = new Set<string>();
  clock = 1;
  lastFolder: string | null = null;
  prefs: Prefs = {};
  sessions = new Map<string, Session>();
  drafts = new Map<string, DraftRecord>();
  trashed: string[] = [];
  revealed: string[] = [];
  dirtyReports: string[][] = [];
  writes: string[] = [];
  scans = 0;

  /** Scripted answers, consumed in order. Defaults: unsaved→cancel, others→true. */
  unsavedAnswers: UnsavedChoice[] = [];
  overwriteAnswers: boolean[] = [];
  deleteAnswers: boolean[] = [];
  recoverAnswers: boolean[] = [];
  unsavedAsked: string[] = [];
  pickResult: string | null = null;
  failTrash = false;

  constructor(public root = '/proj') {}

  add(rel: string, text: string): void {
    this.files.set(`${this.root}/${rel}`, { text, mtime: this.clock++ });
    this.registerParents(`${this.root}/${rel}`);
  }
  addDir(rel: string): void {
    this.dirs.add(`${this.root}/${rel}`);
    this.registerParents(`${this.root}/${rel}`);
  }
  private registerParents(path: string): void {
    for (let d = dirname(path); d.length > this.root.length; d = dirname(d)) this.dirs.add(d);
  }
  /** Simulates another program editing the file. */
  external(path: string, text: string): void {
    this.files.set(path, { text, mtime: this.clock++ });
  }
  text(path: string): string | undefined {
    return this.files.get(path)?.text;
  }
  private stampOf(path: string): FileStamp | null {
    const f = this.files.get(path);
    return f ? { mtimeMs: f.mtime, size: f.text.length } : null;
  }

  private buildTree(dir: string): DirNode {
    const dirNodes: TreeNode[] = [...this.dirs]
      .filter((d) => dirname(d) === dir)
      .sort()
      .map((d) => this.buildTree(d));
    const fileNodes: TreeNode[] = [...this.files.keys()]
      .filter((p) => dirname(p) === dir)
      .sort()
      .map((p) => ({ kind: 'file' as const, name: basename(p), path: p, ...(this.books.has(p) ? { marked: this.books.get(p)!.marked } : {}) }));
    const orphanSidecars = this.orphans.filter((o) => dirname(o) === dir);
    return { kind: 'dir', name: basename(dir), path: dir, children: [...dirNodes, ...fileNodes], ...(orphanSidecars.length ? { orphanSidecars } : {}) };
  }

  /** Saved Book Details by manuscript path (present = marked/has a sidecar). */
  books = new Map<string, BookDetails>();
  orphans: string[] = [];
  damagedOnMark = false;
  coverPick: string | null = null;
  getBookDetails = async (file: string) => {
    const d = this.books.get(file);
    return { details: d ?? bookFromDefaults(this.appDefaults, { title: basename(file).replace(/\.md$/, '') }), exists: !!d, damaged: false };
  };
  saveBookDetails = async (file: string, d: BookDetails) => void this.books.set(file, d);
  setMarked = async (file: string, marked: boolean) => {
    const cur = this.books.get(file) ?? bookFromDefaults(this.appDefaults, { title: basename(file).replace(/\.md$/, '') });
    if (!marked && !this.books.has(file)) return { backedUp: false };
    this.books.set(file, { ...cur, marked });
    return { backedUp: this.damagedOnMark };
  };
  relinkSidecar = async (sidecar: string, md: string) => {
    this.orphans = this.orphans.filter((o) => o !== sidecar);
    this.books.set(md, defaultBookDetails({ title: 'relinked', author: 'x' }));
  };
  appDefaults: AppDefaults = defaultAppDefaults();
  getAppDefaults = async () => this.appDefaults;
  setAppDefaults = async (d: AppDefaults) => (this.appDefaults = d);
  getMenu = async () => [];
  clickMenu = () => undefined;
  windowInfo = async () => ({ platform: 'win32', overlay: true, maximized: false, fullscreen: false });
  onWindowState = () => () => undefined;
  windowControl = () => undefined;
  // ---- projects ----
  projectMetas = new Map<string, ProjectMeta>();
  projectsSettings: ProjectsSettings = defaultProjectsSettings();
  progressByProject = new Map<string, Progress>();
  lastProject: string | null = null;
  addProject(path: string, patch: Partial<ProjectMeta> = {}): ProjectMeta {
    const meta = { ...newProjectMeta({ id: path, name: basename(path), template: defaultTemplates()[3], now: new Date('2026-10-05T10:00:00Z') }), ...patch };
    this.projectMetas.set(path, meta);
    return meta;
  }
  getProjectMeta = async (p: string) => this.projectMetas.get(p) ?? null;
  setLastProject = (p: string | null) => void (this.lastProject = p);
  recordProgress = async (p: string) => {
    const manuscript = this.projectMetas.get(p)?.activeManuscript ?? null;
    let total = 0;
    for (const [f, v] of this.files) {
      if (!f.startsWith(p + '/') || (manuscript && f !== `${p}/${manuscript}`)) continue;
      total += v.text.split(/\s+/).filter(Boolean).length;
    }
    const key = manuscript ? `${p}::${manuscript}` : p;
    const prev = this.progressByProject.get(key) ?? emptyProgress();
    const next = recordSnapshot(prev, '2026-10-05', total);
    this.progressByProject.set(key, next);
    return { progress: next, total, manuscript };
  };
  getProjectsConfig = async (): Promise<ProjectsConfig> => ({ ...this.projectsSettings, root: '/root', defaultRoot: '/home/MDEdit', rootExists: true });
  setProjectsConfig = async (patch: Partial<ProjectsSettings>) => {
    this.projectsSettings = { ...this.projectsSettings, ...patch };
    return this.getProjectsConfig();
  };
  listProjects = async () => ({ root: '/root', exists: true, projects: [], folders: [] });
  createProject = async (name: string) => ({ path: `/root/${name}`, meta: this.addProject(`/root/${name}`, { name }) });
  updateProject = async (p: string, patch: Record<string, unknown>) => {
    const meta = { ...(this.projectMetas.get(p) ?? this.addProject(p)), ...patch } as ProjectMeta;
    this.projectMetas.set(p, meta);
    return meta;
  };
  renameProject = async (p: string, name: string) => `${dirname(p)}/${name}`;
  duplicateProject = async (p: string, name: string) => ({ path: `${dirname(p)}/${name}`, meta: this.addProject(`${dirname(p)}/${name}`) });
  deleteProject = async () => undefined;
  convertFolder = async (p: string) => this.addProject(p);
  addMissingTemplateParts = async () => [] as string[];
  moveProjects = async () => ({ moved: [] as string[], failed: [] as { name: string; error: string }[] });
  installedFonts: string[] = ['Georgia', 'Times New Roman'];
  listInstalledFonts = async () => this.installedFonts;
  bundledFontPreview = async () => null;
  pickCoverImage = async () => this.coverPick;
  launchFiles: string[] = [];
  takeLaunchFiles = async () => this.launchFiles.splice(0);
  onLaunchFiles = () => () => undefined;
  planExport = async (file: string, _d?: BookDetails) => ({ dir: file, outputs: [] });
  runExport = async () => ({ ok: true, errors: [], warnings: [], outputs: [] });
  cancelExport = () => undefined;
  onExportProgress = () => () => undefined;
  revealOutput = () => undefined;
  openOutput = async () => '';

  pickFolder = async () => this.pickResult;
  getLastFolder = async () => this.lastFolder;
  scanFolder = async (root: string) => {
    this.scans++;
    this.lastFolder = root;
    return this.buildTree(root);
  };
  readFile = async (p: string) => {
    const f = this.files.get(p);
    if (!f) throw new Error(`ENOENT: ${p}`);
    return { text: f.text, stamp: this.stampOf(p)! };
  };
  statFile = async (p: string) => this.stampOf(p);
  writeFile = async (p: string, content: string) => {
    this.writes.push(p);
    this.files.set(p, { text: content, mtime: this.clock++ });
    return this.stampOf(p)!;
  };
  createFile = async (dir: string, name: string, content = '') => {
    const n = /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
    const p = `${dir}/${n}`;
    if (this.files.has(p)) throw new Error(`"${n}" already exists.`);
    this.files.set(p, { text: content, mtime: this.clock++ });
    return p;
  };
  createFolder = async (dir: string, name: string) => {
    const p = `${dir}/${name}`;
    if (this.dirs.has(p) || this.files.has(p)) throw new Error(`"${name}" already exists.`);
    this.dirs.add(p);
    return p;
  };
  renameNode = async (p: string, newName: string) => {
    const isFile = this.files.has(p);
    const to = `${dirname(p)}/${isFile && !/\.(md|markdown)$/i.test(newName) ? newName + '.md' : newName}`;
    if (this.files.has(to)) throw new Error('already exists');
    for (const [k, v] of [...this.files]) {
      if (isInside(k, p)) {
        this.files.delete(k);
        this.files.set(to + k.slice(p.length), v);
      }
    }
    for (const d of [...this.dirs]) {
      if (isInside(d, p)) {
        this.dirs.delete(d);
        this.dirs.add(to + d.slice(p.length));
      }
    }
    return to;
  };
  trashNode = async (p: string) => {
    if (this.failTrash) throw new Error('trash unavailable');
    for (const k of [...this.files.keys()]) if (isInside(k, p)) this.files.delete(k);
    for (const d of [...this.dirs]) if (isInside(d, p)) this.dirs.delete(d);
    this.trashed.push(p);
  };
  reveal = (p: string) => void this.revealed.push(p);

  getPrefs = async () => this.prefs;
  setPrefs = (patch: Partial<Prefs>) => void Object.assign(this.prefs, patch);
  getSession = async (folder: string) => this.sessions.get(folder) ?? null;
  saveSession = (folder: string, s: Session) => void this.sessions.set(folder, s);

  saveDraft = async (d: DraftRecord) => void this.drafts.set(d.file, d);
  clearDraft = async (file: string) => void this.drafts.delete(file);
  listDrafts = async () => [...this.drafts.values()];

  confirmUnsaved = async (name: string) => {
    this.unsavedAsked.push(name);
    return this.unsavedAnswers.shift() ?? 'cancel';
  };
  confirmOverwrite = async () => this.overwriteAnswers.shift() ?? true;
  confirmDelete = async () => this.deleteAnswers.shift() ?? true;
  confirmRecover = async () => this.recoverAnswers.shift() ?? true;

  setDirtyFiles = (names: string[]) => void this.dirtyReports.push(names);
  onCloseRequested = () => () => undefined;
  reportCloseDecision = () => undefined;
  onMenuAction = (_cb: (a: MenuAction) => void) => () => undefined;
}
