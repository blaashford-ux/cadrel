/** What the shell's own page (rail, Home, Dashboard) can ask of the shell. Write and Market keep their own bridges. */

/** The places the rail can go. Home and Dashboard are drawn by the shell; the rest are modules in their own views. */
export const PAGES = ['home', 'dashboard', 'write', 'market'] as const;
export type Page = (typeof PAGES)[number];
export type ModuleId = Extract<Page, 'write' | 'market'>;
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

export interface ShellInfo {
  version: string;
  electron: string;
  platform: string;
}

export interface CadrelApi {
  navigate(page: Page): Promise<void>;
  current(): Promise<Page>;
  onPage(cb: (page: Page) => void): () => void;
  overview(): Promise<Overview>;
  info(): Promise<ShellInfo>;
  windowInfo(): Promise<WindowInfo>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onWindowState(cb: (info: WindowInfo) => void): () => void;
}
