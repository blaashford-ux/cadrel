import { relativeTo } from '../shared/projects';
import { dirname } from '../shared/paths';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeApi } from './testing/fakeApi';
import { Workspace } from './workspace';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = '/proj';
const A = `${ROOT}/a.md`;
const B = `${ROOT}/sub/b.md`;
const BOOK = '# One\nfirst\n\n# Two\nsecond\n\n# Three\nthird\n';

let api: FakeApi;
let ws: Workspace;
const state = () => ws.getState();
const tabOf = (file: string) => state().tabs.find((t) => t.file === file)!;

beforeEach(async () => {
  api = new FakeApi(ROOT);
  api.add('a.md', BOOK);
  api.add('sub/b.md', '# Bee\nbuzz\n');
  ws = new Workspace(api, { draftDelayMs: 5, sessionDelayMs: 5 });
  await ws.openPath(ROOT);
});

describe('tabs', () => {
  it('opens one tab per file and reuses it for other chapters of the same file', async () => {
    await ws.openChapter(A, 1);
    await ws.openChapter(B, 0);
    expect(state().tabs.map((t) => [t.file, t.chapter])).toEqual([[A, 1], [B, 0]]);
    expect(state().activeId).toBe(tabOf(B).id);
    await ws.openChapter(A, 2);
    expect(state().tabs).toHaveLength(2);
    expect(tabOf(A).chapter).toBe(2);
    expect(state().activeId).toBe(tabOf(A).id);
  });

  it('switching tabs never prompts and keeps each tab’s unsaved edits', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    ws.setDraft(tabOf(A).id, '# One\nEDITED');
    ws.setDraft(tabOf(B).id, '# Bee\nBUZZ');
    ws.activateTab(tabOf(A).id);
    ws.cycleTab(1);
    ws.cycleTab(1);
    expect(api.unsavedAsked).toEqual([]);
    expect(tabOf(A).draft).toBe('# One\nEDITED');
    expect(tabOf(B).draft).toBe('# Bee\nBUZZ');
  });

  it('switching chapter inside a dirty tab prompts; Cancel stays, Don’t Save moves on', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nEDITED');
    await ws.openChapter(A, 1); // default answer: cancel
    expect(api.unsavedAsked).toEqual(['a.md']);
    expect(tabOf(A).chapter).toBe(0);
    expect(tabOf(A).draft).not.toBeNull();
    api.unsavedAnswers = ['discard'];
    await ws.openChapter(A, 1);
    expect(tabOf(A).chapter).toBe(1);
    expect(tabOf(A).draft).toBeNull();
    expect(api.text(A)).toBe(BOOK);
  });

  it('closing a clean tab does not prompt; closing a dirty one does', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    expect(await ws.closeTab(tabOf(B).id)).toBe(true);
    expect(api.unsavedAsked).toEqual([]);

    ws.setDraft(tabOf(A).id, '# One\nEDITED');
    expect(await ws.closeTab(tabOf(A).id)).toBe(false); // Cancel
    expect(state().tabs).toHaveLength(1);

    api.unsavedAnswers = ['save'];
    expect(await ws.closeTab(tabOf(A).id)).toBe(true);
    expect(state().tabs).toHaveLength(0);
    expect(state().activeId).toBeNull();
    expect(api.text(A)).toContain('EDITED');
  });

  it('Don’t Save on close discards the edit and the recovery draft', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nEDITED');
    await sleep(30);
    expect(api.drafts.has(A)).toBe(true);
    api.unsavedAnswers = ['discard'];
    expect(await ws.closeTab(tabOf(A).id)).toBe(true);
    await sleep(10);
    expect(api.text(A)).toBe(BOOK);
    expect(api.drafts.has(A)).toBe(false);
  });

  it('activates a neighbour when the active tab closes', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    await ws.openChapter(`${ROOT}/sub/b.md`, 0);
    api.add('c.md', '# C\n');
    await ws.refresh();
    await ws.openChapter(`${ROOT}/c.md`, 0);
    // tabs: A, B, C (C active)
    await ws.closeTab(tabOf(`${ROOT}/c.md`).id);
    expect(state().activeId).toBe(tabOf(B).id);
    ws.activateTab(tabOf(A).id);
    await ws.closeTab(tabOf(A).id);
    expect(state().activeId).toBe(tabOf(B).id);
  });

  it('reports the unsaved file names to the main process', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    ws.setDraft(tabOf(B).id, 'x');
    ws.setDraft(tabOf(A).id, 'y');
    ws.setDraft(tabOf(B).id, null);
    expect(api.dirtyReports.at(-1)).toEqual(['a.md']);
    ws.setDraft(tabOf(A).id, null);
    expect(api.dirtyReports.at(-1)).toEqual([]);
  });

  it('chapter navigation steps within the file and stops at the ends', async () => {
    await ws.openChapter(A, 0);
    await ws.gotoChapter(-1);
    expect(tabOf(A).chapter).toBe(0);
    await ws.gotoChapter(1);
    await ws.gotoChapter(1);
    await ws.gotoChapter(1);
    expect(tabOf(A).chapter).toBe(2);
  });
});

describe('window close / change folder', () => {
  it('walks every dirty tab; Cancel on any aborts', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    ws.setDraft(tabOf(A).id, 'a!');
    ws.setDraft(tabOf(B).id, 'b!');
    await sleep(30); // both edits autosaved for recovery
    api.unsavedAnswers = ['discard', 'cancel'];
    expect(await ws.handleCloseRequest()).toBe(false);
    expect(api.unsavedAsked).toEqual(['a.md', 'b.md']);
    // cancelling part-way throws nothing away: the edits and their recovery drafts are intact
    expect(tabOf(A).draft).toBe('a!');
    expect(api.drafts.has(A)).toBe(true);
    api.unsavedAnswers = ['discard', 'discard'];
    expect(await ws.handleCloseRequest()).toBe(true);
    expect(api.drafts.size).toBe(0);
  });

  it('close with nothing unsaved asks nothing', async () => {
    await ws.openChapter(A, 0);
    expect(await ws.handleCloseRequest()).toBe(true);
    expect(api.unsavedAsked).toEqual([]);
  });

  it('changing folder prompts for unsaved tabs first', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, 'x');
    api.pickResult = '/other';
    await ws.openFolder(); // cancel
    expect(state().root?.path).toBe(ROOT);
    api.unsavedAnswers = ['discard'];
    api.add('zzz.md', '# Z\n'); // keeps /proj non-empty; /other is empty
    await ws.openFolder();
    expect(state().root?.path).toBe('/other');
    expect(state().tabs).toEqual([]);
  });
});

describe('saving', () => {
  it('writes only the edited chapter and clears the draft', async () => {
    await ws.openChapter(A, 1);
    ws.setDraft(tabOf(A).id, '# Two\nSECOND');
    expect(await ws.save(tabOf(A).id)).toBe(true);
    expect(api.text(A)).toBe('# One\nfirst\n\n# Two\nSECOND\n\n# Three\nthird\n');
    expect(tabOf(A).draft).toBeNull();
    expect(tabOf(A).saved?.version).toBe(1);
  });

  it('saving a tab does not touch other tabs', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    ws.setDraft(tabOf(A).id, '# One\nX');
    ws.setDraft(tabOf(B).id, '# Bee\nY');
    await ws.save(tabOf(A).id);
    expect(tabOf(B).draft).toBe('# Bee\nY');
    expect(api.text(B)).toBe('# Bee\nbuzz\n');
  });

  it('keeps edits made while the save was in flight', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nv1');
    const saving = ws.save(tabOf(A).id);
    ws.setDraft(tabOf(A).id, '# One\nv2');
    await saving;
    expect(tabOf(A).draft).toBe('# One\nv2');
  });

  it('adding a Heading 1 splits the file and reloads the editor with no duplication', async () => {
    await ws.openChapter(A, 1);
    const before = tabOf(A).reloadKey;
    ws.setDraft(tabOf(A).id, '# Two\nsecond\n\n# Two-b\nextra');
    await ws.save(tabOf(A).id);
    expect(state().docs.get(A)!.chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Two-b', 'Three']);
    expect(tabOf(A).reloadKey).toBe(before + 1);
    expect(tabOf(A).draft).toBeNull();
    expect(api.text(A)!.match(/extra/g)).toHaveLength(1);
  });

  it('a failing Save keeps the draft and the tab', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nX');
    api.writeFile = async () => {
      throw new Error('disk full');
    };
    expect(await ws.save(tabOf(A).id)).toBe(false);
    expect(state().error).toMatch(/disk full/);
    expect(tabOf(A).draft).not.toBeNull();
    api.unsavedAnswers = ['save'];
    expect(await ws.closeTab(tabOf(A).id)).toBe(false); // Save failed ⇒ tab stays open
  });
});

describe('changes made outside the app', () => {
  it('reloads a clean tab silently with a notice', async () => {
    await ws.openChapter(A, 0);
    api.external(A, '# One\nEXT\n');
    await ws.checkAllOpenFiles();
    expect(state().docs.get(A)!.chapters).toHaveLength(1);
    expect(state().notice).toMatch(/a\.md changed on disk/);
    expect(tabOf(A).conflict).toBeNull();
  });

  it('ignores a touch with identical content', async () => {
    await ws.openChapter(A, 0);
    api.external(A, BOOK);
    await ws.checkAllOpenFiles();
    expect(state().notice).toBeNull();
    expect(tabOf(A).reloadKey).toBe(0);
  });

  it('raises a conflict on the right tab only when it has unsaved edits', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    ws.setDraft(tabOf(A).id, '# One\nMINE');
    api.external(A, '# One\nTHEIRS\n');
    api.external(B, '# Bee\nTHEIRS\n');
    await ws.checkAllOpenFiles();
    expect(tabOf(A).conflict?.kind).toBe('changed');
    expect(tabOf(A).draft).toBe('# One\nMINE');
    expect(tabOf(B).conflict).toBeNull(); // clean tab simply reloaded
    expect(state().docs.get(B)!.chapters[0].raw).toContain('THEIRS');
  });

  it('Reload discards my edits; Keep lets me save over without another prompt', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nMINE');
    api.external(A, '# One\nTHEIRS\n');
    await ws.checkAllOpenFiles();
    ws.resolveConflict(tabOf(A).id, 'reload');
    expect(tabOf(A).draft).toBeNull();
    expect(api.drafts.has(A)).toBe(false);

    ws.setDraft(tabOf(A).id, '# One\nMINE2');
    api.external(A, '# One\nTHEIRS2\n');
    await ws.checkAllOpenFiles();
    ws.resolveConflict(tabOf(A).id, 'keep');
    api.overwriteAnswers = [false]; // would block if asked
    expect(await ws.save(tabOf(A).id)).toBe(true);
    expect(api.text(A)).toContain('MINE2');
  });

  it('saving over an unseen outside change asks first', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nMINE');
    api.external(A, '# One\nTHEIRS\n');
    api.overwriteAnswers = [false];
    expect(await ws.save(tabOf(A).id)).toBe(false);
    expect(api.text(A)).toBe('# One\nTHEIRS\n');
    api.overwriteAnswers = [true];
    expect(await ws.save(tabOf(A).id)).toBe(true);
    expect(api.text(A)).toContain('MINE');
  });

  it('flags a deleted file', async () => {
    await ws.openChapter(A, 0);
    api.files.delete(A);
    await ws.checkAllOpenFiles();
    expect(tabOf(A).conflict?.kind).toBe('missing');
    ws.resolveConflict(tabOf(A).id, 'dismiss');
    expect(tabOf(A).conflict).toBeNull();
  });
});

describe('refresh', () => {
  it('picks up new and removed files and keeps unsaved edits', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nMINE');
    api.add('new.md', '# N\n');
    api.files.delete(B);
    await ws.refresh();
    const names = state().root!.children.map((c) => c.name);
    expect(names).toContain('new.md');
    expect(names).toContain('sub'); // the folder is still on disk, now empty
    expect(tabOf(A).draft).toBe('# One\nMINE');
  });
});

describe('autosave drafts and recovery', () => {
  it('autosaves unsaved edits after a short delay and clears them on save', async () => {
    await ws.openChapter(A, 1);
    ws.setDraft(tabOf(A).id, '# Two\nDRAFT');
    expect(api.drafts.has(A)).toBe(false);
    await sleep(40);
    expect(api.drafts.get(A)).toMatchObject({ chapter: 1, title: 'Two', markdown: '# Two\nDRAFT' });
    expect(tabOf(A).autosavedAt).not.toBeNull();
    await ws.save(tabOf(A).id);
    await sleep(10);
    expect(api.drafts.has(A)).toBe(false);
  });

  it('a save that lands while the autosave write is in flight leaves no stale draft', async () => {
    await ws.openChapter(A, 0);
    const slow = api.saveDraft;
    api.saveDraft = async (d) => {
      await sleep(20);
      return slow(d);
    };
    ws.setDraft(tabOf(A).id, '# One\nX');
    await sleep(10); // autosave started, still writing
    await ws.save(tabOf(A).id);
    await sleep(60);
    expect(api.drafts.has(A)).toBe(false);
  });

  it('restores an autosaved draft as unsaved edits on the right chapter', async () => {
    api.drafts.set(A, { file: A, chapter: 1, title: 'Two', markdown: '# Two\nRECOVERED', updatedAt: 1 });
    await ws.openPath(ROOT, true);
    expect(tabOf(A).chapter).toBe(1);
    expect(tabOf(A).draft).toBe('# Two\nRECOVERED');
    expect(state().notice).toMatch(/Recovered/);
    expect(api.text(A)).toBe(BOOK); // nothing written until the user saves
  });

  it('finds the chapter by title if the numbering moved', async () => {
    api.drafts.set(A, { file: A, chapter: 0, title: 'Three', markdown: '# Three\nR', updatedAt: 1 });
    await ws.openPath(ROOT, true);
    expect(tabOf(A).chapter).toBe(2);
  });

  it('Discard throws the draft away', async () => {
    api.drafts.set(A, { file: A, chapter: 0, title: 'One', markdown: 'x', updatedAt: 1 });
    api.recoverAnswers = [false];
    await ws.openPath(ROOT, true);
    expect(state().tabs).toEqual([]);
    expect(api.drafts.size).toBe(0);
  });

  it('keeps the text as a new file when its chapter no longer exists', async () => {
    api.drafts.set(A, { file: A, chapter: 1, title: 'Deleted Chapter', markdown: '# Deleted Chapter\nprecious', updatedAt: 1 });
    await ws.openPath(ROOT, true);
    expect(api.text(`${ROOT}/a (recovered).md`)).toBe('# Deleted Chapter\nprecious');
    expect(api.drafts.size).toBe(0);
    expect(api.text(A)).toBe(BOOK);
  });

  it('ignores drafts of vanished files and of other folders', async () => {
    api.drafts.set(`${ROOT}/gone.md`, { file: `${ROOT}/gone.md`, chapter: 0, title: '', markdown: 'x', updatedAt: 1 });
    api.drafts.set('/elsewhere/z.md', { file: '/elsewhere/z.md', chapter: 0, title: '', markdown: 'x', updatedAt: 1 });
    await ws.openPath(ROOT, true);
    expect(api.drafts.has(`${ROOT}/gone.md`)).toBe(false);
    expect(api.drafts.has('/elsewhere/z.md')).toBe(true);
    expect(state().tabs).toEqual([]);
  });
});

describe('session restore', () => {
  it('saves the layout and brings it back, skipping files that vanished', async () => {
    await ws.openChapter(A, 2);
    await ws.openChapter(B, 0);
    ws.setMode(tabOf(B).id, 'source');
    await ws.toggleExpanded(`${ROOT}/sub`, false);
    ws.activateTab(tabOf(A).id);
    ws.flushSessionNow();
    const saved = api.sessions.get(ROOT)!;
    expect(saved.tabs.map((t) => [t.file, t.chapter, t.mode])).toEqual([[A, 2, 'visual'], [B, 0, 'source']]);
    expect(saved.active).toBe(A);

    api.sessions.set(ROOT, { ...saved, tabs: [...saved.tabs, { file: `${ROOT}/ghost.md`, chapter: 0, mode: 'visual' }] });
    const again = new Workspace(api, { draftDelayMs: 5, sessionDelayMs: 5 });
    await again.init();
    const s = again.getState();
    expect(s.tabs.map((t) => [t.file, t.chapter, t.mode])).toEqual([[A, 2, 'visual'], [B, 0, 'source']]);
    expect(s.tabs.find((t) => t.id === s.activeId)!.file).toBe(A);
    expect(s.expanded.has(`${ROOT}/sub`)).toBe(true);
  });

  it('clamps a remembered chapter that no longer exists', async () => {
    api.sessions.set(ROOT, { tabs: [{ file: A, chapter: 99, mode: 'visual' }], active: A, expanded: [] });
    await ws.openPath(ROOT, true);
    expect(tabOf(A).chapter).toBe(2);
  });

  it('remembers the sidebar width', async () => {
    api.prefs = { sidebarWidth: 410 };
    const again = new Workspace(api);
    await again.init();
    expect(again.getState().sidebarWidth).toBe(410);
    again.setSidebarWidth(5000, true);
    expect(api.prefs.sidebarWidth).toBe(640);
    again.setSidebarWidth(10, true);
    expect(api.prefs.sidebarWidth).toBe(180);
  });
});

describe('file operations', () => {
  it('creates a file with a starting heading, expands its folder and opens it', async () => {
    expect(await ws.createFile(`${ROOT}/sub`, 'ideas')).toBe(true);
    expect(api.text(`${ROOT}/sub/ideas.md`)).toBe('# ideas\n\n');
    expect(state().tabs.map((t) => t.file)).toContain(`${ROOT}/sub/ideas.md`);
    expect(state().expanded.has(`${ROOT}/sub`)).toBe(true);
  });

  it('reports a name clash without opening anything', async () => {
    expect(await ws.createFile(ROOT, 'a')).toBe(false);
    expect(state().error).toMatch(/already exists/);
    expect(state().tabs).toEqual([]);
  });

  it('renaming a file keeps its tab, unsaved edits and chapter', async () => {
    await ws.openChapter(A, 1);
    ws.setDraft(tabOf(A).id, '# Two\nWIP');
    expect(await ws.renameNode(A, 'renamed')).toBe(true);
    const t = state().tabs[0];
    expect(t.file).toBe(`${ROOT}/renamed.md`);
    expect(t.draft).toBe('# Two\nWIP');
    expect(t.chapter).toBe(1);
    expect(state().docs.has(`${ROOT}/renamed.md`)).toBe(true);
    expect(state().docs.has(A)).toBe(false);
    await ws.save(t.id);
    expect(api.text(`${ROOT}/renamed.md`)).toContain('WIP');
  });

  it('renaming a folder moves every open file inside it', async () => {
    await ws.openChapter(B, 0);
    await ws.toggleExpanded(`${ROOT}/sub`, false);
    await ws.renameNode(`${ROOT}/sub`, 'deeper');
    expect(state().tabs[0].file).toBe(`${ROOT}/deeper/b.md`);
    expect(state().expanded.has(`${ROOT}/deeper`)).toBe(true);
  });

  it('deleting asks first, closes the file’s tabs (even unsaved) and trashes it', async () => {
    await ws.openChapter(A, 0);
    await ws.openChapter(B, 0);
    ws.setDraft(tabOf(B).id, 'x');
    api.deleteAnswers = [false];
    expect(await ws.deleteNode(`${ROOT}/sub`, 'folder')).toBe(false);
    expect(state().tabs).toHaveLength(2);
    api.deleteAnswers = [true];
    expect(await ws.deleteNode(`${ROOT}/sub`, 'folder')).toBe(true);
    expect(api.trashed).toEqual([`${ROOT}/sub`]);
    expect(state().tabs.map((t) => t.file)).toEqual([A]);
    expect(api.unsavedAsked).toEqual([]); // the delete confirmation already warned about it
  });

  it('a failed trash leaves tabs untouched', async () => {
    await ws.openChapter(A, 0);
    api.failTrash = true;
    expect(await ws.deleteNode(A, 'file')).toBe(false);
    expect(state().tabs).toHaveLength(1);
    expect(state().error).toMatch(/trash unavailable/);
  });
});

describe('folders', () => {
  it('shows empty folders', async () => {
    api.addDir('empty');
    await ws.refresh();
    const empty = state().root!.children.find((c) => c.name === 'empty');
    expect(empty).toMatchObject({ kind: 'dir', children: [] });
  });

  it('creates a folder, refreshes the tree and reveals it', async () => {
    await ws.toggleExpanded(`${ROOT}/sub`, false);
    const p = await ws.createFolder(`${ROOT}/sub`, '  chapters ');
    expect(p).toBe(`${ROOT}/sub/chapters`);
    const sub = state().root!.children.find((c) => c.name === 'sub') as { children: { name: string }[] };
    expect(sub.children.map((c) => c.name)).toContain('chapters');
  });

  it('expands the parents of a folder created deep inside a collapsed tree', async () => {
    await ws.createFolder(`${ROOT}/sub`, 'inner');
    expect(state().expanded.has(`${ROOT}/sub`)).toBe(true);
  });

  it('reports a clash and returns null', async () => {
    api.addDir('dup');
    expect(await ws.createFolder(ROOT, 'dup')).toBeNull();
    expect(state().error).toMatch(/already exists/);
  });

  it('a new empty folder can receive a file straight away', async () => {
    const dir = (await ws.createFolder(ROOT, 'fresh'))!;
    expect(await ws.createFile(dir, 'first')).toBe(true);
    expect(api.text(`${ROOT}/fresh/first.md`)).toBe('# first\n\n');
  });

  it('renames and deletes an empty folder', async () => {
    const dir = (await ws.createFolder(ROOT, 'tmp'))!;
    expect(await ws.renameNode(dir, 'tmp2')).toBe(true);
    expect(state().root!.children.map((c) => c.name)).toContain('tmp2');
    expect(await ws.deleteNode(`${ROOT}/tmp2`, 'folder')).toBe(true);
    expect(state().root!.children.map((c) => c.name)).not.toContain('tmp2');
  });
});

describe('chapter structure from the sidebar', () => {
  it('adds a chapter after another and opens it', async () => {
    expect(await ws.newChapter(A, 0, 'Interlude')).toBe(true);
    expect(api.text(A)).toBe('# One\nfirst\n\n# Interlude\n\n# Two\nsecond\n\n# Three\nthird\n');
    expect(tabOf(A).chapter).toBe(1);
    expect(state().docs.get(A)!.chapters.map((c) => c.title)).toEqual(['One', 'Interlude', 'Two', 'Three']);
  });

  it('moves a chapter, and the open tab follows the chapter it was showing', async () => {
    await ws.openChapter(A, 1); // Two
    expect(await ws.moveChapter(A, 1, 1)).toBe(2);
    expect(state().docs.get(A)!.chapters.map((c) => c.title)).toEqual(['One', 'Three', 'Two']);
    expect(tabOf(A).chapter).toBe(2); // still on Two
    expect(await ws.moveChapter(A, 2, -1)).toBe(1);
    expect(tabOf(A).chapter).toBe(1);
  });

  it('a tab on the neighbour that got swapped follows it too', async () => {
    await ws.openChapter(A, 2); // Three
    await ws.moveChapter(A, 1, 1); // Two <-> Three
    expect(tabOf(A).chapter).toBe(1); // Three is now at 1
  });

  it('refuses impossible moves without touching the file', async () => {
    expect(await ws.moveChapter(A, 0, -1)).toBeNull();
    expect(api.writes).toEqual([]);
  });

  it('deleting a chapter asks first, then removes it and shifts the open tab', async () => {
    await ws.openChapter(A, 2);
    api.deleteAnswers = [false];
    expect(await ws.deleteChapter(A, 0)).toBe(false);
    expect(api.writes).toEqual([]);
    expect(await ws.deleteChapter(A, 0)).toBe(true);
    expect(state().docs.get(A)!.chapters.map((c) => c.title)).toEqual(['Two', 'Three']);
    expect(tabOf(A).chapter).toBe(1); // still on Three
  });

  it('resolves unsaved edits in that file first', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nWIP');
    await ws.moveChapter(A, 1, 1); // default: cancel
    expect(api.writes).toEqual([]);
    api.unsavedAnswers = ['save'];
    await ws.moveChapter(A, 1, 1);
    expect(api.text(A)).toContain('WIP');
    expect(state().docs.get(A)!.chapters.map((c) => c.title)).toEqual(['One', 'Three', 'Two']);
  });
});

describe('mark for export', () => {
  it('marks a file, shows it as marked in the tree, and lists it', async () => {
    expect(ws.markedFiles()).toEqual([]);
    expect(await ws.setMarked(A, true)).toBe(true);
    expect(ws.markedFiles()).toEqual([A]);
    const node = state().root!.children.find((c) => c.name === 'a.md');
    expect(node).toMatchObject({ marked: true });
  });

  it('unmarking keeps the saved details but clears the badge', async () => {
    await ws.setMarked(A, true);
    await ws.setMarked(A, false);
    expect(ws.markedFiles()).toEqual([]);
    expect(api.books.get(A)).toMatchObject({ marked: false });
  });

  it('tells you when unreadable export settings were replaced (and backed up)', async () => {
    api.damagedOnMark = true;
    await ws.setMarked(A, true);
    expect(state().notice).toMatch(/couldn’t be read and were replaced.*\.bak/);
  });

  it('reports a failure and leaves the tree alone', async () => {
    api.setMarked = async () => {
      throw new Error('read-only folder');
    };
    expect(await ws.setMarked(A, true)).toBe(false);
    expect(state().error).toMatch(/Could not mark the file: read-only folder/);
  });

  it('lists orphaned export settings and can re-link them to a file', async () => {
    api.orphans = [`${ROOT}/old.export.json`];
    await ws.refresh();
    expect(ws.orphanSidecars()).toEqual([`${ROOT}/old.export.json`]);
    expect(await ws.relinkSidecar(`${ROOT}/old.export.json`, A)).toBe(true);
    expect(ws.orphanSidecars()).toEqual([]);
    expect(api.books.has(A)).toBe(true);
  });
});

describe('files opened from outside (double-click / Open with / second launch)', () => {
  it('a file inside the open folder opens as a tab and its folder is expanded', async () => {
    expect(await ws.openExternalFile(B)).toBe(true);
    expect(state().tabs.map((t) => t.file)).toEqual([B]);
    expect(state().activeId).toBe(tabOf(B).id);
    expect(state().expanded.has(`${ROOT}/sub`)).toBe(true);
    expect(state().root?.path).toBe(ROOT);
  });

  it('a file that is already open is activated, not duplicated', async () => {
    await ws.openChapter(A, 2);
    await ws.openChapter(B, 0);
    expect(await ws.openExternalFile(A)).toBe(true);
    expect(state().tabs).toHaveLength(2);
    expect(state().activeId).toBe(tabOf(A).id);
    expect(tabOf(A).chapter).toBe(2); // keeps the chapter you were on
  });

  it('a file in another folder switches the open folder to its folder', async () => {
    api.files.set('/other/x.md', { text: '# X\nbody\n', mtime: 1 });
    expect(await ws.openExternalFile('/other/x.md')).toBe(true);
    expect(state().root?.path).toBe('/other');
    expect(state().tabs.map((t) => t.file)).toEqual(['/other/x.md']);
  });

  it('asks about unsaved edits before leaving the current folder; Cancel keeps everything', async () => {
    api.files.set('/other/x.md', { text: '# X\n', mtime: 1 });
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nUNSAVED');
    expect(await ws.openExternalFile('/other/x.md')).toBe(false); // default answer: cancel
    expect(state().root?.path).toBe(ROOT);
    expect(tabOf(A).draft).toBe('# One\nUNSAVED');
    api.unsavedAnswers = ['discard'];
    expect(await ws.openExternalFile('/other/x.md')).toBe(true);
    expect(state().root?.path).toBe('/other');
  });

  it('opening within the current folder never prompts, even with unsaved edits', async () => {
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nUNSAVED');
    await ws.openExternalFile(B);
    expect(api.unsavedAsked).toEqual([]);
    expect(tabOf(A).draft).toBe('# One\nUNSAVED');
  });

  it('a missing file reports an error and opens nothing', async () => {
    expect(await ws.openExternalFile(`${ROOT}/nope.md`)).toBe(false);
    expect(state().error).toBeTruthy();
    expect(state().tabs).toEqual([]);
  });

  it('takes the queued launch files in order and opens each', async () => {
    api.launchFiles = [A, B];
    await ws.openLaunchFiles();
    expect(state().tabs.map((t) => t.file)).toEqual([A, B]);
    expect(state().activeId).toBe(tabOf(B).id);
    expect(api.launchFiles).toEqual([]); // each file is handed out once
    await ws.openLaunchFiles(); // nothing left: no change
    expect(state().tabs).toHaveLength(2);
  });

  it('restores the other folder’s saved tabs when its file is opened', async () => {
    api.files.set('/other/x.md', { text: '# X\n', mtime: 1 });
    api.files.set('/other/y.md', { text: '# Y\n', mtime: 2 });
    api.sessions.set('/other', { tabs: [{ file: '/other/y.md', chapter: 0, mode: 'visual' }], active: '/other/y.md', expanded: [] });
    await ws.openExternalFile('/other/x.md');
    expect(state().tabs.map((t) => t.file)).toEqual(['/other/y.md', '/other/x.md']);
    expect(state().activeId).toBe(tabOf('/other/x.md').id);
  });
});

describe('chapter heading level setting', () => {
  const LEVEL2 = '# Book\n\nintro\n\n## One\nfirst\n\n## Two\nsecond\n\n### Deep\nx\n\n## Three\nthird\n';
  const defaultsWith = (chapterLevel: number) => ({ ...api.appDefaults, chapterLevel });

  it('loads the saved level on init', async () => {
    api.appDefaults = defaultsWith(2);
    api.add('lv.md', LEVEL2);
    const w = new Workspace(api, { draftDelayMs: 5, sessionDelayMs: 5 });
    await w.init();
    await w.openPath(ROOT);
    await w.openChapter(`${ROOT}/lv.md`, 1);
    expect(w.getState().chapterLevel).toBe(2);
    expect(w.getState().docs.get(`${ROOT}/lv.md`)!.chapters.map((c) => c.title)).toEqual(['', 'One', 'Two', 'Three']);
  });

  it('changing the level re-splits open files and keeps each tab on the same text', async () => {
    api.add('lv.md', LEVEL2);
    await ws.openChapter(`${ROOT}/lv.md`, 0); // level 1: "Book" is chapter 0
    expect(state().docs.get(`${ROOT}/lv.md`)!.chapters).toHaveLength(1);
    expect(await ws.applyAppDefaults(defaultsWith(2))).toBe(true);
    expect(state().chapterLevel).toBe(2);
    expect(api.appDefaults.chapterLevel).toBe(2);
    const doc = state().docs.get(`${ROOT}/lv.md`)!;
    expect(doc.chapters.map((c) => c.title)).toEqual(['', 'One', 'Two', 'Three']);
    expect(tabOf(`${ROOT}/lv.md`).chapter).toBe(0); // was at the very top: still in the preamble
    expect(api.text(`${ROOT}/lv.md`)).toBe(LEVEL2); // never rewrites files
  });

  it('keeps a tab on the chapter that contains its position', async () => {
    api.add('lv.md', LEVEL2);
    await ws.applyAppDefaults(defaultsWith(2));
    await ws.openChapter(`${ROOT}/lv.md`, 2); // "Two"
    await ws.applyAppDefaults(defaultsWith(3));
    const doc = state().docs.get(`${ROOT}/lv.md`)!;
    expect(doc.chapters.map((c) => c.title)).toEqual(['', 'Deep']);
    expect(tabOf(`${ROOT}/lv.md`).chapter).toBe(0); // "Two" starts before "Deep", so it is in the preamble now
    await ws.applyAppDefaults(defaultsWith(1));
    expect(tabOf(`${ROOT}/lv.md`).chapter).toBe(0);
  });

  it('asks about unsaved edits first, and Cancel changes nothing', async () => {
    api.add('lv.md', LEVEL2);
    await ws.openChapter(`${ROOT}/lv.md`, 0);
    ws.setDraft(tabOf(`${ROOT}/lv.md`).id, '# Book EDITED\n');
    api.unsavedAnswers = ['cancel'];
    expect(await ws.applyAppDefaults(defaultsWith(2))).toBe(false);
    expect(state().chapterLevel).toBe(1);
    expect(api.appDefaults.chapterLevel).toBe(1);
    expect(tabOf(`${ROOT}/lv.md`).draft).toBe('# Book EDITED\n');

    api.unsavedAnswers = ['discard'];
    expect(await ws.applyAppDefaults(defaultsWith(2))).toBe(true);
    expect(tabOf(`${ROOT}/lv.md`).draft).toBeNull();
    expect(state().chapterLevel).toBe(2);
  });

  it('changing something else does not prompt or re-split', async () => {
    api.add('lv.md', LEVEL2);
    await ws.openChapter(`${ROOT}/lv.md`, 0);
    ws.setDraft(tabOf(`${ROOT}/lv.md`).id, '# Book EDITED\n');
    const next = { ...api.appDefaults, book: { ...api.appDefaults.book, author: 'New Default' } };
    expect(await ws.applyAppDefaults(next)).toBe(true);
    expect(api.unsavedAsked).toEqual([]);
    expect(api.appDefaults.book.author).toBe('New Default');
    expect(tabOf(`${ROOT}/lv.md`).draft).toBe('# Book EDITED\n');
  });

  it('structural edits and saves use the level', async () => {
    api.add('lv.md', '## One\na\n\n## Two\nb\n');
    await ws.applyAppDefaults(defaultsWith(2));
    await ws.newChapter(`${ROOT}/lv.md`, 0, 'Middle');
    expect(api.text(`${ROOT}/lv.md`)).toBe('## One\na\n\n## Middle\n\n## Two\nb\n');
    await ws.openChapter(`${ROOT}/lv.md`, 0);
    ws.setDraft(tabOf(`${ROOT}/lv.md`).id, '## One\nchanged');
    await ws.save();
    expect(api.text(`${ROOT}/lv.md`)).toBe('## One\nchanged\n\n## Middle\n\n## Two\nb\n');
    expect(state().docs.get(`${ROOT}/lv.md`)!.chapters.map((c) => c.title)).toEqual(['One', 'Middle', 'Two']);
  });

  it('a new book from Mark for Export uses the template', async () => {
    api.appDefaults = { ...api.appDefaults, book: { ...api.appDefaults.book, author: 'Template Author' } };
    await ws.setMarked(A, true);
    expect(api.books.get(A)).toMatchObject({ marked: true, author: 'Template Author', title: 'a' });
  });
});

describe('replace in file', () => {
  const find = { query: 'dave', caseSensitive: false, wholeWord: true, regex: false };

  it('rewrites every chapter on disk, keeps the structure, and reloads the open tab', async () => {
    api.add('r.md', '# One\nDave went home.\n\n# Two\nHe met dave. Davey stayed.\n\n# Three\nnone\n');
    await ws.openChapter(`${ROOT}/r.md`, 1);
    const n = await ws.replaceInFile(`${ROOT}/r.md`, find, 'Mark');
    expect(n).toBe(2);
    expect(api.text(`${ROOT}/r.md`)).toBe('# One\nMark went home.\n\n# Two\nHe met Mark. Davey stayed.\n\n# Three\nnone\n');
    expect(state().docs.get(`${ROOT}/r.md`)!.chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
    expect(tabOf(`${ROOT}/r.md`).chapter).toBe(1);
    expect(tabOf(`${ROOT}/r.md`).draft).toBeNull();
  });

  it('asks about unsaved edits first; Cancel changes nothing', async () => {
    api.add('r.md', '# One\nDave\n');
    await ws.openChapter(`${ROOT}/r.md`, 0);
    ws.setDraft(tabOf(`${ROOT}/r.md`).id, '# One\nDave EDITED');
    api.unsavedAnswers = ['cancel'];
    expect(await ws.replaceInFile(`${ROOT}/r.md`, find, 'Mark')).toBeNull();
    expect(api.text(`${ROOT}/r.md`)).toBe('# One\nDave\n');
    expect(tabOf(`${ROOT}/r.md`).draft).toBe('# One\nDave EDITED');
  });

  it('Save first applies the replacement to the saved edits too', async () => {
    api.add('r.md', '# One\nDave\n');
    await ws.openChapter(`${ROOT}/r.md`, 0);
    ws.setDraft(tabOf(`${ROOT}/r.md`).id, '# One\nDave and Dave');
    api.unsavedAnswers = ['save'];
    expect(await ws.replaceInFile(`${ROOT}/r.md`, find, 'Mark')).toBe(2);
    expect(api.text(`${ROOT}/r.md`)).toBe('# One\nMark and Mark\n');
  });

  it('works with regular expressions and capture groups, and refuses a bad pattern', async () => {
    api.add('r.md', '# One\nChapter 3 and chapter 12\n');
    expect(await ws.replaceInFile(`${ROOT}/r.md`, { ...find, wholeWord: false, regex: true, query: 'chapter (\\d+)' }, 'Part $1')).toBe(2);
    expect(api.text(`${ROOT}/r.md`)).toBe('# One\nPart 3 and Part 12\n');
    expect(await ws.replaceInFile(`${ROOT}/r.md`, { ...find, regex: true, query: '(' }, 'x')).toBeNull();
  });

  it('zero matches writes nothing new but still succeeds with 0', async () => {
    api.add('r.md', '# One\nnothing\n');
    const before = api.writes.length;
    expect(await ws.replaceInFile(`${ROOT}/r.md`, find, 'x')).toBe(0);
    expect(api.text(`${ROOT}/r.md`)).toBe('# One\nnothing\n');
    expect(api.writes.length).toBeGreaterThanOrEqual(before);
  });

  it('a replacement that introduces a heading re-splits the file', async () => {
    api.add('r.md', '# One\nSPLIT HERE and more\n');
    await ws.openChapter(`${ROOT}/r.md`, 0);
    await ws.replaceInFile(`${ROOT}/r.md`, { query: 'SPLIT HERE', caseSensitive: true, wholeWord: false, regex: false }, '\n# Two\n');
    expect(state().docs.get(`${ROOT}/r.md`)!.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
  });
});

describe('undo / redo of structural actions', () => {
  const F = `${ROOT}/u.md`;
  const BOOK5 = '# One\na\n\n# Two\nb\n\n# Three\nc\n\n# Four\nd\n';
  const titles = () => state().docs.get(F)!.chapters.map((c) => c.title);

  it('undoes a chapter delete, restoring the file and the open chapter', async () => {
    api.add('u.md', BOOK5);
    await ws.openChapter(F, 1);
    api.deleteAnswers = [true];
    await ws.deleteChapter(F, 1);
    expect(titles()).toEqual(['One', 'Three', 'Four']);
    expect(state().undoLabels).toEqual(['Delete chapter “Two”']);
    expect(await ws.undoAction()).toBe(true);
    expect(api.text(F)).toBe(BOOK5);
    expect(titles()).toEqual(['One', 'Two', 'Three', 'Four']);
    expect(tabOf(F).chapter).toBe(1);
    expect(state().undoLabels).toEqual([]);
    expect(state().redoLabels).toEqual(['Delete chapter “Two”']);
    expect(state().notice).toMatch(/Undid: Delete chapter/);
  });

  it('redo re-applies it', async () => {
    api.add('u.md', BOOK5);
    api.deleteAnswers = [true];
    await ws.openChapter(F, 0);
    await ws.deleteChapter(F, 2);
    await ws.undoAction();
    expect(await ws.redoAction()).toBe(true);
    expect(titles()).toEqual(['One', 'Two', 'Four']);
    expect(state().redoLabels).toEqual([]);
    expect(state().undoLabels).toHaveLength(1);
  });

  it('keeps only the last 5 actions and unwinds them in order', async () => {
    api.add('u.md', '# A\n');
    await ws.openChapter(F, 0);
    for (const t of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) await ws.newChapter(F, state().docs.get(F)!.chapters.length - 1, t);
    expect(titles()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(state().undoLabels).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(await ws.undoAction()).toBe(true);
    expect(titles()).toEqual(['A', 'B', 'C']); // seven actions made, the oldest two fell off
    expect(await ws.undoAction()).toBe(false);
    expect(state().notice).toBe('Nothing to undo.');
  });

  it('undoes moving a chapter and adding one', async () => {
    api.add('u.md', BOOK5);
    await ws.openChapter(F, 0);
    await ws.moveChapter(F, 1, 1);
    expect(titles()).toEqual(['One', 'Three', 'Two', 'Four']);
    await ws.newChapter(F, 0, 'Extra');
    expect(state().undoLabels).toEqual(['Move chapter “Two” down', 'Add chapter “Extra”']);
    await ws.undoAction();
    await ws.undoAction();
    expect(api.text(F)).toBe(BOOK5);
  });

  it('undoes a whole-file Replace All', async () => {
    api.add('u.md', '# One\nDave\n\n# Two\nDave\n');
    await ws.openChapter(F, 0);
    await ws.replaceInFile(F, { query: 'dave', caseSensitive: false, wholeWord: false, regex: false }, 'Mark');
    expect(api.text(F)).toBe('# One\nMark\n\n# Two\nMark\n');
    expect(state().undoLabels[0]).toMatch(/Replace “dave” with “Mark”/);
    await ws.undoAction();
    expect(api.text(F)).toBe('# One\nDave\n\n# Two\nDave\n');
  });

  it('a new action clears what could be redone', async () => {
    api.add('u.md', BOOK5);
    api.deleteAnswers = [true];
    await ws.openChapter(F, 0);
    await ws.deleteChapter(F, 3);
    await ws.undoAction();
    expect(state().redoLabels).toHaveLength(1);
    await ws.newChapter(F, 0, 'X');
    expect(state().redoLabels).toEqual([]);
  });

  it('refuses (and drops the entry) when the file was changed after the action', async () => {
    api.add('u.md', BOOK5);
    api.deleteAnswers = [true];
    await ws.openChapter(F, 0);
    await ws.deleteChapter(F, 3);
    api.external(F, '# One\nedited elsewhere\n');
    expect(await ws.undoAction()).toBe(false);
    expect(state().error).toMatch(/has been changed since/);
    expect(api.text(F)).toBe('# One\nedited elsewhere\n');
    expect(state().undoLabels).toEqual([]);
  });

  it('asks about unsaved edits first; Cancel keeps the action undoable', async () => {
    api.add('u.md', BOOK5);
    api.deleteAnswers = [true];
    await ws.openChapter(F, 0);
    await ws.deleteChapter(F, 3);
    ws.setDraft(tabOf(F).id, '# One\nTYPING');
    api.unsavedAnswers = ['cancel'];
    expect(await ws.undoAction()).toBe(false);
    expect(state().undoLabels).toHaveLength(1);
    expect(tabOf(F).draft).toBe('# One\nTYPING');
    api.unsavedAnswers = ['discard'];
    expect(await ws.undoAction()).toBe(true);
    expect(api.text(F)).toBe(BOOK5);
  });

  it('follows a renamed file, forgets deleted ones, and starts empty in a new folder', async () => {
    api.add('u.md', BOOK5);
    api.deleteAnswers = [true, true];
    await ws.openChapter(F, 0);
    await ws.deleteChapter(F, 3);
    await ws.renameNode(F, 'renamed.md');
    expect(await ws.undoAction()).toBe(true);
    expect(api.text(`${ROOT}/renamed.md`)).toBe(BOOK5);
    await ws.deleteChapter(`${ROOT}/renamed.md`, 3);
    await ws.deleteNode(`${ROOT}/renamed.md`, 'file');
    expect(state().undoLabels).toEqual([]);
    await ws.deleteChapter(`${ROOT}/a.md`, 0);
    await ws.openPath(ROOT);
    expect(state().undoLabels).toEqual([]);
  });

  it('nothing to redo says so', async () => {
    expect(await ws.redoAction()).toBe(false);
    expect(state().notice).toBe('Nothing to redo.');
  });
});

describe('projects in the workspace', () => {
  const PROJ = ROOT; // the fake folder is the project

  it('a folder with a project marker opens as a project and remembers it', async () => {
    api.addProject(PROJ, { name: 'The Lost King' });
    await ws.openPath(PROJ);
    expect(state().project?.meta.name).toBe('The Lost King');
    expect(api.lastProject).toBe(PROJ);
    expect(state().progress?.total).toBeGreaterThan(0);
  });

  it('an ordinary folder is not a project', async () => {
    await ws.openPath(ROOT);
    expect(state().project).toBeNull();
    expect(api.lastProject).toBeNull();
  });

  it('the project’s chapter level overrides the app’s, and falls back when it has none', async () => {
    api.add('lv.md', '# Book\n\n## One\na\n\n## Two\nb\n');
    api.appDefaults = { ...api.appDefaults, chapterLevel: 1 };
    await ws.init();
    api.addProject(PROJ, { overrides: { chapterLevel: 2, book: null } });
    await ws.openPath(PROJ);
    await ws.openChapter(`${ROOT}/lv.md`, 0);
    expect(state().chapterLevel).toBe(2);
    expect(state().docs.get(`${ROOT}/lv.md`)!.chapters.map((c) => c.title)).toEqual(['', 'One', 'Two']);
    api.projectMetas.clear();
    await ws.openPath(ROOT);
    expect(state().chapterLevel).toBe(1);
  });

  it('changing the app level does not change a project that has its own', async () => {
    api.addProject(PROJ, { overrides: { chapterLevel: 2, book: null } });
    await ws.openPath(PROJ);
    await ws.applyAppDefaults({ ...api.appDefaults, chapterLevel: 3 });
    expect(state().chapterLevel).toBe(2);
    api.projectMetas.set(PROJ, { ...api.projectMetas.get(PROJ)!, overrides: { chapterLevel: null, book: null } });
    await ws.openPath(PROJ);
    expect(state().chapterLevel).toBe(3);
  });

  it('editing the project’s settings re-splits the open files, asking about unsaved edits first', async () => {
    api.add('lv.md', '# Book\n\n## One\na\n');
    const meta = api.addProject(PROJ);
    await ws.openPath(PROJ);
    await ws.openChapter(`${ROOT}/lv.md`, 0);
    ws.setDraft(tabOf(`${ROOT}/lv.md`).id, '# Book EDIT');
    api.unsavedAnswers = ['cancel'];
    expect(await ws.updateProjectMeta({ ...meta, overrides: { chapterLevel: 2, book: null } })).toBe(false);
    expect(state().chapterLevel).toBe(1);
    api.unsavedAnswers = ['discard'];
    expect(await ws.updateProjectMeta({ ...meta, overrides: { chapterLevel: 2, book: null } })).toBe(true);
    expect(state().chapterLevel).toBe(2);
    expect(state().project?.meta.overrides.chapterLevel).toBe(2);
  });

  it('closing the project returns to the home state, after resolving unsaved edits', async () => {
    api.addProject(PROJ);
    await ws.openPath(PROJ);
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\nEDIT');
    api.unsavedAnswers = ['cancel'];
    expect(await ws.closeProject()).toBe(false);
    expect(state().root).not.toBeNull();
    api.unsavedAnswers = ['discard'];
    expect(await ws.closeProject()).toBe(true);
    expect(state()).toMatchObject({ root: null, project: null, progress: null, tabs: [] });
    expect(api.lastProject).toBeNull();
  });

  it('saving schedules a progress count', async () => {
    api.addProject(PROJ);
    await ws.openPath(PROJ);
    const before = state().progress?.total ?? 0;
    await ws.openChapter(A, 0);
    ws.setDraft(tabOf(A).id, '# One\n' + 'word '.repeat(50));
    await ws.save();
    await sleep(1700);
    expect(state().progress!.total).toBeGreaterThan(before);
  });

  it('openProject refuses a folder that is not a project', async () => {
    expect(await ws.openProject('/nowhere')).toBe(false);
    expect(state().error).toMatch(/not a project/);
  });

  it('Active Manuscript: one at a time, swapped without prompting, and it follows a rename', async () => {
    api.addProject(PROJ, { name: 'Saga' });
    await ws.openPath(PROJ);
    expect(await ws.setActiveManuscript(A)).toBe(true);
    expect(state().project?.meta.activeManuscript).toBe(relativeTo(PROJ, A));
    expect(state().progress?.manuscript).toBe(relativeTo(PROJ, A));
    expect(await ws.setActiveManuscript(B)).toBe(true);
    expect(state().project?.meta.activeManuscript).toBe(relativeTo(PROJ, B));
    expect(await ws.renameNode(B, 'Renamed.md')).toBe(true);
    expect(state().project?.meta.activeManuscript).toBe(relativeTo(PROJ, dirname(B) + '/Renamed.md'));
    expect(await ws.setActiveManuscript(null)).toBe(true);
    expect(state().project?.meta.activeManuscript).toBeNull();
  });
});
