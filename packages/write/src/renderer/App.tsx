import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MenuAction } from '../shared/api';
import { basename, dirname, validateName } from '../shared/paths';
import { collectFiles, collectOrphans, findNode } from '../shared/tree';
import { countWords } from '../shared/words';
import { BookDetailsDialog } from './BookDetailsDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Editor } from './Editor';
import { Icon } from './Icon';
import { ExportDialog } from './ExportDialog';
import { FindBar, initialFindForm, type FindForm } from './FindBar';
import { PromptDialog, type PromptSpec } from './PromptDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { ProjectsHome } from './ProjectsHome';
import { ProjectSwitcher } from './ProjectSwitcher';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';
import { ProgressDialog } from './ProgressDialog';
import { QuickSwitcher } from './QuickSwitcher';
import { WelcomeDialog } from './WelcomeDialog';
import { localDate, writtenOn } from '../shared/progress';
import { goalFor, relativeTo } from '../shared/projects';
import { projectNameError, uniqueName, type ProjectStatus, type ProjectSummary, type ProjectsConfig, type RootListing } from '../shared/projects';
import { RelinkDialog } from './RelinkDialog';
import { SettingsDialog } from './SettingsDialog';
import type { SceneNav } from './sceneNav';
import { SourceEditor } from './SourceEditor';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { Tabs } from './Tabs';
import { Tree } from './Tree';
import { buildRows, chapterKey, chapterLabel, type Row } from './treeRows';
import { useWorkspace } from './useWorkspace';
import { Workspace } from './workspace';
import './styles.css';

const POLL_MS = 2000;

const cleanError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');

export function App() {
  const [ws] = useState(() => new Workspace(window.mdedit));
  const s = useWorkspace(ws);
  const [filter, setFilter] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [bookFile, setBookFile] = useState<string | null>(null);
  const [relink, setRelink] = useState<string | null>(null);
  const [exportFile, setExportFile] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [find, setFindState] = useState<FindForm>(initialFindForm);
  const [navVersion, setNavVersion] = useState(0);
  const setFind = (patch: Partial<FindForm>) => setFindState((f) => ({ ...f, ...patch }));
  const [sceneMsg, setSceneMsg] = useState<string | null>(null);
  const navs = useRef(new Map<string, SceneNav>());
  const sceneTimer = useRef<ReturnType<typeof setTimeout>>();
  const [detailsVersion, setDetailsVersion] = useState(0);
  const [ignoredOrphans, setIgnoredOrphans] = useState<Set<string>>(new Set());
  const filterRef = useRef<HTMLInputElement>(null);
  const [pConfig, setPConfig] = useState<ProjectsConfig | null>(null);
  const [listing, setListing] = useState<RootListing | null>(null);
  const [listing_loading, setListingLoading] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [projectSettings, setProjectSettings] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [welcome, setWelcome] = useState<{ lastFolder: string | null } | null>(null);
  const [started, setStarted] = useState(false);

  const activeTab = s.tabs.find((t) => t.id === s.activeId);
  const activeDoc = activeTab ? s.docs.get(activeTab.file) : undefined;
  const activeChapter = activeDoc?.chapters[activeTab?.chapter ?? 0];
  const activeKey = activeTab ? chapterKey(activeTab.file, activeTab.chapter) : null;

  const rows = useMemo(
    () => (s.root ? buildRows(s.root, s.expanded, s.docs, filter) : []),
    [s.root, s.expanded, s.docs, filter]
  );
  const orphan = useMemo(
    () => (s.root ? collectOrphans(s.root).find((o) => !ignoredOrphans.has(o)) : undefined),
    [s.root, ignoredOrphans]
  );
  const relinkCandidates = useMemo(() => {
    if (!relink || !s.root) return [];
    const dir = findNode(s.root, dirname(relink));
    return dir && dir.kind === 'dir'
      ? dir.children.filter((c) => c.kind === 'file' && c.marked === undefined && !c.exportBlocked).map((c) => ({ name: c.name, path: c.path }))
      : [];
  }, [relink, s.root]);
  const markedFiles = useMemo(() => (s.root ? collectFiles(s.root, (f) => f.marked === true).map((f) => f.path) : []), [s.root]);
  const dirtyFiles = useMemo(() => new Set(s.tabs.filter((t) => t.draft !== null).map((t) => t.file)), [s.tabs]);

  // ---- lifecycle -------------------------------------------------------------------------

  useEffect(() => {
    // Restore the last project (or folder), then open any file the app was launched with.
    void (async () => {
      await ws.init({ restoreFolder: false });
      const cfg = await window.mdedit.getProjectsConfig().catch(() => null);
      if (cfg) setPConfig(cfg);
      const lastFolder = await window.mdedit.getLastFolder().catch(() => null);
      if (cfg && !cfg.setupDone) setWelcome({ lastFolder });
      else if (cfg?.reopenLast && cfg.lastProject) await ws.openProject(cfg.lastProject);
      else if (lastFolder && !cfg?.lastProject) await ws.openPath(lastFolder, true);
      setStarted(true);
      await ws.openLaunchFiles();
    })();
    // Files handed over later by another launch (double-clicking a second .md).
    const stopLaunch = window.mdedit.onLaunchFiles(() => void ws.openLaunchFiles());
    const stopClose = window.mdedit.onCloseRequested(() => {
      void ws.handleCloseRequest().then((ok) => window.mdedit.reportCloseDecision(ok));
    });
    return () => {
      stopLaunch();
      stopClose();
    };
  }, [ws]);

  // Notice edits made outside the app (Dropbox sync, another editor, git checkout...).
  useEffect(() => {
    const check = () => void ws.checkAllOpenFiles();
    const timer = setInterval(check, POLL_MS);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [ws]);

  const reloadListing = useCallback(async () => {
    setListingLoading(true);
    try {
      const [cfg, l] = await Promise.all([window.mdedit.getProjectsConfig(), window.mdedit.listProjects()]);
      setPConfig(cfg);
      setListing(l);
    } catch (e) {
      ws.setError(cleanError(e));
    } finally {
      setListingLoading(false);
    }
  }, [ws]);
  const atHome = started && !s.root;
  // The Projects home keeps itself fresh: loaded when shown, and again when the window regains focus.
  useEffect(() => {
    if (!atHome && !showQuick && !showNewProject) return;
    void reloadListing();
    const onFocus = () => void reloadListing();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [atHome, showQuick, showNewProject, reloadListing]);
  // The switcher in the sidebar needs the list too.
  useEffect(() => {
    if (s.project) void reloadListing();
  }, [s.project?.path, reloadListing]);

  const activeDirty = activeTab !== undefined && activeTab.draft !== null;
  const titleText = activeTab
    ? `${activeChapter ? chapterLabel(activeChapter) + ' — ' : ''}${basename(activeTab.file)}${s.project ? ' · ' + s.project.meta.name : ''}`
    : s.project
      ? s.project.meta.name
      : 'MDEdit';
  useEffect(() => {
    document.title = activeTab ? `${titleText}${activeDirty ? ' ●' : ''} — MDEdit` : 'MDEdit';
  }, [activeTab, titleText, activeDirty]);

  // ---- actions ---------------------------------------------------------------------------

  const takeError = () => {
    const e = ws.getState().error;
    ws.setError(null);
    return e ?? 'That did not work.';
  };

  /** The folder a "new file" should go into, based on what is focused in the tree. */
  const dirFor = (row: Row | null): string => {
    const root = ws.getState().root?.path ?? '';
    if (row) return row.kind === 'dir' ? row.path : dirname(row.path);
    const focused = rows.find((r) => r.key === focusKey);
    if (focused) return focused.kind === 'dir' ? focused.path : dirname(focused.path);
    return activeTab ? dirname(activeTab.file) : root;
  };

  const promptNewFile = (dir: string) =>
    setPrompt({
      title: 'New file',
      hint: `In folder “${basename(dir)}”`,
      label: 'File name',
      initial: '',
      confirm: 'Create',
      validate: validateName,
      onSubmit: async (name) => ((await ws.createFile(dir, name)) ? null : takeError())
    });

  const promptNewFolder = (dir: string) =>
    setPrompt({
      title: 'New folder',
      hint: `In folder “${basename(dir)}”`,
      label: 'Folder name',
      initial: '',
      confirm: 'Create',
      validate: validateName,
      onSubmit: async (name) => {
        const created = await ws.createFolder(dir, name);
        if (!created) return takeError();
        setFocusKey(created);
        return null;
      }
    });

  const promptRename = (row: Row) =>
    setPrompt({
      title: row.kind === 'dir' ? 'Rename folder' : 'Rename file',
      label: 'New name',
      initial: row.label,
      confirm: 'Rename',
      selectBase: row.kind === 'file',
      validate: validateName,
      onSubmit: async (name) => ((await ws.renameNode(row.path, name)) ? null : takeError())
    });

  const promptNewChapter = (file: string, after: number) =>
    setPrompt({
      title: 'New chapter',
      hint: `After “${s.docs.get(file)?.chapters[after]?.title || 'the preamble'}” in ${basename(file)}`,
      label: 'Chapter title',
      initial: '',
      confirm: 'Add',
      validate: () => null,
      onSubmit: async (title) => {
        if (!(await ws.newChapter(file, after, title))) return takeError();
        const opened = ws.tabForFile(file);
        if (opened) setFocusKey(chapterKey(file, opened.chapter));
        return null;
      }
    });

  /** Moves a chapter and keeps the tree focus on it. */
  const moveRow = async (row: Row, delta: -1 | 1) => {
    const idx = await ws.moveChapter(row.path, row.chapter!, delta);
    if (idx !== null) setFocusKey(chapterKey(row.path, idx));
  };

  /** Marks a file for export and opens its Book Details so the title and author can be filled in. */
  const markAndEdit = async (file: string) => {
    if (await ws.setMarked(file, true)) setBookFile(file);
  };

  const deleteRow = (row: Row) => {
    if (row.kind === 'chapter') void ws.deleteChapter(row.path, row.chapter!);
    else void ws.deleteNode(row.path, row.kind === 'dir' ? 'folder' : 'file');
  };

  const activateRow = async (row: Row) => {
    setFocusKey(row.key);
    if (row.kind === 'chapter') return ws.openChapter(row.path, row.chapter!);
    if (row.kind === 'dir') return row.expandable ? ws.toggleExpanded(row.path, false) : undefined;
    // A file row: open it if it has no tab, switch to its tab if it isn't the active one, and only
    // collapse/expand when you click the file you are already on.
    const tab = ws.tabForFile(row.path);
    const isExpanded = () => ws.getState().expanded.has(row.path);
    if (!tab) {
      if (!isExpanded()) await ws.toggleExpanded(row.path, true);
      return ws.openChapter(row.path, 0);
    }
    if (ws.getState().activeId !== tab.id) {
      ws.activateTab(tab.id);
      if (!isExpanded()) await ws.toggleExpanded(row.path, true);
      return;
    }
    await ws.toggleExpanded(row.path, true);
  };

  const menuItems = (row: Row): MenuItem[] => {
    const reveal = { label: 'Show in File Explorer', onClick: () => ws.reveal(row.path) };
    if (row.kind === 'dir') {
      return [
        { label: 'New File Here…', onClick: () => promptNewFile(row.path) },
        { label: 'New Folder Here…', onClick: () => promptNewFolder(row.path) },
        { label: 'Rename…', hint: 'F2', onClick: () => promptRename(row) },
        reveal,
        { label: 'Delete Folder…', danger: true, hint: 'Del', onClick: () => deleteRow(row) }
      ];
    }
    if (row.kind === 'file') {
      const exportItems: MenuItem[] = row.exportBlocked
        ? [{ label: 'Can’t mark: another file with this name owns the export settings', disabled: true, onClick: () => undefined }]
        : row.marked
          ? [
              { label: 'Export…', onClick: () => setExportFile(row.path) },
              { label: 'Book Details…', onClick: () => setBookFile(row.path) },
              { label: 'Unmark for Export', onClick: () => void ws.setMarked(row.path, false) }
            ]
          : [{ label: 'Mark for Export', onClick: () => void markAndEdit(row.path) }];
      const active = !!s.project && s.project.meta.activeManuscript === relativeTo(s.project.path, row.path);
      const manuscriptItems: MenuItem[] = s.project
        ? [
            active
              ? { label: 'Clear Active Manuscript', onClick: () => void ws.setActiveManuscript(null) }
              : { label: 'Active Manuscript', onClick: () => void ws.setActiveManuscript(row.path) }
          ]
        : [];
      return [
        ...manuscriptItems,
        ...exportItems,
        { label: 'Rename…', hint: 'F2', onClick: () => promptRename(row) },
        reveal,
        { label: 'Delete…', danger: true, hint: 'Del', onClick: () => deleteRow(row) }
      ];
    }
    const doc = s.docs.get(row.path);
    const i = row.chapter!;
    const first = doc?.chapters[0]?.isPreamble ? 1 : 0;
    const real = !doc?.chapters[i]?.isPreamble;
    return [
      { label: 'New Chapter Below…', onClick: () => promptNewChapter(row.path, i) },
      { label: 'Move Up', hint: 'Alt+↑', disabled: !real || i <= first, onClick: () => void moveRow(row, -1) },
      {
        label: 'Move Down',
        hint: 'Alt+↓',
        disabled: !real || !doc || i >= doc.chapters.length - 1,
        onClick: () => void moveRow(row, 1)
      },
      { label: 'Delete Chapter…', danger: true, hint: 'Del', onClick: () => deleteRow(row) }
    ];
  };

  // ---- projects --------------------------------------------------------------------------

  const openProject = async (path: string) => {
    setShowQuick(false);
    await ws.openProject(path);
  };
  const goHome = async () => {
    setShowQuick(false);
    if (await ws.closeProject()) void reloadListing();
  };
  const changeRoot = async () => {
    const folder = await window.mdedit.pickFolder();
    if (!folder) return;
    try {
      setPConfig(await window.mdedit.setProjectsConfig({ rootFolder: folder }));
      await reloadListing();
    } catch (e) {
      ws.setError(cleanError(e));
    }
  };
  const projectCall = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      ws.setError(cleanError(e));
    }
    await reloadListing();
  };
  const existingNames = [...(listing?.projects.map((p) => p.name) ?? []), ...(listing?.folders.map((f) => f.name) ?? [])];
  const promptProjectName = (title: string, initial: string, confirm: string, run: (name: string) => Promise<unknown>) =>
    setPrompt({
      title,
      label: 'Project name',
      initial,
      confirm,
      validate: (v) => projectNameError(v, existingNames.filter((n) => n !== initial)),
      onSubmit: async (name) => {
        try {
          await run(name.trim());
          await reloadListing();
          return null;
        } catch (e) {
          return cleanError(e);
        }
      }
    });
  const homeProps = {
    config: pConfig,
    listing,
    loading: listing_loading,
    onOpen: (p: string) => void openProject(p),
    onNew: () => setShowNewProject(true),
    onOpenFolder: () => void ws.openFolder(),
    onChangeRoot: () => void changeRoot(),
    onRetry: () => void reloadListing(),
    onConvert: (p: string) => void projectCall(() => window.mdedit.convertFolder(p)),
    onRename: (p: ProjectSummary) => promptProjectName('Rename project', p.name, 'Rename', (n) => window.mdedit.renameProject(p.path, n)),
    onDuplicate: (p: ProjectSummary) =>
      promptProjectName('Duplicate project', uniqueName(`${p.name} copy`, existingNames), 'Duplicate', (n) => window.mdedit.duplicateProject(p.path, n)),
    onDelete: (p: ProjectSummary) =>
      setPrompt({
        title: `Delete “${p.name}”?`,
        hint: `Its folder and everything in it (${p.files} file${p.files === 1 ? '' : 's'}, ${p.words.toLocaleString()} words) goes to the Recycle Bin.`,
        label: 'Type the project name to confirm',
        initial: '',
        confirm: 'Delete project',
        validate: (v) => (v.trim() === p.name ? null : 'Type the name exactly as shown.'),
        onSubmit: async () => {
          try {
            await window.mdedit.deleteProject(p.path);
            await reloadListing();
            return null;
          } catch (e) {
            return cleanError(e);
          }
        }
      }),
    onArchive: (p: ProjectSummary, archived: boolean) => void projectCall(() => window.mdedit.updateProject(p.path, { archived })),
    onStatus: (p: ProjectSummary, status: ProjectStatus) => void projectCall(() => window.mdedit.updateProject(p.path, { status })),
    onProperties: (p: ProjectSummary) => setProjectSettings(p.path),
    onReveal: (p: string) => ws.reveal(p)
  };

  /** Jumps the active editor to the next/previous scene break and says so when there are no more. */
  const gotoScene = (dir: 1 | -1) => {
    const nav = s.activeId ? navs.current.get(s.activeId) : undefined;
    if (!nav) return;
    const moved = nav.go(dir);
    clearTimeout(sceneTimer.current);
    setSceneMsg(moved ? null : dir === 1 ? 'No more scene breaks below' : 'No scene break above');
    if (!moved) sceneTimer.current = setTimeout(() => setSceneMsg(null), 2500);
  };

  const registerNav = (id: string, n: SceneNav | null) => {
    if (n) navs.current.set(id, n);
    else navs.current.delete(id);
    setNavVersion((v) => v + 1);
  };
  void navVersion; // re-render when an editor registers, so the find bar gets its handle

  const closeFind = () => {
    setFind({ open: false });
    // hand the keyboard back to the editor
    (document.querySelector('.pane:not([hidden]) .ProseMirror, .pane:not([hidden]) textarea.source-editor') as HTMLElement | null)?.focus();
  };

  /** Opens the find bar (prefilled with the selected text); `replace` also shows the Replace row. */
  const openFind = (replace: boolean) => {
    if (!s.activeId) return;
    const picked = navs.current.get(s.activeId)?.find.selectedText() ?? '';
    setFindState((f) => ({
      ...f,
      open: true,
      replace: replace || (f.open && f.replace),
      query: picked || f.query,
      focusTick: f.focusTick + 1
    }));
  };
  const findStep = (dir: 1 | -1) => {
    if (!s.activeId) return;
    if (!find.open) {
      setFindState((f) => ({ ...f, open: true, focusTick: f.focusTick + 1 }));
      return;
    }
    setFindState((f) => ({ ...f, step: { dir, n: f.step.n + 1 } }));
  };

  // Shortcuts and the native menu share the same actions. The ref keeps listeners stable.
  const actions: Record<MenuAction | 'toggle-mode' | 'focus-filter', () => void> = {
    'new-project': () => setShowNewProject(true),
    'projects-home': () => void goHome(),
    'switch-project': () => setShowQuick(true),
    'project-settings': () => s.project && setProjectSettings(s.project.path),
    'project-progress': () => s.project && setShowProgress(true),
    save: () => void ws.save(),
    'change-folder': () => void ws.openFolder(),
    refresh: () => void ws.refresh(),
    'new-file': () => s.root && promptNewFile(dirFor(null)),
    'new-folder': () => s.root && promptNewFolder(dirFor(null)),
    'close-tab': () => s.activeId && void ws.closeTab(s.activeId),
    'next-tab': () => ws.cycleTab(1),
    'prev-tab': () => ws.cycleTab(-1),
    'next-chapter': () => void ws.gotoChapter(1),
    'prev-chapter': () => void ws.gotoChapter(-1),
    'undo-action': () => void ws.undoAction(),
    'redo-action': () => void ws.redoAction(),
    find: () => openFind(false),
    replace: () => openFind(true),
    'find-next': () => findStep(1),
    'find-prev': () => findStep(-1),
    'next-scene': () => gotoScene(1),
    'prev-scene': () => gotoScene(-1),
    settings: () => setShowSettings(true),
    'toggle-mode': () => activeTab && ws.setMode(activeTab.id, activeTab.mode === 'visual' ? 'source' : 'visual'),
    export: () => {
      const target = activeTab && markedFiles.includes(activeTab.file) ? activeTab.file : markedFiles[0];
      if (target) setExportFile(target);
      else ws.setError('Mark a file for export first: right-click it in the tree and choose “Mark for Export”.');
    },
    'focus-filter': () => filterRef.current?.focus()
  };
  const act = useRef(actions);
  act.current = actions;

  useEffect(() => window.mdedit.onMenuAction((a) => act.current[a]()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let name: keyof typeof actions | null = null;
      if (mod && e.altKey && !e.shiftKey && k === 'n') name = 'new-project';
      else if (mod && !e.shiftKey && !e.altKey && k === 'k') name = 'switch-project';
      else if (mod && !e.shiftKey && k === 's') name = 'save';
      else if (mod && k === 'o') name = 'change-folder';
      else if (mod && e.shiftKey && k === 'n') name = 'new-folder';
      else if (mod && k === 'n') name = 'new-file';
      else if (mod && k === 'w') name = 'close-tab';
      else if (mod && k === 'p') name = 'focus-filter';
      else if (mod && !e.shiftKey && k === 'e') name = 'export';
      else if (mod && !e.shiftKey && e.key === ',') name = 'settings';
      else if (mod && e.altKey && !e.shiftKey && k === 'z') name = 'undo-action';
      else if (mod && e.altKey && ((!e.shiftKey && k === 'y') || (e.shiftKey && k === 'z'))) name = 'redo-action';
      else if (mod && !e.shiftKey && !e.altKey && k === 'f') name = 'find';
      else if (mod && !e.shiftKey && !e.altKey && k === 'h') name = 'replace';
      else if (e.key === 'F3' && !mod) name = e.shiftKey ? 'find-prev' : 'find-next';
      else if (mod && !e.altKey && k === 'g') name = e.shiftKey ? 'find-prev' : 'find-next';
      else if (mod && e.shiftKey && k === 'm') name = 'toggle-mode';
      else if (e.ctrlKey && e.key === 'Tab') name = e.shiftKey ? 'prev-tab' : 'next-tab';
      else if (e.ctrlKey && e.key === 'PageDown') name = 'next-chapter';
      else if (e.ctrlKey && e.key === 'PageUp') name = 'prev-chapter';
      else if (e.key === 'F5') name = 'refresh';
      if (!name) return;
      e.preventDefault();
      act.current[name]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl+Up / Ctrl+Down jump between scene breaks while you are in the editor. Captured so the
  // editor's own handling of those keys (move by paragraph) never sees them.
  useEffect(() => {
    const onSceneKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.pane') || target.closest('.modal-backdrop')) return;
      e.preventDefault();
      e.stopPropagation();
      act.current[e.key === 'ArrowDown' ? 'next-scene' : 'prev-scene']();
    };
    window.addEventListener('keydown', onSceneKey, true);
    return () => window.removeEventListener('keydown', onSceneKey, true);
  }, []);

  // Esc in the editor closes an open find bar (Esc inside the bar is handled by the bar itself).
  const findOpenRef = useRef(false);
  findOpenRef.current = find.open;
  const closeFindRef = useRef(closeFind);
  closeFindRef.current = closeFind;
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !findOpenRef.current) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.pane') || t.closest('.find-bar') || t.closest('.modal-backdrop')) return;
      closeFindRef.current();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, []);

  // ---- sidebar resize --------------------------------------------------------------------

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const move = (ev: PointerEvent) => ws.setSidebarWidth(ev.clientX, false);
      const up = (ev: PointerEvent) => {
        ws.setSidebarWidth(ev.clientX, true);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [ws]
  );

  // ---- render ----------------------------------------------------------------------------

  const toolbarBusy = s.refreshing;

  return (
    <div className="frame">
    <TitleBar title={titleText} dirty={activeDirty} />
    {!s.root ? (
      <div className="app-home">
        {s.error && (
          <div className="banner error" role="alert">
            {s.error} <button onClick={() => ws.setError(null)}>Dismiss</button>
          </div>
        )}
        {started && !welcome && <ProjectsHome {...homeProps} />}
      </div>
    ) : (
    <div className="app" style={{ gridTemplateColumns: `${s.sidebarWidth}px 6px minmax(0, 1fr)` }}>
      <aside className="sidebar">
        <div className="toolbar">
          <ProjectSwitcher
            name={s.project ? s.project.meta.name : s.root?.name ?? ''}
            isProject={s.project !== null}
            projects={listing?.projects ?? []}
            currentPath={s.project?.path ?? null}
            onOpen={(p) => void openProject(p)}
            onHome={() => void goHome()}
            onNew={() => setShowNewProject(true)}
            onOpenFolder={() => void ws.openFolder()}
            onSettings={() => s.project && setProjectSettings(s.project.path)}
            onProgress={() => setShowProgress(true)}
          />
          <button
            onClick={() => void ws.refresh()}
            disabled={!s.root || toolbarBusy}
            title="Rescan the folder for new, renamed and deleted files (F5)"
          >
            <Icon name="refresh" /> {toolbarBusy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button onClick={() => actions.export()} disabled={!s.root} title="Export marked books for KDP (Ctrl+E)">
            <Icon name="download" /> Export…
          </button>
          <button onClick={() => promptNewFile(dirFor(null))} disabled={!s.root} title="New file (Ctrl+N)" aria-label="New file">
            <Icon name="filePlus" /> File
          </button>
          <button
            onClick={() => promptNewFolder(dirFor(null))}
            disabled={!s.root}
            title="New folder (Ctrl+Shift+N)"
            aria-label="New folder"
          >
            <Icon name="folderPlus" /> Folder
          </button>
        </div>
        {s.root ? (
          <>
            <input
              ref={filterRef}
              className="filter"
              type="search"
              placeholder="Filter files (Ctrl+P)"
              aria-label="Filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFilter('');
                else if (e.key === 'ArrowDown' && rows[0]) {
                  e.preventDefault();
                  setFocusKey(rows[0].key);
                  (e.currentTarget.parentElement?.querySelector('[role=treeitem]') as HTMLElement | null)?.focus();
                }
              }}
            />
            {s.root.children.length === 0 ? (
              <p className="muted pad">This folder is empty. Use “＋ File” or “＋ Folder” to add something.</p>
            ) : rows.length === 0 ? (
              <p className="muted pad">No files match “{filter}”.</p>
            ) : (
              <Tree
                rows={rows}
                focusKey={focusKey}
                activeKey={activeKey}
                dirtyFiles={dirtyFiles}
                onFocusKey={setFocusKey}
                onActivate={(r) => void activateRow(r)}
                onToggle={(r) => void ws.toggleExpanded(r.path, r.kind === 'file')}
                onContextMenu={(row, x, y) => setMenu({ row, x, y })}
                onRename={promptRename}
                onDelete={deleteRow}
                onMoveChapter={(r, d) => void moveRow(r, d)}
                isManuscript={(r) => r.kind === 'file' && !!s.project?.meta.activeManuscript && relativeTo(s.project.path, r.path) === s.project.meta.activeManuscript}
              />
            )}
          </>
        ) : (
          <p className="muted pad">Pick a folder to browse its Markdown files.</p>
        )}
      </aside>

      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={s.sidebarWidth}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            ws.setSidebarWidth(s.sidebarWidth + (e.key === 'ArrowLeft' ? -16 : 16), true);
          }
        }}
      />

      <main className="content">
        {s.error && (
          <div className="banner error" role="alert">
            {s.error} <button onClick={() => ws.setError(null)}>Dismiss</button>
          </div>
        )}
        {orphan && (
          <div className="banner warn" role="alert">
            Export settings for “{basename(orphan).replace(/\.export\.json$/i, '')}” no longer match a file (renamed outside MDEdit?).{' '}
            <button onClick={() => setRelink(orphan)}>Link to a file…</button>{' '}
            <button onClick={() => setIgnoredOrphans(new Set([...ignoredOrphans, orphan]))}>Ignore</button>
          </div>
        )}
        {s.notice && (
          <div className="banner info" role="status">
            {s.notice} <button onClick={() => ws.dismissNotice()}>Dismiss</button>
          </div>
        )}

        <Tabs tabs={s.tabs} activeId={s.activeId} onActivate={(id) => ws.activateTab(id)} onClose={(id) => void ws.closeTab(id)} />

        <div className="panes">
          {s.tabs.length === 0 && (
            <p className="muted pad">{s.root ? 'Select a chapter to edit it.' : 'Open a folder to get started.'}</p>
          )}
          {s.tabs.map((tab) => {
            const doc = s.docs.get(tab.file);
            const chapter = doc?.chapters[tab.chapter];
            if (!doc || !chapter) return null;
            const active = tab.id === s.activeId;
            const dirty = tab.draft !== null;
            return (
              <section key={tab.id} className="pane" hidden={!active} aria-label={basename(tab.file)}>
                {tab.conflict?.kind === 'changed' && (
                  <div className="banner warn" role="alert">
                    {basename(tab.file)} was changed on disk while you have unsaved edits.{' '}
                    <button onClick={() => ws.resolveConflict(tab.id, 'reload')}>Reload from disk (discard my edits)</button>{' '}
                    <button onClick={() => ws.resolveConflict(tab.id, 'keep')}>Keep my version</button>
                  </div>
                )}
                {tab.conflict?.kind === 'missing' && (
                  <div className="banner warn" role="alert">
                    {basename(tab.file)} was deleted or moved. Saving will recreate it.{' '}
                    <button onClick={() => ws.resolveConflict(tab.id, 'dismiss')}>Dismiss</button>
                  </div>
                )}
                <div className="pane-top">
                <div className="editor-head">
                  <h2>
                    {chapterLabel(chapter)}
                    {dirty && <span className="dirty" title="Unsaved changes"> ●</span>}
                  </h2>
                  {active && sceneMsg && (
                    <span className="scene-msg" role="status">
                      {sceneMsg}
                    </span>
                  )}
                  <div className="head-actions">
                    <button aria-label="Previous chapter" title="Previous chapter (Ctrl+PgUp)" disabled={tab.chapter === 0} onClick={() => void ws.gotoChapter(-1)}>
                      <Icon name="left" />
                    </button>
                    <button aria-label="Next chapter" title="Next chapter (Ctrl+PgDn)" disabled={tab.chapter >= doc.chapters.length - 1} onClick={() => void ws.gotoChapter(1)}>
                      <Icon name="right" />
                    </button>
                    <button aria-label="Previous scene break" title="Previous scene break (Ctrl+↑)" onClick={() => gotoScene(-1)}>
                      <Icon name="up" /> Scene
                    </button>
                    <button aria-label="Next scene break" title="Next scene break (Ctrl+↓)" onClick={() => gotoScene(1)}>
                      <Icon name="down" /> Scene
                    </button>
                    <button
                      onClick={() => ws.setMode(tab.id, tab.mode === 'visual' ? 'source' : 'visual')}
                      title="Switch between formatted and raw Markdown (Ctrl+Shift+M)"
                    >
                      {tab.mode === 'visual' ? 'Source' : 'Visual'}
                    </button>
                    <button className="save-btn" onClick={() => void ws.save(tab.id)} disabled={!dirty}>
                      Save (Ctrl+S)
                    </button>
                  </div>
                </div>
                {active && find.open && (
                  <FindBar
                    form={find}
                    setForm={setFind}
                    handle={navs.current.get(tab.id)}
                    chapterIndex={tab.chapter}
                    chapterTexts={doc.chapters.map((c, i) => (i === tab.chapter && tab.draft !== null ? tab.draft : c.raw))}
                    fileName={basename(tab.file)}
                    gotoChapter={async (i) => {
                      await ws.openChapter(tab.file, i);
                      return ws.tabForFile(tab.file)?.chapter === i;
                    }}
                    replaceInFile={(o, r) => ws.replaceInFile(tab.file, o, r)}
                    onClose={closeFind}
                  />
                )}
                </div>
                {tab.mode === 'visual' ? (
                  <Editor
                    key={`${tab.id}@${tab.reloadKey}@v`}
                    initial={chapter.raw}
                    restore={tab.draft}
                    onChange={(md) => ws.setDraft(tab.id, md)}
                    saved={tab.saved}
                    onNav={(n) => registerNav(tab.id, n)}
                  />
                ) : (
                  <SourceEditor
                    key={`${tab.id}@${tab.reloadKey}@s`}
                    raw={chapter.raw}
                    draft={tab.draft}
                    onChange={(md) => ws.setDraft(tab.id, md)}
                    savedVersion={tab.saved?.version ?? 0}
                    onNav={(n) => registerNav(tab.id, n)}
                  />
                )}
              </section>
            );
          })}
        </div>

        {activeTab && activeDoc && activeChapter && (
          <StatusBar
            chapterIndex={activeTab.chapter}
            chapterCount={activeDoc.chapters.length}
            words={countWords(activeTab.draft ?? activeChapter.raw)}
            dirty={activeTab.draft !== null}
            autosaved={activeTab.autosavedAt !== null}
            eol={activeDoc.eol}
            mode={activeTab.mode}
            undoLabel={s.undoLabels[s.undoLabels.length - 1] ?? null}
            undoCount={s.undoLabels.length}
            redoLabel={s.redoLabels[s.redoLabels.length - 1] ?? null}
            onUndo={() => void ws.undoAction()}
            onRedo={() => void ws.redoAction()}
            project={
              s.project && s.progress
                ? {
                    total: s.progress.total,
                    goal: goalFor(s.project.meta)?.targetWords ?? null,
                    today: writtenOn(s.progress.progress, localDate(new Date()))
                  }
                : null
            }
            onProgress={() => setShowProgress(true)}
          />
        )}
      </main>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog spec={prompt} onClose={() => setPrompt(null)} />}
      {relink && (
        <RelinkDialog sidecar={relink} candidates={relinkCandidates} onLink={(md) => ws.relinkSidecar(relink, md)} onClose={() => setRelink(null)} />
      )}
      {exportFile && (
        <ExportDialog
          files={markedFiles}
          chapterLevel={s.chapterLevel}
          initialFile={exportFile}
          dirtyFiles={dirtyFiles}
          saveFile={async (f) => {
            const t = ws.tabForFile(f);
            return t ? ws.save(t.id) : true;
          }}
          onEditDetails={(f) => setBookFile(f)}
          detailsVersion={detailsVersion}
          onClose={() => setExportFile(null)}
        />
      )}
      {bookFile && (
        <BookDetailsDialog
          file={bookFile}
          onClose={() => setBookFile(null)}
          onSaved={() => {
            setDetailsVersion((v) => v + 1);
            void ws.refresh();
          }}
        />
      )}
    </div>
    )}
    {showSettings && <SettingsDialog
        onSave={async (d) => {
          const ok = await ws.applyAppDefaults(d);
          void reloadListing();
          return ok;
        }}
        beforeMove={() => ws.closeProject()}
        onClose={() => {
          setShowSettings(false);
          void reloadListing();
        }}
      />}
    {showNewProject && pConfig && (
      <NewProjectDialog
        config={pConfig}
        existingNames={existingNames}
        onClose={() => setShowNewProject(false)}
        onCreate={async (name, templateId) => {
          try {
            const made = await window.mdedit.createProject(name, templateId);
            setShowNewProject(false);
            await ws.openProject(made.path);
            return null;
          } catch (e) {
            return cleanError(e);
          }
        }}
      />
    )}
    {showQuick && (
      <QuickSwitcher
        projects={listing?.projects ?? []}
        currentPath={s.project?.path ?? null}
        onOpen={(p) => void openProject(p)}
        onHome={() => void goHome()}
        onNew={() => (setShowQuick(false), setShowNewProject(true))}
        onClose={() => setShowQuick(false)}
      />
    )}
    {projectSettings && (
      <ProjectSettingsDialog
        path={projectSettings}
        config={pConfig}
        onClose={() => setProjectSettings(null)}
        onChanged={(meta) => {
          if (s.project?.path === projectSettings) void ws.updateProjectMeta(meta).then(() => ws.refreshProgress());
          void reloadListing();
        }}
      />
    )}
    {showProgress && s.project && (
      <ProgressDialog
        project={s.project}
        progress={s.progress}
        onClose={() => setShowProgress(false)}
        onSetGoal={() => (setShowProgress(false), setProjectSettings(s.project!.path))}
      />
    )}
    {welcome && (
      <WelcomeDialog
        config={pConfig}
        lastFolder={welcome.lastFolder}
        onDone={async (opened) => {
          setWelcome(null);
          await reloadListing();
          if (opened) await ws.openProject(opened);
        }}
      />
    )}
    {prompt && !s.root && <PromptDialog spec={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}
