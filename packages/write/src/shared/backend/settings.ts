import type { Prefs, Session, ThemeSource } from '../api';
import { defaultAppDefaults, sanitizeAppDefaults, type AppDefaults } from '../appDefaults';
import type { FsPort } from '../fsPort';
import { defaultProjectsSettings, sanitizeProjectsSettings, type ProjectsSettings } from '../projects';
import { sanitizeThemeCustom } from '../theme';
import { makeFiles } from './files';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface Settings {
  lastFolder?: string;
  theme?: ThemeSource;
  window?: WindowState;
  prefs?: Prefs;
  /** Chapter heading level and the new-book template (File → Settings). */
  appDefaults?: AppDefaults;
  /** Root Folder, project templates and related options. */
  projects?: ProjectsSettings;
  /** Open tabs etc., per folder, so switching back to a folder restores it. */
  sessions?: Record<string, Session>;
}

const MAX_SESSIONS = 20;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeSession(v: unknown): Session | null {
  if (!isObj(v) || !Array.isArray(v.tabs) || !Array.isArray(v.expanded)) return null;
  const tabs = v.tabs
    .filter(isObj)
    .filter((t) => typeof t.file === 'string' && isNum(t.chapter))
    .map((t) => ({
      file: t.file as string,
      chapter: Math.max(0, Math.floor(t.chapter as number)),
      mode: t.mode === 'source' ? ('source' as const) : ('visual' as const)
    }));
  return {
    tabs,
    active: typeof v.active === 'string' ? v.active : null,
    expanded: v.expanded.filter((e): e is string => typeof e === 'string')
  };
}

/** Defensive parse: corrupt or hand-edited settings never crash the app. */
export function sanitizeSettings(data: unknown): Settings {
  const out: Settings = {};
  if (!isObj(data)) return out;
  if (typeof data.lastFolder === 'string') out.lastFolder = data.lastFolder;
  if (data.theme === 'system' || data.theme === 'light' || data.theme === 'dark') out.theme = data.theme;
  if (isObj(data.window) && isNum(data.window.width) && isNum(data.window.height)) {
    const w = data.window;
    out.window = {
      width: w.width as number,
      height: w.height as number,
      ...(isNum(w.x) && isNum(w.y) ? { x: w.x, y: w.y } : {}),
      ...(w.maximized === true ? { maximized: true } : {})
    };
  }
  if (isObj(data.prefs)) {
    const themeCustom = sanitizeThemeCustom(data.prefs.themeCustom);
    if (isNum(data.prefs.sidebarWidth) || themeCustom) out.prefs = { ...(isNum(data.prefs.sidebarWidth) ? { sidebarWidth: data.prefs.sidebarWidth } : {}), ...(themeCustom ? { themeCustom } : {}) };
  }
  if (isObj(data.appDefaults)) out.appDefaults = sanitizeAppDefaults(data.appDefaults);
  if (isObj(data.projects)) out.projects = sanitizeProjectsSettings(data.projects);
  if (isObj(data.sessions)) {
    const sessions: Record<string, Session> = {};
    for (const [folder, raw] of Object.entries(data.sessions)) {
      const s = sanitizeSession(raw);
      if (s) sessions[folder] = s;
    }
    out.sessions = sessions;
  }
  return out;
}

/** In-memory settings with serialized, coalesced writes (no lost updates, no torn files). */
export class SettingsStore {
  private data: Settings = {};
  private pending = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly writeFileAtomic: ReturnType<typeof makeFiles>['writeFileAtomic'];

  constructor(private readonly file: string, private readonly fs: FsPort) {
    this.writeFileAtomic = makeFiles(fs).writeFileAtomic;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await this.fs.readText(this.file));
      this.data = sanitizeSettings(raw);
      // tidy old key names / dropped keys in the saved defaults the first time they are read
      if (raw && typeof raw === 'object' && raw.appDefaults && JSON.stringify(raw.appDefaults) !== JSON.stringify(this.data.appDefaults)) this.schedule();
    } catch {
      this.data = {};
    }
  }

  get(): Readonly<Settings> {
    return this.data;
  }

  projects(): ProjectsSettings {
    return this.data.projects ?? defaultProjectsSettings();
  }

  appDefaults(): AppDefaults {
    return this.data.appDefaults ?? defaultAppDefaults();
  }

  update(change: (s: Settings) => void): void {
    change(this.data);
    this.schedule();
  }

  setSession(folder: string, session: Session): void {
    this.update((s) => {
      const sessions = { ...(s.sessions ?? {}) };
      delete sessions[folder]; // re-insert so the most recently used folder is last
      sessions[folder] = session;
      const keys = Object.keys(sessions);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete sessions[k];
      s.sessions = sessions;
    });
  }

  /** Resolves once everything scheduled so far is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    this.writing = this.writing.then(async () => {
      this.pending = false;
      try {
        await this.writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
      } catch {
        // settings are best-effort
      }
    });
  }
}

/** The remembered folder, but only if it still exists and is a directory. */
export async function existingFolder(fs: FsPort, folder: string | undefined): Promise<string | null> {
  if (!folder) return null;
  try {
    return (await fs.stat(folder))?.isDirectory ? folder : null;
  } catch {
    return null;
  }
}
