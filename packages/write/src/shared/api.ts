import type { AppDefaults } from './appDefaults';
import type { BookDetails } from './export/model';
import type { Progress } from './progress';
import type { ProjectMeta, ProjectsConfig, ProjectsSettings, ProjectSummary, RootListing } from './projects';

export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  /** Marked for export (its `<name>.export.json` says so). */
  marked?: boolean;
  /** Another file with the same name already owns this export-settings file. */
  exportBlocked?: boolean;
}

export interface DirNode {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  /** Export-settings files in this folder whose manuscript no longer exists. */
  orphanSidecars?: string[];
}

export type TreeNode = FileNode | DirNode;

/** Cheap fingerprint of a file on disk, used to notice external changes. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** Commands the native application menu can trigger in the renderer. */
export type MenuAction =
  | 'change-folder'
  | 'refresh'
  | 'save'
  | 'new-file'
  | 'new-folder'
  | 'export'
  | 'settings'
  | 'new-project'
  | 'projects-home'
  | 'switch-project'
  | 'project-settings'
  | 'project-progress'
  | 'undo-action'
  | 'redo-action'
  | 'find'
  | 'replace'
  | 'find-next'
  | 'find-prev'
  | 'next-scene'
  | 'prev-scene'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'next-chapter'
  | 'prev-chapter';

export type ExportKind = 'epub' | 'pdf' | 'docx';

export interface ExportProgress {
  /** Which output this is about, or 'prepare' for the shared first step. */
  kind: ExportKind | 'prepare';
  message: string;
}

export interface ExportOutput {
  kind: ExportKind;
  path: string;
  bytes: number;
  /** Print PDF only. */
  pages?: number;
  gutter?: number;
  warnings: string[];
}

export interface ExportResult {
  ok: boolean;
  /** Problems that stopped (part of) the export. */
  errors: string[];
  warnings: string[];
  outputs: ExportOutput[];
}

/** What an export would write, and where, before running it. */
export interface ExportPlan {
  dir: string;
  outputs: { kind: ExportKind; path: string; exists: boolean }[];
}

/** One entry of the application menu, as drawn by the in-window menu bar. */
export interface MenuNode {
  id: string;
  /** Without the `&` mnemonic marker or the `\t` shortcut hint. */
  label: string;
  /** Shortcut text shown on the right, e.g. "Ctrl+N". */
  hint?: string;
  /** The letter that opens a top-level menu with Alt (from "&File"). */
  mnemonic?: string;
  type: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu';
  checked?: boolean;
  enabled: boolean;
  submenu?: MenuNode[];
}

/** How the window is dressed, so the custom title bar knows whether to draw its own buttons. */
export interface WindowInfo {
  platform: string;
  /** True when the OS draws the minimise/maximise/close buttons over our title bar (Windows). */
  overlay: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel';
export type ThemeSource = 'system' | 'light' | 'dark';
export type EditorMode = 'visual' | 'source';

/** Which tabs were open in a folder, so the app can put you back where you were. */
export interface Session {
  tabs: { file: string; chapter: number; mode: EditorMode }[];
  active: string | null;
  expanded: string[];
}

export interface Prefs {
  sidebarWidth?: number;
}

/** Unsaved text autosaved for crash recovery. One per file (the open chapter's edits). */
export interface DraftRecord {
  file: string;
  chapter: number;
  title: string;
  markdown: string;
  updatedAt: number;
}

/** Fields of a project's metadata that can be changed after it is created. */
export type ProjectPatch = Partial<Pick<ProjectMeta, 'status' | 'notes' | 'archived' | 'goal' | 'activeManuscript' | 'manuscriptGoals' | 'excludedFolders'>> & {
  overrides?: Partial<ProjectMeta['overrides']>;
};

export type { ProjectSummary };

export interface MdeditApi {
  /** Shows the OS folder picker. Resolves to the chosen folder or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** The folder open when the app was last used, if it still exists. */
  getLastFolder(): Promise<string | null>;
  /** Scans a folder recursively for Markdown files and remembers it as the last folder. */
  scanFolder(root: string): Promise<DirNode>;
  readFile(path: string): Promise<{ text: string; stamp: FileStamp }>;
  /** Null when the file no longer exists. */
  statFile(path: string): Promise<FileStamp | null>;
  /** Atomically overwrites a Markdown file inside the opened folder. */
  writeFile(path: string, content: string): Promise<FileStamp>;

  /** New Markdown file in `dir` (".md" is added if missing). Fails if it exists. Returns its path. */
  createFile(dir: string, name: string, content?: string): Promise<string>;
  /** New folder in `dir`. Fails if the name is taken. Returns its path. */
  createFolder(dir: string, name: string): Promise<string>;
  /** Renames within the same folder. Returns the new path. */
  renameNode(path: string, newName: string): Promise<string>;
  /** Moves to the Recycle Bin. */
  trashNode(path: string): Promise<void>;
  /** Shows the item in File Explorer. */
  reveal(path: string): void;

  /** The book's saved details, or fresh defaults if none exist yet. */
  getBookDetails(file: string): Promise<{ details: BookDetails; exists: boolean; damaged: boolean }>;
  saveBookDetails(file: string, details: BookDetails): Promise<void>;
  /** Marks/unmarks a file for export (creates or updates its export-settings file). */
  setMarked(file: string, marked: boolean): Promise<{ backedUp: boolean }>;
  /** Attaches an orphaned export-settings file to a manuscript in the same folder. */
  relinkSidecar(sidecar: string, markdownFile: string): Promise<void>;
  /** Font families installed on this computer (empty if the OS can't list them). */
  listInstalledFonts(): Promise<string[]>;
  /** The regular face of a bundled font as a data: URL, so the form can preview it. */
  bundledFontPreview(family: string): Promise<string | null>;
  /** Native image picker for the EPUB cover. */
  pickCoverImage(): Promise<string | null>;

  /** Where an export would write. Pass the dialog's current (unsaved) details to preview them. */
  planExport(file: string, details?: BookDetails): Promise<ExportPlan>;
  /** Builds the enabled outputs from the book's saved details and the manuscript as saved on disk. */
  runExport(file: string): Promise<ExportResult>;
  cancelExport(): void;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  /** Show / open a file the last export produced. */
  revealOutput(path: string): void;
  openOutput(path: string): Promise<string>;

  /** Markdown files given on the command line (double-click / "Open with"); each is returned once. */
  takeLaunchFiles(): Promise<string[]>;
  /** Fires when another launch hands a file to this running instance. */
  onLaunchFiles(cb: () => void): () => void;

  /** Chapter heading level and the template new books start from. */
  getAppDefaults(): Promise<AppDefaults>;
  /** Saves them (sanitised) and returns what was stored. */
  setAppDefaults(defaults: AppDefaults): Promise<AppDefaults>;

  // ---- projects ----
  getProjectsConfig(): Promise<ProjectsConfig>;
  /** Saves part of the project settings (Root Folder, templates, …) and returns the result. */
  setProjectsConfig(patch: Partial<ProjectsSettings>): Promise<ProjectsConfig>;
  /** Projects and other folders directly inside the Root Folder. */
  listProjects(): Promise<RootListing>;
  /** Creates a project from a template in the Root Folder (all-or-nothing). */
  createProject(name: string, templateId: string): Promise<{ path: string; meta: ProjectMeta }>;
  getProjectMeta(path: string): Promise<ProjectMeta | null>;
  updateProject(path: string, patch: ProjectPatch): Promise<ProjectMeta>;
  renameProject(path: string, name: string): Promise<string>;
  duplicateProject(path: string, name: string): Promise<{ path: string; meta: ProjectMeta }>;
  /** Moves a project to the Recycle Bin. */
  deleteProject(path: string): Promise<void>;
  /** Marks an ordinary folder in the Root as a project. */
  convertFolder(path: string): Promise<ProjectMeta>;
  /** Adds template folders / starter files the project is missing; returns what was added. */
  addMissingTemplateParts(path: string, templateId: string): Promise<string[]>;
  /** Counts the project's words now, notes them in its history, and returns the history. */
  recordProgress(path: string): Promise<{ progress: Progress; total: number; manuscript: string | null }>;
  /** Moves every project in the Root to a new Root Folder (best effort; reports what failed). */
  moveProjects(newRoot: string): Promise<{ moved: string[]; failed: { name: string; error: string }[] }>;
  /** Remembers which project is open (so it can be reopened at startup). */
  setLastProject(path: string | null): void;

  getPrefs(): Promise<Prefs>;
  setPrefs(patch: Partial<Prefs>): void;
  getSession(folder: string): Promise<Session | null>;
  saveSession(folder: string, session: Session): void;

  saveDraft(draft: DraftRecord): Promise<void>;
  clearDraft(file: string): Promise<void>;
  listDrafts(): Promise<DraftRecord[]>;

  /** Native "Do you want to save changes?" dialog. */
  confirmUnsaved(fileName: string): Promise<UnsavedChoice>;
  /** Native "file changed on disk, overwrite?" dialog. */
  confirmOverwrite(fileName: string): Promise<boolean>;
  confirmDelete(name: string, kind: 'file' | 'folder' | 'chapter', hasUnsaved: boolean): Promise<boolean>;
  confirmRecover(fileName: string): Promise<boolean>;

  /** Tells the main process which files have unsaved edits so closing the window can ask first. */
  setDirtyFiles(fileNames: string[]): void;
  /** Main asks the renderer to resolve unsaved tabs before the window closes. */
  onCloseRequested(cb: () => void): () => void;
  /** true = all tabs resolved, go ahead and close; false = the user cancelled. */
  reportCloseDecision(ok: boolean): void;
  /** The application menu, to draw in the title bar. */
  getMenu(): Promise<MenuNode[]>;
  /** Runs a menu item (by `MenuNode.id`) exactly as if it had been clicked in a native menu. */
  clickMenu(id: string): void;
  windowInfo(): Promise<WindowInfo>;
  onWindowState(cb: (info: WindowInfo) => void): () => void;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  /** Native menu item clicked. Returns an unsubscribe function. */
  onMenuAction(cb: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window {
    mdedit: MdeditApi;
  }
}
