import type { DataCard, FileRef, FileVersion, ApprovalRecord, DecisionRecord, NewApproval, NewTask, TaskPatch, TaskRecord, TaskState, AssignmentRecord, PenName, Person, RoleRecord, Team, WorkflowDraft, WorkflowRecord, WorkflowUsage } from '@cadrel/kernel';
import type { ThemeCustom } from '@cadrel/write/src/shared/theme';
import type { ThemeSource } from './theme';
import type { Attachment, ProfilePatch, UserProfile } from '@cadrel/kernel';
import type { ProjectTemplate } from '@cadrel/write/src/shared/projects';
import type { AiRemoteStatus } from '@cadrel/write/src/shared/agent/config';
import type { NoteStatus, NoteTarget, NoteView, ProjectTree, ResolvedViewScope, ViewScope } from '@cadrel/kernel';

/** What the shell's own page (rail, Home, Dashboard) can ask of the shell. Write and Market keep their own bridges. */

/** The places the rail can go. Home and Dashboard are drawn by the shell; the rest are modules in their own views. */
export const PAGES = ['home', 'mybooks', 'dashboard', 'planner', 'files', 'projects', 'notes', 'write', 'market', 'finance', 'assistants', 'admin', 'profile', 'settings'] as const;
export type Page = (typeof PAGES)[number];
export type ModuleId = 'write' | 'market' | 'finance';
export const isPage = (v: unknown): v is Page => typeof v === 'string' && (PAGES as readonly string[]).includes(v);
export const isModule = (p: Page): p is ModuleId => p === 'write' || p === 'market' || p === 'finance';

export interface WindowInfo {
  platform: string;
  overlay: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

export interface WriteProjectRow {
  name: string;
  /** The name of the stage of the project this manuscript belongs to (from its workflow); null when it has none. */
  stage: string | null;
  stageColor: string | null;
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
    /** The program holding the capture port when that is why the server is not running, if known. */
    portHolder: { pid: number; name: string } | null;
    port: number | null;
    categories: MarketCategoryRow[];
    queued: number;
    error: string | null;
  };
}

/** What a project's manuscript folder says about itself. */
export interface ManuscriptMeta {
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
  /** `workflowId` is chosen here, once: the project keeps it. Without one, the default for a project (or for a subproject, when it has a parent) is used. */
  create(o: { name: string; parentId?: string | null; kind?: string; template?: string | null; workflowId?: string | null }): Promise<{ id: string; folder: string | null }>;
  addManuscript(projectId: string, template: string): Promise<string>;
  /** Gives a Project with no Books its first: the Project's manuscript folder becomes the Book's, and the Book starts in the Project's stage. */
  addFirstBook(projectId: string, name?: string): Promise<{ id: string }>;
  rename(projectId: string, name: string): Promise<void>;
  archive(projectId: string, archived: boolean): Promise<void>;
  /** Deletes the project, its subprojects and notes, and moves their manuscript folders to the recycle bin. */
  remove(projectId: string): Promise<string[]>;
  duplicate(projectId: string): Promise<string>;
  manuscript(projectId: string): Promise<{ folder: string; meta: ManuscriptMeta & { templateId: string } } | null>;
  setManuscript(projectId: string, patch: { notes?: string }): Promise<void>;
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
  /** From every project, or from `projectId` only (a Market category can belong to several). */
  unlink(module: string, ref: string, projectId?: string): Promise<void>;
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

/** Settings → MCP: the things an AI tool may do to a person's documents. */
export interface McpAccess {
  /** Make new files in projects (never replacing one). */
  createFiles: boolean;
  /** Change the text of existing files. */
  editFiles: boolean;
  /** Send keyword suggestions into Market's Keywords tab, for the person to review. */
  suggestKeywords: boolean;
}

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
  /** Saves the Market capture extension (a .zip, for Chrome's "Load unpacked" once unzipped) into Downloads and shows it; resolves to the file. */
  saveChromeExtension(): Promise<string>;
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
}

/** What a backup holds, read (and checked) before anything is restored. */
export interface BackupSummary {
  file: string;
  studioName: string;
  created: string;
  app: string;
  /** Project folder names in the backup. */
  projects: string[];
  files: number;
}

/** A project found in an MDEdit folder, with what importing it would do. */
export interface MdeditCandidate {
  source: string;
  name: string;
  asName: string;
  files: number;
  bytes: number;
  chapterFiles: number;
  hasGoal: boolean;
  reviewFiles: number;
  editedMarks: number;
  alreadyImportedAs: string | null;
  notCarried: string[];
}

/** Backing up the Studio, restoring from a backup, and bringing projects over from MDEdit. Every picker is a dialog the page cannot fill in itself. */
export interface BackupApi {
  /** Asks where to save, then backs up this Studio's data and project folders (all projects, or just the ones named). Null if cancelled. */
  make(o?: { projects?: string[] }): Promise<{ file: string; files: number; bytes: number } | null>;
  /** Asks for a backup file and checks it. Null if cancelled. */
  inspect(): Promise<BackupSummary | null>;
  /** Puts one project of a checked backup into this Studio's Projects folder, under a free name, and in the project tree. */
  restoreProject(file: string, project: string, parentId?: string | null): Promise<{ id: string; name: string }>;
  /** Restores a whole backup as a new Studio on this computer (nothing here is overwritten); switch to it from the Studio menu. */
  restoreAsStudio(file: string, name: string): Promise<StudiosView>;
  /** Asks for an MDEdit project folder, or a Root Folder holding several, and previews each project in it. Null if cancelled. */
  findMdedit(): Promise<MdeditCandidate[] | null>;
  /** Copies one previewed project into this Studio as a Cadrel project. The MDEdit original is not touched. */
  importMdedit(source: string, o?: { asNewCopy?: boolean; parentId?: string | null }): Promise<{ id: string; name: string }>;
}

/** One published book in the My Books list. `money` is null when the person's role may not see Finance's figures (not zero: absent). */
export interface MyBookRow {
  asin: string;
  title: string;
  penNames: string[];
  authors: string[];
  captured: boolean;
  overallRank: number | null;
  listRank: number | null;
  kindlePrice: number | null;
  ratingValue: number | null;
  ratingCount: number | null;
  money: null | { paidUnits: number; kenpPages: number; lastSaleDay: string | null; lastMonth: string | null; lastMonthUsd: number | null; lastMonthState: 'final' | 'estimated' | 'pending' | null };
}

export interface MyBooksList {
  /** False until Market has a library: there is nothing to list. */
  available: boolean;
  books: MyBookRow[];
  /** Whether Finance's figures are shown at all to this person. */
  financeVisible: boolean;
}

/** One format of a book in the catalogue. The ASIN is the join to Market and Finance. */
export interface CatalogueEdition { id: string; format: string; asin: string | null; isbn: string | null; price: number | null; currency: string; publishedOn: string | null }
/** A book in the catalogue, with its project's stage and progress and (when it has an ASIN Market knows) its listing and money. */
export interface CatalogueBookRow {
  bookId: string;
  title: string;
  subtitle: string;
  penName: string;
  seriesId: string | null;
  seriesName: string | null;
  position: number | null;
  editions: CatalogueEdition[];
  /** The ASIN that stands for the book in Market and Finance; null until an edition has one. */
  asin: string | null;
  market: MyBookRow | null;
  projectId: string | null;
  projectName: string | null;
  stage: string | null;
  stageColor: string | null;
  /** The kind of the stage (start, active, review, done, hold), so a gate or a count can tell a finished book from one in production. */
  stageCategory: string | null;
  words: number | null;
  goalWords: number | null;
}
export interface CatalogueList {
  /** False where this computer holds no records for the Studio: the page falls back to Market's list. */
  available: boolean;
  reason?: string;
  marketAvailable: boolean;
  financeVisible: boolean;
  may: { create: boolean; edit: boolean; archive: boolean };
  series: { id: string; name: string }[];
  books: CatalogueBookRow[];
  /** Books Market knows as yours that the catalogue does not have yet. */
  unlisted: { asin: string; title: string; penNames: string[] }[];
  /** Projects a book could be linked to (live and not linked to a book yet). */
  projects: { id: string; name: string }[];
}
export interface CatalogueDetail {
  book: CatalogueBookRow;
  series: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  may: CatalogueList['may'];
}

/** Everything about one published book, assembled from Market and (for roles that may see it) Finance. Nothing is stored here. */
export interface BookPage {
  asin: string;
  title: string;
  penNames: string[];
  authors: string[];
  cover: string | null;
  source: 'report' | 'manual';
  addedAt: string;
  market: {
    captured: boolean;
    lastCaptured: string | null;
    overallRank: number | null;
    listRank: number | null;
    listCategory: string | null;
    kindlePrice: number | null;
    ratingValue: number | null;
    ratingCount: number | null;
    text: 'manuscript' | 'sample' | null;
    history: { capturedAt: string; price: number | null; rank: number | null; ratings: number | null }[];
    categories: { key: string; name: string }[];
  };
  /** Null when the person's role does not include royalties: the sections are left out, not shown empty. */
  finance: null | {
    hasData: boolean;
    paidUnits: number;
    kenpPages: number;
    firstSaleDay: string | null;
    lastSaleDay: string | null;
    /** Newest first. `state` says whether KDP has reported the month (final), it rests on an estimated KENP rate, or it is not in yet. */
    months: { month: string; usd: number; units: number; pages: number; state: 'final' | 'estimated' | 'pending' }[];
    totalUsd: number;
    /** The part of `totalUsd` that rests on estimates. */
    estimatedUsd: number;
    split: { fromMonth: string; shares: { name: string; pct: number }[] } | null;
    payees: string[];
    /** The KDP payments this book is in, newest first, with the book's part of each. `reconciled` is false until a payment report is imported. */
    payments: {
      reconciled: boolean;
      items: { number: string; paidOn: string; scheduled: boolean; allocated: boolean; changed: boolean; paymentNet: number; net: number }[];
      totalNet: number;
      awaitingUsd: number;
    };
  };
}

export interface BookSaveResult {
  /** The folder the files went into. */
  folder: string;
  files: string[];
}

/** My Books: the portal for a published book. It reads Market and Finance and saves through their own generators; it keeps no data. */
export interface MyBooksApi {
  /** The catalogue's books with Market and Finance joined by ASIN. Where this computer has no records, `available` is false and `list()` is the fallback. */
  catalogue(): Promise<CatalogueList>;
  catalogueBook(bookId: string): Promise<CatalogueDetail | null>;
  createBook(i: { title: string; subtitle?: string; penName?: string; seriesId?: string | null; position?: number | null }): Promise<{ id: string }>;
  createSeries(i: { name: string; description?: string }): Promise<{ id: string; name: string }>;
  updateBook(id: string, patch: { title?: string; subtitle?: string; penName?: string }): Promise<unknown>;
  moveBook(id: string, seriesId: string | null, position?: number | null): Promise<unknown>;
  addEdition(bookId: string, i: { format: string; asin?: string | null; isbn?: string | null; price?: number | null; currency?: string; publishedOn?: string | null }): Promise<unknown>;
  updateEdition(id: string, patch: { asin?: string | null; isbn?: string | null; price?: number | null; currency?: string; publishedOn?: string | null }): Promise<unknown>;
  archiveBook(id: string): Promise<void>;
  /** Deletes a book added by mistake from the catalogue and from Market and Finance, leaving no trace of it (the project it was made in stays). */
  deleteBook(id: string): Promise<{ asins: string[] }>;
  /** Links the book to the project it is made in (or unlinks with null). */
  linkProject(bookId: string, projectId: string | null): Promise<void>;
  /** Adds books Market knows as yours to the catalogue. */
  addFromMarket(asins: string[]): Promise<{ added: string[]; skipped: { asin: string; reason: string }[] }>;
  list(): Promise<MyBooksList>;
  book(asin: string): Promise<BookPage | null>;
  /** Asks for a folder, then saves the Market exports for the categories this book is listed in. Null if cancelled. */
  saveMarket(asin: string): Promise<BookSaveResult | null>;
  /** Asks for a folder, then saves this book's earnings and the statements of the authors on it (CSV and PDF). Null if cancelled, or refused when the role may not see Finance. */
  saveFinance(asin: string, o?: { months?: number }): Promise<BookSaveResult | null>;
  /** Everything the two above save, in one folder for this book. */
  saveAll(asin: string, o?: { months?: number }): Promise<BookSaveResult | null>;
  /** Opens the book's page on Amazon in the browser, where it can be captured with the extension. */
  openOnAmazon(asin: string): Promise<void>;
  /** Shows the book in Market's Library, or on its own page in Finance (only for roles that may see Finance). */
  openIn(module: 'market' | 'finance', asin: string): Promise<void>;
}

/** The studio's people, teams, roles and who holds what, as the Admin page shows them. `may` is what the person using the app may change. */
export type PeopleState =
  | { available: false; reason: string }
  | {
      available: true;
      /** The person using this computer. */
      me: string;
      /** The Studio's id: the scope of a studio-wide role. */
      studioId: string;
      people: Person[];
      deactivated: Person[];
      teams: Team[];
      penNames: PenName[];
      roles: RoleRecord[];
      assignments: AssignmentRecord[];
      /** Capabilities a newer version added that no administrator has placed or acknowledged yet. */
      review: string[];
      may: { people: boolean; teams: boolean; roles: boolean };
    };

/** Every change goes through the permission-checked service as the person using the app; a refusal comes back as its reason in words. */
export interface PeopleApi {
  state(): Promise<PeopleState>;
  createPerson(i: { name: string; email?: string | null; kind?: string }): Promise<Person>;
  updatePerson(id: string, patch: { name?: string; email?: string | null; kind?: string }): Promise<Person>;
  setPersonActive(id: string, active: boolean): Promise<Person>;
  createPenName(i: { displayName: string; personIds?: string[] }): Promise<PenName>;
  setPenNamePeople(id: string, personIds: string[]): Promise<PenName>;
  createTeam(name: string): Promise<Team>;
  renameTeam(id: string, name: string): Promise<Team>;
  setTeamMember(teamId: string, personId: string, member: boolean): Promise<Team>;
  deleteTeam(id: string): Promise<void>;
  createRole(i: { name: string; description?: string; capabilities?: string[]; copyFrom?: string }): Promise<RoleRecord>;
  updateRole(id: string, patch: { name?: string; description?: string; capabilities?: string[] }): Promise<RoleRecord>;
  resetRole(id: string): Promise<RoleRecord>;
  /** A role that is still assigned needs `replacementId`: its people are moved to that role. */
  deleteRole(id: string, replacementId?: string): Promise<void>;
  acknowledgeCapabilities(caps: string[]): Promise<void>;
  grant(i: { subject: { kind: 'person' | 'team'; id: string }; roleId: string; scope: { kind: 'studio' | 'project' | 'file'; id: string }; expiresAt?: string | null }): Promise<AssignmentRecord>;
  revoke(id: string): Promise<void>;
  setExpiry(id: string, expiresAt: string | null): Promise<AssignmentRecord>;
  /** Why this person can or cannot do something at the studio, or on one project. */
  explainAccess(personId: string, capability: string, projectId?: string | null): Promise<{ allowed: boolean; reason: string }>;
  /** Every capability the person holds at the studio, or on one project when `projectId` is given (`*` means all). */
  effectiveCapabilities(personId: string, projectId?: string | null): Promise<string[]>;
}

/** The workflows an administrator builds: the stages a book moves through and the gates between them. */
export type WorkflowState =
  | { available: false; reason: string }
  | {
      available: true;
      workflows: WorkflowRecord[];
      /** How many projects use each workflow, and how many are in each of its stages. */
      usage: Record<string, WorkflowUsage>;
      /** The roles a gate can name. */
      roles: { id: string; name: string }[];
      /** May the person using the app build workflows? Everyone may read them. */
      may: boolean;
    };

export interface WorkflowApi {
  state(): Promise<WorkflowState>;
  /** A blank workflow, or a copy of `copyFrom`. It is not the default until `setDefault`. */
  create(i: { name: string; description?: string; copyFrom?: string }): Promise<WorkflowRecord>;
  /** Saves the whole definition (stages, moves, gates). Dropping a stage that has projects in it needs `moveProjects` to say where they go. */
  save(id: string, draft: WorkflowDraft): Promise<WorkflowRecord>;
  /** Makes it the default for new projects, new subprojects, or both (the default when `levels` is left out). */
  setDefault(id: string, levels?: ('project' | 'subproject')[]): Promise<WorkflowRecord>;
  delete(id: string): Promise<void>;
}

/** Tasks, deadlines, approvals and decisions on a project and its subprojects, each labelled with the project it is on. */
export type OnProject<T> = T & { projectName: string };
export type WorkState =
  | { available: false; reason: string }
  | {
      available: true;
      me: string;
      people: { id: string; name: string }[];
      /** What the person using the app may do with work: task.edit (their own), task.assign (hand work over), task.manage (anyone's). */
      may: { edit: boolean; assign: boolean; manage: boolean };
      tasks: OnProject<TaskRecord>[];
      approvals: OnProject<ApprovalRecord>[];
      decisions: OnProject<Omit<DecisionRecord, 'projectId'> & { projectId: string | null }>[];
      /** The sign-off labels the project stands approved under now. */
      approved: string[];
    };
/** What waits on the person using the app, across projects. */
export interface MineState {
  available: boolean;
  tasks: OnProject<TaskRecord>[];
  approvals: OnProject<ApprovalRecord>[];
}
/** The files of the Studio: the working folder, and every file's state for this person on this computer. */
export type VaultState =
  | { available: false; reason: string }
  | {
      available: true;
      dir: string;
      machine: string;
      me: string;
      people: { id: string; name: string }[];
      may: { force: boolean };
      entries: {
        path: string;
        kind: 'manuscript' | 'asset';
        fileId: string | null;
        status: 'untracked' | 'not-local' | 'latest' | 'out-of-date' | 'checked-out-by-me' | 'checked-out-by-other' | 'modified-unprotected' | 'missing';
        version: number | null;
        localVersion: number | null;
        modified: boolean;
        lock: { personId: string; machine: string; since: string } | null;
        size: number | null;
        state: string | null;
      }[];
      /** Lock removals found on this computer just now: the unsaved copy was kept aside (`savedAs`, null if there was nothing unsaved). */
      kept: { path: string; savedAs: string | null; removedBy: string; reason: string }[];
      /** Every copy kept aside on this computer. */
      orphans: { path: string; savedAs: string; removedBy: string; removedAt: string; reason: string; version: number }[];
    };
export interface VaultApi {
  state(): Promise<VaultState>;
  /** Puts a file from the working folder into the vault as its first version. */
  add(path: string, comment?: string): Promise<void>;
  checkOut(path: string): Promise<void>;
  /** Saves the file as a new version and releases it; nothing changed means it is released with no new version. */
  checkIn(path: string, comment?: string): Promise<{ unchanged: boolean }>;
  undoCheckOut(path: string): Promise<void>;
  discardLocalChanges(path: string): Promise<void>;
  /** Updates read-only copies to the newest versions (files you have checked out are never touched). */
  getLatest(paths?: string[], o?: { fetchMissing?: boolean }): Promise<{ updated: string[]; skipped: { path: string; why: string }[] }>;
  /** An administrator releases someone else's check-out; their unsaved work is kept aside on their computer. Needs a reason. */
  forceRelease(path: string, reason: string): Promise<void>;
  history(path: string): Promise<FileVersion[]>;
  /** A file's versions, what it uses, where it is used (and whether each user names an older version) and its data card. */
  detail(path: string): Promise<{ versions: FileVersion[]; uses: FileRef[]; usedBy: FileRef[]; card: DataCard }>;
  /** `path` uses `to`, at a version or the latest. A reference never updates itself: `setReferenceVersion` is a person's choice. */
  addReference(path: string, to: string, version?: number | null, note?: string): Promise<void>;
  setReferenceVersion(path: string, to: string, version: number | null): Promise<void>;
  removeReference(path: string, to: string): Promise<void>;
  /** Replaces the data card; an empty value removes a field. */
  setCard(path: string, fields: Record<string, string>, projectId?: string | null): Promise<DataCard>;
  saveVersionAs(path: string, version: number, as: string): Promise<string>;
  /** Opens the working folder in the file manager. */
  openFolder(): Promise<void>;
}

/** One live project in the pipeline: where it is in its workflow and what is due on it. */
export interface PlanProject {
  id: string;
  name: string;
  /** The names of the projects above it, outermost first. */
  path: string[];
  kind: string;
  workflowId: string | null;
  stage: string | null;
  openTasks: number;
  late: number;
  /** The earliest date of an open task or deadline on the project itself, or null. */
  nextDue: string | null;
}
/** The pipeline and the calendar: every live project by workflow and stage, and every task and deadline that is not cancelled. */
export type PlanState =
  | { available: false; reason: string }
  | {
      available: true;
      me: string;
      today: string;
      people: { id: string; name: string }[];
      /** The workflows in use, with their stages in order. */
      workflows: { id: string; name: string; stages: { key: string; name: string; color: string; category: string }[] }[];
      projects: PlanProject[];
      tasks: OnProject<TaskRecord>[];
    };
/** The studio at a glance, for Home and the Dashboard. */
export type Pulse =
  | { available: false; reason: string }
  | {
      available: true;
      today: string;
      work: { open: number; late: number; dueSoon: number; approvalsPending: number; doneThisWeek: number };
      late: PulseTask[];
      upcoming: PulseTask[];
      approvals: { id: string; label: string; projectId: string; projectName: string; waiting: string[] }[];
      decisions: { id: string; title: string; outcome: string; projectName: string | null; decidedAt: string }[];
      pipeline: { id: string; name: string; total: number; stages: { key: string; name: string; color: string; category: string; count: number }[] }[];
      books: { total: number; published: number; unpublished: number; series: number; inProduction: number; unlisted: number; money: null | { month: string; usd: number; estimated: boolean } };
      people: { id: string; name: string }[];
    };
export interface PulseTask { id: string; title: string; kind: string; due: string | null; projectId: string; projectName: string; assigneeId: string | null }
export interface WorkApi {
  pulse(): Promise<Pulse>;
  plan(): Promise<PlanState>;
  state(projectId: string): Promise<WorkState>;
  mine(): Promise<MineState>;
  createTask(i: NewTask): Promise<TaskRecord>;
  updateTask(id: string, patch: TaskPatch): Promise<TaskRecord>;
  setState(id: string, state: TaskState): Promise<TaskRecord>;
  addDependency(id: string, dependsOnId: string): Promise<TaskRecord>;
  removeDependency(id: string, dependsOnId: string): Promise<TaskRecord>;
  requestApproval(i: NewApproval): Promise<ApprovalRecord>;
  /** Only a person the approval names can answer it; rejecting needs a reason. */
  respond(id: string, response: 'approved' | 'rejected', reason?: string): Promise<ApprovalRecord>;
  withdraw(id: string): Promise<ApprovalRecord>;
  /** Adds to the ledger. Entries are never changed; `supersedes` replaces an earlier one. */
  recordDecision(i: { projectId?: string | null; title: string; context?: string; outcome: string; supersedes?: string | null }): Promise<DecisionRecord>;
}

/** A project's workflow and where it is in it, as the pages show them. */
export interface ProjectStageView {
  workflowId: string;
  workflowName: string;
  stage: { key: string; name: string; color: string; category: 'start' | 'active' | 'review' | 'done' | 'hold' } | null;
}
export interface StageMoveOption { key: string; name: string; color: string; category: 'start' | 'active' | 'review' | 'done' | 'hold'; allowed: boolean; reasons: string[] }

/** Where projects are in their workflows, and the moves between stages. A move is checked against the workflow's gates and the person's roles. */
export interface StagesApi {
  /** Every project's stage (by project id), for the tree and the lists. */
  views(): Promise<Record<string, ProjectStageView>>;
  /** Where one project can go, and for each move whether it is open now and what is in the way. Null for a project with no workflow. */
  options(projectId: string): Promise<{ workflowName: string; current: ProjectStageView['stage']; options: StageMoveOption[] } | null>;
  move(projectId: string, to: string): Promise<void>;
  /** Closes a Book: moves it to the first Done stage open to this person from where it is. */
  close(bookId: string): Promise<void>;
  /** Reopens a closed Book into one of the stages open from its Done stage. */
  reopen(bookId: string, to: string): Promise<void>;
  /** Takes the stage off a Project above its Books (made before stages moved to Books). */
  clear(projectId: string): Promise<void>;
}

/** The scope with the names to show for it, so a page or module view needs nothing else to label it. */
export interface ScopeView extends ResolvedViewScope {
  projectName: string | null;
  /** The chosen Book's name, or null for all books. */
  bookName: string | null;
}

/** The Project and Book the app is showing (docs/UI-MODEL.md). One scope for the whole app: the shell's pages and the module views follow it. */
export interface ScopeApi {
  get(): Promise<ScopeView>;
  /** Changes the Project and/or the Book; answers with the scope that resulted (a Book that is not the Project's is dropped). */
  set(change: Partial<ViewScope>): Promise<ScopeView>;
  /** Opens the native menu for choosing the Project and Book at a point in the window (native, so it draws above the module views). */
  openMenu(at: { x: number; y: number }): Promise<void>;
  /** Called whenever the scope changes, whoever changed it (another page, a project archived). */
  onChange(cb: (scope: ScopeView) => void): () => void;
}

export interface CadrelApi {
  scope: ScopeApi;
  studios: StudiosApi;
  stages: StagesApi;
  workflow: WorkflowApi;
  work: WorkApi;
  vault: VaultApi;
  people: PeopleApi;
  myBooks: MyBooksApi;
  backup: BackupApi;
  studio: StudioApi;
  manage: ManageApi;
  theme: {
    get(): Promise<ThemeState>;
    set(change: { source?: ThemeSource; custom?: ThemeCustom | null }): Promise<ThemeState>;
    onChange(cb: (t: ThemeState) => void): () => void;
  };
  user: UserApi;
  /** What AI tools (the MCP server) may do to documents. Everything that changes a file is off until the person turns it on. */
  mcp: {
    get(): Promise<McpAccess>;
    set(change: Partial<McpAccess>): Promise<McpAccess>;
  };
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
  market: {
    /** Tries Market's capture server again, for example after freeing the port some other program was holding it on. */
    reconnect(): Promise<void>;
    /** Stops Market's capture server deliberately, without closing its library, so the port is free right away for another program. */
    forceDisconnect(): Promise<void>;
    /** Quits the program holding Market's capture port (looked up now) and starts the server again. */
    freePort(): Promise<void>;
  };
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
