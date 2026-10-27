/**
 * The Cadrel shell: one window that hosts the modules. The shell draws the rail, Home and Dashboard itself; Write and
 * Market each live in their own view with their own preload, styles and bridge, so neither knows the other exists.
 * Both modules' main-process halves run in this process from startup (the capture server must keep listening
 * whichever page is showing).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp, appendFileSync, readFileSync } from 'node:fs';
import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, screen, shell } from 'electron';
import { createWriteModule, type WriteModule } from '@cadrel/write/electron/module';
import { chromeColors, drawsOwnChrome, markOwnChrome, onChromeTheme, shellColor, watchWindow, windowInfo } from '@cadrel/write/electron/windowChrome';
import { fileFromArgv } from '@cadrel/write/electron/launch';
import { createMarketModule, type MarketModule } from '@cadrel/market-desktop/src/main/module.js';
import { createFinanceModule, type FinanceModule } from '@cadrel/finance-desktop/src/main/module.js';
import { launcherSource, readHandshake } from '@cadrel/market-desktop/src/main/launcher.js';
import type { McpBrand } from '@cadrel/market-desktop/src/main/service.js';
import type { KitBrand } from '@cadrel/write/src/shared/agent/kit';
import { sanitizeThemeCustom, type ThemeCustom } from '@cadrel/write/src/shared/theme';
import { isModule, isPage, type AppFolders, type FolderKey, type ModuleId, type Overview, type Page, type ThemeState, type UserView } from '../shared/api';
import { isThemeSource, marketCss, type ThemeSource } from '../shared/theme';
import { moduleBounds } from './layout';
import { CONTROLS_HEIGHT, WINDOW_RADIUS, controlsBounds, controlsUrl } from './controls';
import { marketUnavailable, summariseMarket, summariseWrite, writeUnavailable } from './overview';
import { runShellSmoke } from './smoke';
import { SettingsStore } from './settings';
import { StudioService } from './studio';
import { ProjectManager, type WriteFolders } from './manage';
import { nodeFs } from '@cadrel/write/electron/nodeFs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { NOTES_VERSION, NoteError, PROJECT_TREE_VERSION, ProjectError, UserError, type UserProfile } from '@cadrel/kernel';
import { PeopleHost } from './people';
import { bookPage, financeAccess, listBooks, saveBook } from './mybooks';
import { BACKUP_EXTENSION, createBackup, describeBackup, findMdeditProjects, importMdeditProject, previewMdeditImport, restoreBackup, restoreProject } from './backup';
import { UserStore } from '@cadrel/studio';
import { AdminError, AdminStore, canAdminister, type Role } from './admin';
import { Updater } from './updater';
import { StudioRegistry, LOCAL_ID } from './studios';
import { buildStudio, upgradeStudio, type CloudflareOptions } from './cloudflare';
import { Secrets } from './secrets';
import { joinStudio, StudioClient } from './studioClient';
import { generateKeyPair, type KeyPair } from '@cadrel/kernel';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST = process.env.CADREL_TEST === '1';
// `Cadrel.exe --smoke-test=<file>` runs a headless self-test of the installed app and exits (see smoke.ts).
const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));

app.setName('Cadrel');
if (process.platform === 'win32') app.setAppUserModelId('com.blaashford.cadrel');
if (process.env.CADREL_USER_DATA) app.setPath('userData', process.env.CADREL_USER_DATA);

// Everything Cadrel keeps for a person lives under one folder (%APPDATA%\Cadrel): the shell's settings, the studio, the user, and one
// folder for each module. The AI server finds Market's config at <that folder>/market/config.json and Write's settings at
// <that folder>/write/settings.json (CADREL_USER_DATA moves the whole folder, for tests).
const userData = process.env.CADREL_USER_DATA ?? app.getPath('userData');
/**
 * The active Studio's data folder: <userData>/studios/<id>. Its projects and notes, its profile, its Write and Market data and its
 * settings are all inside it, and nothing is shared between Studios. Which Studio is active is chosen at start-up (switching restarts
 * Cadrel), so no module ever holds two Studios' data at once.
 */
let studioDir = '';
const writeData = () => path.join(studioDir, 'write');
const marketData = () => path.join(studioDir, 'market');

let win: BrowserWindow | null = null;
let settings: SettingsStore;
/** The active Studio's own settings (where its Projects and Write folders are, if the person moved them). */
let studioSettings: SettingsStore;
let studio: StudioService;
let users: UserStore;
let admin: AdminStore;
let studios: StudioRegistry;
let updater: Updater;
/** A verified installer to start once the app has exited. */
let installerToRun: string | null = null;
let manager: ProjectManager;
let userCache: UserProfile | null = null;

async function refreshUser(): Promise<UserProfile> {
  userCache = await users.read();
  return userCache;
}

async function userView(): Promise<UserView> {
  const profile = await refreshUser();
  return { profile, name: authorName(), nameIsDefault: !profile.displayName, problems: await users.verify() };
}

/** Attaches each file in turn; one that cannot be attached does not stop the rest, and the first refusal is reported after. */
async function attachAll(paths: string[]): Promise<UserView> {
  let first: unknown;
  for (const p of paths) {
    try {
      await users.attach(p);
    } catch (e) {
      first ??= e;
    }
  }
  const v = await userView();
  win?.webContents.send('shell:user', v);
  if (first) throw first;
  return v;
}
let write: WriteModule;
let market: MarketModule;
let finance: FinanceModule;
const peopleHost = new PeopleHost();
let page: Page = 'home';
let quitting = false;
const views: Partial<Record<ModuleId, WebContentsView>> = {};

// ---- appearance: one setting for the whole app --------------------------------------------------
// Light/dark follows nativeTheme (which reaches every view). The colours are the shell's to set: it paints its own page,
// tells Write (which already understands the model), and maps the same colours onto Market's differently named variables.
const themeState = (): ThemeState => ({ source: settings.get().theme ?? 'system', ...(settings.get().themeCustom ? { custom: settings.get().themeCustom } : {}) });
// Finance is drawn with Market's stylesheet, so it takes the same mapping.
const paintedCss: Partial<Record<ModuleId, string>> = {};

function paintMarketStyled(id: 'market' | 'finance'): void {
  const c = views[id]?.webContents;
  if (!c || c.isDestroyed()) return;
  const old = paintedCss[id];
  void c.insertCSS(marketCss(settings.get().themeCustom)).then((key) => {
    paintedCss[id] = key;
    if (old) void c.removeInsertedCSS(old).catch(() => undefined);
  });
}
const paintMarket = (): void => (paintMarketStyled('market'), paintMarketStyled('finance'));

function setTheme(change: { source?: ThemeSource; custom?: ThemeCustom | null }): ThemeState {
  settings.update((s) => {
    if (change.source !== undefined && isThemeSource(change.source)) {
      if (change.source === 'system') delete s.theme;
      else s.theme = change.source;
    }
    if (change.custom !== undefined) {
      const custom = sanitizeThemeCustom(change.custom);
      if (custom) s.themeCustom = custom;
      else delete s.themeCustom;
    }
  });
  nativeTheme.themeSource = settings.get().theme ?? 'system';
  write.themeChanged(settings.get().themeCustom);
  paintMarket();
  if (win && !win.isDestroyed()) win.webContents.send('shell:theme', themeState());
  return themeState();
}

// ---- the one MCP server --------------------------------------------------------------------
// Write's AI Kit and Market's "connect to Claude" both end up here: one server, one Claude Desktop extension, one name.
const MCP_DESCRIPTION = 'Lets Claude read your Cadrel manuscripts and leave review notes in them (it never changes your manuscript), and search your Kindle market research.';
const CADREL_MCP: McpBrand = { id: 'cadrel', name: 'Cadrel', description: MCP_DESCRIPTION, file: 'Cadrel.mcpb' };
const KIT_BRAND: KitBrand = { id: 'cadrel', name: 'Cadrel', folder: 'Cadrel AI Kit', description: MCP_DESCRIPTION };
const mcpFile = () => path.join(here, 'mcp.mjs');
/** How an AI app starts the server: the installed app's own runtime acting as Node (it carries the native modules), the system Node in development. */
const mcpLaunch = () => ({
  command: app.isPackaged ? process.execPath : 'node',
  // Pinned to the active Studio: its projects and its notes, nothing else (the library is added by Market).
  args: [mcpFile(), '--root', projectsFolder(), '--studio', studioFile()],
  env: (app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) as Record<string, string>
});
/**
 * The file inside the Claude Desktop extension: a small launcher that starts the server above with the installed app's runtime.
 * The server takes seconds to open the library, which Claude Desktop will not wait for, so the launcher answers the handshake first.
 * Arguments the extension's settings add (the projects folder) are passed on to the server.
 */
async function kitLauncher(): Promise<Uint8Array> {
  const launch = mcpLaunch();
  const handshake = await readHandshake(launch);
  return Buffer.from(launcherSource({ label: 'Cadrel', ...launch, handshake, logFile: path.join(marketData(), 'logs', 'mcp-launcher.log') }), 'utf8');
}

/** Who a note written in the app is by: the profile's name, else the Windows user. */
const authorName = () => userCache?.displayName || os.userInfo().username || 'Me';

/** Write, as the project manager needs it. */
function writeFolders(): WriteFolders {
  return {
    projectsRoot: () => write.projectsRoot(),
    templates: () => write.templates().map((t) => ({ id: t.id, name: t.name, description: t.description })),
    listFolders: async () => {
      const l = await write.listProjects();
      return { projects: l.projects.map((p) => ({ name: p.name, path: p.path })), others: l.folders };
    },
    createProject: (name, template) => write.createProject(name, template),
    renameProject: (p, name) => write.renameProject(p, name),
    duplicateProject: (p, name) => write.duplicateProject(p, name),
    deleteProject: (p) => write.deleteProject(p),
    readProject: async (p) => {
      const m = await write.readProject(p);
      return m ? { status: m.status, notes: m.notes, archived: m.archived, templateName: m.templateName, createdAt: m.createdAt, templateId: m.templateId } : null;
    },
    updateProject: (p, patch) => write.updateProject(p, patch),
    convertFolder: (p) => write.convertFolder(p),
    addMissingTemplateParts: (p, id) => write.addMissingTemplateParts(p, id),
    openProject: (p) => write.openProject(p)
  };
}

// ---- updating -------------------------------------------------------------------------------------

/** What the person is in the active Studio: its Owner if they made it, otherwise the role they were invited with. */
function studioRole(): Role {
  const a = studios.active();
  return a.role === 'owner' ? 'owner' : a.memberRole === 'admin' ? 'admin' : 'member';
}

/** One line per update step in <data folder>\update.log, so a failed update can be diagnosed afterwards. */
function updateLog(line: string): void {
  try {
    appendFileSync(path.join(userData, 'update.log'), `${new Date().toISOString()} v${app.getVersion()} ${line}\n`);
  } catch {
    /* logging must never get in the way of updating */
  }
}

/** For tests: answers GitHub's release questions from a JSON file (an array of releases) so no network is needed. */
function fakeReleases(file: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const all = JSON.parse(readFileSync(file, 'utf8')) as { prerelease?: boolean }[];
    const body = String(url).includes('/releases/latest') ? all.find((r) => !r.prerelease) : all;
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

/** Looks for an update now and then, and tells the page when there is one (the rail and Settings show it). */
function watchForUpdates(): void {
  const look = () => void updater.check().then((st) => st.available && win && !win.isDestroyed() && win.webContents.send('shell:update:available', st), () => undefined);
  if (!TEST || process.env.CADREL_TEST_RELEASES) setTimeout(look, TEST ? 500 : 15_000);
  if (!TEST) setInterval(look, 6 * 60 * 60 * 1000).unref();
}

// ---- the Cadrel folder ----------------------------------------------------------------------------
// Everything a person works with lives in one folder, <home>\Cadrel by default (wherever their home folder is, so a profile kept on
// another drive is followed). Each Studio has its own folder inside it: <Cadrel>\<Studio>\Projects, \Write and \Market. None needs setting
// up. The Cadrel folder can be moved (it moves at the next start, when nothing is open), and the Projects, Write and Market folders of
// the active Studio can each be placed elsewhere, which a move of the Cadrel folder then leaves alone.
const defaultCadrelFolder = () => process.env.CADREL_FOLDER ?? path.join(app.getPath('home'), 'Cadrel');
const cadrelFolder = () => settings.get().cadrelFolder ?? defaultCadrelFolder();
const studioFolder = () => path.join(cadrelFolder(), studios.active().folderName);
const projectsDefault = () => path.join(studioFolder(), 'Projects');
const writeDefault = () => path.join(studioFolder(), 'Write');
const marketDefault = () => path.join(studioFolder(), 'Market');
const projectsFolder = () => studioSettings.get().projectsFolder ?? projectsDefault();
const writeFolder = () => studioSettings.get().writeFolder ?? writeDefault();
const studioFile = () => path.join(studioDir, 'studio.json');
const sameDir = (a: string, b: string) => path.resolve(a) === path.resolve(b);
/** The shell's own last word on a move of the Cadrel folder that did not work. */
let moveError: string | null = null;

async function folders(): Promise<AppFolders> {
  const m = market.service.status().libraryRoot;
  return {
    studioFolder: studioFolder(),
    studioName: studios.active().name,
    pendingCadrelMove: settings.get().pendingCadrelMove ? settings.get().pendingCadrelMove!.to ?? defaultCadrelFolder() : null,
    moveError,
    cadrelFolder: cadrelFolder(),
    cadrelFolderIsDefault: !settings.get().cadrelFolder,
    projectsFolder: projectsFolder(),
    projectsIsCustom: !!studioSettings.get().projectsFolder,
    writeFolder: writeFolder(),
    writeIsCustom: !!studioSettings.get().writeFolder,
    marketLibrary: m ?? null,
    marketIsCustom: !!m && !sameDir(m, marketDefault()),
    studioFile: studioFile(),
    settingsFolder: studioDir
  };
}

/** Moves a whole folder to a new place (a rename, or a copy then delete across drives). The new place must be new or empty. */
async function relocate(from: string, to: string): Promise<void> {
  if (sameDir(from, to)) return;
  if (!path.isAbsolute(to)) throw new Error('Choose a full folder path.');
  if (to.startsWith(path.resolve(from) + path.sep) || path.resolve(from).startsWith(to + path.sep)) throw new Error('The new place cannot be inside the old one, or the other way round.');
  const there = await fsp.readdir(to).catch(() => null);
  if (there && there.length) throw new Error(`${to} is not empty. Choose a new or empty folder.`);
  const here = await fsp.stat(from).then((st) => st.isDirectory(), () => false);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  if (!here) return void (await fsp.mkdir(to, { recursive: true }));
  if (there) await fsp.rmdir(to);
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw new Error(`Could not move ${from}: ${(e as Error).message} (is something open in it?)`);
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Market copies its library; an earlier move leaves the old copy behind, so one in the way is put aside (never deleted). */
async function moveMarket(dest: string): Promise<void> {
  if (await fsp.readdir(dest).then((f) => f.length > 0, () => false)) await fsp.rename(dest, `${dest} (old copy ${new Date().toISOString().slice(0, 10)}-${Date.now() % 100000})`);
  await fsp.mkdir(dest, { recursive: true });
  await market.service.moveTo(dest);
}

/** Moving anything out from under the editor with changes unsaved would lose them. */
function mustBeIdle(): void {
  if (write.hasUnsaved()) throw new Error('Save your changes in Write first, then continue.');
}

/** Rewrites a path that sits under the old Cadrel folder so it sits under the new one (anything else is left alone). */
const rebase = (p: string | undefined | null, from: string, to: string): string | undefined => {
  if (!p) return undefined;
  const rel = path.relative(from, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(to, rel) : p;
};

/**
 * Finishes a move of the Cadrel folder that was asked for last time. It runs at the start, before anything is opened, because a folder
 * with open files (Market's library, Write's open project) cannot be moved on Windows. Every Studio's own record of where things are is
 * updated with it. A move that fails leaves everything where it was and says why in Settings.
 */
async function applyPendingCadrelMove(): Promise<void> {
  const pending = settings.get().pendingCadrelMove;
  if (!pending) return;
  const from = cadrelFolder();
  const to = path.resolve(pending.to ?? defaultCadrelFolder());
  try {
    await relocate(from, to);
    for (const st of studios.view().studios) {
      const dir = path.join(userData, 'studios', st.id);
      const cfg = path.join(dir, 'market', 'config.json');
      try {
        const c = JSON.parse(await fsp.readFile(cfg, 'utf8')) as { libraryRoot?: string };
        const next = rebase(c.libraryRoot, from, to);
        if (next && next !== c.libraryRoot) await fsp.writeFile(cfg, JSON.stringify({ ...c, libraryRoot: next }, null, 2));
      } catch {
        /* this Studio has no Market library yet */
      }
      const own = new SettingsStore(path.join(dir, 'settings.json'));
      await own.load();
      const projects = rebase(own.get().projectsFolder, from, to);
      const write = rebase(own.get().writeFolder, from, to);
      if (projects !== own.get().projectsFolder || write !== own.get().writeFolder) {
        own.update((x) => {
          if (projects) x.projectsFolder = projects;
          if (write) x.writeFolder = write;
        });
        await own.flush();
      }
    }
    settings.update((x) => {
      if (pending.to === null || sameDir(to, defaultCadrelFolder())) delete x.cadrelFolder;
      else x.cadrelFolder = to;
    });
  } catch (e) {
    moveError = `The Cadrel folder was not moved: ${(e as Error).message}`;
  }
  settings.update((x) => {
    delete x.pendingCadrelMove;
  });
  await settings.flush();
}

/** Puts one of the active Studio's folders in a new place (null: back inside the Studio's folder). */
async function moveFolder(which: FolderKey, next: string | null): Promise<AppFolders> {
  if (which === 'cadrel') {
    // Moved at the next start. Asking again, or asking for where it already is, changes the request, never the files.
    const to = next === null ? null : path.resolve(next);
    settings.update((s) => {
      if ((to === null && !s.cadrelFolder) || (to !== null && sameDir(to, cadrelFolder()))) delete s.pendingCadrelMove;
      else s.pendingCadrelMove = { to };
    });
    moveError = null;
    return folders();
  }
  mustBeIdle();
  const key = which === 'projects' ? 'projectsFolder' : which === 'write' ? 'writeFolder' : null;
  if (which === 'market') {
    await moveMarket(path.resolve(next ?? marketDefault()));
    return folders();
  }
  const from = which === 'projects' ? projectsFolder() : writeFolder();
  const to = path.resolve(next ?? (which === 'projects' ? projectsDefault() : writeDefault()));
  await relocate(from, to);
  studioSettings.update((s) => {
    if (next === null || sameDir(to, which === 'projects' ? projectsDefault() : writeDefault())) delete s[key!];
    else s[key!] = to;
  });
  await ensureFolders();
  return folders();
}

/** The folders exist from the first launch, so there is nothing to set up and nothing missing to explain. */
async function ensureFolders(): Promise<void> {
  await Promise.all([projectsFolder(), writeFolder()].map((d) => fsp.mkdir(d, { recursive: true }).catch(() => undefined)));
}

// ---- Studios: keys, secrets and Cloudflare -------------------------------------------------------
const cipher = { available: () => safeStorage.isEncryptionAvailable(), encrypt: (p: string) => safeStorage.encryptString(p), decrypt: (b: Buffer) => safeStorage.decryptString(b) };
/** A Studio's secrets (its key for this computer, and the Cloudflare token if kept) live in its own data folder. Under test a marked plain file stands in for the operating system's store. */
const secretsFor = (id: string) => new Secrets(path.join(userData, 'studios', id, 'secrets'), cipher, TEST);
async function studioKey(id: string): Promise<KeyPair | null> {
  try {
    const k = JSON.parse((await secretsFor(id).get('studio-key')) ?? 'null') as KeyPair | null;
    return k?.publicKey && k.privateKey ? k : null;
  } catch {
    return null;
  }
}
const fingerprintOf = async (k: KeyPair) => (await import('@cadrel/kernel')).fingerprint(k.publicKey);
const studioWorkerSource = () => fsp.readFile(path.join(here, 'studio-worker.mjs'), 'utf8');
/** Cloudflare's real address, unless a test points the app at a stand-in (CADREL_TEST_CF=http://127.0.0.1:<port>). */
function cloudflareOptions(): CloudflareOptions {
  const fake = TEST ? process.env.CADREL_TEST_CF : undefined;
  return { fetchFn: fetch, ...(fake ? { base: `${fake}/client/v4`, workerUrl: (w: string) => `${fake}/w/${w}`, sleep: async () => undefined } : {}) };
}

/** Restarts Cadrel (to finish a move, or to open another Studio). Under test the process just ends and the test starts it again. */
async function restartApp(): Promise<void> {
  await Promise.all([studios.flush(), settings.flush(), studioSettings.flush()]);
  if (!TEST) app.relaunch();
  app.quit();
}

const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(here, 'assets', 'icon.png'));
const resourcesDir = () => (app.isPackaged ? process.resourcesPath : path.join(here, 'resources'));

// ---- the window and its views ---------------------------------------------------------------

function restoredBounds(): Partial<Electron.Rectangle> & { width: number; height: number } {
  const w = settings.get().window;
  const fallback = { width: 1280, height: 820 };
  if (!w) return fallback;
  const size = { width: Math.max(800, w.width), height: Math.max(500, w.height) };
  if (w.x === undefined || w.y === undefined) return size;
  // Only reuse the saved position if it still lands on a connected display.
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return w.x! < a.x + a.width - 50 && w.x! + size.width > a.x + 50 && w.y! >= a.y - 10 && w.y! < a.y + a.height - 50;
  });
  return visible ? { ...size, x: w.x, y: w.y } : size;
}

function saveWindowState(): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  settings.update((s) => {
    s.window = { ...b, ...(win!.isMaximized() ? { maximized: true } : {}) };
  });
}

function layout(): void {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  // A module's view is square; its outer corners are rounded off to match the window's (not when maximised, where the window has none).
  const radius = windowIsRounded() ? WINDOW_RADIUS : 0;
  for (const v of Object.values(views)) {
    v?.setBounds(moduleBounds({ width, height }));
    v?.setBorderRadius(radius);
  }
  controls?.setBounds(controlsBounds({ width }));
  paintControls();
}

// ---- the window's own buttons (Windows) ---------------------------------------------------------
// The window is transparent and frameless, so its rounded outline and its minimise / maximise / close buttons are ours. The buttons
// live in a small view kept above every other view.
let controls: WebContentsView | null = null;
let controlsKey = '';
const windowIsRounded = () => !!win && !win.isDestroyed() && drawsOwnChrome(win) && !win.isMaximized() && !win.isFullScreen();

function paintControls(): void {
  if (!controls || controls.webContents.isDestroyed() || !win || win.isDestroyed()) return;
  const look = { ...chromeColors(), maximized: win.isMaximized() };
  const key = JSON.stringify(look);
  if (key === controlsKey) return;
  controlsKey = key;
  void controls.webContents.loadURL(controlsUrl(look));
}

function addControls(w: BrowserWindow): void {
  controls = new WebContentsView({ webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  controls.setBackgroundColor('#00000000');
  controls.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controls.webContents.on('will-navigate', (e) => {
    if (!e.url.startsWith('data:')) e.preventDefault();
  });
  w.contentView.addChildView(controls);
  controls.setBounds({ x: 0, y: 0, width: 0, height: CONTROLS_HEIGHT });
  const off = onChromeTheme(paintControls);
  w.on('closed', () => {
    off();
    controls = null;
  });
}

/** Keeps the buttons above a module view that has just been added (the last view added is the top one). */
function raiseControls(): void {
  if (controls && win && !win.isDestroyed()) win.contentView.addChildView(controls);
}

/** Creates a module's view the first time it is needed. The module's main half is already running. */
function ensureView(id: ModuleId): WebContentsView {
  const existing = views[id];
  if (existing) return existing;
  const dir = path.join(here, 'modules', id);
  const view = new WebContentsView({
    webPreferences: { preload: path.join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  view.setBackgroundColor(shellColor());
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (e) => e.preventDefault());
  view.webContents.on('render-process-gone', (_e, d) => market?.log.error(`${id} renderer gone`, d.reason));
  // Market and Finance have no title bar of their own, so on Windows their tab bars must clear the window buttons and be draggable.
  if (id === 'market' || id === 'finance') {
    view.webContents.on('did-finish-load', () => {
      if (win && windowInfo(win).overlay) {
        void view.webContents.insertCSS('header.tabs{padding-right:150px;-webkit-app-region:drag}header.tabs button{-webkit-app-region:no-drag}');
      }
    });
  }
  if (id === 'market' || id === 'finance') view.webContents.on('did-finish-load', () => paintMarketStyled(id));
  void view.webContents.loadFile(path.join(dir, 'renderer', 'index.html'));
  if (id === 'write') write.attach(view.webContents, win!);
  views[id] = view;
  win!.contentView.addChildView(view);
  view.setBounds(moduleBounds(win!.getContentBounds()));
  view.setBorderRadius(windowIsRounded() ? WINDOW_RADIUS : 0);
  raiseControls();
  return view;
}

/** Pages that show a Studio's own data. A Studio that is not connected here has none, so they say so instead of showing another Studio's. */
const STUDIO_PAGES = new Set<Page>(['home', 'dashboard', 'projects', 'notes', 'write', 'market', 'finance']);

function showPage(next: Page): void {
  if (next === 'admin' && !admin.isAdmin()) next = 'home'; // only administrators have the Admin page
  if (!win || win.isDestroyed()) return;
  page = next;
  for (const id of ['write', 'market', 'finance'] as const) views[id]?.setVisible(false);
  if (isModule(next) && !studios.view().connected) {
    win.webContents.focus(); // the page explains; the module's view stays hidden
  } else if (isModule(next)) {
    const v = ensureView(next);
    v.setVisible(true);
    v.webContents.focus();
  } else {
    win.webContents.focus();
  }
  win.webContents.send('shell:page', next);
  settings.update((s) => {
    s.page = next;
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 800,
    minHeight: 500,
    title: 'Cadrel',
    // Windows: a frameless, transparent window, so the corners can be rounded (Windows itself rounds nothing here) and the window
    // buttons can share the border's colour. The shell page draws the outline and `addControls` the buttons. Elsewhere (development
    // only) a normal frame.
    ...(process.platform === 'win32' ? { frame: false, transparent: true, backgroundColor: '#00000000' } : { backgroundColor: shellColor() }),
    icon: iconPath(),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (settings.get().window?.maximized) win.maximize();
  const w = win;
  if (process.platform === 'win32') {
    markOwnChrome(w);
    addControls(w);
    layout();
  }
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  watchWindow(w); // tells the shell's own page about maximise / fullscreen
  w.on('closed', () => {
    for (const k of Object.keys(views) as ModuleId[]) delete views[k];
    if (win === w) win = null;
  });

  // Views do not follow the window by themselves; and Write's title bar needs to hear about maximise too.
  const relayout = () => {
    layout();
    const v = views.write;
    if (v && !v.webContents.isDestroyed()) v.webContents.send('window:state', windowInfo(w));
  };
  w.on('resize', relayout);
  w.on('maximize', relayout);
  w.on('unmaximize', relayout);
  w.on('enter-full-screen', relayout);
  w.on('leave-full-screen', relayout);
  w.on('restore', relayout);
  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(saveWindowState, 800);
  };
  w.on('resize', later);
  w.on('move', later);

  // Closing with unsaved edits in Write: bring Write forward and let it ask.
  let waiting = false;
  let confirmed = false;
  w.on('close', (e) => {
    saveWindowState();
    if (confirmed || !write.hasUnsaved() || w.webContents.isCrashed()) return;
    e.preventDefault();
    if (waiting) return;
    waiting = true;
    showPage('write');
    void write.requestClose().then((ok) => {
      waiting = false;
      if (!ok) installerToRun = null; // the person backed out of closing, so the update in progress is off
      if (ok) {
        confirmed = true;
        w.close();
      }
    });
  });

  w.webContents.once('did-finish-load', () => showPage(settings.get().page));
  void w.loadFile(path.join(here, 'renderer', 'index.html'));
}

// ---- IPC the shell's own page may call ----------------------------------------------------------

async function overview(): Promise<Overview> {
  const [w, m] = await Promise.all([
    write.listProjects().then(summariseWrite, writeUnavailable),
    (async () => {
      const status = market.service.status();
      try {
        return summariseMarket({ status, categories: market.service.categories(), queue: market.service.queue() });
      } catch {
        // No library chosen yet, or it is being rebuilt: the module is up, it just has nothing to show.
        return summariseMarket({ status });
      }
    })().catch(marketUnavailable)
  ]);
  return { write: w, market: m };
}

function registerShellIpc(): void {
  // Only the shell's own page may drive the shell; a module's view must not be able to switch pages or read the other module.
  const fromShell = (e: Electron.IpcMainInvokeEvent) => !!win && e.sender === win.webContents;
  const guard = <A extends unknown[], R>(fn: (...a: A) => R) => (e: Electron.IpcMainInvokeEvent, ...a: A): R => {
    if (!fromShell(e)) throw new Error('not allowed');
    return fn(...a);
  };
  ipcMain.handle('shell:navigate', guard((p: unknown) => {
    if (!isPage(p)) throw new Error('unknown page');
    showPage(p);
  }));
  ipcMain.handle('shell:current', guard(() => page));
  ipcMain.handle('shell:overview', guard(() => overview()));
  // Projects and notes. A broken rule (a duplicate name, a move into itself) is told to the page as a message, not thrown through IPC.
  const studioOp = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) =>
    ipcMain.handle(channel, async (e, ...a: unknown[]) => {
      if (!fromShell(e)) throw new Error('not allowed');
      try {
        return await fn(...(a as A));
      } catch (err) {
        if (err instanceof ProjectError || err instanceof NoteError || (err instanceof Error && /^There is no project/.test(err.message))) return { __error: err.message };
        throw err;
      }
    });
  // Creating and managing projects. Write's own messages (a name Windows will not allow) are meant to be read, so any refusal reaches the page as text.
  const manageOp = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    ipcMain.handle(`shell:manage:${name}`, async (e, ...a: unknown[]) => {
      if (!fromShell(e)) throw new Error('not allowed');
      try {
        return await fn(...(a as A));
      } catch (err) {
        return { __error: err instanceof Error ? err.message : String(err) };
      }
    });
  /** Like manageOp, for any channel name: every refusal reaches the page as text. */
  const manageLike = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    ipcMain.handle(`shell:${name}`, async (e, ...a: unknown[]) => {
      if (!fromShell(e)) throw new Error('not allowed');
      try {
        return await fn(...(a as A));
      } catch (err) {
        return { __error: err instanceof Error ? err.message : String(err) };
      }
    });
  // Studios: anyone can switch; the Studio Manager's changes are for administrators.
  let lastShown = '';
  const studiosChanged = (v: ReturnType<StudioRegistry['view']>) => {
    if (win && !win.isDestroyed()) win.webContents.send('shell:studios', v);
    // A module's view must appear or go away with the Studio; the page needs telling only when that changes.
    const shown = `${v.activeId}:${v.connected}`;
    if (shown !== lastShown) {
      lastShown = shown;
      showPage(page);
    }
    return v;
  };
  const adminOnly = () => {
    if (!admin.isAdmin()) throw new Error('Only an administrator can manage Studios.');
  };
  manageLike('studios:get', async () => studios.view());
  manageLike('studios:setActive', async (id: string) => {
    if (String(id) === studios.view().activeId) return studios.view();
    mustBeIdle();
    const v = studios.setActive(String(id));
    // Switching Studios opens the other Studio's folders from the start, so nothing of this one stays in memory.
    setTimeout(() => void restartApp(), 50);
    return v;
  });
  manageLike('studios:enableManager', async (on: boolean) => (adminOnly(), studiosChanged(studios.enableManager(on === true))));
  manageLike('studios:create', async (name: string) => (adminOnly(), studiosChanged(studios.create(name))));
  manageLike('studios:rename', async (id: string, name: string) => (adminOnly(), studiosChanged(studios.rename(String(id), name))));
  manageLike('studios:remove', async (id: string) => (adminOnly(), studiosChanged(studios.remove(String(id)))));
  // Building and looking after a Studio in the owner's own Cloudflare account, and the people in it.
  manageLike('studios:provision', async (id: string, d: { accountId: string; apiToken: string; keepToken?: boolean }) => {
    adminOnly();
    const { accountId, apiToken } = StudioRegistry.checkCredentials(d);
    const entry = studios.get(String(id));
    if (entry.role !== 'owner' || entry.status === 'local') throw new Error('Only a Studio you created can be built in Cloudflare.');
    if (entry.status === 'provisioning') throw new Error('This Studio is already being built.');
    const secrets = secretsFor(entry.id);
    // The owner's key is made before anything is uploaded and kept, so a build that stops half way is finished with the same key.
    let key = await studioKey(entry.id);
    if (!key) {
      key = await generateKeyPair();
      await secrets.put('studio-key', JSON.stringify(key));
    }
    studiosChanged(studios.update(entry.id, { status: 'provisioning', accountId, note: 'Starting…' }));
    try {
      const built = await buildStudio({ ...cloudflareOptions(), step: (t) => studiosChanged(studios.update(entry.id, { note: t })) }, { accountId, apiToken, studioId: entry.id, ownerKey: key.publicKey, workerSource: await studioWorkerSource() });
      let kept = false;
      let note: string | null = null;
      if (d.keepToken) {
        try {
          await secrets.put('cf-token', apiToken);
          kept = true;
        } catch (e) {
          note = `The Studio is built, but the token was not kept: ${(e as Error).message}`;
        }
      } else await secrets.delete('cf-token');
      return studiosChanged(studios.update(entry.id, { status: 'ready', url: built.url, resources: built.resources, server: built.server, fingerprint: await fingerprintOf(key), tokenKept: kept, note }));
    } catch (e) {
      studiosChanged(studios.update(entry.id, { status: 'error', note: (e as Error).message }));
      throw e;
    }
  });
  manageLike('studios:upgrade', async (id: string, token?: string) => {
    adminOnly();
    const entry = studios.get(String(id));
    const secrets = secretsFor(entry.id);
    const apiToken = (typeof token === 'string' && token.trim()) || (await secrets.get('cf-token'));
    if (!apiToken) throw new Error('Paste your Cloudflare API token to upgrade this Studio (it was not kept on this computer).');
    const key = await studioKey(entry.id);
    if (!key || !entry.accountId) throw new Error('This Studio has no owner key or account here, so it cannot be upgraded from this computer.');
    const built = await upgradeStudio(cloudflareOptions(), { accountId: entry.accountId, apiToken: apiToken.trim(), studioId: entry.id, ownerKey: key.publicKey, workerSource: await studioWorkerSource() }, entry);
    return studiosChanged(studios.update(entry.id, { server: built.server, note: null }));
  });
  manageLike('studios:forgetToken', async (id: string) => {
    adminOnly();
    await secretsFor(String(id)).delete('cf-token');
    return studiosChanged(studios.update(String(id), { tokenKept: false }));
  });
  const clientFor = async (id: string) => {
    const e = studios.get(id);
    const key = await studioKey(id);
    if (e.role !== 'owner' || !e.url || !key) throw new Error('This Studio has not been built yet.');
    return { e, client: new StudioClient({ url: e.url, key, fetchFn: fetch }) };
  };
  manageLike('studios:people', async (id: string) => {
    adminOnly();
    try {
      return { reachable: true, error: null, ...(await (await clientFor(String(id))).client.people()) };
    } catch (e) {
      return { reachable: false, error: (e as Error).message, members: [], invites: [] };
    }
  });
  manageLike('studios:createInvite', async (id: string, i: { role: string; label: string }) => {
    adminOnly();
    const { e, client } = await clientFor(String(id));
    return client.invite(String(i?.role), String(i?.label ?? ''), e.name);
  });
  manageLike('studios:revokeInvite', async (id: string, inviteId: string) => {
    adminOnly();
    const { client } = await clientFor(String(id));
    await client.revokeInvite(String(inviteId));
    return { reachable: true, error: null, ...(await client.people()) };
  });
  manageLike('studios:removeMember', async (id: string, memberId: string) => {
    adminOnly();
    const { client } = await clientFor(String(id));
    await client.removeMember(String(memberId));
    return { reachable: true, error: null, ...(await client.people()) };
  });
  // Joining is for anyone: the person was invited by someone else, and is not an administrator of anything yet.
  manageLike('studios:join', async (link: string, d: { yourName: string; studioName?: string }) => {
    const yourName = String(d?.yourName ?? '').trim();
    if (!yourName) throw new Error('Say what you are called in this Studio.');
    const inv = (await import('@cadrel/kernel')).parseInvitation(String(link));
    if (!inv) throw new Error('That is not a Cadrel invitation link. It starts with cadrel://join');
    const name = (d?.studioName?.trim() || inv.studioName || 'Studio').slice(0, 60);
    studios.checkNewMember(name, inv.url); // before anything is sent: a name clash must not leave a half-joined Studio
    const joined = await joinStudio({ link: String(link), yourName, fetchFn: fetch });
    const before = new Set(studios.view().studios.map((x) => x.id));
    const view = studios.addMember({ name, url: joined.url, fingerprint: joined.fingerprint, memberRole: joined.role, studioId: joined.studioId });
    const added = view.studios.find((x) => !before.has(x.id))!;
    await secretsFor(added.id).put('studio-key', JSON.stringify(joined.key));
    return studiosChanged(view);
  });
  // People and roles. Every change is made by the service as the person using the app, so the page only shows what the service allows.
  manageLike('workflow:state', async () => peopleHost.workflowState());
  manageLike('workflow:call', async (name: string, ...args: unknown[]) => peopleHost.workflowCall(String(name), ...args));
  manageLike('people:state', async () => peopleHost.state());
  manageLike('people:call', async (name: string, ...args: unknown[]) => peopleHost.call(String(name), ...args));
  manageLike('people:effective', async (personId: string, projectId?: string | null) => peopleHost.effective(String(personId), projectId));
  manageLike('people:explain', async (personId: string, capability: string, projectId?: string | null) => peopleHost.explain(String(personId), String(capability), projectId));
  // My Books: one published book across Market and Finance. Finance's figures are decided here, from the person's role, never by the page.
  const roleKey = () => {
    const a = studios.active();
    return a.role === 'owner' ? 'owner' : a.memberRole;
  };
  const financeSeen = () => financeAccess(roleKey());
  const asinOf = (v: unknown) => {
    if (typeof v !== 'string' || !/^[A-Z0-9]{10}$/.test(v)) throw new Error('That is not an ASIN.');
    return v;
  };
  manageLike('mybooks:list', async () => listBooks(market.service, financeSeen()));
  manageLike('mybooks:book', async (asin: string) => bookPage(market.service, asinOf(asin), financeSeen()));
  const saveWhat = (what: 'market' | 'finance' | 'all') => async (asin: string, o?: { months?: number }) => {
    let parent = picked('CADREL_TEST_BOOK_SAVE_TO');
    if (!parent) {
      const r = await dialog.showOpenDialog(win!, { title: 'Choose where to save this book’s files', properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('documents') });
      if (r.canceled || !r.filePaths[0]) return null;
      parent = r.filePaths[0];
    }
    const months = typeof o?.months === 'number' && o.months >= 1 && o.months <= 60 ? Math.floor(o.months) : 12;
    const r = await saveBook(market.service, asinOf(asin), what, financeSeen(), { parent, months, pdf: { statements: (dir, from, to, payees, basis, asin) => finance.writeStatementPdfs(dir, from, to, payees, basis, asin), rollups: (dir, from, to, payees, asin) => finance.writeRollupPdfs(dir, from, to, payees, asin) } });
    if (!TEST) shell.showItemInFolder(r.files[0]!);
    return r;
  };
  manageLike('mybooks:saveMarket', saveWhat('market'));
  manageLike('mybooks:saveFinance', saveWhat('finance'));
  manageLike('mybooks:saveAll', saveWhat('all'));
  /** Shows a module and asks its page to show something. The page subscribes just after it loads, so the first ask can land before it is listening; asking twice is harmless (it opens the same book). */
  const showInModule = async (id: 'market' | 'finance', channel: string, payload: string) => {
    showPage(id);
    const wc = views[id]!.webContents;
    if (wc.isLoading()) await new Promise<void>((r) => wc.once('did-finish-load', () => r()));
    wc.send(channel, payload);
    setTimeout(() => !wc.isDestroyed() && wc.send(channel, payload), 400);
  };
  manageLike('mybooks:openIn', async (module: string, asin: string) => {
    const a = asinOf(asin);
    if (module === 'finance') {
      if (!financeSeen()) throw new Error('Your role does not include Finance.');
      await showInModule('finance', 'finance:navigate', `book:${a}`);
    } else if (module === 'market') await showInModule('market', 'navigate', `book:${a}`);
    else throw new Error('unknown module');
  });
  // The book's Amazon page in the browser (Market's own "Open on Amazon", so only Amazon addresses are ever opened).
  manageLike('mybooks:openOnAmazon', async (asin: string) => market.service.openBook(asinOf(asin)));
  // Backup and import. The pickers are dialogs only the shell can open; under test an environment variable stands in for the person's choice.
  const picked = (name: string) => (TEST ? process.env[name] : undefined);
  const stamp = () => new Date().toISOString().slice(0, 10);
  const schemaNow = Math.max(PROJECT_TREE_VERSION, NOTES_VERSION);
  /** Regenerable or machine-bound things stay out: model downloads, caches, logs. */
  const regenerable = (rel: string) => /(^|\/)(models?|model-cache|cache|logs)(\/|$)/i.test(rel);
  manageLike('backup:make', async (o?: { projects?: string[] }) => {
    const st = studios.active();
    const only = Array.isArray(o?.projects) && o!.projects.length ? o!.projects.map(String) : undefined;
    let file = picked('CADREL_TEST_BACKUP_TO');
    if (!file) {
      const r = await dialog.showSaveDialog(win!, {
        title: 'Back up this Studio',
        defaultPath: path.join(app.getPath('documents'), `${st.name} ${stamp()}${BACKUP_EXTENSION}`),
        filters: [{ name: 'Cadrel backup', extensions: [BACKUP_EXTENSION.slice(1)] }]
      });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    await studio.studio.read(); // settles any write in flight before the folder is read
    await studios.flush();
    const made = await createBackup({
      file, studio: { id: st.id, name: st.name }, appVersion: app.getVersion(), schema: schemaNow,
      sources: [{ name: 'data', dir: studioDir, exclude: regenerable }, { name: 'Projects', dir: projectsFolder(), only }]
    });
    return { file, files: made.files, bytes: made.bytes };
  });
  manageLike('backup:inspect', async () => {
    let file = picked('CADREL_TEST_BACKUP_FROM');
    if (!file) {
      const r = await dialog.showOpenDialog(win!, { title: 'Choose a Cadrel backup', properties: ['openFile'], filters: [{ name: 'Cadrel backup', extensions: [BACKUP_EXTENSION.slice(1)] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    const d = await describeBackup(file);
    return { file, studioName: d.studio.name, created: d.created, app: d.app, projects: d.projects, files: d.entries.length };
  });
  manageLike('backup:restoreProject', async (file: string, project: string, parentId?: string | null) => {
    const r = await restoreProject({ file: String(file), project: String(project), projectsDir: projectsFolder() });
    return { id: await manager.adopt(r.name, parentId ?? null), name: r.name };
  });
  manageLike('backup:restoreAsStudio', async (file: string, name: string) => {
    adminOnly();
    const d = await describeBackup(String(file));
    if (d.schema > schemaNow) throw new Error('That backup is from a newer Cadrel than this one. Update Cadrel to restore it.');
    const before = new Set(studios.view().studios.map((x) => x.id));
    const view = studios.create(String(name));
    const added = view.studios.find((x) => !before.has(x.id))!;
    await studios.flush();
    try {
      await restoreBackup({
        file: String(file), maxSchema: schemaNow,
        targets: { data: path.join(userData, 'studios', added.id), Projects: path.join(cadrelFolder(), added.folderName, 'Projects') }
      });
    } catch (e) {
      // Nothing half-restored is left behind: the folders were empty or missing before, so they are removed whole.
      await Promise.all([path.join(userData, 'studios', added.id), path.join(cadrelFolder(), added.folderName)].map((d) => fsp.rm(d, { recursive: true, force: true })));
      studios.remove(added.id);
      throw e;
    }
    return studiosChanged(studios.view());
  });
  manageLike('backup:findMdedit', async () => {
    let dir = picked('CADREL_TEST_MDEDIT');
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, { title: 'Choose an MDEdit project folder, or the Root Folder that holds your projects', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    const found = await findMdeditProjects(dir);
    if (!found.length) throw new Error('No MDEdit projects were found there. An MDEdit project is a folder with a .mdedit folder inside it.');
    const out = [];
    for (const f of found) {
      const { source, name, asName, status, files, bytes, chapterFiles, hasGoal, reviewFiles, editedMarks, alreadyImportedAs, notCarried } = await previewMdeditImport(f, projectsFolder());
      out.push({ source, name, asName, status, files, bytes, chapterFiles, hasGoal, reviewFiles, editedMarks, alreadyImportedAs, notCarried });
    }
    return out;
  });
  manageLike('backup:importMdedit', async (source: string, o?: { asNewCopy?: boolean; parentId?: string | null }) => {
    const r = await importMdeditProject({ source: String(source), projectsDir: projectsFolder(), asNewCopy: o?.asNewCopy === true });
    return { id: await manager.adopt(r.name, o?.parentId ?? null), name: r.name };
  });
  manageOp('templates', async () => admin.templates().map((t) => ({ id: t.id, name: t.name, description: t.description })));
  manageOp('create', (o: Parameters<ProjectManager['create']>[0]) => manager.create(o));
  manageOp('addManuscript', (id: string, template: string) => manager.addManuscript(id, template));
  manageOp('rename', (id: string, name: string) => manager.rename(id, name));
  manageOp('archive', (id: string, archived: boolean) => manager.archive(id, archived === true));
  manageOp('remove', (id: string) => manager.remove(id));
  manageOp('duplicate', (id: string) => manager.duplicate(id));
  manageOp('manuscript', (id: string) => manager.manuscript(id));
  manageOp('setManuscript', (id: string, patch: { status?: string; notes?: string }) => manager.setManuscript(id, patch ?? {}));
  manageOp('addMissingParts', (id: string) => manager.addMissingParts(id));
  manageOp('open', async (id: string) => {
    await manager.open(id);
    showPage('write');
  });
  manageOp('reveal', async (id: string) => {
    const m = await manager.manuscript(id);
    if (!m) throw new Error('That project has no manuscript folder.');
    if (!TEST) shell.showItemInFolder(m.folder);
  });
  manageOp('unfiled', () => manager.unfiled());
  manageOp('adopt', (name: string, parentId?: string | null) => manager.adopt(name, parentId));
  studioOp('studio:state', () => studio.state());
  studioOp('studio:createProject', async (o: Parameters<StudioService['createProject']>[0]) => ({ id: (await studio.createProject(o)).id }));
  studioOp('studio:updateProject', (id: string, c: { name?: string; kind?: string }) => studio.updateProject(id, c));
  studioOp('studio:moveProject', (id: string, parent: string | null, index?: number) => studio.moveProject(id, parent, index));
  studioOp('studio:archiveProject', (id: string, archived: boolean) => studio.archiveProject(id, archived));
  studioOp('studio:deleteProject', (id: string, cascade: boolean) => studio.deleteProject(id, cascade));
  studioOp('studio:link', (id: string, module: string, ref: string) => studio.link(id, module, ref));
  studioOp('studio:unlink', (module: string, ref: string) => studio.unlink(module, ref));
  studioOp('studio:addNote', async (o: Parameters<StudioService['addNote']>[0]) => ({ id: (await studio.addNote(o)).id }));
  studioOp('studio:setNoteStatus', (id: string, status: Parameters<StudioService['setNoteStatus']>[1]) => studio.setNoteStatus(id, status));
  studioOp('studio:replyToNote', (id: string, body: string) => studio.replyToNote(id, body));
  studioOp('studio:deleteNote', (id: string) => studio.deleteNote(id));
  // Notes on Market's records, asked for by Market's own page. The module is decided here from who is asking, never taken from the
  // page, and a page can only change notes that are on its own records.
  const fromMarket = (e: Electron.IpcMainInvokeEvent) => !!views.market && e.sender === views.market.webContents;
  const hostNotes = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R> | R) =>
    ipcMain.handle(`host:notes:${name}`, async (e, ...a: unknown[]) => {
      if (!fromMarket(e)) throw new Error('not allowed');
      return fn(...(a as A));
    });
  const rec = (v: unknown): { kind: string; id: string } => {
    const r = v as { kind?: unknown; id?: unknown };
    if (typeof r?.kind !== 'string' || typeof r.id !== 'string' || !r.kind || !r.id) throw new Error('bad record');
    return { kind: r.kind, id: r.id };
  };
  hostNotes('available', () => true);
  hostNotes('list', (r: unknown) => studio.recordNotes('market', rec(r).kind, rec(r).id));
  hostNotes('add', async (o: { kind: string; id: string; label: string; body: string; category?: string }) => ({ id: (await studio.addRecordNote({ module: 'market', ...rec(o), label: String(o.label ?? ''), body: o.body, category: o.category })).id }));
  hostNotes('status', async (id: string, status: Parameters<StudioService['setNoteStatus']>[1]) => (await studio.ownedBy('market', id), studio.setNoteStatus(id, status)));
  hostNotes('reply', async (id: string, body: string) => (await studio.ownedBy('market', id), studio.replyToNote(id, body)));
  hostNotes('remove', async (id: string) => (await studio.ownedBy('market', id), studio.deleteNote(id)));
  ipcMain.handle('shell:theme:get', guard(() => themeState()));
  ipcMain.handle('shell:theme:set', guard((change: { source?: ThemeSource; custom?: ThemeCustom | null }) => setTheme(change ?? {})));
  // The user: profile and attached files. A rule that was broken ("that is not an email") reaches the page as a message.
  const userOp = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) =>
    ipcMain.handle(channel, async (e, ...a: unknown[]) => {
      if (!fromShell(e)) throw new Error('not allowed');
      try {
        return await fn(...(a as A));
      } catch (err) {
        if (err instanceof UserError) return { __error: err.message };
        throw err;
      }
    });
  /** After a change: tell the page (so the rail's photo and the name update everywhere) and give the view back. */
  const changed = async (): Promise<UserView> => {
    const v = await userView();
    win?.webContents.send('shell:user', v);
    return v;
  };
  userOp('shell:user:get', userView);
  userOp('shell:user:update', async (patch: Parameters<UserStore['update']>[0]) => (await users.update(patch ?? {}), changed()));
  userOp('shell:user:attach', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Attach files to your profile', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || r.filePaths.length === 0) return null;
    return attachAll(r.filePaths);
  });
  userOp('shell:user:attachPaths', async (paths: unknown) => attachAll(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []));
  userOp('shell:user:editAttachment', async (id: string, patch: { note?: string; name?: string; assistant?: boolean }) => (await users.editAttachment(id, patch ?? {}), changed()));
  userOp('shell:user:chooseAvatar', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose your photo', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    // The picture is kept with the person's files like any other, and is also their photo.
    const a = await users.attach(r.filePaths[0], 'My photo');
    await users.setAvatar(a.id);
    return changed();
  });
  userOp('shell:user:download', async (id: string) => {
    const p = await users.pathOf(id);
    const a = (await users.read()).attachments.find((x) => x.id === id);
    if (!p || !a) throw new UserError('That file is not there any more.');
    const r = await dialog.showSaveDialog(win!, { title: 'Save a copy', defaultPath: path.join(app.getPath('downloads'), a.name) });
    if (r.canceled || !r.filePath) return false;
    await fsp.copyFile(p, r.filePath);
    return true;
  });
  userOp('shell:user:removeAttachment', async (id: string) => (await users.removeAttachment(id), changed()));
  userOp('shell:user:setAvatar', async (id: string | null) => (await users.setAvatar(id ?? null), changed()));
  userOp('shell:user:open', async (id: string) => {
    const p = await users.pathOf(id);
    if (!p) throw new UserError('That file is not there any more.');
    const name = (await users.read()).attachments.find((a) => a.id === id)!.name;
    // Opened from a copy named as the person knows it, so the program shows a sensible title and picks the right app by extension.
    const dir = path.join(app.getPath('temp'), 'cadrel-open', id);
    await fsp.mkdir(dir, { recursive: true });
    const copy = path.join(dir, name);
    await fsp.copyFile(p, copy);
    const err = await shell.openPath(copy);
    if (err) throw new UserError(`Could not open it: ${err}`);
  });
  userOp('shell:user:reveal', async (id: string) => {
    const p = await users.pathOf(id);
    if (!p) throw new UserError('That file is not there any more.');
    shell.showItemInFolder(p);
  });
  userOp('shell:user:avatar', async () => {
    const u = await users.read();
    const p = u.avatarId ? await users.pathOf(u.avatarId) : null;
    if (!p) return null;
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img.resize({ width: 128, quality: 'best' }).toDataURL();
  });
  ipcMain.handle('shell:prefs:folders', guard(() => folders()));
  const isKey = (k: unknown): k is FolderKey => k === 'cadrel' || k === 'projects' || k === 'write' || k === 'market';
  const TITLES: Record<FolderKey, string> = { cadrel: 'Choose where the Cadrel folder goes', projects: 'Choose where your project folders go', write: 'Choose Write’s own folder', market: 'Choose where Market’s library goes' };
  const CURRENT = (k: FolderKey) => (k === 'cadrel' ? cadrelFolder() : k === 'projects' ? projectsFolder() : k === 'write' ? writeFolder() : market.service.status().libraryRoot ?? marketDefault());
  ipcMain.handle('shell:prefs:choose', guard(async (which: unknown) => {
    if (!isKey(which)) throw new Error('unknown folder');
    const r = await dialog.showOpenDialog(win!, { title: TITLES[which], properties: ['openDirectory', 'createDirectory'], defaultPath: path.dirname(CURRENT(which)) });
    if (r.canceled || !r.filePaths[0]) return null;
    const picked = path.resolve(r.filePaths[0]);
    // The Cadrel folder is the one the person points at, or a Cadrel folder inside what they picked; the others are used exactly as chosen.
    return moveFolder(which, which === 'cadrel' ? (path.basename(picked).toLowerCase() === 'cadrel' ? picked : path.join(picked, 'Cadrel')) : picked);
  }));
  ipcMain.handle('shell:prefs:restart', guard(() => restartApp()));
  ipcMain.handle('shell:prefs:reset', guard((which: unknown) => {
    if (!isKey(which)) throw new Error('unknown folder');
    return moveFolder(which, null);
  }));
  // Administration. Anyone can read the templates (making a project needs them); changing them is refused to anyone who is not an administrator.
  const roleNow = (): Role => studioRole();
  const adminView = () => ({ isAdmin: admin.isAdmin(), role: roleNow(), templates: admin.get().templates, defaultTemplateId: admin.get().defaultTemplateId });
  manageLike('admin:get', async () => adminView());
  manageLike('admin:save', async (change: { templates: unknown; defaultTemplateId: string }) => {
    await admin.save(change ?? { templates: [], defaultTemplateId: '' });
    return adminView();
  });
  manageLike('admin:fonts', async () => {
    const { listInstalledFonts } = await import('@cadrel/write/electron/fonts');
    return listInstalledFonts();
  });
  manageLike('admin:fontPreview', async (family: string) => write.fontPreview(String(family)));
  // AI assistants: one server for Write and Market, files to download, and the online door for ChatGPT.
  manageLike('assistants:get', async () => {
    const server = await write.ai.server();
    const snippets = market.service.mcpConfig();
    return { available: !!server, projectsFolder: projectsFolder(), claudeDesktop: snippets.claudeDesktop, claudeCode: snippets.claudeCode, codex: snippets.codex, remote: server ? await write.ai.remote.status() : null };
  });
  manageLike('assistants:saveKit', () => write.ai.saveKit());
  manageLike('assistants:saveExtension', async () => {
    const { file } = await market.service.buildClaudeExtension();
    const dest = path.join(app.getPath('downloads'), path.basename(file));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(file, dest);
    if (!TEST) shell.showItemInFolder(dest);
    return dest;
  });
  manageLike('assistants:saveChromeExtension', async () => {
    const src = path.join(resourcesDir(), 'cadrel-market-extension.zip');
    const dest = path.join(app.getPath('downloads'), path.basename(src));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    if (!TEST) shell.showItemInFolder(dest);
    return dest;
  });
  manageLike('assistants:setRemote', (on: boolean) => write.ai.remote.setEnabled(on === true));
  manageLike('assistants:resetRemoteToken', () => write.ai.remote.resetToken());
  // Market's capture server: a retry after whatever was holding the port (another app, an earlier run) lets go of it.
  manageLike('market:reconnect', () => market.service.reconnect());
  // A deliberate stop, so the port is free right away without waiting on a reconnect retry.
  manageLike('market:forceDisconnect', () => market.service.forceDisconnect());
  // Quits whatever program is holding the port (an old build still running, say), then starts the server.
  manageLike('market:freePort', () => market.service.freePort());
  // Updating.
  manageLike('update:check', () => updater.check());
  manageLike('update:last', async () => updater.last());
  manageLike('update:install', () => updater.install());
  ipcMain.handle('shell:info', guard(() => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform })));
}

// ---- startup ------------------------------------------------------------------------------------

if (!TEST && !smokeArg && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    if (!write) return;
    const file = fileFromArgv(argv.slice(1), cwd);
    if (file) {
      write.queueFile(file);
      showPage('write');
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (smokeArg) {
      app.exit(await runShellSmoke(smokeArg.slice('--smoke-test='.length), here));
      return;
    }
    Menu.setApplicationMenu(null); // the default menu has View > Reload, which would silently discard unsaved edits
    settings = new SettingsStore(path.join(app.getPath('userData'), 'shell.json'));
    await settings.load();
    nativeTheme.themeSource = settings.get().theme ?? 'system';
    studios = new StudioRegistry(path.join(userData, 'studios.json'));
    await studios.load();
    await applyPendingCadrelMove();
    // Which Studio this run belongs to is settled now, before anything is opened.
    studioDir = path.join(userData, 'studios', studios.active().id);
    await fsp.mkdir(studioDir, { recursive: true });
    studioSettings = new SettingsStore(path.join(studioDir, 'settings.json'));
    await studioSettings.load();
    admin = new AdminStore(path.join(studioDir, 'admin.json'), studioRole);
    await admin.load();
    await ensureFolders();
    updater = new Updater({
      version: TEST && process.env.CADREL_TEST_VERSION ? process.env.CADREL_TEST_VERSION : app.getVersion(),
      platform: process.platform,
      fetchFn: TEST && process.env.CADREL_TEST_RELEASES ? fakeReleases(process.env.CADREL_TEST_RELEASES) : fetch,
      dir: path.join(os.tmpdir(), 'cadrel-update'),
      log: updateLog,
      onProgress: (p) => win?.webContents.send('shell:update:progress', p),
      // Quitting goes through the usual unsaved-changes prompt in Write; if that is cancelled the installer is dropped (see win 'close').
      runAfterQuit: (file) => {
        installerToRun = file;
        app.quit();
      }
    });
    users = new UserStore(path.join(studioDir, 'user'));
    await refreshUser();
    // The Studio's people and roles: a Studio this person owns starts with its default roles and them as Owner.
    {
      const here = studios.active();
      await peopleHost.open({ file: path.join(studioDir, 'records.db'), studioId: here.id, owned: here.role === 'owner', ownerName: userCache?.displayName || os.userInfo().username });
    }
    // The name used to be a setting; it belongs to the profile now.
    const legacy = settings.get().author?.trim();
    if (legacy) {
      if (!userCache?.displayName) await users.update({ displayName: legacy });
      settings.update((s) => {
        delete s.author;
      });
      await refreshUser();
    }
    studio = new StudioService({
      file: studioFile(),
      author: authorName,
      writeRoot: async () => {
        const l = await write.listProjects();
        return l.exists ? l.root : null;
      },
      fs: nodeFs
    });
    manager = new ProjectManager(studio, writeFolders());

    write = await createWriteModule({
      getWindow: () => win,
      getContents: () => views.write?.webContents ?? null,
      standalone: false,
      defaultRoot: projectsDefault,
      projectsFolder,
      templates: () => admin.templates(),
      theme: { get: themeState, set: setTheme },
      dataDir: writeData(),
      assetsDir: path.join(here, 'assets'),
      // One AI server for the whole suite, started with Cadrel's own runtime; the Claude Desktop extension holds a launcher for it.
      mcp: { file: mcpFile(), kitServer: kitLauncher, brand: KIT_BRAND, extraArgs: () => ['--studio', studioFile(), ...(market.service.status().libraryRoot ? ['--library', market.service.status().libraryRoot!] : [])] },
      updatesDisabledReason: 'Cadrel is updated as a whole; Cadrel Write’s own updater is switched off here.'
    });
    market = createMarketModule({
      getWindow: () => win,
      getContents: () => views.market?.webContents ?? null,
      dataDir: marketData(),
      codeDir: here,
      resourcesDir: resourcesDir(),
      iconFile: iconPath,
      version: app.getVersion(),
      willQuit: () => {
        quitting = true;
      },
      defaultLibrary: marketDefault,
      mcpLaunch,
      mcpBrand: CADREL_MCP,
      updatesDisabledReason: 'Cadrel is updated as a whole; Cadrel Market’s own updater is switched off here.'
    });
    await market.start();
    // Finance reads and writes the money side of the same library. It is told when a capture arrives so its figures reload.
    finance = createFinanceModule({ getWindow: () => win, getContents: () => views.finance?.webContents ?? null, service: market.service });
    finance.start();
    market.service.onCapture(() => finance.notify());
    registerShellIpc();
    watchForUpdates();

    const launchFile = fileFromArgv(process.argv.slice(1), process.cwd());
    if (launchFile) {
      write.queueFile(launchFile);
      settings.update((s) => {
        s.page = 'write';
      });
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((e) => {
    // Never fail silently: a startup error would otherwise leave a running process with no window.
    console.error('Cadrel failed to start:', e);
    app.exit(1);
  });
}

let finalSyncStarted = false;
let marketStopped = false;
app.on('before-quit', (e) => {
  quitting = true;
  void write?.flush();
  void settings?.flush();
  void peopleHost.close();
  write?.stop();
  // Close Market's capture server first and wait for it, so port 47321 is released before this process goes and the next start never finds it taken.
  if (!marketStopped && market) {
    marketStopped = true;
    e.preventDefault();
    void Promise.race([market.stop().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => app.quit());
    return;
  }
  // Edits made in the last few seconds haven't synced to Google Drive yet: give them one pass (at most 10 s) before exiting.
  const sync = write?.syncService();
  if (!smokeArg && !finalSyncStarted && sync?.dirty) {
    finalSyncStarted = true;
    e.preventDefault();
    void Promise.race([sync.syncNow(), new Promise((resolve) => setTimeout(resolve, 10_000))]).finally(() => app.quit());
  }
});

app.on('quit', () => {
  if (!installerToRun) return;
  updateLog(`starting ${installerToRun}`);
  // Started the way a double-click starts it, through the shell: started directly it has failed its own integrity check now and then.
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [installerToRun]] : [installerToRun, []];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', (e) => updateLog(`start failed: ${e.message}`)).unref();
});

app.on('window-all-closed', () => {
  if (smokeArg) return; // the smoke test's hidden PDF windows come and go; it exits the app itself
  void Promise.all([market?.stop(), write?.flush(), settings?.flush()]).finally(() => app.quit());
});
