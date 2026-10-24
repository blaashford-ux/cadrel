import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { flattenMarkdown } from '../shared/agent/flatten';
import { locateAnchor } from '../shared/review/comments';
import type { MenuAction, SyncStatus } from '../shared/api';
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
import { goalFor, relativeTo, withOpened } from '../shared/projects';
import { projectNameError, uniqueName, type ProjectStatus, type ProjectSummary, type ProjectsConfig, type RootListing } from '../shared/projects';
import { RelinkDialog } from './RelinkDialog';
import { ReportView } from './ReportView';
import { EditBar } from './EditBar';
import { extractAnalysis } from '../shared/analysis/embed';
import { SettingsDialog } from './SettingsDialog';
import type { MarkdownDoc } from '../shared/chapters';
import { locateRow } from '../shared/rows';
import { docRows } from './rowEnv';
import type { SceneNav } from './sceneNav';
import { SourceEditor } from './SourceEditor';
import { StatusBar } from './StatusBar';
import { MobileBar } from './MobileBar';
import { AboutDialog } from './AboutDialog';
import { SyncDialog } from './SyncDialog';
import { AiDialog } from './AiDialog';
import { chapterForNote } from './noteChapter';
import { ReviewPanel } from './ReviewPanel';
import { ShareDialog } from './ShareDialog';
import { JoinDialog } from './JoinDialog';
import { SharingHome } from './SharingHome';
import type { SharedProject } from '../shared/review/share';
import type { Anchor } from '../shared/review/comments';
import { loadIdentity, saveIdentity, useReview } from './useReview';
import { TitleBar } from './TitleBar';
import { Tabs } from './Tabs';
import { Tree } from './Tree';
import { buildRows, chapterKey, chapterLabel, type Row } from './treeRows';
import { useWorkspace } from './useWorkspace';
import { Workspace } from './workspace';
import './styles.css';

const POLL_MS = 2000;

const reportCache = new WeakMap<MarkdownDoc, ReturnType<typeof extractAnalysis>>();
/** The analysis a text-analysis report carries at the end of its last chapter (null for any other file). */
function reportOf(doc: MarkdownDoc): ReturnType<typeof extractAnalysis> {
  if (!reportCache.has(doc)) reportCache.set(doc, extractAnalysis(doc.chapters[doc.chapters.length - 1]?.raw ?? ''));
  return reportCache.get(doc) ?? null;
}

const cleanError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');

export function App() {
  const caps = window.mdedit.capabilities;
  const [drawer, setDrawer] = useState(false);
  const [ws] = useState(() => new Workspace(window.mdedit));
  const s = useWorkspace(ws);
  const [filter, setFilter] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  /** Cut / Copy / Paste / Select all for the editor, opened by press-and-hold or right-click on the text. */
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
  /** Projects in the order they were opened on this device, most recent first (saved with the settings, kept current here). */
  const [openedOrder, setOpenedOrder] = useState<string[]>([]);
  useEffect(() => setOpenedOrder((cur) => (pConfig ? [...cur, ...pConfig.recentProjects.filter((p) => !cur.includes(p))] : cur)), [pConfig?.recentProjects]);
  const [listing, setListing] = useState<RootListing | null>(null);
  const [listing_loading, setListingLoading] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [projectSettings, setProjectSettings] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [welcome, setWelcome] = useState<{ lastFolder: string | null } | null>(null);
  const [started, setStarted] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showSync, setShowSync] = useState(false);
  /** Report tabs the user switched to the Markdown text (the default is the formatted report). */
  const [rawReports, setRawReports] = useState<Set<string>>(new Set());
  const showRaw = (id: string, raw: boolean) => {
    setRawReports((cur) => {
      const next = new Set(cur);
      if (raw) next.add(id);
      else next.delete(id);
      return next;
    });
    ws.setMode(id, raw ? 'source' : 'visual');
  };
  const [showAbout, setShowAbout] = useState(false);

  const activeTab = s.tabs.find((t) => t.id === s.activeId);

  const activeDoc = activeTab ? s.docs.get(activeTab.file) : undefined;
  const activeChapter = activeDoc?.chapters[activeTab?.chapter ?? 0];

  // Comments and suggestions on the open file (stored per reviewer inside the project).
  const [showReview, setShowReview] = useState(false);
  // Zone Mode: full screen with only the open file and its navigation bar. It lasts as long as the window stays full screen,
  // so leaving full screen another way (F11, Esc from the OS) ends it too.
  const [zone, setZone] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const zoneArmed = useRef(false); // true once the window has actually gone full screen for this zone session
  const wasFullscreen = useRef(false); // full screen before Zone Mode, to go back to it
  useEffect(() => {
    if (!caps.windowChrome) return;
    void window.mdedit.windowInfo().then((i) => setFullscreen(i.fullscreen));
    return window.mdedit.onWindowState((i) => setFullscreen(i.fullscreen));
  }, [caps.windowChrome]);
  useEffect(() => {
    if (!zone) {
      zoneArmed.current = false;
      return;
    }
    if (fullscreen) zoneArmed.current = true;
    else if (zoneArmed.current) setZone(false);
  }, [zone, fullscreen]);
  const toggleZone = () => {
    if (zone) {
      setZone(false);
      if (!wasFullscreen.current) window.mdedit.windowControl('windowed');
      return;
    }
    wasFullscreen.current = fullscreen;
    setZone(true);
    if (!fullscreen) window.mdedit.windowControl('fullscreen');
  };
  const [showShare, setShowShare] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [textMenu, setTextMenu] = useState<{ x: number; y: number; sel: { anchor: Anchor; oneBlock: boolean } } | null>(null);
  const [noteRequest, setNoteRequest] = useState<{ id: number; kind: 'comment' | 'suggestion'; sel: { anchor: Anchor; oneBlock: boolean } } | null>(null);
  const [showJoin, setShowJoin] = useState(false);
  const [showSharingHome, setShowSharingHome] = useState(false);
  const [shared, setShared] = useState<SharedProject[]>([]);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [me, setMe] = useState(loadIdentity);
  const projectPath = s.project?.path ?? null;
  useEffect(() => setOpenedOrder((cur) => withOpened(cur, projectPath)), [projectPath]);
  const sameDir = (a: string, b: string) => a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
  /** Set when the open project was shared with this person: a reviewer can read and annotate it, a collaborator can edit it too. */
  const sharedHere = projectPath ? shared.find((sp) => sameDir(sp.dir, projectPath)) : undefined;
  const isCollaborator = sharedHere?.role === 'edit';
  const isReviewer = sharedHere !== undefined && !isCollaborator;
  const meHere = { id: sharedHere?.reviewerId ?? 'owner', name: me.name };
  const reviewFile = projectPath && activeTab ? activeTab.file.replace(/\\/g, '/').slice(projectPath.replace(/\\/g, '/').replace(/\/+$/, '').length + 1) : null;
  const review = useReview(
    window.mdedit,
    projectPath,
    reviewFile,
    s.activeId ? navs.current.get(s.activeId)?.review : undefined,
    meHere,
    activeTab ? `${activeTab.id}@${activeTab.chapter}@${activeTab.reloadKey}@${navVersion}` : ''
  );
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const openNote = (kind: 'comment' | 'suggestion', sel: { anchor: Anchor; oneBlock: boolean }) => {
    setShowReview(true);
    setNoteRequest((r) => ({ id: (r?.id ?? 0) + 1, kind, sel }));
  };
  /** Attaches a note to the text selected now (the phone's Comment / Suggest buttons). */
  const noteFromSelection = (tabId: string, kind: 'comment' | 'suggestion') => {
    const sel = navs.current.get(tabId)?.review?.selection();
    if (sel && (kind === 'comment' || sel.oneBlock)) openNote(kind, sel);
  };
  /** The note whose highlighted text was just clicked, so the Notes panel can bring it to the top. `n` makes every click a new request. */
  const [noteFocus, setNoteFocus] = useState<{ id: string; n: number } | null>(null);
  const onNoteClicked = useRef<(id: string) => void>(() => undefined);
  onNoteClicked.current = (id) => {
    setShowReview(true);
    setNoteFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    if (s.activeId) navs.current.get(s.activeId)?.review?.reveal(id, false); // mark the text as the active note without moving the page
  };
  useEffect(() => {
    const api = s.activeId ? navs.current.get(s.activeId)?.review : undefined;
    api?.onClick((id) => onNoteClicked.current(id));
    return () => api?.onClick(null);
  }, [s.activeId, navVersion, activeTab?.chapter, activeTab?.reloadKey]);
  /** A note that was clicked in another chapter, waiting for that chapter's editor to open so it can be shown. */
  const pendingNote = useRef<{ id: string; tabId: string; chapter: number } | null>(null);
  /**
   * Shows a note, opening the chapter it is in first. Leaving a chapter with unsaved edits goes through the usual
   * Save / Don't Save / Cancel question, and cancelling stays where you are. Returns a message when it can't be shown.
   */
  const goToNote = async (id: string): Promise<string | null> => {
    const tab = activeTab;
    const doc = tab && s.docs.get(tab.file);
    const item = review.items.find((i) => i.id === id);
    if (!tab || !doc || !item) return null;
    const texts = doc.chapters.map((c, i) => (i === tab.chapter && tab.draft !== null ? tab.draft : c.raw));
    const target = chapterForNote(texts, item.anchor, tab.chapter);
    if (target === null) return 'That text is no longer in the file, so there is nothing to show.';
    if (target === tab.chapter) {
      pendingNote.current = null;
      review.focus(id);
      return null;
    }
    pendingNote.current = { id, tabId: tab.id, chapter: target };
    await ws.openChapter(tab.file, target);
    if (ws.tabForFile(tab.file)?.chapter !== target) pendingNote.current = null; // cancelled, or the save failed
    return null;
  };
  // Once the other chapter's editor is up and has drawn its notes, scroll to the one that was clicked.
  useEffect(() => {
    const p = pendingNote.current;
    if (!p || !activeTab || activeTab.id !== p.tabId || activeTab.chapter !== p.chapter) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (navs.current.get(p.tabId)?.review?.reveal(p.id) || tries > 20) {
        clearInterval(timer);
        pendingNote.current = null;
      }
    }, 100);
    return () => clearInterval(timer);
  }, [activeTab?.id, activeTab?.chapter, activeTab?.reloadKey, navVersion, review.items]);
  const openNotes = review.items.filter((i) => i.status === 'open').length;
  // Which notes are in the open chapter's text, for the Notes panel's "This chapter only" switch. Worked out from the (deferred)
  // chapter text, so typing is never held up by it. Null when the file is a single chapter, where the switch means nothing.
  const chapterText = useDeferredValue(activeTab && activeDoc ? (activeTab.draft ?? activeDoc.chapters[activeTab.chapter]?.raw ?? '') : '');
  const multiChapter = !!activeDoc && activeDoc.chapters.length > 1;
  const notesInChapter = useMemo(() => {
    if (!showReview || !multiChapter) return null;
    const flat = flattenMarkdown(chapterText);
    return new Set(review.items.filter((i) => locateAnchor(flat, i.anchor) !== null).map((i) => i.id));
  }, [showReview, multiChapter, chapterText, review.items]);
  const activeKey = activeTab ? chapterKey(activeTab.file, activeTab.chapter) : null;
  useEffect(() => setDrawer(false), [activeKey]);
  // the pane element outlives a chapter change within a tab, so its scroll position would carry over: always start a chapter at the top
  useEffect(() => {
    if (!activeKey) return;
    document.querySelectorAll<HTMLElement>('.pane:not([hidden])').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [activeKey]);
  // On the phone, a project with nothing open starts with its file list showing.
  useEffect(() => {
    if (!caps.windowChrome && s.root && !s.activeId) setDrawer(true);
  }, [caps.windowChrome, s.root, s.activeId]);

  const rows = useMemo(
    () =>
      s.root
        ? buildRows(s.root, s.expanded, s.docs, filter, s.project?.meta.status === 'editing' ? (file) => s.project!.meta.editedChapters[relativeTo(s.project!.path, file)] ?? [] : null)
        : [],
    [s.root, s.expanded, s.docs, filter, s.project]
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
      if (cfg && !cfg.setupDone && !caps.folderPicker) await window.mdedit.setProjectsConfig({ setupDone: true }).then(setPConfig);
      else if (cfg && !cfg.setupDone) setWelcome({ lastFolder });
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

  // Google Drive sync status (phone): the button's state, and a refresh whenever a sync changed local files.
  useEffect(() => {
    if (!caps.sync) return;
    void window.mdedit.getSyncStatus().then(setSyncStatus);
    const stop = window.mdedit.onSyncStatus(setSyncStatus);
    return stop;
  }, [caps.sync]);

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

  // Projects shared with this person, and the exchange of notes with Drive for the open project.
  const reloadShared = useCallback(() => {
    if (caps.review) void window.mdedit.listShared().then(setShared).catch(() => undefined);
  }, [caps.review]);
  useEffect(reloadShared, [reloadShared, atHome]);

  const exchange = useCallback(async () => {
    if (!caps.review || !projectPath) return;
    const r = await window.mdedit.exchangeReviews(projectPath).catch(() => null);
    if (!r) return;
    setReviewNotice(r.revoked ? 'The owner has stopped sharing this project with you. Your notes stay on this device.' : r.errors[0] ?? null);
    if (r.changed) {
      reviewRef.current.reload();
      void ws.refresh(); // the other author's text may have changed too
    }
  }, [caps.review, projectPath, ws]);
  useEffect(() => {
    if (!caps.review || !projectPath) return;
    void exchange();
    const t = setInterval(() => void exchange(), 60_000);
    return () => clearInterval(t);
  }, [caps.review, projectPath, exchange]);
  const noteStamp = review.items.map((i) => i.updatedAt).join();
  useEffect(() => {
    if (!caps.review || !projectPath || !noteStamp) return;
    const t = setTimeout(() => void exchange(), 4000); // soon after a note changes
    return () => clearTimeout(t);
  }, [noteStamp, caps.review, projectPath, exchange]);
  // A sync that changed files: refresh the tree (open files reload through the usual external-change check) and the project list.
  const syncChanges = syncStatus?.localChanges ?? 0;
  useEffect(() => {
    if (syncChanges === 0) return;
    void ws.refresh();
    void reloadListing();
    reviewRef.current.reload(); // notes that arrived with the sync (a reviewer's, via the owner's other device)
  }, [syncChanges, ws, reloadListing]);
  // The switcher in the sidebar needs the list too.
  useEffect(() => {
    if (s.project) void reloadListing();
  }, [s.project?.path, reloadListing]);

  const activeDirty = activeTab !== undefined && activeTab.draft !== null;
  // Collaborators: a save is sent to the other author soon after, not at the next minute tick.
  const wasDirty = useRef(false);
  useEffect(() => {
    const saved = wasDirty.current && !activeDirty;
    wasDirty.current = activeDirty;
    if (!saved || !caps.review || !projectPath) return;
    const t = setTimeout(() => void exchange(), 5000);
    return () => clearTimeout(t);
  }, [activeDirty, caps.review, projectPath, exchange]);
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

  /** Next chapter; on the last chapter there is no next one, so the new-chapter dialog opens to add one after it. */
  const nextOrNewChapter = () => {
    const tab = s.tabs.find((t) => t.id === s.activeId);
    const doc = tab ? s.docs.get(tab.file) : undefined;
    if (!tab || !doc) return;
    if (tab.chapter < doc.chapters.length - 1) void ws.gotoChapter(1);
    // Moving on from the last chapter counts as leaving it, so the Editing stage's "Mark Edited?" comes first, then the dialog.
    else if (!isReviewer) void ws.offerMarkEdited(tab.id).then(() => promptNewChapter(tab.file, tab.chapter));
  };

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
    const reveal: MenuItem[] = caps.folderPicker ? [{ label: 'Show in File Explorer', onClick: () => ws.reveal(row.path) }] : [];
    if (row.kind === 'dir') {
      return [
        { label: 'New File Here…', onClick: () => promptNewFile(row.path) },
        { label: 'New Folder Here…', onClick: () => promptNewFolder(row.path) },
        ...(caps.importDocx ? [{ label: 'Import Word Document…', onClick: () => void ws.importDocx(row.path) }] : []),
        { label: 'Rename…', hint: 'F2', onClick: () => promptRename(row) },
        ...reveal,
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
        { label: 'Analyze Text', disabled: ws.isAnalyzing(row.path), onClick: () => void ws.analyzeFile(row.path) },
        ...(caps.export ? exportItems : []),
        { label: 'Rename…', hint: 'F2', onClick: () => promptRename(row) },
        ...reveal,
        { label: 'Delete…', danger: true, hint: 'Del', onClick: () => deleteRow(row) }
      ];
    }
    const doc = s.docs.get(row.path);
    const i = row.chapter!;
    const first = doc?.chapters[0]?.isPreamble ? 1 : 0;
    const real = !doc?.chapters[i]?.isPreamble;
    return [
      { label: 'New Chapter Below…', onClick: () => promptNewChapter(row.path, i) },
      ...(s.project
        ? [
            ws.isChapterEdited(row.path, i)
              ? { label: 'Unmark Edited', onClick: () => void ws.setChapterEdited(row.path, i, false) }
              : { label: 'Mark Edited', onClick: () => void ws.setChapterEdited(row.path, i, true) },
            { label: 'Mark Edited to Here', onClick: () => void ws.markEditedThrough(row.path, i) },
            { label: 'Unmark Edited to Here', onClick: () => void ws.unmarkEditedThrough(row.path, i) }
          ]
        : []),
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
    shared,
    onOpenShared: (dir: string) => void openProject(dir),
    onJoin: caps.review ? () => setShowJoin(true) : undefined,
    onSharing: caps.review ? () => setShowSharingHome(true) : undefined,
    onNew: () => setShowNewProject(true),
    onOpenFolder: caps.folderPicker ? () => void ws.openFolder() : undefined,
    onChangeRoot: caps.folderPicker ? () => void changeRoot() : undefined,
    onRetry: () => void reloadListing(),
    onConvert: (p: string) => void projectCall(() => window.mdedit.convertFolder(p)),
    onRename: (p: ProjectSummary) => promptProjectName('Rename project', p.name, 'Rename', (n) => window.mdedit.renameProject(p.path, n)),
    onDuplicate: (p: ProjectSummary) =>
      promptProjectName('Duplicate project', uniqueName(`${p.name} copy`, existingNames), 'Duplicate', (n) => window.mdedit.duplicateProject(p.path, n)),
    onDelete: (p: ProjectSummary) =>
      setPrompt({
        title: `Delete “${p.name}”?`,
        hint: `Its folder and everything in it (${p.files} file${p.files === 1 ? '' : 's'}) goes to the Recycle Bin.`,
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
    onReveal: caps.folderPicker ? (p: string) => ws.reveal(p) : undefined
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

  /** A Go To that is waiting for the editor of its chapter to open. */
  const pendingLine = useRef<{ id: string; chapter: number; line: number } | null>(null);
  const applyPendingLine = () => {
    const p = pendingLine.current;
    const tab = p && s.tabs.find((t) => t.id === p.id);
    const nav = p && navs.current.get(p.id);
    if (!p || !tab || !nav || s.activeId !== p.id || tab.chapter !== p.chapter) return;
    pendingLine.current = null;
    setTimeout(() => nav.goToLine(p.line), 80); // after the Go To dialog has closed and given focus back
  };

  /** Ctrl+G: asks for a line number and goes there, opening another chapter if that is where it is (unsaved edits are checked first). */
  const promptGoToLine = () => {
    const tab = activeTab;
    const doc = tab && s.docs.get(tab.file);
    if (!tab || !doc) return;
    const { rows } = docRows(doc, tab.mode);
    const total = Math.max(1, rows.reduce((a, b) => a + b, 0));
    setPrompt({
      title: 'Go to Line',
      label: `Line number (1–${total})`,
      hint: 'Lines are the rows you see on screen, blank lines included. The total is approximate for chapters you are not in.',
      initial: '',
      confirm: 'Go',
      validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= total ? null : `Enter a line number from 1 to ${total}.`),
      onSubmit: async (v) => {
        const line = Number(v);
        const at = locateRow(rows, line);
        if (at.chapter === tab.chapter) {
          pendingLine.current = null;
          setTimeout(() => navs.current.get(tab.id)?.goToLine(line), 80);
          return null;
        }
        pendingLine.current = { id: tab.id, chapter: at.chapter, line };
        await ws.openChapter(tab.file, at.chapter);
        if (ws.tabForFile(tab.file)?.chapter !== at.chapter) pendingLine.current = null; // cancelled at the unsaved-changes prompt
        return null;
      }
    });
  };

  // Row numbers depend on the width of the text, so a resized window renumbers the chapters after this one.
  const [, setLayoutTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setLayoutTick((n) => n + 1), 250);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  /** The row number the chapter starts on: one more than the rows of the chapters before it (estimated for those). */
  const firstRowOf = (doc: MarkdownDoc, chapter: number, mode: 'visual' | 'source') =>
    1 + docRows(doc, mode).rows.slice(0, chapter).reduce((a, b) => a + b, 0);

  const registerNav = (id: string, n: SceneNav | null) => {
    if (n) navs.current.set(id, n);
    else navs.current.delete(id);
    setNavVersion((v) => v + 1);
  };
  void navVersion; // re-render when an editor registers, so the find bar gets its handle
  useEffect(applyPendingLine); // a Go To into another chapter lands once that chapter's editor is up

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
    sync: () => caps.sync && setShowSync(true),
    about: () => setShowAbout(true),
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
    'next-chapter': nextOrNewChapter,
    'zone-mode': () => caps.windowChrome && toggleZone(),
    'prev-chapter': () => void ws.gotoChapter(-1),
    'undo-action': () => void ws.undoAction(),
    'redo-action': () => void ws.redoAction(),
    find: () => openFind(false),
    replace: () => openFind(true),
    'go-to-line': promptGoToLine,
    'find-next': () => findStep(1),
    'find-prev': () => findStep(-1),
    'next-scene': () => gotoScene(1),
    'prev-scene': () => gotoScene(-1),
    settings: () => setShowSettings(true),
    'toggle-mode': () => {
      if (!activeTab) return;
      if (activeDoc && reportOf(activeDoc)) showRaw(activeTab.id, !rawReports.has(activeTab.id));
      else ws.setMode(activeTab.id, activeTab.mode === 'visual' ? 'source' : 'visual');
    },
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
      else if (mod && !e.shiftKey && !e.altKey && k === 'g') name = 'go-to-line';
      else if (mod && e.shiftKey && k === 'm') name = 'toggle-mode';
      else if (e.ctrlKey && e.key === 'Tab') name = e.shiftKey ? 'prev-tab' : 'next-tab';
      else if (e.ctrlKey && e.key === 'PageDown') name = 'next-chapter';
      else if (e.ctrlKey && e.key === 'PageUp') name = 'prev-chapter';
      else if (e.key === 'F5') name = 'refresh';
      else if (e.key === 'F8' && !mod && !e.altKey && !e.shiftKey) name = 'zone-mode';
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
    <div className={`frame${caps.windowChrome ? '' : ' mobile'}${drawer ? ' drawer-open' : ''}${zone ? ' zone' : ''}`}>
    {caps.windowChrome ? (zone ? null :
      <TitleBar title={titleText} dirty={activeDirty} />
    ) : (
      <MobileBar
        title={titleText}
        dirty={activeDirty}
        showFiles={!!s.root}
        onFiles={() => setDrawer((d) => !d)}
        onHome={s.root ? () => void goHome() : undefined}
        onSave={() => void ws.save()}
        canSave={activeDirty}
        find={activeTab ? { open: find.open, onToggle: () => (find.open ? closeFind() : openFind(false)) } : undefined}
        sync={caps.sync && syncStatus ? { state: syncStatus.state, onOpen: () => setShowSync(true) } : undefined}
        onAbout={() => setShowAbout(true)}
      />
    )}
    {!s.root ? (
      <div className="app-home">
        {s.error && (
          <div className="banner error" role="alert">
            {s.error} <button onClick={() => ws.setError(null)}>Dismiss</button>
          </div>
        )}
        {caps.sync && !caps.windowChrome && syncStatus && !syncStatus.connected && started && !welcome && (
          <div className="banner info sync-banner" role="status">
            <span>Keep your projects in sync with Google Drive.</span> <button onClick={() => setShowSync(true)}>Set up sync</button>
          </div>
        )}
        {started && !welcome && (showSharingHome && caps.review ? (
          <SharingHome
            config={pConfig}
            listing={listing}
            sync={syncStatus}
            onBack={() => setShowSharingHome(false)}
            onConnect={() => setShowSync(true)}
          />
        ) : (
          <ProjectsHome {...homeProps} />
        ))}
      </div>
    ) : (
    <div className="app" style={{ gridTemplateColumns: zone ? 'minmax(0, 1fr)' : `${s.sidebarWidth}px 6px minmax(0, 1fr)` }}>
      <aside className="sidebar">
        <div className="toolbar">
          <ProjectSwitcher
            name={s.project ? s.project.meta.name : s.root?.name ?? ''}
            isProject={s.project !== null}
            projects={listing?.projects ?? []}
            currentPath={s.project?.path ?? null}
            openedOrder={openedOrder}
            onOpen={(p) => void openProject(p)}
            onHome={() => void goHome()}
            onNew={() => setShowNewProject(true)}
            onOpenFolder={caps.folderPicker ? () => void ws.openFolder() : undefined}
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
          {caps.export && (
            <button onClick={() => actions.export()} disabled={!s.root} title="Export marked books for KDP (Ctrl+E)">
              <Icon name="download" /> Export…
            </button>
          )}
          {caps.importDocx && (
            <button
              onClick={() => void ws.importDocx(dirFor(null))}
              disabled={!s.root}
              title="Import Word documents (.docx) as Markdown files"
              aria-label="Import Word document"
            >
              <Icon name="upload" /> Import
            </button>
          )}
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

      {!caps.windowChrome && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
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

        {!zone && <Tabs tabs={s.tabs} activeId={s.activeId} onActivate={(id) => ws.activateTab(id)} onClose={(id) => void ws.closeTab(id)} />}

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
            const report = reportOf(doc);
            if (report && !rawReports.has(tab.id)) {
              return (
                <section key={tab.id} className="pane report" hidden={!active} aria-label={basename(tab.file)}>
                  <ReportView file={tab.file} report={report} canSave={caps.export} onEdit={() => showRaw(tab.id, true)} />
                </section>
              );
            }
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
                    {tab.chapter >= doc.chapters.length - 1 ? (
                      <button aria-label="New chapter" title="This is the last chapter: add a new one after it (Ctrl+PgDn)" disabled={isReviewer} onClick={nextOrNewChapter}>
                        <Icon name="plus" />
                      </button>
                    ) : (
                      <button aria-label="Next chapter" title="Next chapter (Ctrl+PgDn)" onClick={nextOrNewChapter}>
                        <Icon name="right" />
                      </button>
                    )}
                    {!caps.windowChrome && !zone && (
                      <button aria-label="Go to line" onClick={promptGoToLine}>
                        Line…
                      </button>
                    )}
                    <button aria-label="Previous scene break" title="Previous scene break (Ctrl+↑)" onClick={() => gotoScene(-1)}>
                      <Icon name="up" /> Scene
                    </button>
                    <button aria-label="Next scene break" title="Next scene break (Ctrl+↓)" onClick={() => gotoScene(1)}>
                      <Icon name="down" /> Scene
                    </button>
                    {report && (
                      <button onClick={() => showRaw(tab.id, false)} title="Back to the formatted report">
                        Report
                      </button>
                    )}
                    {tab.mode === 'visual' && projectPath && (
                      <button
                        aria-label="Comments and suggestions"
                        aria-pressed={showReview}
                        title="Comments and suggestions"
                        onClick={() => setShowReview((v) => !v)}
                      >
                        Notes{openNotes > 0 ? ` (${openNotes})` : ''}
                      </button>
                    )}
                    {!isReviewer && !zone && tab.mode === 'visual' && caps.windowChrome && navs.current.get(tab.id)?.format && (
                      <span className="align-group" role="group" aria-label="Text alignment">
                        {([['left', 'alignLeft', 'Left'], ['center', 'alignCenter', 'Centre'], ['right', 'alignRight', 'Right'], ['justify', 'alignJustify', 'Justify']] as const).map(([a, icon, label]) => (
                          <button key={a} type="button" aria-label={`Align ${label.toLowerCase()}`} title={`Align ${label.toLowerCase()} (Ctrl+Shift+${a === 'left' ? 'L' : a === 'center' ? 'E' : a === 'right' ? 'R' : 'J'}); pick it again to remove`} onClick={() => navs.current.get(tab.id)?.format?.align(a)}>
                            <Icon name={icon} />
                          </button>
                        ))}
                      </span>
                    )}
                    {!isReviewer && !zone && (
                    <button
                      onClick={() => ws.setMode(tab.id, tab.mode === 'visual' ? 'source' : 'visual')}
                      title="Switch between formatted and raw Markdown (Ctrl+Shift+M)"
                    >
                      {tab.mode === 'visual' ? 'Source' : 'Visual'}
                    </button>
                    )}
                    <button className="save-btn" onClick={() => void ws.save(tab.id)} disabled={!dirty}>
                      Save (Ctrl+S)
                    </button>
                    {caps.windowChrome && (
                      <button className="zone-btn" aria-label="Zone Mode" aria-pressed={zone} title={zone ? 'Leave Zone Mode (F8)' : 'Zone Mode: full screen, just this file (F8)'} onClick={toggleZone}>
                        <Icon name={zone ? 'shrink' : 'expand'} /> Zone
                      </button>
                    )}
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
                    readOnly={isReviewer}
                    onContextMenu={
                      projectPath && caps.windowChrome
                        ? ({ x, y }) => {
                            const sel = navs.current.get(tab.id)?.review?.selectionAt(x, y);
                            if (sel) setTextMenu({ x, y, sel });
                          }
                        : undefined
                    }
                    firstLine={firstRowOf(doc, tab.chapter, 'visual')}
                  />
                ) : (
                  <SourceEditor
                    key={`${tab.id}@${tab.reloadKey}@s`}
                    raw={chapter.raw}
                    draft={tab.draft}
                    onChange={(md) => ws.setDraft(tab.id, md)}
                    savedVersion={tab.saved?.version ?? 0}
                    onNav={(n) => registerNav(tab.id, n)}
                    firstLine={firstRowOf(doc, tab.chapter, 'source')}
                  />
                )}
              </section>
            );
          })}
        </div>

        {!caps.windowChrome && activeTab && !(activeDoc && reportOf(activeDoc) && !rawReports.has(activeTab.id)) && (
          <EditBar
            key={activeTab.id}
            format={activeTab.mode === 'visual' ? navs.current.get(activeTab.id)?.format : undefined}
            onComment={activeTab.mode === 'visual' && projectPath ? () => noteFromSelection(activeTab.id, 'comment') : undefined}
            onSuggest={activeTab.mode === 'visual' && projectPath ? () => noteFromSelection(activeTab.id, 'suggestion') : undefined}
            onFind={() => openFind(false)}
          />
        )}

        {!zone && activeTab && activeDoc && activeChapter && (
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
            sync={caps.sync && caps.windowChrome && syncStatus ? { state: syncStatus.state, progress: syncStatus.progress, onOpen: () => setShowSync(true) } : undefined}
          />
        )}
      </main>

      {showReview && projectPath && activeTab?.mode === 'visual' && (
        <ReviewPanel
          state={review}
          me={meHere}
          role={isReviewer ? 'reviewer' : 'owner'}
          notice={reviewNotice}
          request={noteRequest}
          onShare={caps.review && !sharedHere ? () => setShowShare(true) : undefined}
          onAi={caps.ai && !isReviewer ? () => setShowAi(true) : undefined}
          onGoTo={goToNote}
          focus={noteFocus}
          inChapter={notesInChapter}
          onRename={(name) => {
            const next = { ...me, name };
            setMe(next);
            saveIdentity(next);
          }}
          onClose={() => setShowReview(false)}
        />
      )}
      {textMenu && (
        <ContextMenu
          x={textMenu.x}
          y={textMenu.y}
          items={[
            { label: 'Add comment…', onClick: () => openNote('comment', textMenu.sel) },
            { label: 'Suggest a change…', disabled: !textMenu.sel.oneBlock, onClick: () => openNote('suggestion', textMenu.sel) }
          ]}
          onClose={() => setTextMenu(null)}
        />
      )}
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
    {showAi && projectPath && <AiDialog project={projectPath} projectName={s.project?.meta.name ?? ''} onClose={() => setShowAi(false)} />}
    {showShare && projectPath && (
      <ShareDialog
        project={projectPath}
        projectName={s.project?.meta.name ?? ''}
        manuscript={s.project?.meta.activeManuscript ?? null}
        sync={syncStatus}
        onConnect={() => {
          setShowShare(false);
          setShowSync(true);
        }}
        onClose={() => setShowShare(false)}
      />
    )}
    {showJoin && (
      <JoinDialog
        onJoined={(sp) => {
          setMe(loadIdentity());
          setShared((l) => [...l.filter((x) => x.dir !== sp.dir), sp]);
          setShowJoin(false);
          void openProject(sp.dir);
        }}
        onClose={() => setShowJoin(false)}
      />
    )}
    {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
    {showSync && syncStatus && <SyncDialog status={syncStatus} onClose={() => setShowSync(false)} />}
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
        openedOrder={openedOrder}
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
