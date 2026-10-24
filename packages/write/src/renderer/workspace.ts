import type { DirNode, DraftRecord, EditorMode, FileStamp, MdeditApi, Session } from '../shared/api';
import {
  chapterBody,
  clampLevel,
  deleteChapter as deleteChapterIn,
  insertChapter,
  joinChapters,
  mapChapters,
  moveChapter as moveChapterIn,
  splitChapters,
  updateChapter,
  type MarkdownDoc
} from '../shared/chapters';
import type { AppDefaults } from '../shared/appDefaults';
import { compileFind, replaceAllInText, type FindOptions } from '../shared/find';
import type { Progress } from '../shared/progress';
import { relativeTo, type ProjectMeta } from '../shared/projects';
import { basename, dirname, isInside, remapPath } from '../shared/paths';
import { collectFiles, collectOrphans, flattenPaths } from '../shared/tree';

export type Conflict = { kind: 'changed'; text: string; stamp: FileStamp } | { kind: 'missing' };

export interface Tab {
  id: string;
  file: string;
  chapter: number;
  mode: EditorMode;
  /** Unsaved editor output for the open chapter, or null when it matches what is on disk. */
  draft: string | null;
  /** Set after each successful save so the editor can reset its "clean" baseline. */
  saved: { version: number; markdown: string } | null;
  /** Bumped to remount the editor when its content is replaced from outside. */
  reloadKey: number;
  conflict: Conflict | null;
  /** When the current draft was last autosaved for crash recovery. */
  autosavedAt: number | null;
}

export interface WorkspaceState {
  root: DirNode | null;
  expanded: Set<string>;
  docs: Map<string, MarkdownDoc>;
  tabs: Tab[];
  activeId: string | null;
  error: string | null;
  notice: string | null;
  refreshing: boolean;
  sidebarWidth: number;
  /** The heading level that starts a chapter (File → Settings). */
  chapterLevel: number;
  /** Labels of the actions Undo Last Action would reverse, oldest first (at most UNDO_DEPTH). */
  undoLabels: string[];
  /** The open folder is a project (it carries `.mdedit/project.json`). */
  project: { path: string; meta: ProjectMeta } | null;
  /** The open project's word total and day-by-day history (null until counted). */
  progress: { progress: Progress; total: number; manuscript: string | null } | null;
  /** Labels of undone actions Redo would re-apply, oldest first. */
  redoLabels: string[];
}

/** How many structural actions (delete / move / add chapter, whole-file replace) can be undone. */
export const UNDO_DEPTH = 5;

interface UndoEntry {
  label: string;
  file: string;
  /** The whole file's text before and after the action. */
  before: string;
  after: string;
  chapterBefore: number | null;
  chapterAfter: number | null;
}

export interface WorkspaceOptions {
  /** Delay before unsaved edits are autosaved for crash recovery. */
  draftDelayMs?: number;
  /** Delay before the open-tabs layout is persisted. */
  sessionDelayMs?: number;
}

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 640;
export const SIDEBAR_DEFAULT = 300;

const sameStamp = (a: FileStamp, b: FileStamp) => a.mtimeMs === b.mtimeMs && a.size === b.size;
const stripExt = (name: string) => name.replace(/\.(md|markdown)$/i, '');

/**
 * All document state and logic: the folder tree, open tabs (one per file), unsaved drafts,
 * conflicts with outside changes, structural edits, and persistence. Framework-free so it can be
 * tested against a fake API; React just subscribes to it.
 */
export class Workspace {
  private state: WorkspaceState = {
    root: null,
    expanded: new Set(),
    docs: new Map(),
    tabs: [],
    activeId: null,
    error: null,
    notice: null,
    refreshing: false,
    sidebarWidth: SIDEBAR_DEFAULT,
    chapterLevel: 1,
    undoLabels: [],
    redoLabels: [],
    project: null,
    progress: null
  };
  private appLevel = 1;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private listeners = new Set<() => void>();
  private stamps = new Map<string, FileStamp>();
  private nextId = 1;
  private saving = new Set<string>();
  private checking = new Set<string>();
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private draftsOnDisk = new Set<string>();
  private sessionTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSession = '';
  private lastDirty = '';
  private readonly draftDelay: number;
  private readonly sessionDelay: number;

  constructor(
    private readonly api: MdeditApi,
    opts: WorkspaceOptions = {}
  ) {
    this.draftDelay = opts.draftDelayMs ?? 1000;
    this.sessionDelay = opts.sessionDelayMs ?? 500;
  }

  // ---- store plumbing -------------------------------------------------------------------

  getState = (): WorkspaceState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    this.afterChange();
    this.listeners.forEach((l) => l());
  }

  private afterChange(): void {
    const dirty = this.state.tabs.filter((t) => t.draft !== null).map((t) => basename(t.file));
    const key = dirty.join('\u0000');
    if (key !== this.lastDirty) {
      this.lastDirty = key;
      this.api.setDirtyFiles(dirty);
    }
    this.scheduleSession();
  }

  tab(id: string | null): Tab | undefined {
    return id ? this.state.tabs.find((t) => t.id === id) : undefined;
  }
  activeTab(): Tab | undefined {
    return this.tab(this.state.activeId);
  }
  tabForFile(file: string): Tab | undefined {
    return this.state.tabs.find((t) => t.file === file);
  }
  private patchTab(id: string, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)): void {
    this.set({
      tabs: this.state.tabs.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t))
    });
  }
  /** Splits text into chapters at the configured heading level. */
  private split(text: string): MarkdownDoc {
    return splitChapters(text, this.state.chapterLevel);
  }
  private setDoc(file: string, doc: MarkdownDoc): void {
    this.set({ docs: new Map(this.state.docs).set(file, doc) });
  }

  private publishUndo(): void {
    this.set({ undoLabels: this.undoStack.map((e) => e.label), redoLabels: this.redoStack.map((e) => e.label) });
  }
  private clearUndo(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.publishUndo();
  }

  setError(message: string | null): void {
    this.set({ error: message });
  }
  dismissNotice(): void {
    this.set({ notice: null });
  }

  setSidebarWidth(width: number, persist: boolean): void {
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
    this.set({ sidebarWidth: w });
    if (persist) this.api.setPrefs({ sidebarWidth: w });
  }

  // ---- settings ---------------------------------------------------------------------------

  /**
   * Saves the app defaults. Changing the chapter heading level re-splits every open file, so any
   * unsaved edits are resolved first (Save / Don't Save / Cancel); cancelling changes nothing.
   * Open tabs stay on the same spot in the text.
   */
  async applyAppDefaults(next: AppDefaults): Promise<boolean> {
    const level = clampLevel(next.chapterLevel);
    const effective = this.effectiveLevel(level);
    const changed = effective !== this.state.chapterLevel;
    if (changed && !(await this.resolveDirtyTabs())) return false;
    try {
      await this.api.setAppDefaults({ ...next, chapterLevel: level });
    } catch (e) {
      this.set({ error: `Could not save settings: ${e instanceof Error ? e.message : e}` });
      return false;
    }
    this.appLevel = level;
    if (changed) this.resplitAll(effective);
    return true;
  }

  /** The chapter heading level in force: the open project's own, if it has one, else the app's. */
  private effectiveLevel(appLevel = this.appLevel, project: { meta: ProjectMeta } | null = this.state.project): number {
    return clampLevel(project?.meta.overrides.chapterLevel ?? appLevel);
  }

  /** Re-splits every open file at `level` and keeps each tab on the same text. */
  private resplitAll(level: number): void {
    const old = this.state.docs;
    this.state = { ...this.state, chapterLevel: level };
    const docs = new Map<string, MarkdownDoc>();
    const startOf = (doc: MarkdownDoc, index: number) => doc.chapters.slice(0, index).reduce((n, c) => n + c.raw.length, 0);
    const moved = new Map<string, number>();
    for (const [file, doc] of old) {
      const text = joinChapters(doc);
      const fresh = this.split(text);
      docs.set(file, fresh);
      const tab = this.tabForFile(file);
      if (tab) {
        const offset = startOf(doc, tab.chapter);
        let at = 0;
        for (let i = 0, pos = 0; i < fresh.chapters.length; i++) {
          if (pos <= offset) at = i;
          pos += fresh.chapters[i].raw.length;
        }
        moved.set(tab.id, at);
      }
    }
    this.set({
      docs,
      tabs: this.state.tabs.map((t) =>
        moved.has(t.id) ? { ...t, chapter: moved.get(t.id)!, draft: null, saved: null, conflict: null, reloadKey: t.reloadKey + 1 } : t
      )
    });
  }

  // ---- projects ---------------------------------------------------------------------------

  /** Opens a project: its folder becomes the workspace, using the project's own chapter level. */
  async openProject(path: string): Promise<boolean> {
    if (!(await this.resolveDirtyTabs())) return false;
    try {
      const meta = await this.api.getProjectMeta(path);
      if (!meta) {
        this.set({ error: 'That folder is not a project.' });
        return false;
      }
      await this.openPath(path, true);
      return true;
    } catch (e) {
      this.set({ error: String(e instanceof Error ? e.message : e) });
      return false;
    }
  }

  /** Back to the Projects home: closes the open project or folder (unsaved edits are resolved first). */
  async closeProject(): Promise<boolean> {
    if (!(await this.resolveDirtyTabs())) return false;
    this.clearAllTimers();
    clearTimeout(this.progressTimer);
    this.stamps.clear();
    this.lastSession = '';
    this.undoStack = [];
    this.redoStack = [];
    this.state = { ...this.state, chapterLevel: this.effectiveLevel(this.appLevel, null) };
    this.set({ root: null, expanded: new Set(), docs: new Map(), tabs: [], activeId: null, error: null, notice: null, undoLabels: [], redoLabels: [], project: null, progress: null });
    this.api.setLastProject(null);
    return true;
  }

  /** The open project's metadata changed (status, goal, overrides…). A new chapter level re-splits the open files. */
  async updateProjectMeta(meta: ProjectMeta): Promise<boolean> {
    const project = this.state.project;
    if (!project) return false;
    const level = this.effectiveLevel(this.appLevel, { meta });
    const changed = level !== this.state.chapterLevel;
    if (changed && !(await this.resolveDirtyTabs())) return false;
    this.set({ project: { ...project, meta } });
    if (changed) this.resplitAll(level);
    return true;
  }

  /** Makes `file` (or nothing, with null) the active manuscript: goals and progress follow it. Swaps without prompting. */
  async setActiveManuscript(file: string | null): Promise<boolean> {
    const project = this.state.project;
    if (!project) return false;
    try {
      const meta = await this.api.updateProject(project.path, { activeManuscript: file === null ? null : relativeTo(project.path, file) });
      this.set({ project: { ...project, meta }, progress: null });
      await this.refreshProgress();
      return true;
    } catch (e) {
      this.set({ error: String(e instanceof Error ? e.message : e) });
      return false;
    }
  }

  /** Counts the project's words and notes them in its history (soon, and not more than once in a while). */
  scheduleProgress(delay = 1500): void {
    if (!this.state.project) return;
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => void this.refreshProgress(), delay);
  }

  async refreshProgress(): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    try {
      const r = await this.api.recordProgress(project.path);
      if (this.state.project?.path === project.path) this.set({ progress: r });
    } catch {
      // progress is a nicety: never interrupt writing for it
    }
  }

  // ---- startup, folders -----------------------------------------------------------------

  async init(opts: { restoreFolder?: boolean } = {}): Promise<void> {
    try {
      const defaults = await this.api.getAppDefaults();
      this.appLevel = clampLevel(defaults.chapterLevel);
      if (this.appLevel !== this.state.chapterLevel) this.set({ chapterLevel: this.appLevel });
      const prefs = await this.api.getPrefs();
      if (typeof prefs.sidebarWidth === 'number') this.setSidebarWidth(prefs.sidebarWidth, false);
      if (opts.restoreFolder !== false) {
        const folder = await this.api.getLastFolder();
        if (folder) await this.openPath(folder, true);
      }
    } catch (e) {
      this.set({ error: String(e) });
    }
  }

  /** Scans `folder` and resets the workspace to it, optionally restoring its saved tabs. */
  async openPath(folder: string, restore = false): Promise<void> {
    // A folder with a project marker is a project: it brings its own chapter level and remembers its progress.
    const meta = await this.api.getProjectMeta(folder).catch(() => null);
    const project = meta ? { path: folder, meta } : null;
    this.state = { ...this.state, chapterLevel: this.effectiveLevel(this.appLevel, project) };
    const root = await this.api.scanFolder(folder);
    this.clearAllTimers();
    this.stamps.clear();
    this.lastSession = '';
    this.undoStack = [];
    this.redoStack = [];
    this.set({ root, expanded: new Set(), docs: new Map(), tabs: [], activeId: null, error: null, notice: null, undoLabels: [], redoLabels: [], project, progress: null });
    if (project) {
      this.api.setLastProject(folder);
      void this.refreshProgress();
    }
    if (restore) await this.applySession(await this.api.getSession(folder), root);
    await this.recoverDrafts();
  }

  private async applySession(session: Session | null, root: DirNode): Promise<void> {
    if (!session) return;
    const exists = flattenPaths(root);
    this.set({ expanded: new Set(session.expanded.filter((p) => exists.has(p))) });
    const tabs: Tab[] = [];
    for (const t of session.tabs) {
      if (!exists.has(t.file)) continue;
      try {
        await this.loadDoc(t.file);
      } catch {
        continue;
      }
      const doc = this.state.docs.get(t.file)!;
      tabs.push(this.newTab(t.file, Math.min(t.chapter, doc.chapters.length - 1), t.mode));
    }
    const active = tabs.find((t) => t.file === session.active) ?? tabs[tabs.length - 1];
    this.set({ tabs, activeId: active?.id ?? null });
  }

  /**
   * Opens a file handed to the app from outside (double-click, "Open with", a second launch).
   * Inside the current folder it simply opens as a tab. Otherwise the file's folder becomes the open
   * folder, after the usual Save / Don't Save / Cancel check for unsaved tabs.
   */
  async openExternalFile(file: string): Promise<boolean> {
    const root = this.state.root;
    if (!root || !isInside(file, root.path)) {
      if (!(await this.resolveDirtyTabs())) return false;
      try {
        await this.openPath(dirname(file), true);
      } catch (e) {
        this.set({ error: `Could not open ${basename(file)}: ${e instanceof Error ? e.message : e}` });
        return false;
      }
    }
    this.expandPath(file);
    const existing = this.tabForFile(file);
    if (existing) {
      this.activateTab(existing.id);
      return true;
    }
    await this.openChapter(file, 0);
    return this.tabForFile(file) !== undefined;
  }

  /** Opens the files queued by the main process (command line / second instance). */
  async openLaunchFiles(): Promise<void> {
    let files: string[];
    try {
      files = await this.api.takeLaunchFiles();
    } catch {
      return;
    }
    for (const f of files) await this.openExternalFile(f);
  }

  async openFolder(): Promise<void> {
    if (!(await this.resolveDirtyTabs())) return;
    try {
      const folder = await this.api.pickFolder();
      if (folder) await this.openPath(folder, true);
    } catch (e) {
      this.set({ error: String(e) });
    }
  }

  // ---- reading --------------------------------------------------------------------------

  private newTab(file: string, chapter: number, mode: EditorMode = 'visual'): Tab {
    return {
      id: `t${this.nextId++}`,
      file,
      chapter,
      mode,
      draft: null,
      saved: null,
      reloadKey: 0,
      conflict: null,
      autosavedAt: null
    };
  }

  /** Reads a file into the cache and records its disk stamp. Keeps the old doc if unchanged. */
  private async loadDoc(file: string): Promise<void> {
    const { text, stamp } = await this.api.readFile(file);
    this.stamps.set(file, stamp);
    const existing = this.state.docs.get(file);
    if (!existing || joinChapters(existing) !== text) this.setDoc(file, this.split(text));
  }

  async toggleExpanded(path: string, isFile: boolean): Promise<void> {
    const wasOpen = this.state.expanded.has(path);
    const next = new Set(this.state.expanded);
    if (wasOpen) next.delete(path);
    else next.add(path);
    this.set({ expanded: next });
    if (isFile && !wasOpen) {
      try {
        const tab = this.tabForFile(path);
        if (!(tab && tab.draft !== null)) await this.loadDoc(path); // re-read so chapters are never stale
      } catch (e) {
        this.set({ error: String(e) });
      }
    }
  }

  /** Makes sure these folders are expanded (used after creating or opening a file). */
  private expandPath(file: string): void {
    const root = this.state.root;
    if (!root) return;
    const next = new Set(this.state.expanded);
    for (let d = dirname(file); isInside(d, root.path) && d !== root.path; d = dirname(d)) next.add(d);
    this.set({ expanded: next });
  }

  // ---- tabs and chapters ----------------------------------------------------------------

  /** Opens `file` at `chapter` in its tab (creating the tab if needed) and activates it. */
  async openChapter(file: string, chapter: number): Promise<void> {
    let tab = this.tabForFile(file);
    if (!tab) {
      try {
        await this.loadDoc(file);
      } catch (e) {
        this.set({ error: String(e) });
        return;
      }
      const doc = this.state.docs.get(file)!;
      const created = this.newTab(file, Math.max(0, Math.min(chapter, doc.chapters.length - 1)));
      const at = this.state.tabs.findIndex((t) => t.id === this.state.activeId);
      const tabs = this.state.tabs.slice();
      tabs.splice(at + 1, 0, created);
      this.set({ tabs, activeId: created.id, notice: null });
      return;
    }
    if (tab.chapter !== chapter) {
      if (!(await this.leaveTab(tab))) return;
      tab = this.tabForFile(file);
      if (!tab) return;
      const doc = this.state.docs.get(file);
      const target = Math.max(0, Math.min(chapter, (doc?.chapters.length ?? 1) - 1));
      this.patchTab(tab.id, (t) => ({ chapter: target, draft: null, conflict: null, reloadKey: t.reloadKey + 1 }));
    }
    this.set({ activeId: tab.id, notice: null });
  }

  /** Switching tabs never prompts: each tab keeps its own unsaved edits. */
  activateTab(id: string): void {
    const tab = this.tab(id);
    if (!tab || this.state.activeId === id) return;
    this.set({ activeId: id, notice: null });
    void this.checkFile(tab.file);
  }

  cycleTab(delta: 1 | -1): void {
    const { tabs, activeId } = this.state;
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    this.activateTab(tabs[(i + delta + tabs.length) % tabs.length].id);
  }

  /** Closing a tab with unsaved edits asks Save / Don't Save / Cancel. Returns whether it closed. */
  async closeTab(id: string): Promise<boolean> {
    const tab = this.tab(id);
    if (!tab) return true;
    if (!(await this.leaveTab(tab))) return false;
    this.removeTabs([id]);
    return true;
  }

  private removeTabs(ids: string[]): void {
    const { tabs, activeId } = this.state;
    const removed = tabs.filter((t) => ids.includes(t.id));
    removed.forEach((t) => this.dropDraft(t.file));
    const remaining = tabs.filter((t) => !ids.includes(t.id));
    let nextActive = activeId;
    if (activeId && ids.includes(activeId)) {
      const i = tabs.findIndex((t) => t.id === activeId);
      const after = tabs.slice(i + 1).find((t) => !ids.includes(t.id));
      const before = tabs.slice(0, i).reverse().find((t) => !ids.includes(t.id));
      nextActive = (after ?? before)?.id ?? null;
    }
    this.set({ tabs: remaining, activeId: nextActive });
  }

  async gotoChapter(delta: 1 | -1): Promise<void> {
    const tab = this.activeTab();
    const doc = tab && this.state.docs.get(tab.file);
    if (!tab || !doc) return;
    const target = tab.chapter + delta;
    if (target < 0 || target >= doc.chapters.length) return;
    await this.openChapter(tab.file, target);
  }

  setMode(id: string, mode: EditorMode): void {
    const tab = this.tab(id);
    if (!tab || tab.mode === mode) return;
    this.patchTab(id, (t) => ({ mode, reloadKey: t.reloadKey + 1 }));
  }

  // ---- unsaved edits --------------------------------------------------------------------

  setDraft(id: string, markdown: string | null): void {
    const tab = this.tab(id);
    if (!tab || tab.draft === markdown) return;
    this.patchTab(id, { draft: markdown, ...(markdown === null ? { autosavedAt: null } : {}) });
    if (markdown === null) this.dropDraft(tab.file);
    else this.scheduleDraftSave(id);
  }

  private scheduleDraftSave(id: string): void {
    clearTimeout(this.draftTimers.get(id));
    this.draftTimers.set(
      id,
      setTimeout(() => void this.flushDraft(id), this.draftDelay)
    );
  }

  private async flushDraft(id: string): Promise<void> {
    this.draftTimers.delete(id);
    const tab = this.tab(id);
    if (!tab || tab.draft === null) return;
    const doc = this.state.docs.get(tab.file);
    const record: DraftRecord = {
      file: tab.file,
      chapter: tab.chapter,
      title: doc?.chapters[tab.chapter]?.title ?? '',
      markdown: tab.draft,
      updatedAt: Date.now()
    };
    try {
      await this.api.saveDraft(record);
      const still = this.tab(id);
      if (!still || still.draft === null) {
        // saved or closed while the write was in flight: don't leave a stale recovery file
        await this.api.clearDraft(record.file);
      } else {
        this.draftsOnDisk.add(record.file);
        this.patchTab(id, { autosavedAt: record.updatedAt });
      }
    } catch {
      // recovery is best-effort
    }
  }

  /** Forgets a file's autosaved draft (it was saved, discarded, or its tab closed). */
  private dropDraft(file: string): void {
    const tab = this.tabForFile(file);
    if (tab) {
      clearTimeout(this.draftTimers.get(tab.id));
      this.draftTimers.delete(tab.id);
    }
    if (this.draftsOnDisk.delete(file)) void this.api.clearDraft(file).catch(() => undefined);
  }

  /**
   * Asks what to do with a tab's unsaved edits. Nothing is thrown away here: a discard only takes
   * effect (see dropDraft) once the caller knows the whole operation is going ahead.
   */
  private async decide(tab: Tab): Promise<'clean' | 'saved' | 'discard' | 'cancel'> {
    if (tab.draft === null) return 'clean';
    const choice = await this.api.confirmUnsaved(basename(tab.file));
    if (choice === 'cancel') return 'cancel';
    if (choice === 'discard') return 'discard';
    return (await this.save(tab.id)) ? 'saved' : 'cancel'; // a failed save keeps you where you are
  }

  /** True if it's fine to leave this tab's content: it was clean, saved, or the user discarded it. */
  private async leaveTab(tab: Tab): Promise<boolean> {
    const decision = await this.decide(tab);
    if (decision === 'cancel') return false;
    if (decision === 'discard') this.dropDraft(tab.file);
    return true;
  }

  /**
   * Walks the unsaved tabs one by one (window close, changing folder). If the user cancels at any
   * point nothing is discarded; otherwise the discarded tabs' recovery drafts are dropped at the end.
   */
  async resolveDirtyTabs(): Promise<boolean> {
    const discarded: string[] = [];
    for (const t of this.state.tabs.filter((x) => x.draft !== null)) {
      this.activateTab(t.id);
      const current = this.tab(t.id);
      if (!current) continue;
      const decision = await this.decide(current);
      if (decision === 'cancel') return false;
      if (decision === 'discard') discarded.push(current.file);
    }
    discarded.forEach((f) => this.dropDraft(f));
    return true;
  }

  async handleCloseRequest(): Promise<boolean> {
    const ok = await this.resolveDirtyTabs();
    if (ok) this.flushSessionNow();
    return ok;
  }

  // ---- saving ---------------------------------------------------------------------------

  async save(id: string | null = this.state.activeId): Promise<boolean> {
    const tab = this.tab(id);
    if (!tab || tab.draft === null) return true; // nothing to save
    const doc = this.state.docs.get(tab.file);
    if (!doc || this.saving.has(tab.file)) return false;
    const text = tab.draft;
    this.saving.add(tab.file);
    try {
      // Never silently clobber an edit made outside the app.
      const known = this.stamps.get(tab.file);
      const now = await this.api.statFile(tab.file);
      if (known && now && !sameStamp(known, now)) {
        const onDisk = (await this.api.readFile(tab.file)).text;
        if (onDisk !== joinChapters(doc) && !(await this.api.confirmOverwrite(basename(tab.file)))) return false;
      }
      const updated = updateChapter(doc, tab.chapter, text);
      const out = joinChapters(updated);
      this.stamps.set(tab.file, await this.api.writeFile(tab.file, out));
      const fresh = this.split(out);
      this.setDoc(tab.file, fresh);
      const idx = Math.min(tab.chapter, fresh.chapters.length - 1);
      // If the edit added or removed a Heading 1 the editor no longer matches one chapter: reload it.
      const restructured = chapterBody(fresh.chapters[idx].raw) !== chapterBody(text);
      this.patchTab(tab.id, (t) => ({
        // anything typed while the save was in flight stays unsaved
        draft: restructured || t.draft === text ? null : t.draft,
        conflict: null,
        autosavedAt: null,
        saved: { version: (t.saved?.version ?? 0) + 1, markdown: text },
        ...(restructured ? { chapter: idx, reloadKey: t.reloadKey + 1 } : {})
      }));
      this.dropDraft(tab.file);
      this.set({ error: null });
      this.scheduleProgress();
      return true;
    } catch (e) {
      this.set({ error: `Could not save: ${e}` });
      return false;
    } finally {
      this.saving.delete(tab.file);
    }
  }

  // ---- changes made outside the app -----------------------------------------------------

  /** Replaces a file's content from disk, dropping the tab's edits. */
  private applyDisk(file: string, text: string, stamp: FileStamp): void {
    const doc = this.split(text);
    this.stamps.set(file, stamp);
    this.set({ docs: new Map(this.state.docs).set(file, doc) });
    const tab = this.tabForFile(file);
    if (tab) {
      this.patchTab(tab.id, (t) => ({
        chapter: Math.min(t.chapter, doc.chapters.length - 1),
        draft: null,
        conflict: null,
        autosavedAt: null,
        reloadKey: t.reloadKey + 1
      }));
      this.dropDraft(file);
    }
  }

  /** Reloads silently when there are no unsaved edits; otherwise raises a conflict on the tab. */
  async checkFile(file: string): Promise<void> {
    if (this.checking.has(file) || this.saving.has(file)) return;
    this.checking.add(file);
    try {
      const tab = this.tabForFile(file);
      if (!tab) return;
      const known = this.stamps.get(file);
      const now = await this.api.statFile(file);
      if (!now) {
        if (known) {
          this.stamps.delete(file);
          this.patchTab(tab.id, { conflict: { kind: 'missing' } });
        }
        return;
      }
      if (known && sameStamp(known, now)) return;
      const pending = tab.conflict;
      if (pending?.kind === 'changed' && sameStamp(pending.stamp, now)) return;

      const { text, stamp } = await this.api.readFile(file);
      const doc = this.state.docs.get(file);
      const current = this.tabForFile(file);
      if (!current) return;
      if (doc && joinChapters(doc) === text) {
        this.stamps.set(file, stamp); // touched, content identical
        if (current.conflict?.kind === 'missing') this.patchTab(current.id, { conflict: null });
      } else if (current.draft === null) {
        this.applyDisk(file, text, stamp);
        this.set({ notice: `${basename(file)} changed on disk and was reloaded.` });
      } else {
        this.patchTab(current.id, { conflict: { kind: 'changed', text, stamp } });
      }
    } catch {
      // transient read error (file mid-write): try again next tick
    } finally {
      this.checking.delete(file);
    }
  }

  async checkAllOpenFiles(): Promise<void> {
    await Promise.all(this.state.tabs.map((t) => this.checkFile(t.file)));
  }

  resolveConflict(id: string, choice: 'reload' | 'keep' | 'dismiss'): void {
    const tab = this.tab(id);
    const c = tab?.conflict;
    if (!tab || !c) return;
    if (c.kind === 'changed' && choice === 'reload') this.applyDisk(tab.file, c.text, c.stamp);
    else {
      if (c.kind === 'changed' && choice === 'keep') this.stamps.set(tab.file, c.stamp);
      this.patchTab(id, { conflict: null });
    }
  }

  /** Rescans the folder and re-reads expanded/open files, keeping tabs and unsaved edits. */
  async refresh(): Promise<void> {
    const current = this.state.root;
    if (!current || this.state.refreshing) return;
    this.set({ refreshing: true });
    try {
      const root = await this.api.scanFolder(current.path);
      const exists = flattenPaths(root);
      this.set({ root, expanded: new Set([...this.state.expanded].filter((p) => exists.has(p))) });
      for (const file of [...this.state.docs.keys()]) {
        if (this.tabForFile(file)) {
          await this.checkFile(file); // reloads, or raises the changed/missing banner
        } else if (!exists.has(file)) {
          const docs = new Map(this.state.docs);
          docs.delete(file);
          this.stamps.delete(file);
          this.set({ docs });
        } else if (this.state.expanded.has(file)) {
          await this.loadDoc(file).catch(() => undefined);
        }
      }
      this.set({ error: null });
    } catch (e) {
      this.set({ error: `Could not refresh: ${e}` });
    } finally {
      this.set({ refreshing: false });
    }
  }

  // ---- files ----------------------------------------------------------------------------

  async createFile(dir: string, name: string): Promise<boolean> {
    try {
      const title = stripExt(name.trim());
      const file = await this.api.createFile(dir, name, `# ${title}\n\n`);
      await this.refresh();
      this.expandPath(file);
      await this.openChapter(file, 0);
      return true;
    } catch (e) {
      this.set({ error: String(e instanceof Error ? e.message : e) });
      return false;
    }
  }

  /** Creates a folder and reveals it in the tree. Returns its path, or null on failure. */
  async createFolder(dir: string, name: string): Promise<string | null> {
    try {
      const folder = await this.api.createFolder(dir, name.trim());
      await this.refresh();
      this.expandPath(folder); // opens the parents so the new folder is visible
      return folder;
    } catch (e) {
      this.set({ error: String(e instanceof Error ? e.message : e) });
      return null;
    }
  }

  /** Marks/unmarks a file for export. The tree is refreshed so its badge appears. */
  async setMarked(file: string, marked: boolean): Promise<boolean> {
    try {
      const { backedUp } = await this.api.setMarked(file, marked);
      await this.refresh();
      if (backedUp) {
        this.set({ notice: `The old export settings for ${basename(file)} couldn’t be read and were replaced. A copy was kept as a .bak file next to it.` });
      }
      return true;
    } catch (e) {
      this.set({ error: `Could not ${marked ? 'mark' : 'unmark'} the file: ${e instanceof Error ? e.message : e}` });
      return false;
    }
  }

  markedFiles(): string[] {
    return this.state.root ? collectFiles(this.state.root, (f) => f.marked === true).map((f) => f.path) : [];
  }

  orphanSidecars(): string[] {
    return this.state.root ? collectOrphans(this.state.root) : [];
  }

  async relinkSidecar(sidecar: string, markdownFile: string): Promise<boolean> {
    try {
      await this.api.relinkSidecar(sidecar, markdownFile);
      await this.refresh();
      return true;
    } catch (e) {
      this.set({ error: String(e instanceof Error ? e.message : e) });
      return false;
    }
  }

  async renameNode(path: string, newName: string): Promise<boolean> {
    try {
      const to = await this.api.renameNode(path, newName);
      this.remap(path, to);
      await this.followActiveManuscript(path, to);
      await this.refresh();
      return true;
    } catch (e) {
      this.set({ error: String(e instanceof Error ? e.message : e) });
      return false;
    }
  }

  /** A renamed file (or folder) that holds the active manuscript: point the project at its new path. */
  private async followActiveManuscript(from: string, to: string): Promise<void> {
    const project = this.state.project;
    const active = project?.meta.activeManuscript;
    if (!project || !active) return;
    const moved = remapPath(active, relativeTo(project.path, from), relativeTo(project.path, to));
    if (moved === active) return;
    try {
      const meta = await this.api.updateProject(project.path, { activeManuscript: moved });
      this.set({ project: { ...project, meta } });
      void this.refreshProgress();
    } catch {
      // the next progress count clears a manuscript that can't be found
    }
  }

  /** Points every record of `from` (a file, or a folder and its contents) at `to`. */
  private remap(from: string, to: string): void {
    const re = (p: string) => remapPath(p, from, to);
    const docs = new Map([...this.state.docs].map(([k, v]) => [re(k), v] as const));
    const stamps = new Map([...this.stamps].map(([k, v]) => [re(k), v] as const));
    this.stamps = stamps;
    for (const e of [...this.undoStack, ...this.redoStack]) e.file = re(e.file);
    const renamed = this.state.tabs.filter((t) => re(t.file) !== t.file);
    renamed.forEach((t) => this.dropDraft(t.file));
    this.set({
      docs,
      expanded: new Set([...this.state.expanded].map(re)),
      tabs: this.state.tabs.map((t) => ({ ...t, file: re(t.file) }))
    });
    // Re-autosave unsaved edits under the new name.
    renamed.forEach((t) => {
      if (t.draft !== null) this.scheduleDraftSave(t.id);
    });
  }

  async deleteNode(path: string, kind: 'file' | 'folder'): Promise<boolean> {
    const affected = this.state.tabs.filter((t) => isInside(t.file, path));
    const hasUnsaved = affected.some((t) => t.draft !== null);
    if (!(await this.api.confirmDelete(basename(path), kind, hasUnsaved))) return false;
    try {
      await this.api.trashNode(path);
    } catch (e) {
      this.set({ error: `Could not delete: ${e instanceof Error ? e.message : e}` });
      return false;
    }
    this.removeTabs(affected.map((t) => t.id));
    this.undoStack = this.undoStack.filter((e) => !isInside(e.file, path));
    this.redoStack = this.redoStack.filter((e) => !isInside(e.file, path));
    this.publishUndo();
    await this.refresh();
    return true;
  }

  reveal(path: string): void {
    this.api.reveal(path);
  }

  // ---- chapter structure ----------------------------------------------------------------

  /**
   * Applies a structural edit to a file's chapters on disk. Unsaved edits in that file's tab are
   * resolved first (Save / Don't Save / Cancel), and the text is re-read so the edit applies to
   * what is really on disk.
   */
  private async editStructure(
    file: string,
    label: (doc: MarkdownDoc) => string,
    edit: (doc: MarkdownDoc) => { doc: MarkdownDoc; index: number | null; remapIndex: (old: number) => number } | null
  ): Promise<{ index: number | null } | null> {
    const tab = this.tabForFile(file);
    if (tab && !(await this.leaveTab(tab))) return null;
    try {
      const { text } = await this.api.readFile(file);
      const before = this.split(text);
      const result = edit(before);
      if (!result) return null;
      const actionLabel = label(before);
      const chapterBefore = this.tabForFile(file)?.chapter ?? null;
      const out = joinChapters(result.doc);
      const stamp = await this.api.writeFile(file, out);
      this.stamps.set(file, stamp);
      this.setDoc(file, this.split(out));
      const open = this.tabForFile(file);
      if (open) {
        const next = result.remapIndex(open.chapter);
        this.patchTab(open.id, (t) => ({
          chapter: Math.max(0, Math.min(next, this.split(out).chapters.length - 1)),
          draft: null,
          conflict: null,
          reloadKey: t.reloadKey + 1
        }));
      }
      if (out !== text) {
        this.undoStack.push({
          label: actionLabel,
          file,
          before: text,
          after: out,
          chapterBefore,
          chapterAfter: this.tabForFile(file)?.chapter ?? null
        });
        if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
        this.redoStack = [];
        this.publishUndo();
      }
      this.scheduleProgress();
      return { index: result.index };
    } catch (e) {
      this.set({ error: `Could not edit chapters: ${e instanceof Error ? e.message : e}` });
      return null;
    }
  }

  /**
   * Find & Replace across a whole file: every chapter's Markdown text is rewritten and saved. Unsaved
   * edits in the file's tab are resolved first (Save / Don't Save / Cancel). Returns how many
   * replacements were made, or null if it was cancelled or failed.
   */
  async replaceInFile(file: string, find: FindOptions, replacement: string): Promise<number | null> {
    if (compileFind(find)?.error) return null;
    let count = 0;
    const done = await this.editStructure(file, () => `Replace “${find.query}” with “${replacement}” in ${basename(file)}`, (doc) => {
      const next = mapChapters(doc, (raw) => {
        const r = replaceAllInText(raw, find, replacement);
        count += r.count;
        return r.text;
      });
      return { doc: next, index: null, remapIndex: (old) => old };
    });
    return done ? count : null;
  }

  async newChapter(file: string, afterIndex: number, title: string): Promise<boolean> {
    const r = await this.editStructure(file, () => `Add chapter “${title.trim()}”`, (doc) => {
      const ins = insertChapter(doc, afterIndex, title);
      return { doc: ins.doc, index: ins.index, remapIndex: (old) => (old >= ins.index ? old + 1 : old) };
    });
    if (!r || r.index === null) return false;
    this.expandPath(file);
    await this.openChapter(file, r.index);
    return true;
  }

  /** Returns the chapter's new index, or null if it could not be moved. */
  async moveChapter(file: string, index: number, delta: -1 | 1): Promise<number | null> {
    const r = await this.editStructure(file, (doc) => `Move chapter “${doc.chapters[index]?.title || 'untitled'}” ${delta < 0 ? 'up' : 'down'}`, (doc) => {
      const moved = moveChapterIn(doc, index, delta);
      if (!moved) return null;
      return {
        doc: moved.doc,
        index: moved.index,
        remapIndex: (old) => (old === index ? moved.index : old === index + delta ? index : old)
      };
    });
    return r?.index ?? null;
  }

  async deleteChapter(file: string, index: number): Promise<boolean> {
    const title = this.state.docs.get(file)?.chapters[index]?.title || 'this chapter';
    const tab = this.tabForFile(file);
    if (!(await this.api.confirmDelete(title, 'chapter', tab?.draft !== null && tab?.chapter === index))) return false;
    const r = await this.editStructure(file, () => `Delete chapter “${title}”`, (doc) => {
      const next = deleteChapterIn(doc, index);
      if (!next) return null;
      return { doc: next, index: null, remapIndex: (old) => (old > index ? old - 1 : old) };
    });
    return r !== null;
  }

  // ---- undo / redo of structural actions ------------------------------------------------

  /** Reverses the latest delete / move / add chapter or whole-file replace (up to UNDO_DEPTH of them). */
  undoAction(): Promise<boolean> {
    return this.stepUndo('undo');
  }
  redoAction(): Promise<boolean> {
    return this.stepUndo('redo');
  }

  private async stepUndo(dir: 'undo' | 'redo'): Promise<boolean> {
    const from = dir === 'undo' ? this.undoStack : this.redoStack;
    const entry = from[from.length - 1];
    if (!entry) {
      this.set({ notice: dir === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.' });
      return false;
    }
    const target = dir === 'undo' ? entry.before : entry.after;
    const expected = dir === 'undo' ? entry.after : entry.before;
    const tab = this.tabForFile(entry.file);
    if (tab && !(await this.leaveTab(tab))) return false;
    try {
      const { text } = await this.api.readFile(entry.file);
      if (text !== expected) {
        from.pop();
        this.publishUndo();
        this.set({ error: `Can’t ${dir} “${entry.label}”: ${basename(entry.file)} has been changed since.` });
        return false;
      }
      const stamp = await this.api.writeFile(entry.file, target);
      this.stamps.set(entry.file, stamp);
      const doc = this.split(target);
      this.setDoc(entry.file, doc);
      const open = this.tabForFile(entry.file);
      if (open) {
        const wanted = dir === 'undo' ? entry.chapterBefore : entry.chapterAfter;
        this.patchTab(open.id, (t) => ({
          chapter: Math.max(0, Math.min(wanted ?? t.chapter, doc.chapters.length - 1)),
          draft: null,
          conflict: null,
          reloadKey: t.reloadKey + 1
        }));
      }
      from.pop();
      (dir === 'undo' ? this.redoStack : this.undoStack).push(entry);
      this.publishUndo();
      this.scheduleProgress();
      this.set({ notice: `${dir === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}` });
      return true;
    } catch (e) {
      this.set({ error: `Could not ${dir}: ${e instanceof Error ? e.message : e}` });
      return false;
    }
  }

  // ---- crash recovery -------------------------------------------------------------------

  /** Offers to restore edits that were autosaved but never written (e.g. after a crash). */
  async recoverDrafts(): Promise<void> {
    const root = this.state.root;
    if (!root) return;
    let drafts: DraftRecord[];
    try {
      drafts = await this.api.listDrafts();
    } catch {
      return;
    }
    for (const d of drafts) {
      if (!isInside(d.file, root.path)) continue; // belongs to another folder: keep it for later
      try {
        await this.loadDoc(d.file);
      } catch {
        await this.api.clearDraft(d.file).catch(() => undefined); // the file is gone
        continue;
      }
      if (!(await this.api.confirmRecover(basename(d.file)))) {
        await this.api.clearDraft(d.file).catch(() => undefined);
        continue;
      }
      const doc = this.state.docs.get(d.file)!;
      let idx = doc.chapters[d.chapter]?.title === d.title && !doc.chapters[d.chapter].isPreamble ? d.chapter : -1;
      if (idx < 0 && d.title === '' && doc.chapters[d.chapter]?.isPreamble) idx = d.chapter;
      if (idx < 0) idx = doc.chapters.findIndex((c) => !c.isPreamble && c.title === d.title);
      if (idx < 0) {
        await this.saveRecoveredAside(d);
        continue;
      }
      let tab = this.tabForFile(d.file);
      if (!tab) {
        tab = this.newTab(d.file, idx);
        this.set({ tabs: [...this.state.tabs, tab] });
      }
      this.patchTab(tab.id, (t) => ({ chapter: idx, draft: d.markdown, conflict: null, reloadKey: t.reloadKey + 1 }));
      this.draftsOnDisk.add(d.file);
      this.scheduleDraftSave(tab.id);
      this.expandPath(d.file);
      this.set({ activeId: tab.id, notice: `Recovered unsaved changes to ${basename(d.file)}.` });
    }
  }

  /** The chapter the draft belonged to no longer exists: keep the text as a new file instead. */
  private async saveRecoveredAside(d: DraftRecord): Promise<void> {
    const dir = dirname(d.file);
    const base = stripExt(basename(d.file));
    for (let n = 0; n < 20; n++) {
      const name = `${base} (recovered${n ? ` ${n + 1}` : ''}).md`;
      try {
        const path = await this.api.createFile(dir, name, d.markdown);
        await this.api.clearDraft(d.file).catch(() => undefined);
        await this.refresh();
        this.set({ notice: `The chapter "${d.title}" no longer exists, so your unsaved text was saved as ${basename(path)}.` });
        return;
      } catch {
        // name taken: try the next one
      }
    }
  }

  // ---- persistence ----------------------------------------------------------------------

  private currentSession(): Session | null {
    const { root, tabs, expanded, activeId } = this.state;
    if (!root) return null;
    return {
      tabs: tabs.map((t) => ({ file: t.file, chapter: t.chapter, mode: t.mode })),
      active: this.tab(activeId)?.file ?? null,
      expanded: [...expanded]
    };
  }

  private scheduleSession(): void {
    if (!this.state.root) return;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.flushSessionNow(), this.sessionDelay);
  }

  flushSessionNow(): void {
    clearTimeout(this.sessionTimer);
    const session = this.currentSession();
    if (!session || !this.state.root) return;
    const json = JSON.stringify(session);
    if (json === this.lastSession) return;
    this.lastSession = json;
    this.api.saveSession(this.state.root.path, session);
  }

  private clearAllTimers(): void {
    this.draftTimers.forEach((t) => clearTimeout(t));
    this.draftTimers.clear();
    clearTimeout(this.sessionTimer);
    this.draftsOnDisk.clear();
  }
}
