import type { ThemeCustom } from '@cadrel/write/src/shared/theme';
import type { ThemeSource } from './theme';
import type { Attachment, ProfilePatch, UserProfile } from '@cadrel/kernel';
import type { NoteStatus, NoteTarget, NoteView, ProjectTree } from '@cadrel/kernel';

/** What the shell's own page (rail, Home, Dashboard) can ask of the shell. Write and Market keep their own bridges. */

/** The places the rail can go. Home and Dashboard are drawn by the shell; the rest are modules in their own views. */
export const PAGES = ['home', 'dashboard', 'projects', 'notes', 'write', 'market', 'profile', 'settings'] as const;
export type Page = (typeof PAGES)[number];
export type ModuleId = 'write' | 'market';
export const isPage = (v: unknown): v is Page => typeof v === 'string' && (PAGES as readonly string[]).includes(v);
export const isModule = (p: Page): p is ModuleId => p === 'write' || p === 'market';

export interface WindowInfo {
  platform: string;
  overlay: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

export interface WriteProjectRow {
  name: string;
  status: string;
  /** Words in the project's active manuscript, or null when none has been chosen (nothing is counted then). */
  words: number | null;
  /** Words the project aims for, or null if no goal is set. */
  goalWords: number | null;
  /** Milliseconds since epoch, or null if nothing has been written. */
  lastEdited: number | null;
  archived: boolean;
}

export interface MarketCategoryRow {
  /** The category's id in Market; what a project links to. */
  key: string;
  name: string;
  listedBooks: number;
  capturedBooks: number;
  listCaptures: number;
  lastListCapture: string | null;
}

/** A snapshot of both modules for Home and Dashboard. A module that cannot answer says so instead of throwing. */
export interface Overview {
  write: { ok: boolean; root: string | null; exists: boolean; projects: WriteProjectRow[]; error: string | null };
  market: {
    ok: boolean;
    libraryRoot: string | null;
    serverRunning: boolean;
    /** Why the capture server is not running when it should be (for example the port is taken), or null. */
    serverError: string | null;
    port: number | null;
    categories: MarketCategoryRow[];
    queued: number;
    error: string | null;
  };
}

/** Everything the Projects and Notes pages need, in one read. */
export interface StudioState {
  tree: ProjectTree;
  /** Studio notes and the notes in Write's manuscripts, newest first; deleted ones left out. */
  notes: NoteView[];
  /** Who a note written here is by. */
  author: string;
  /** Open notes per project id, counting its subprojects too. Projects with none are absent. */
  openByProject: Record<string, number>;
}

export interface StudioApi {
  state(): Promise<StudioState>;
  createProject(o: { name: string; parentId?: string | null; kind?: string }): Promise<{ id: string }>;
  updateProject(id: string, change: { name?: string; kind?: string }): Promise<void>;
  moveProject(id: string, parentId: string | null, index?: number): Promise<void>;
  archiveProject(id: string, archived: boolean): Promise<void>;
  /** Returns the ids that were removed. Subprojects go too only with `cascade`. */
  deleteProject(id: string, cascade: boolean): Promise<string[]>;
  link(projectId: string, module: string, ref: string): Promise<void>;
  unlink(module: string, ref: string): Promise<void>;
  addNote(o: { projectId: string | null; body: string; target?: NoteTarget | null; category?: string }): Promise<{ id: string }>;
  setNoteStatus(id: string, status: NoteStatus): Promise<void>;
  replyToNote(id: string, body: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
}

export interface ShellInfo {
  version: string;
  electron: string;
  platform: string;
}

export interface ThemeState {
  source: ThemeSource;
  custom?: ThemeCustom;
}

/** The signed-in person: their profile, and the name that goes on what they write. */
export interface UserView {
  profile: UserProfile;
  /** The name notes are written under: the profile's display name, or the Windows user name until one is set. */
  name: string;
  nameIsDefault: boolean;
  /** Attached files whose copy has gone missing or changed on disk. */
  problems: { id: string; name: string; problem: 'missing' | 'changed' }[];
}

export interface UserApi {
  get(): Promise<UserView>;
  update(patch: ProfilePatch): Promise<UserView>;
  /** Opens the file picker and attaches what is chosen; null if cancelled. */
  attach(): Promise<UserView | null>;
  /** Attaches dropped files (the page passes the File objects; the bridge turns them into paths). */
  attachDropped(files: File[]): Promise<UserView>;
  editAttachment(id: string, patch: { note?: string; name?: string; assistant?: boolean }): Promise<UserView>;
  /** Opens a picker for a picture, keeps it with the person's files and makes it their photo; null if cancelled. */
  chooseAvatar(): Promise<UserView | null>;
  /** Saves a copy of an attached file where the person chooses; false if cancelled. */
  download(id: string): Promise<boolean>;
  removeAttachment(id: string): Promise<UserView>;
  setAvatar(id: string | null): Promise<UserView>;
  open(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  /** The photo as a small data URL, or null. */
  avatar(): Promise<string | null>;
  onChange(cb: (v: UserView) => void): () => void;
}

export type { Attachment };

/** Where everything lives, for the Settings page. */
export interface AppFolders {
  writeRoot: string | null;
  marketLibrary: string | null;
  studioFile: string;
  settingsFolder: string;
}

export interface CadrelApi {
  studio: StudioApi;
  theme: {
    get(): Promise<ThemeState>;
    set(change: { source?: ThemeSource; custom?: ThemeCustom | null }): Promise<ThemeState>;
    onChange(cb: (t: ThemeState) => void): () => void;
  };
  user: UserApi;
  prefs: {
    folders(): Promise<AppFolders>;
  };
  navigate(page: Page): Promise<void>;
  current(): Promise<Page>;
  onPage(cb: (page: Page) => void): () => void;
  overview(): Promise<Overview>;
  info(): Promise<ShellInfo>;
  windowInfo(): Promise<WindowInfo>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onWindowState(cb: (info: WindowInfo) => void): () => void;
}
