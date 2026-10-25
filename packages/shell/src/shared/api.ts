import type { ThemeCustom } from '@cadrel/write/src/shared/theme';
import type { ThemeSource } from './theme';
import type { Attachment, ProfilePatch, UserProfile } from '@cadrel/kernel';
import type { ProjectTemplate } from '@cadrel/write/src/shared/projects';
import type { AiRemoteStatus } from '@cadrel/write/src/shared/agent/config';
import type { NoteStatus, NoteTarget, NoteView, ProjectTree } from '@cadrel/kernel';

/** What the shell's own page (rail, Home, Dashboard) can ask of the shell. Write and Market keep their own bridges. */

/** The places the rail can go. Home and Dashboard are drawn by the shell; the rest are modules in their own views. */
export const PAGES = ['home', 'dashboard', 'projects', 'notes', 'write', 'market', 'assistants', 'admin', 'profile', 'settings'] as const;
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

/** The statuses a manuscript project can be in (Write's own list). */
export const MANUSCRIPT_STATUSES = ['planning', 'drafting', 'revising', 'editing', 'published', 'paused'] as const;

/** What a project's manuscript folder says about itself. */
export interface ManuscriptMeta {
  status: string;
  notes: string;
  archived: boolean;
  templateName: string;
  createdAt: string;
}

/** A way to start a manuscript folder: Novel, Series, Short Story, Blank, or one of the person's own. */
export interface ManuscriptTemplate {
  id: string;
  name: string;
  description: string;
}

/**
 * Creating and managing projects. This is the one place projects are made and looked after (not in Write): a project may have a
 * manuscript folder, and these keep the project and its folder in step.
 */
export interface ManageApi {
  templates(): Promise<ManuscriptTemplate[]>;
  /** A project, and with `template` its manuscript folder too. */
  create(o: { name: string; parentId?: string | null; kind?: string; template?: string | null }): Promise<{ id: string; folder: string | null }>;
  addManuscript(projectId: string, template: string): Promise<string>;
  rename(projectId: string, name: string): Promise<void>;
  archive(projectId: string, archived: boolean): Promise<void>;
  /** Deletes the project, its subprojects and notes, and moves their manuscript folders to the recycle bin. */
  remove(projectId: string): Promise<string[]>;
  duplicate(projectId: string): Promise<string>;
  manuscript(projectId: string): Promise<{ folder: string; meta: ManuscriptMeta & { templateId: string } } | null>;
  setManuscript(projectId: string, patch: { status?: string; notes?: string }): Promise<void>;
  addMissingParts(projectId: string): Promise<string[]>;
  /** Opens the project's manuscript folder in Write. */
  open(projectId: string): Promise<void>;
  /** Show the folder in the file manager. */
  reveal(projectId: string): Promise<void>;
  unfiled(): Promise<{ projects: { name: string }[]; folders: { name: string }[] }>;
  adopt(folderName: string, parentId?: string | null): Promise<string>;
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
  /** This Studio's folder inside the Cadrel folder; Projects, Write and Market are inside it. */
  studioFolder: string;
  studioName: string;
  /** A move of the Cadrel folder waiting for the next start (nothing may be open while it moves), and the last move that failed. */
  pendingCadrelMove: string | null;
  moveError: string | null;
  /** The Cadrel folder: where the working folders below default to. */
  cadrelFolder: string;
  /** False when the person has put it somewhere of their own. */
  cadrelFolderIsDefault: boolean;
  /** Where project folders are made and kept. */
  projectsFolder: string;
  /** True when it is a choice of its own, not <Cadrel folder>/Projects. */
  projectsIsCustom: boolean;
  /** Write's own folder. */
  writeFolder: string;
  writeIsCustom: boolean;
  marketLibrary: string | null;
  marketIsCustom: boolean;
  studioFile: string;
  settingsFolder: string;
}

export type FolderKey = 'cadrel' | 'projects' | 'write' | 'market';

/** What administrators govern for the whole studio. Anyone can read it (creating a project needs the templates); only an administrator can change it. */
export interface AdminView {
  isAdmin: boolean;
  role: 'owner' | 'admin' | 'member';
  templates: ProjectTemplate[];
  defaultTemplateId: string;
}

export interface AdminApi {
  get(): Promise<AdminView>;
  save(change: { templates: ProjectTemplate[]; defaultTemplateId: string }): Promise<AdminView>;
  /** For the font pickers in the template editor. */
  fonts(): Promise<string[]>;
  fontPreview(family: string): Promise<string | null>;
}

/** How an AI app connects to Cadrel: one server for Write and Market. */
export interface AssistantsView {
  /** False when this build has no AI server. */
  available: boolean;
  /** The folder the assistant reads manuscripts from. */
  projectsFolder: string;
  claudeDesktop: string;
  claudeCode: string;
  codex: string;
  remote: AiRemoteStatus | null;
}

export interface AssistantsApi {
  get(): Promise<AssistantsView>;
  /** Saves the AI Kit (the Claude extension, the editing skills, the server, the steps) into Downloads and shows it; resolves to the folder. */
  saveKit(): Promise<string>;
  /** Saves just the Claude Desktop extension (Cadrel.mcpb) into Downloads and shows it; resolves to the file. */
  saveExtension(): Promise<string>;
  setRemote(on: boolean): Promise<AiRemoteStatus>;
  resetRemoteToken(): Promise<AiRemoteStatus>;
}

export interface UpdateStatus {
  current: string;
  /** 'dev' builds follow development releases only; 'stable' follows stable ones. */
  channel: 'dev' | 'stable';
  latest: string | null;
  available: boolean;
  notes: string;
  pageUrl: string;
  /** Windows installers only; elsewhere the update is a download link. */
  canInstall: boolean;
  /** Why it could not check (offline, no release yet), in a sentence. */
  error: string | null;
}

export interface UpdateApi {
  check(): Promise<UpdateStatus>;
  /** Downloads, verifies and runs the installer; the app closes to let it. */
  install(): Promise<void>;
  onProgress(cb: (p: { received: number; total: number }) => void): () => void;
  /** The last check's answer without asking again (null before the first). */
  last(): Promise<UpdateStatus | null>;
  onAvailable(cb: (s: UpdateStatus) => void): () => void;
}

/** Where a Studio stands. 'local' is the one-person Studio on this computer (no server). */
export type StudioStatus = 'local' | 'not-provisioned' | 'provisioning' | 'ready' | 'error';

/** A Studio this Cadrel knows about: one the person owns (created here), or one they were invited to. */
export interface StudioEntry {
  id: string;
  name: string;
  role: 'owner' | 'member';
  status: StudioStatus;
  /** The Studio's address once it exists. */
  url: string | null;
  /** The owner's Cloudflare account (owners only). Shown masked; the API token is never kept. */
  accountId: string | null;
  createdAt: string;
  /** The last thing worth telling the person about this Studio, in a sentence. */
  note: string | null;
  /** The folder inside the Cadrel folder that holds this Studio's work: <Cadrel>/<this>/{Projects,Write,Market}. Fixed when the Studio is made. */
  folderName: string;
  /** What the person is in a Studio they were invited to (a role key); null for a Studio they own. */
  memberRole: string | null;
  /** The owner's key fingerprint: what an invitation is checked against. */
  fingerprint: string | null;
  /** Their Cloudflare API token is kept on this computer (encrypted) for upgrades. */
  tokenKept: boolean;
  /** What was built in the owner's Cloudflare account, so a build that stopped can be finished and an upgrade knows where to go. */
  resources: { worker: string; d1Id: string | null; d1Name: string; bucket: string } | null;
  /** The versions the Studio's server last reported, and the ones in this app; an upgrade is offered when the app's are newer. */
  server: { api: number; schema: number } | null;
}

/** One person in a Studio, as the owner sees them. */
export interface StudioMember {
  id: string;
  name: string;
  role: string;
  joinedAt: string;
  revokedAt: string | null;
}

export interface StudioInvite {
  id: string;
  role: string;
  label: string;
  expiresAt: string;
}

/** What the Studio's own server says about itself, when it can be reached. */
export interface StudioPeople {
  reachable: boolean;
  error: string | null;
  members: StudioMember[];
  invites: StudioInvite[];
}

export interface StudiosView {
  /** The Studio Manager (on the Admin page) is switched on. Off until an administrator turns it on. */
  managerEnabled: boolean;
  activeId: string;
  studios: StudioEntry[];
  /** The active Studio has its data here and now. False for one that is not provisioned or not connected: the pages say so instead of showing another Studio's data. */
  connected: boolean;
}

export interface StudiosApi {
  get(): Promise<StudiosView>;
  /** Switch to another Studio (anyone). */
  setActive(id: string): Promise<StudiosView>;
  onChange(cb: (v: StudiosView) => void): () => void;
  // The rest are the Studio Manager's: administrators only.
  enableManager(on: boolean): Promise<StudiosView>;
  create(name: string): Promise<StudiosView>;
  rename(id: string, name: string): Promise<StudiosView>;
  /** Forget a Studio on this computer. A provisioned Studio's data stays where it is in Cloudflare. */
  remove(id: string): Promise<StudiosView>;
  /**
   * Builds the Studio in the owner's Cloudflare account (a Worker, a D1 database and an R2 bucket of its own), or finishes a build that stopped.
   * The token is used for this and dropped, unless `keepToken` asks to keep it (encrypted on this computer) for upgrades.
   */
  provision(id: string, details: { accountId: string; apiToken: string; keepToken?: boolean }): Promise<StudiosView>;
  /** Puts a Worker upgrade (the version in this app) on a built Studio. Uses the kept token, or the one given. */
  upgrade(id: string, apiToken?: string): Promise<StudiosView>;
  forgetToken(id: string): Promise<StudiosView>;
  /** Who is in the Studio and what invitations are open (owner only; asks the Studio's server). */
  people(id: string): Promise<StudioPeople>;
  createInvite(id: string, invite: { role: string; label: string }): Promise<{ link: string; expiresAt: string }>;
  revokeInvite(id: string, inviteId: string): Promise<StudioPeople>;
  removeMember(id: string, memberId: string): Promise<StudioPeople>;
  /** Accepts an invitation link someone sent: checks the Studio is the one named, joins it and adds it to this computer's list. */
  join(link: string, details: { yourName: string; studioName?: string }): Promise<StudiosView>;
  backup(id: string): Promise<string>;
}

export interface CadrelApi {
  studios: StudiosApi;
  studio: StudioApi;
  manage: ManageApi;
  theme: {
    get(): Promise<ThemeState>;
    set(change: { source?: ThemeSource; custom?: ThemeCustom | null }): Promise<ThemeState>;
    onChange(cb: (t: ThemeState) => void): () => void;
  };
  user: UserApi;
  prefs: {
    folders(): Promise<AppFolders>;
    /** Opens a folder picker and moves the Cadrel folder there; null if cancelled. Write and Market follow it unless they were given folders of their own. */
    choose(which: FolderKey): Promise<AppFolders | null>;
    /** Back to the default place inside the Cadrel folder. */
    reset(which: FolderKey): Promise<AppFolders>;
    /** Restart Cadrel (to finish moving the Cadrel folder). */
    restart(): Promise<void>;
  };
  admin: AdminApi;
  assistants: AssistantsApi;
  update: UpdateApi;
  navigate(page: Page): Promise<void>;
  current(): Promise<Page>;
  onPage(cb: (page: Page) => void): () => void;
  overview(): Promise<Overview>;
  info(): Promise<ShellInfo>;
  windowInfo(): Promise<WindowInfo>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onWindowState(cb: (info: WindowInfo) => void): () => void;
}
