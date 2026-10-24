import type { AppDefaults } from './appDefaults';
import type { Origin } from './export/layers';
import type { BookDetails } from './export/model';
import type { Progress } from './progress';
import type { AiRemoteStatus, AiServerInfo } from './agent/config';
import type { ChapterSelection } from './review/package';
import type { ReviewerRecord, ShareChapters, ShareStatus, ShareSummary, SharedProject } from './review/share';
import type { UpdateInfo, UpdateProgress } from './update';
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
  | 'zone-mode'
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
  | 'go-to-line'
  | 'find-prev'
  | 'next-scene'
  | 'prev-scene'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'next-chapter'
  | 'prev-chapter'
  | 'sync'
  | 'about';

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

import type { ThemeCustom } from './theme';

export interface Prefs {
  sidebarWidth?: number;
  /** Colours the user changed in the light and dark themes (File → Settings → Appearance). */
  themeCustom?: ThemeCustom;
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
export type ProjectPatch = Partial<Pick<ProjectMeta, 'status' | 'notes' | 'archived' | 'goal' | 'activeManuscript' | 'manuscriptGoals' | 'excludedFolders' | 'editedChapters'>> & {
  overrides?: Partial<ProjectMeta['overrides']>;
};

export type { ProjectSummary };

/**
 * What the editor, the project model and sync need. Every platform implements this: the Windows app over Node's `fs`,
 * the Android app over the phone's storage.
 */
export interface CoreApi {
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
  recordProgress(path: string): Promise<{ progress: Progress; total: number | null; manuscript: string | null }>;
  /** Moves every project in the Root to a new Root Folder (best effort; reports what failed). */
  moveProjects(newRoot: string): Promise<{ moved: string[]; failed: { name: string; error: string }[] }>;
  /** Remembers which project is open (so it can be reopened at startup). */
  setLastProject(path: string | null): void;

  /** Review files (comments and suggestions), one per reviewer, kept inside the project. */
  listReviews(project: string): Promise<{ id: string; text: string }[]>;
  saveReview(project: string, reviewerId: string, text: string): Promise<void>;
  /** Removes one reviewer's whole file (all the notes they wrote). */
  deleteReview(project: string, reviewerId: string): Promise<void>;

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
  /** Editing stage: asks whether the chapter just left should be marked as edited. */
  confirmMarkEdited(chapterTitle: string): Promise<boolean>;
}

export interface BookDetailsResult {
  details: BookDetails;
  inherited: BookDetails;
  origins: Record<string, Origin>;
  overrides: string[];
  exists: boolean;
  damaged: boolean;
}

/** Export for KDP (EPUB, print PDF, DOCX) and the book details it needs. Desktop only. */
export interface ExportApi {
  /**
   * The book's details as they export (app settings, then the project's, then the book's own), or fresh defaults if none
   * exist yet. `inherited` is the book without its own settings, `origins` says whether each inherited field comes from
   * the project or the app, and `overrides` lists the fields the book sets itself.
   */
  getBookDetails(file: string): Promise<BookDetailsResult>;
  /** `overrides` names the fields this book sets itself; the rest follow the project and the app. */
  saveBookDetails(file: string, details: BookDetails, overrides?: string[]): Promise<void>;
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
  /**
   * Saves a text-analysis report page as a self-contained `.html` file or a PDF, after asking where (a native Save dialog,
   * starting beside the manuscript). Resolves to the saved path, or null if the dialog was cancelled.
   */
  saveReport(kind: 'html' | 'pdf', suggestedName: string, html: string): Promise<string | null>;
}

/** Things that only make sense in the Windows app: its window and menu, the OS folder picker, Explorer, launch files. */
export interface ImportDocxResult {
  /** Paths of the Markdown files that were written. */
  created: string[];
  /** One message per document that could not be imported. */
  failed: string[];
}

export interface DesktopApi {
  /** Shows the OS folder picker. Resolves to the chosen folder or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** Shows the item in File Explorer. */
  reveal(path: string): void;
  /**
   * Asks for one or more Word (.docx) files and writes each into `dir` as a Markdown file of the same name
   * (headings, bold / italic and so on kept). Null when the picker is cancelled.
   */
  importDocx(dir: string): Promise<ImportDocxResult | null>;
  /** How an AI app starts MDEdit's MCP server; null when this build doesn't include it. */
  getAiServer(): Promise<AiServerInfo | null>;
  /** Writes the AI Kit (Claude extension, skills, server, settings) into Downloads, shows it, and returns the folder. */
  exportAiKit(): Promise<string>;
  /** Online access for apps that can't run a program on this PC (ChatGPT, Custom GPTs). Off until the user turns it on. */
  getAiRemote(): Promise<AiRemoteStatus>;
  setAiRemote(enabled: boolean): Promise<AiRemoteStatus>;
  /** Replaces the access token, so any app using the old one is locked out. */
  resetAiRemoteToken(): Promise<AiRemoteStatus>;

  /** Markdown files given on the command line (double-click / "Open with"); each is returned once. */
  takeLaunchFiles(): Promise<string[]>;
  /** Fires when another launch hands a file to this running instance. */
  onLaunchFiles(cb: () => void): () => void;

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
  /** 'fullscreen' and 'windowed' set the full-screen state outright (Zone Mode uses them). */
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'fullscreen' | 'windowed'): void;
  /** Native menu item clicked. Returns an unsubscribe function. */
  onMenuAction(cb: (action: MenuAction) => void): () => void;
}

/** Updating the app from its latest GitHub release (the Windows installer, or the Android APK). */
export interface UpdateApi {
  /** The running app's version, e.g. "0.4.3". */
  getAppVersion(): Promise<string>;
  /** Asks GitHub for the newest release and the file that fits this device. Rejects with a readable message if offline. */
  checkForUpdate(): Promise<UpdateInfo>;
  /**
   * Downloads the release's file for this device, checks it against the release's checksums and hands it to the system
   * installer (Windows: the app closes and the installer opens; Android: the system install screen opens).
   */
  installUpdate(info: UpdateInfo): Promise<void>;
  onUpdateProgress(cb: (p: UpdateProgress) => void): () => void;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  /** Conflict copies made (prose changed on two devices). */
  conflicts: string[];
  /** Files left alone, with the reason. */
  skipped: { path: string; reason: string }[];
  errors: { path: string; message: string }[];
  /** A new `MDEdit` folder was made in Drive because none was visible to this app. */
  rootCreated: boolean;
  /** How long the pass took. */
  durationMs: number;
}

export interface SyncStatus {
  /** Signed in to Google Drive and syncing. */
  connected: boolean;
  state: 'off' | 'idle' | 'syncing' | 'error' | 'confirm';
  lastSyncAt: number | null;
  /** A short human message for `error` (and sign-in problems). */
  message: string | null;
  summary: SyncSummary | null;
  /** Files a pass wanted to delete but held back for the user's go-ahead (`state: 'confirm'`). */
  pendingDeletes: string[];
  /** Goes up when files on this device changed (at most every few seconds during a long pass), so the UI knows to refresh. */
  localChanges: number;
  /** While syncing: how many of this pass's changes are done. */
  progress: { done: number; total: number } | null;
}

/** Keeping the Root Folder in step with Google Drive. Desktop and phone get the same engine (docs/sync-rules.md). */
export interface SyncApi {
  getSyncStatus(): Promise<SyncStatus>;
  /** Signs in to Google (the first time this shows Google's screens) and runs the first sync. */
  connectSync(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  /** Runs the deletes a pass held back. */
  confirmDeletes(): Promise<SyncStatus>;
  /** Stops syncing and forgets this device's sync memory. Files stay where they are, here and in Drive. */
  disconnectSync(): Promise<void>;
  onSyncStatus(cb: (s: SyncStatus) => void): () => void;
}

/** Sharing a project with reviewers over Google Drive, and joining projects others have shared. */
export interface ReviewSharingApi {
  getShareStatus(project: string): Promise<ShareStatus>;
  /** Every project that currently has reviewers. */
  listShares(): Promise<ShareSummary[]>;
  /** Removes every reviewer of a project (their notes stay in it). */
  stopSharing(project: string): Promise<void>;
  /**
   * Makes a private comments file for a new reviewer and returns their invitation link (also publishes the text).
   * With `chapters`, the reviewer is given only those chapters of the manuscript.
   * With `role: 'edit'` the person is a collaborator: they get an editable copy of those chapters, merged with the owner's text on every sync.
   */
  inviteReviewer(project: string, name: string, chapters?: ChapterSelection | null, role?: 'edit'): Promise<ReviewerRecord>;
  /** The share manuscript's chapters (split at heading `level`) and which ones were ticked last time. */
  getShareChapters(project: string, level: number): Promise<ShareChapters>;
  /** Closes a reviewer's file; their notes stay in the project. */
  revokeReviewer(project: string, reviewerId: string): Promise<void>;
  /** Exchanges notes (and, for the owner, the latest text) with Drive for one open project. A no-op when nothing is shared. */
  exchangeReviews(project: string): Promise<{ changed: boolean; revoked: boolean; errors: string[] }>;
  /** Projects other people shared with this person. */
  listShared(): Promise<SharedProject[]>;
  /** An access token for Google's file picker, which gives MDEdit access to the files in an invitation. */
  pickerToken(): Promise<string>;
  /**
   * Phone only: runs Google's file picker in the phone's own browser and returns the file ids picked (null when cancelled).
   * Google's picker stays blank when embedded in the app's web view, so the app hands over to the browser and is called back.
   * Absent where the picker can be embedded (the Windows app).
   */
  pickInBrowser?(url: string): Promise<string[] | null>;
  /** Downloads the shared project into "Shared With Me" (after the picker has granted access). */
  joinReview(link: string, name: string): Promise<SharedProject>;
}

/** Which optional parts of the app a platform provides, so the UI can leave out what is missing. */
export interface Capabilities {
  /** Export for KDP (`ExportApi`). */
  export: boolean;
  /** Custom title bar, in-window menu, window buttons and menu shortcuts. */
  windowChrome: boolean;
  /** Choosing any folder as the workspace, and showing items in the file manager. */
  folderPicker: boolean;
  /** Opening files handed over by double-click / "Open with". */
  launchFiles: boolean;
  /** Installed-font listing for exports. */
  fonts: boolean;
  /** Importing Word documents. */
  importDocx: boolean;
  /** Google Drive sync (`SyncApi`). */
  sync: boolean;
  /** Sharing for review (`ReviewSharingApi`); needs sync. */
  review: boolean;
  /** Updating from the latest GitHub release (`UpdateApi`). */
  update: boolean;
  /** Connecting AI reviewers (the MCP server); needs the desktop app. */
  ai: boolean;
}

export const DESKTOP_CAPABILITIES: Capabilities = { export: true, windowChrome: true, folderPicker: true, launchFiles: true, fonts: true, importDocx: true, sync: true, review: true, update: true, ai: true };
/** The phone: the editor and projects, nothing desktop-specific. */
export const MOBILE_CAPABILITIES: Capabilities = { export: false, windowChrome: false, folderPicker: false, launchFiles: false, fonts: false, importDocx: false, sync: true, review: true, update: true, ai: false };

/**
 * What `Workspace` (the editor's state and logic) needs: the core, plus a few desktop extras it uses when present
 * (the close guard, launch files, the folder picker, Explorer, export markers). On the phone they are simply absent.
 */
export type WorkspaceApi = CoreApi &
  Partial<Pick<DesktopApi, 'setDirtyFiles' | 'takeLaunchFiles' | 'pickFolder' | 'reveal' | 'importDocx'>> &
  Partial<Pick<ExportApi, 'setMarked' | 'relinkSidecar'>>;

/**
 * The full surface the renderer talks to. On the phone the `ExportApi` / `DesktopApi` parts are inert stubs and the
 * UI checks `capabilities` before showing anything that needs them.
 */
export type MdeditApi = CoreApi & ExportApi & DesktopApi & SyncApi & ReviewSharingApi & UpdateApi & { capabilities: Capabilities };

declare global {
  interface Window {
    mdedit: MdeditApi;
  }
}
