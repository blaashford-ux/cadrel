import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sanitizeThemeCustom, type ThemeCustom } from '@cadrel/write/src/shared/theme';
import { isPage, type Page } from '../shared/api';
import { isThemeSource, type ThemeSource } from '../shared/theme';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface ShellSettings {
  window?: WindowState;
  page: Page;
  /** Who notes written in the app are by; empty means the Windows user name. */
  author?: string;
  /** Where Cadrel keeps its working folders (Write, Market). Absent means the default: a Cadrel folder in the person's home folder. */
  cadrelFolder?: string;
  /** A Projects folder of the person's own, instead of <Cadrel folder>/Projects. */
  projectsFolder?: string;
  /** Write's own folder, if the person placed it, instead of <Cadrel folder>/Write. */
  writeFolder?: string;
  /** A move of the Cadrel folder, carried out at the next start (to: null means back to the default). */
  pendingCadrelMove?: { to: string | null };
  /** What this person is in the studio. A one-person studio is its Owner; the server (vault) will say otherwise for others. */
  role?: 'owner' | 'admin' | 'member';
  /** Light, dark or follow Windows. Applies to the whole app. */
  theme?: ThemeSource;
  /** Colours the user changed; the rest stay as shipped. */
  themeCustom?: ThemeCustom;
  /** The Project and Book this Studio was last showing (a request: it is checked against the Studio's projects every time it is used). */
  scope?: { project: string | null; book: string | null; showClosed?: boolean };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads whatever is on disk defensively: a damaged or hand-edited file must never stop the app starting. */
export function sanitizeSettings(raw: unknown): ShellSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ShellSettings = { page: isPage(r.page) ? r.page : 'home' };
  if (typeof r.author === 'string' && r.author.trim()) out.author = r.author.trim().slice(0, 80);
  if (typeof r.cadrelFolder === 'string' && path.isAbsolute(r.cadrelFolder)) out.cadrelFolder = r.cadrelFolder;
  if (typeof r.projectsFolder === 'string' && path.isAbsolute(r.projectsFolder)) out.projectsFolder = r.projectsFolder;
  if (typeof r.writeFolder === 'string' && path.isAbsolute(r.writeFolder)) out.writeFolder = r.writeFolder;
  const pm = r.pendingCadrelMove as { to?: unknown } | undefined;
  if (pm && typeof pm === 'object' && (pm.to === null || (typeof pm.to === 'string' && path.isAbsolute(pm.to)))) out.pendingCadrelMove = { to: pm.to };
  if (r.role === 'admin' || r.role === 'member') out.role = r.role;
  if (isThemeSource(r.theme) && r.theme !== 'system') out.theme = r.theme;
  const sc = r.scope as { project?: unknown; book?: unknown; showClosed?: unknown } | undefined;
  if (sc && typeof sc === 'object') {
    const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : null);
    out.scope = { project: id(sc.project), book: id(sc.book), ...(sc.showClosed === true ? { showClosed: true } : {}) };
  }
  const custom = sanitizeThemeCustom(r.themeCustom);
  if (custom) out.themeCustom = custom;
  const w = r.window as Record<string, unknown> | undefined;
  if (w && finite(w.width) && finite(w.height) && w.width >= 200 && w.height >= 200) {
    out.window = { width: Math.round(w.width), height: Math.round(w.height) };
    if (finite(w.x) && finite(w.y)) {
      out.window.x = Math.round(w.x);
      out.window.y = Math.round(w.y);
    }
    if (w.maximized === true) out.window.maximized = true;
  }
  return out;
}

/** A small JSON file, written atomically so a crash mid-write cannot corrupt it. */
export class SettingsStore {
  private data: ShellSettings = { page: 'home' };
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.data = sanitizeSettings(JSON.parse(await fsp.readFile(this.file, 'utf8')));
    } catch {
      this.data = { page: 'home' };
    }
  }

  get(): ShellSettings {
    return this.data;
  }

  update(change: (s: ShellSettings) => void): void {
    change(this.data);
    const snapshot = JSON.stringify(this.data, null, 2);
    this.pending = this.pending.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, this.file);
    }).catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
