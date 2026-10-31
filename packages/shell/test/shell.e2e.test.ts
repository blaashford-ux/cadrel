// Not type-checked with the shell (it imports the Worker, which needs Cloudflare's types, not the DOM ones): vitest checks it by running it.
// Drives the real built shell in Electron: Home and Dashboard, Write and Market in their own views, and the shell-level
// behaviour (navigation, layout, isolation, persistence, the unsaved-edits close guard).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { strFromU8, unzipSync } from 'fflate';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Library } from '@cadrel/market-library';
import { ACCOUNT, TOKEN, serveFakeCloudflare } from './fakeCloudflare';

const PKG = path.resolve(__dirname, '..');
const electronBin = (() => {
  try {
    return createRequire(path.join(PKG, 'package.json'))('electron') as string;
  } catch {
    return '';
  }
})();
// Set to the packaged app's executable (see `npm run pack`) to run this whole suite against the installed layout.
const PACKAGED = process.env.CADREL_PACKAGED_BIN;
const have = (PACKAGED ? fs.existsSync(PACKAGED) : electronBin !== '' && fs.existsSync(electronBin)) && (!!process.env.DISPLAY || !fs.existsSync('/usr/bin/xvfb-run'));
const PORT = 48321;

let tmp: string;
let home: string;
let userData: string;
const running: ElectronApplication[] = [];

async function launch(over: { userData?: string; home?: string; env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await electron.launch({
    executablePath: PACKAGED ?? electronBin,
    args: PACKAGED ? ['--no-sandbox'] : ['--no-sandbox', PKG],
    env: { ...process.env, CADREL_TEST: '1', CADREL_USER_DATA: over.userData ?? userData, HOME: over.home ?? home, USERPROFILE: over.home ?? home, ...over.env }
  });
  running.push(app);
  const shell = await app.firstWindow();
  await shell.waitForSelector('nav.rail');
  return { app, shell };
}

const moduleView = (app: ElectronApplication, id: 'write' | 'market') => app.windows().find((w) => w.url().includes(`/modules/${id}/`));
const views = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => ({ visible: (v as any).getVisible() as boolean, ...(v as any).getBounds() })));
async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const get = (port: number) =>
  new Promise<number>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });

describe.skipIf(!have)('Cadrel shell in Electron', () => {
  beforeAll(async () => {
    // In CI a missing Electron or display is a failure, not a reason to skip the only test of the whole shell.
    if (process.env.CI && !have) throw new Error('CI needs Electron and a display for the shell e2e tests');
    if (!PACKAGED && !fs.existsSync(path.join(PKG, 'dist', 'main.mjs'))) execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-e2e-'));
    home = path.join(tmp, 'home');
    userData = path.join(tmp, 'userdata');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(userData, 'studios', 'local', 'market'), { recursive: true });
    // A library is needed for Cadrel Market's capture server to start (as in the standalone app).
    fs.mkdirSync(path.join(tmp, 'library'));
    fs.writeFileSync(path.join(userData, 'studios', 'local', 'market', 'config.json'), JSON.stringify({ libraryRoot: path.join(tmp, 'library'), port: PORT }));
  }, 180_000);

  afterAll(async () => {
    await Promise.all(running.map((a) => a.close().catch(() => undefined)));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('opens on Home with the rail, real data from both modules, and the capture server already listening', async () => {
    const { app, shell } = await launch();
    expect(await shell.title()).toBe('Cadrel');
    expect(await shell.locator('.rail-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Home', 'My Books', 'Dashboard', 'Planner', 'Projects', 'Files', 'Notes', 'Write', 'Market', 'Finance', 'Extensions', 'Admin', 'Profile', 'Settings']);
    await shell.getByRole('heading', { level: 2 }).waitFor();
    // Write has no projects yet; Market's server is up even though its page was never opened.
    await shell.getByText('No projects yet').waitFor();
    await shell.getByText(`Listening for captures on port ${PORT}`).waitFor();
    expect(await get(PORT)).toBeGreaterThan(0);
    // Neither module's view exists until it is first opened.
    expect(await views(app)).toEqual([]);
    await app.close();
  }, 60_000);

  it('hosts Write and Market in their own views, each with only its own bridge', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    expect(await write.evaluate(() => [typeof (window as any).cadrelWrite, typeof (window as any).cadrel, typeof (window as any).cadrelMarket])).toEqual(['object', 'undefined', 'undefined']);

    await shell.getByRole('button', { name: 'Market', exact: true }).click();
    const market = await waitFor(() => moduleView(app, 'market'), 'the Market view');
    await market.getByRole('tab', { name: 'Queue' }).waitFor();
    expect(await market.evaluate(() => [typeof (window as any).cadrelMarket, typeof (window as any).cadrel, typeof (window as any).cadrelWrite])).toEqual(['object', 'undefined', 'undefined']);
    expect(await shell.evaluate(() => [typeof (window as any).cadrel, typeof (window as any).cadrelWrite, typeof (window as any).cadrelMarket])).toEqual(['object', 'undefined', 'undefined']);

    // Only the page you are on is showing, and it fills everything beside the rail.
    const v = await views(app);
    expect(v.map((x) => x.visible)).toEqual([false, true]);
    for (const x of v) expect(x).toMatchObject({ x: 64, y: 0 });
    await shell.getByRole('button', { name: 'Home', exact: true }).click();
    await waitFor(async () => (await views(app)).every((x) => !x.visible), 'every module view to hide');
    await waitFor(async () => (await shell.locator('.rail-btn[aria-current="page"]').getAttribute('aria-label')) === 'Home', 'Home to be highlighted');
    await app.close();
  }, 90_000);

  it('a module view cannot drive the shell', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    // The view has no cadrel bridge, so even a hand-rolled IPC call is the only route; it must be refused.
    const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as any;
      const handler = (ipcMain as any)._invokeHandlers.get('shell:navigate');
      try {
        await handler({ sender: view.webContents }, 'market');
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toBe(true);
    expect(await shell.locator('.rail-btn[aria-current="page"]').getAttribute('aria-label')).toBe('Write');
    void write;
    await app.close();
  }, 60_000);

  it('Scope: the rail shows the Project and Book, every module view is told, only the shell can change it, and it survives a restart', async () => {
    // Its own Studio: the projects made here must not be in the one the other tests share.
    const h = fs.mkdtempSync(path.join(tmp, 'scope-home-'));
    const ud = fs.mkdtempSync(path.join(tmp, 'scope-data-'));
    const first = await launch({ home: h, userData: ud });
    const { app, shell } = first;
    const studio = (fn: string, ...args: unknown[]) => shell.evaluate(([f, a]) => (window as any).cadrel.studio[f as string](...(a as unknown[])), [fn, args] as const);
    const scopeNow = () => shell.evaluate(() => (window as any).cadrel.scope.get());
    expect(await shell.locator('.scope-btn').count()).toBe(0); // no projects: nothing to scope

    const series = (await studio('createProject', { name: 'Dragon Rider', kind: 'Series' })) as { id: string };
    await shell.locator('.scope-btn').waitFor();
    expect(await shell.locator('.scope-btn').innerText()).toBe('Dragon Rider');
    const b1 = (await studio('createProject', { name: 'Book 1', parentId: series.id, kind: 'Book' })) as { id: string };
    const b2 = (await studio('createProject', { name: 'Book 2', parentId: series.id, kind: 'Book' })) as { id: string };
    await waitFor(async () => (await shell.locator('.scope-btn').innerText()).includes('All books'), 'the rail to offer all books');
    expect(await scopeNow()).toMatchObject({ projectName: 'Dragon Rider', book: null, bookName: null, books: [b1.id, b2.id], bookImplied: false });

    // Every module view has the read-only bridge and hears about a change.
    const seen: Record<string, Page> = {};
    for (const [label, id] of [['Write', 'write'], ['Market', 'market'], ['Finance', 'finance']] as const) {
      await shell.getByRole('button', { name: label, exact: true }).click();
      seen[id] = await waitFor(() => app.windows().find((w) => w.url().includes(`/modules/${id}/`)), `the ${label} view`);
      expect(await seen[id]!.evaluate(() => Object.keys((window as any).cadrelScope).sort())).toEqual(['get', 'onChange']);
      expect(await seen[id]!.evaluate(async () => (await (window as any).cadrelScope.get()).projectName)).toBe('Dragon Rider');
      await seen[id]!.evaluate(() => {
        (window as any).heard = [];
        (window as any).cadrelScope.onChange((s: { bookName: string | null }) => (window as any).heard.push(s.bookName));
      });
    }
    await shell.getByRole('button', { name: 'Home', exact: true }).click();
    const afterSet = await shell.evaluate((id) => (window as any).cadrel.scope.set({ book: id }), b2.id);
    expect(afterSet.bookName).toBe('Book 2');
    for (const id of ['write', 'market', 'finance']) await waitFor(async () => (await seen[id]!.evaluate(() => (window as any).heard)).includes('Book 2'), `the ${id} view to hear the change`);
    expect(await shell.locator('.scope-btn').innerText()).toContain('Book 2');

    // A module view can ask but not change, even by calling the channel itself.
    const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as any;
      const set = (ipcMain as any)._invokeHandlers.get('shell:scope:set');
      try {
        await set({ sender: view.webContents }, { book: null });
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toBe(true);
    expect((await scopeNow()).bookName).toBe('Book 2');

    // A Book that is not the Project's is dropped, and archiving the Book in scope moves the scope on and tells everyone.
    const other = (await studio('createProject', { name: 'The Lost King' })) as { id: string };
    const lostBook = (await studio('createProject', { name: 'The Lost King', parentId: other.id, kind: 'Book' })) as { id: string };
    expect(await shell.evaluate((id) => (window as any).cadrel.scope.set({ book: id }), lostBook.id)).toMatchObject({ projectName: 'Dragon Rider', bookName: null });
    await shell.evaluate((id) => (window as any).cadrel.scope.set({ book: id }), b2.id);
    await studio('archiveProject', b2.id, true);
    await waitFor(async () => (await scopeNow()).bookImplied === true, 'the scope to move off the archived Book');
    expect(await scopeNow()).toMatchObject({ projectName: 'Dragon Rider', book: b1.id });
    await shell.evaluate((id) => (window as any).cadrel.scope.set({ project: id }), other.id);
    expect(await scopeNow()).toMatchObject({ projectName: 'The Lost King', book: lostBook.id, bookImplied: true });
    await app.close();

    // Remembered for the Studio across a restart.
    const second = await launch({ home: h, userData: ud });
    await second.shell.locator('.scope-btn').waitFor();
    expect(await second.shell.evaluate(() => (window as any).cadrel.scope.get().then((s: any) => s.projectName))).toBe('The Lost King');
    await second.app.close();
  }, 150_000);

  it('Books: only a Book has a stage; a Book can be closed (hidden from the scope), shown again and reopened; a standalone gets its Book; a Project can be given its first Book', async () => {
    const h = fs.mkdtempSync(path.join(tmp, 'books-home-'));
    const ud = fs.mkdtempSync(path.join(tmp, 'books-data-'));
    const { app, shell } = await launch({ home: h, userData: ud });
    const call = <T,>(fn: string, ...args: unknown[]) => shell.evaluate(([f, a]) => { const [ns, name] = (f as string).split('.'); return (window as any).cadrel[ns!][name!](...(a as unknown[])); }, [fn, args] as const) as Promise<T>;
    const scopeNow = () => call<any>('scope.get');
    const stageOf = async (id: string) => (await call<Record<string, any>>('stages.views'))[id]?.stage?.name ?? null;

    const series = await call<{ id: string }>('manage.create', { name: 'Dragon Rider', kind: 'Series', template: null });
    const b1 = await call<{ id: string }>('manage.create', { name: 'Book 1', parentId: series.id, kind: 'Book', template: null });
    const b2 = await call<{ id: string }>('manage.create', { name: 'Book 2', parentId: series.id, kind: 'Book', template: null });
    expect(await stageOf(series.id)).toBeNull(); // a Project has no stage
    expect(await stageOf(b1.id)).toBe('Planning');
    expect(await stageOf(b2.id)).toBe('Planning');

    // The Project page: Books, not a stage, for the Project; a stage for the Book.
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByRole('heading', { level: 3, name: 'Books' }).waitFor();
    expect(await shell.getByRole('heading', { level: 3, name: 'Stage of this book' }).count()).toBe(0);
    expect(await shell.locator('.book-list li').allInnerTexts()).toEqual([expect.stringContaining('Book 1'), expect.stringContaining('Book 2')]);

    // Closing a Book hides it from the scope; the Project page still lists it only when closed Books are shown.
    await shell.locator('.book-list li', { hasText: 'Book 1' }).getByRole('button', { name: 'Close book' }).click();
    await waitFor(async () => (await scopeNow()).closed.includes(b1.id), 'Book 1 to close');
    expect(await scopeNow()).toMatchObject({ books: [b2.id], closed: [b1.id], book: b2.id, bookImplied: true, showClosed: false });
    expect(await stageOf(b1.id)).toBe('Published');
    await waitFor(async () => (await shell.locator('.book-list li').count()) === 1, 'the closed Book to leave the list');
    await shell.getByLabel('Show closed books').click(); // it follows the scope, which answers after a round trip, so not .check()
    await waitFor(async () => (await scopeNow()).showClosed === true, 'closed Books to be shown');
    expect(await scopeNow()).toMatchObject({ books: [b1.id, b2.id], book: null });
    expect(await shell.locator('.book-list li', { hasText: 'Book 1' }).innerText()).toContain('closed');

    // Reopen it into a stage that is not a closing one.
    await shell.locator('.book-list li', { hasText: 'Book 1' }).getByRole('button', { name: 'Reopen…' }).click();
    await shell.getByRole('group', { name: 'Reopen into' }).getByRole('button').first().click();
    await waitFor(async () => (await scopeNow()).closed.length === 0, 'Book 1 to reopen');
    expect(await stageOf(b1.id)).not.toBe('Published');

    // A standalone novel is a Project holding one Book, which has the stage.
    const solo = await call<{ id: string }>('manage.create', { name: 'The Lost King', kind: 'Standalone', template: null });
    const tree = (await call<any>('studio.state')).tree;
    const kids = tree.projects.filter((p: any) => p.parentId === solo.id);
    expect(kids.map((k: any) => [k.name, k.kind])).toEqual([['The Lost King', 'Book']]);
    expect(await stageOf(solo.id)).toBeNull();
    expect(await stageOf(kids[0].id)).toBe('Planning');

    // A Project from before, with a manuscript folder and a stage, is given its first Book: the folder moves to it, with the stage.
    const old = await call<{ id: string }>('manage.create', { name: 'Old Project', kind: 'Series', template: 'novel' });
    await app.evaluate(async () => undefined);
    const before = (await call<any>('studio.state')).tree.links.find((l: any) => l.module === 'write' && l.projectId === old.id);
    expect(before).toBeTruthy();
    await shell.evaluate((id) => (window as any).cadrel.scope.set({ project: id }), old.id);
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.locator('.tree-row', { hasText: 'Old Project' }).click();
    await shell.getByRole('heading', { level: 2, name: 'Old Project' }).waitFor();
    await shell.getByRole('button', { name: 'Add first book' }).click();
    await waitFor(async () => (await call<any>('studio.state')).tree.projects.some((p: any) => p.parentId === old.id), 'the first Book');
    const after = (await call<any>('studio.state')).tree;
    const first = after.projects.find((p: any) => p.parentId === old.id);
    expect(first).toMatchObject({ name: 'Old Project', kind: 'Book' });
    expect(after.links.find((l: any) => l.module === 'write' && l.ref === before.ref).projectId).toBe(first.id); // the folder moved to the Book
    expect(await stageOf(first.id)).toBe('Planning');
    await app.close();
  }, 150_000);

  it('Write shows only the manuscripts of the Project and Book in scope; a closed Book is read-only; leaving the scope closes what is open', async () => {
    const h = fs.mkdtempSync(path.join(tmp, 'wscope-home-'));
    const ud = fs.mkdtempSync(path.join(tmp, 'wscope-data-'));
    const { app, shell } = await launch({ home: h, userData: ud });
    const call = <T,>(fn: string, ...args: unknown[]) => shell.evaluate(([f, a]) => { const [ns, name] = (f as string).split('.'); return (window as any).cadrel[ns!][name!](...(a as unknown[])); }, [fn, args] as const) as Promise<T>;
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    const folder = (name: string) => write.evaluate(async (n) => { const api = (window as any).cadrelWrite; const cfg = await api.getProjectsConfig(); await api.createProject(n, cfg.templates[0].id); }, name);
    for (const n of ['Dragon Bible', 'Ember', 'Ash', 'Lost King']) await folder(n);
    // A chapter in Ember, to try editing once Book 1 is closed.
    const root = await write.evaluate(async () => (await (window as any).cadrelWrite.getProjectsConfig()).root as string);
    fs.writeFileSync(path.join(root, 'Ember', 'Manuscript', 'Draft.md'), '# One\n\nThe king had been lost.\n');

    const series = await call<{ id: string }>('manage.create', { name: 'Dragon Rider', kind: 'Series', template: null });
    const b1 = await call<{ id: string }>('manage.create', { name: 'Book 1', parentId: series.id, kind: 'Book', template: null });
    const b2 = await call<{ id: string }>('manage.create', { name: 'Book 2', parentId: series.id, kind: 'Book', template: null });
    const lost = await call<{ id: string }>('manage.create', { name: 'The Lost King', kind: 'Series', template: null });
    for (const [id, ref] of [[series.id, 'Dragon Bible'], [b1.id, 'Ember'], [b2.id, 'Ash'], [lost.id, 'Lost King']] as const) await call('studio.link', id, 'write', ref);
    await call('scope.set', { project: series.id, book: null });

    const cards = () => write.locator('.project-card .card-name').allInnerTexts().then((t) => t.sort());
    await waitFor(async () => JSON.stringify(await cards()) === JSON.stringify(['Ash', 'Dragon Bible', 'Ember']), 'Write to list only Dragon Rider’s manuscripts');
    expect(await write.getByRole('heading', { level: 1 }).innerText()).toBe('Dragon Rider');
    expect(await write.locator('.project-card', { hasText: 'Dragon Bible' }).locator('.chip').first().innerText()).toBe('Series');
    expect(await write.locator('.project-card', { hasText: 'Ember' }).locator('.chip').first().innerText()).toBe('Book 1');
    expect(await write.getByText(/1 more belong to other projects/).count()).toBe(1);

    // Naming a Book leaves the series and that Book (not the other Book).
    await call('scope.set', { book: b2.id });
    await waitFor(async () => JSON.stringify(await cards()) === JSON.stringify(['Ash', 'Dragon Bible']), 'Write to follow the Book');

    // Another Project shows its own.
    await call('scope.set', { project: lost.id });
    await waitFor(async () => JSON.stringify(await cards()) === JSON.stringify(['Lost King']), 'Write to follow the Project');

    // Closed Books are hidden; shown, they are marked and read-only.
    await call('scope.set', { project: series.id, book: null });
    await call('stages.close', b1.id);
    await waitFor(async () => JSON.stringify(await cards()) === JSON.stringify(['Ash', 'Dragon Bible']), 'the closed Book to leave Write');
    await call('scope.set', { showClosed: true });
    await waitFor(async () => (await cards()).includes('Ember'), 'the closed Book to come back');
    expect(await write.locator('.project-card', { hasText: 'Ember' }).innerText()).toContain('closed');
    await write.locator('.project-card', { hasText: 'Ember' }).click();
    await write.getByText(/This book is closed/).waitFor();
    await write.locator('[role=treeitem]', { hasText: 'Manuscript' }).first().click();
    await write.locator('[role=treeitem]', { hasText: 'Draft.md' }).first().click();
    await write.locator('.ProseMirror').first().waitFor();
    expect(await write.locator('.ProseMirror').first().getAttribute('contenteditable')).toBe('false'); // a closed Book can be read, not changed
    expect(await write.getByRole('button', { name: 'New file' }).count()).toBe(0);

    // Leaving the scope while it is open sends Write back to the list.
    await call('scope.set', { project: lost.id });
    await write.getByRole('heading', { level: 1 }).filter({ hasText: 'The Lost King' }).waitFor();
    expect(await write.getByText(/This book is closed/).count()).toBe(0);
    expect(await cards()).toEqual(['Lost King']);
    await app.close();
  }, 150_000);

  it('Dashboard and Home show a project made in Write', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    await write.evaluate(async () => {
      const api = (window as any).cadrelWrite;
      const cfg = await api.getProjectsConfig();
      await api.createProject('The Lost King', cfg.templates[0].id);
    });
    await shell.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await shell.getByRole('row', { name: /The Lost King/ }).waitFor();
    expect(await shell.getByText('1 project').count()).toBeGreaterThan(0);
    await shell.getByRole('button', { name: 'Home', exact: true }).click();
    await shell.locator('.project-name', { hasText: 'The Lost King' }).waitFor();
    await app.close();
  }, 90_000);

  it('remembers the page it was on', async () => {
    const first = await launch();
    await first.shell.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await first.shell.getByRole('heading', { name: 'Writing' }).waitFor();
    await first.app.close();
    const second = await launch();
    await waitFor(async () => (await second.shell.locator('.rail-btn[aria-current="page"]').getAttribute('aria-label')) === 'Dashboard', 'Dashboard to be restored');
    await second.app.close();
  }, 90_000);

  it('Write\'s AI Kit and Market\'s Claude connection are the same single server', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();

    // Write: the AI server settings and the kit it saves for Claude Desktop.
    const server = await write.evaluate(() => (window as any).cadrelWrite.getAiServer());
    expect(server.args[0]).toMatch(/mcp\.mjs$/);
    const dest: string = await write.evaluate(() => (window as any).cadrelWrite.exportAiKit());
    expect(path.basename(dest)).toBe('Cadrel AI Kit');
    const files = fs.readdirSync(dest);
    expect(files).toEqual(expect.arrayContaining(['README.txt', 'cadrel.mcpb', 'connect-settings.txt', 'skills']));
    expect(files).not.toContain('cadrel-write.mcpb');
    const ext = unzipSync(fs.readFileSync(path.join(dest, 'cadrel.mcpb')));
    expect(JSON.parse(strFromU8(ext['manifest.json']!))).toMatchObject({ name: 'cadrel', display_name: 'Cadrel' });
    const launcher = strFromU8(ext['server/index.js']!);
    expect(launcher).toContain("label");
    expect(launcher).toMatch(/"name":"cadrel"/); // it answers Claude's handshake as the one server
    expect(launcher).toMatch(/mcp\.mjs/);
    expect(fs.readdirSync(path.join(dest, 'skills'))).toContain('cadrel-line-edit.zip');
    expect(fs.readFileSync(path.join(dest, 'connect-settings.txt'), 'utf8')).toContain('claude mcp add cadrel --');

    // Market: its own "connect to Claude" gives the same server under the same name.
    const market = await (async () => {
      await shell.getByRole('button', { name: 'Market', exact: true }).click();
      return waitFor(() => moduleView(app, 'market'), 'the Market view');
    })();
    await market.getByRole('tab', { name: 'Queue' }).waitFor();
    const cfg = await market.evaluate(() => (window as any).cadrelMarket.mcpConfig());
    expect(JSON.parse(cfg.claudeDesktop).mcpServers).toHaveProperty('cadrel');
    expect(cfg.args[0]).toBe(server.args[0]);
    expect(cfg.args).toContain('--library');
    const built = await market.evaluate(() => (window as any).cadrelMarket.installClaudeExtension());
    expect(path.basename(built.file)).toBe('Cadrel.mcpb');
    expect(JSON.parse(strFromU8(unzipSync(fs.readFileSync(built.file))['manifest.json']!))).toMatchObject({ name: 'cadrel' });
    await app.close();
  }, 120_000);

  it('Projects: a series with a book under it, a manuscript linked, a note on it; all of it survives a restart', async () => {
    const first = await launch();
    const { app, shell } = first;
    // A manuscript made in Write, to link.
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    await write.evaluate(async () => {
      const api = (window as any).cadrelWrite;
      const cfg = await api.getProjectsConfig();
      await api.createProject('Dragon Rider 1', cfg.templates[0].id);
    });

    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByText('Start with a project').waitFor();
    await shell.getByRole('button', { name: 'New project' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Dragon Rider');
    await shell.getByRole('dialog').getByPlaceholder(/Series, Book/).fill('Series');
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByRole('heading', { level: 2, name: 'Dragon Rider' }).waitFor();

    await shell.getByRole('button', { name: 'Add book' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Book 1');
    await shell.getByRole('dialog').getByPlaceholder(/Series, Book/).fill('Book');
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByRole('heading', { level: 2, name: 'Book 1' }).waitFor();
    expect(await shell.locator('.tree-row').allInnerTexts()).toEqual(['Dragon Rider', 'Book 1']);
    expect(await shell.locator('.crumbs').innerText()).toContain('Dragon Rider');

    // A duplicate name is refused with a message, not a crash.
    await shell.locator('.tree-row', { hasText: 'Dragon Rider' }).first().click();
    await shell.getByRole('button', { name: 'Add book' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('book 1');
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByRole('alert').getByText(/already exists/).waitFor();
    await shell.getByRole('button', { name: 'Cancel' }).click();

    // Link the manuscript to the book, and the book's words roll up (the template manuscript is short, so just check the link and the picker).
    await shell.locator('.tree-row', { hasText: 'Book 1' }).click();
    await shell.getByLabel('Link to this project').selectOption('write:Dragon Rider 1');
    await shell.getByRole('button', { name: 'Link', exact: true }).click();
    await shell.locator('.links li', { hasText: 'Dragon Rider 1' }).waitFor();

    // A note on the book appears on the series (its subprojects count) and on the Notes page.
    await shell.getByLabel('New note').fill('Check the dragon\'s age against book 2.');
    await shell.getByRole('button', { name: 'Add note' }).click();
    await shell.locator('.cn-note', { hasText: "dragon's age" }).waitFor();
    await shell.locator('.tree-row', { hasText: 'Dragon Rider' }).first().locator('.count').waitFor();
    await shell.getByRole('button', { name: 'Notes', exact: true }).click();
    await shell.locator('.cn-note', { hasText: "dragon's age" }).waitFor();
    await app.close();

    const second = await launch();
    await second.shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await second.shell.locator('.tree-row', { hasText: 'Book 1' }).waitFor();
    await second.shell.locator('.tree-row', { hasText: 'Book 1' }).click();
    await second.shell.locator('.links li', { hasText: 'Dragon Rider 1' }).waitFor();
    await second.shell.locator('.cn-note', { hasText: "dragon's age" }).waitFor();
    await second.app.close();
  }, 150_000);

  it('Settings: one appearance setting recolours Home, Write and Market together', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    await shell.getByRole('button', { name: 'Market', exact: true }).click();
    const market = await waitFor(() => moduleView(app, 'market'), 'the Market view');
    await market.getByRole('tab', { name: 'Queue' }).waitFor();
    const css = (page: Page, v: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase(), v);
    const dark = (page: Page) => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

    // Playwright pins pages to a light colour scheme; let the app's own setting decide.
    for (const p of [shell, write, market]) await p.emulateMedia({ colorScheme: null });
    await shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await shell.getByRole('radio', { name: 'Light' }).click();
    await waitFor(async () => !(await dark(shell)) && !(await dark(write)) && !(await dark(market)), 'every page to be light');
    // Cadrel's own light palette reaches all three: paper for the page (Write's --bg) and the window tone behind it (Market's --bg).
    expect(await css(shell, '--bg')).toBe('#faf8f3');
    expect(await css(write, '--bg')).toBe('#faf8f3');
    expect(await css(market, '--bg')).toBe('#e8e4da');

    await shell.getByRole('radio', { name: 'Dark' }).click();
    await waitFor(async () => (await dark(shell)) && (await dark(write)) && (await dark(market)), `every page to be dark (${[await dark(shell), await dark(write), await dark(market)]})`);
    expect(await css(shell, '--bg')).toBe('#142531');
    expect(await css(market, '--accent')).toBe('#d1c7b8');

    // A changed accent colour reaches all of them.
    // (the form opened on the light theme, since the page was light when it was drawn)
    await shell.getByRole('tab', { name: /Dark theme/ }).click();
    const accent = shell.getByLabel('Accent hex value');
    await accent.fill('#2a7f62');
    await waitFor(async () => (await css(write, '--accent')) === '#2a7f62' && (await css(market, '--accent')) === '#2a7f62' && (await css(shell, '--accent')) === '#2a7f62', `the accent to reach every page (${[await css(shell, '--accent'), await css(write, '--accent'), await css(market, '--accent')]})`);
    // Write's own Settings says where the colours are set, instead of offering a second place.
    await app.close();

    // And it is still dark with that accent after a restart.
    const again = await launch();
    await again.shell.emulateMedia({ colorScheme: null });
    await waitFor(async () => (await dark(again.shell)) && (await css(again.shell, '--accent')) === '#2a7f62', 'the choice to be remembered');
    await again.app.close();
  }, 150_000);

  it('Market: a Notes button beside a category uses the same Notes as everywhere, and the note shows up in the shell', async () => {
    // A captured bestseller list, so Market has a category to write on.
    const fixture = path.resolve(PKG, '../../fixtures/amazon-com/bestsellers-kindle-humorous-fantasy.html.gz');
    const lib = Library.open(path.join(tmp, 'library'));
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: zlib.gunzipSync(fs.readFileSync(fixture)).toString('utf8'), capturedAt: '2026-10-17T00:00:00Z' } as never);
    lib.close();

    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Market', exact: true }).click();
    const market = await waitFor(() => moduleView(app, 'market'), 'the Market view');
    await market.getByRole('tab', { name: 'Analysis' }).click();
    await market.getByRole('button', { name: /^Notes/ }).click();
    const box = market.getByRole('dialog', { name: /Notes on/ });
    await box.getByLabel('New note').fill('Prices in this category look thin.');
    await box.getByLabel('Topic').fill('pricing');
    await box.getByRole('button', { name: 'Add note' }).click();
    await box.locator('.cn-note', { hasText: 'look thin' }).waitFor();
    await market.keyboard.press('Escape');
    await market.getByRole('button', { name: /^Notes/ }).locator('.cn-count').waitFor();

    // Same note, studio-wide: on the shell's Notes page, labelled with the Market category it is about.
    await shell.getByRole('button', { name: 'Notes', exact: true }).click();
    const note = shell.locator('.cn-note', { hasText: 'look thin' });
    await note.waitFor();
    expect(await note.innerText()).toContain('pricing');

    // Link the category to a project: the note now belongs to it.
    const key = await market.evaluate(async () => (await (window as any).cadrelMarket.categories())[0].key);
    await shell.evaluate(async (k) => {
      const s = (window as any).cadrel.studio;
      const p = await s.createProject({ name: 'Humorous fantasy line' });
      await s.link(p.id, 'market', k);
    }, key);
    // (a note already written stays where it was written; a new one on a linked record goes to its project)
    await market.getByRole('button', { name: /^Notes/ }).click();
    await market.getByRole('dialog').getByLabel('New note').fill('Second note, now linked.');
    await market.getByRole('dialog').getByRole('button', { name: 'Add note' }).click();
    await market.getByRole('dialog').locator('.cn-note', { hasText: 'Second note' }).waitFor();
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.locator('.tree-row', { hasText: 'Humorous fantasy line' }).click();
    await shell.locator('.cn-note', { hasText: 'Second note' }).waitFor();

    // A page can only change notes on its own records: Write's view may not use Market's channels.
    const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const h = (ipcMain as any)._invokeHandlers.get('host:notes:list');
      try {
        await h({ sender: BrowserWindow.getAllWindows()[0]!.webContents }, { kind: 'category', id: 'x' });
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toBe(true);
    await app.close();
  }, 120_000);

  it('Profile: the user object holds the name, pen names and attached files, and its name goes on notes everywhere', async () => {
    const doc = path.join(tmp, 'Author bio.txt');
    fs.writeFileSync(doc, 'Blake writes fantasy.');
    const first = await launch();
    const { app, shell } = first;
    await shell.getByRole('button', { name: 'Profile', exact: true }).click();
    await shell.getByLabel('Name', { exact: true }).fill('Blake Ashford');
    await shell.getByLabel('Pen names').fill('Ashe Wilder, Loric Thorne');
    await shell.getByLabel('Email').fill('not an email');
    await shell.getByRole('button', { name: 'Save' }).click();
    await shell.getByRole('alert').getByText(/email/).waitFor();
    await shell.getByLabel('Email').fill('blake@example.com');
    await shell.getByRole('button', { name: 'Save' }).click();
    await shell.getByRole('status').getByText('Saved').waitFor();

    // Attach files as the page would after a drop (the native picker cannot be driven): a document and a picture.
    const attach = (p: string) =>
      app.evaluate(async ({ ipcMain, BrowserWindow }, file) => {
        const h = (ipcMain as any)._invokeHandlers.get('shell:user:attachPaths');
        return h({ sender: BrowserWindow.getAllWindows()[0]!.webContents }, [file]);
      }, p);
    await attach(doc);
    await attach(path.join(PKG, 'build', 'icon.png'));
    await shell.locator('.attachments li', { hasText: 'Author bio.txt' }).waitFor();
    const pic = shell.locator('.attachments li', { hasText: 'icon.png' });
    await pic.waitFor();
    expect(await shell.locator('.attachments li', { hasText: 'Author bio.txt' }).getByRole('button', { name: 'Use as photo' }).count()).toBe(0); // only pictures can be the photo
    await shell.getByLabel('Note on Author bio.txt').fill('Short bio for covers');
    await shell.getByLabel('Note on Author bio.txt').blur();
    await pic.getByRole('button', { name: 'Use as photo' }).click();
    await shell.locator('.rail .avatar img').waitFor(); // the photo is in the rail, with no restart

    // Clicking the picture chooses a photo; the chosen picture is kept with the person's files. (The native picker cannot be driven,
    // so the main process answers it with a file.)
    const photo = path.join(tmp, 'My face.png');
    fs.copyFileSync(path.join(PKG, 'build', 'icon.png'), photo);
    await app.evaluate(({ dialog }, f) => {
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, photo);
    await shell.getByRole('button', { name: 'Choose your photo' }).first().click();
    const mine = shell.locator('.attachments li', { hasText: 'My face.png' });
    await mine.waitFor();
    await mine.getByText('your photo').waitFor();
    expect(await mine.getByLabel('Note on My face.png').inputValue()).toBe('My photo');

    // A file can be downloaded: a copy is saved where the person says, and the stored one stays.
    const saved = path.join(tmp, 'downloaded bio.txt');
    await app.evaluate(({ dialog }, f) => {
      (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: f });
    }, saved);
    await shell.locator('.attachments li', { hasText: 'Author bio.txt' }).getByRole('button', { name: 'Download' }).click();
    await waitFor(() => fs.existsSync(saved), 'the downloaded copy');
    expect(fs.readFileSync(saved, 'utf8')).toBe('Blake writes fantasy.');

    // The assistant opt-out is per file: on by default, and only that file is hidden. There is no global switch.
    expect(await shell.getByLabel('Let the AI assistant see and read my attached files').count()).toBe(0);
    const fileSwitch = shell.locator('.attachments li', { hasText: 'Author bio.txt' }).getByLabel('AI can read');
    expect(await fileSwitch.isChecked()).toBe(true);
    expect(await pic.getByLabel('AI can read').isChecked()).toBe(true);
    await fileSwitch.click();
    await waitFor(async () => !(await fileSwitch.isChecked()), 'the file to be hidden from the assistant');
    expect(await pic.getByLabel('AI can read').isChecked()).toBe(true); // the other file is untouched

    // The name is what notes are written under, in the shell and in Market.
    await shell.getByRole('button', { name: 'Notes', exact: true }).click();
    await shell.getByLabel('New note').fill('Written as me.');
    await shell.getByRole('button', { name: 'Add note' }).click();
    await shell.locator('.cn-note', { hasText: 'Written as me.' }).locator('.cn-meta strong', { hasText: 'Blake Ashford' }).waitFor();
    await app.close();

    // Everything is still there after a restart; the attached file's content is a copy under Cadrel's folder, the original untouched.
    const second = await launch();
    await second.shell.getByRole('button', { name: 'Profile', exact: true }).click();
    await second.shell.getByLabel('Name', { exact: true }).waitFor();
    expect(await second.shell.getByLabel('Name', { exact: true }).inputValue()).toBe('Blake Ashford');
    expect(await second.shell.getByLabel('Pen names').inputValue()).toBe('Ashe Wilder, Loric Thorne');
    expect(await second.shell.getByLabel('Note on Author bio.txt').inputValue()).toBe('Short bio for covers');
    expect(await second.shell.locator('.attachments li', { hasText: 'Author bio.txt' }).getByLabel('AI can read').isChecked()).toBe(false);
    await second.shell.locator('.rail .avatar img').waitFor();
    expect(fs.readFileSync(doc, 'utf8')).toBe('Blake writes fantasy.');
    const stored = fs.readdirSync(path.join(userData, 'studios', 'local', 'user', 'attachments'));
    expect(stored).toHaveLength(3);
    // Only the shell's own page may use the user bridge.
    const refused = await second.app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const h = (ipcMain as any)._invokeHandlers.get('shell:user:get');
      const other = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as any;
      try {
        await h({ sender: other?.webContents ?? {} });
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toBe(true);
    await second.app.close();
  }, 120_000);

  it('Write: Export works on the file you choose, from the tree by right-click or from the open file, and nothing is picked for you', async () => {
    const { app, shell } = await launch();
    // Projects are made on the Projects page; Write only opens them.
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByRole('button', { name: 'New project' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Export Test');
    await shell.getByRole('dialog').getByLabel('Manuscript folder').selectOption('novel');
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByRole('button', { name: 'Open in Write' }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    expect(await write.getByRole('button', { name: /New Project/ }).count()).toBe(0);
    await write.getByRole('treeitem', { name: /Manuscript/ }).click();
    const draft = write.getByRole('treeitem', { name: /Draft\.md/ });
    await draft.waitFor();
    await write.locator('.toolbar, header').first().waitFor();

    // Nothing is open: the toolbar's Export is off, and Ctrl+E says why rather than picking a file.
    expect(await write.getByRole('button', { name: 'Export…' }).isDisabled()).toBe(true);
    await write.keyboard.press('Control+e');
    await write.getByText(/Open the file you want to export/).waitFor();

    // Right-click a file that is not open or focused: Export… is there, and there is no "Mark for Export".
    await draft.click({ button: 'right' });
    const menu = write.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Export…' }).waitFor();
    expect(await menu.getByRole('menuitem', { name: /Mark for Export|Unmark/ }).count()).toBe(0);
    await menu.getByRole('menuitem', { name: 'Export…' }).click();
    const dialog = write.getByRole('dialog', { name: 'Export' });
    await dialog.getByText('Exporting').waitFor();
    expect(await dialog.innerText()).toContain('Draft.md');
    expect(await dialog.getByLabel('Book', { exact: true }).count()).toBe(0); // no picker of other files
    await write.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // From the open file: open it, then Ctrl+E exports that file.
    await draft.click();
    await write.getByRole('button', { name: 'Export…' }).waitFor();
    await write.keyboard.press('Control+e');
    await write.getByRole('dialog', { name: 'Export' }).getByText('Draft.md').waitFor();
    await app.close();
  }, 120_000);

  it('The Cadrel folder: each Studio has Projects, Write and Market inside a folder of its name; they can be placed separately, and the Cadrel folder moves at the next start', async () => {
    const h = path.join(tmp, 'fresh-home');
    const ud = path.join(tmp, 'fresh-userdata');
    fs.mkdirSync(h, { recursive: true });
    const first = await launch({ home: h, userData: ud });
    let { app, shell } = first;

    // Nothing was set up, yet the Studio has its places under <home>/Cadrel/<Studio>.
    await shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await shell.locator('.kv dd', { hasText: path.join(h, 'Cadrel') }).first().waitFor();
    for (const d of ['Projects', 'Write', 'Market']) expect(fs.existsSync(path.join(h, 'Cadrel', 'My Studio', d))).toBe(true);
    expect(await shell.getByText('chosen separately').count()).toBe(0);

    // Write shows its projects straight away (no welcome dialog), and Market is already working on its library.
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    expect(await write.getByText('Welcome to Cadrel Write').count()).toBe(0);
    await shell.getByRole('button', { name: 'Market', exact: true }).click();
    const market = await waitFor(() => moduleView(app, 'market'), 'the Market view');
    await market.getByRole('tab', { name: 'Queue' }).waitFor();
    expect(JSON.parse(fs.readFileSync(path.join(ud, 'studios', 'local', 'market', 'config.json'), 'utf8')).libraryRoot).toBe(path.join(h, 'Cadrel', 'My Studio', 'Market'));

    // Projects can be put somewhere of its own, with its contents.
    fs.mkdirSync(path.join(h, 'Cadrel', 'My Studio', 'Projects', 'Moving Book', '.cadrel'), { recursive: true });
    fs.writeFileSync(path.join(h, 'Cadrel', 'My Studio', 'Projects', 'Moving Book', '.cadrel', 'project.json'), JSON.stringify({ version: 1, id: 'p1', name: 'Moving Book' }));
    fs.writeFileSync(path.join(h, 'Cadrel', 'My Studio', 'Projects', 'Moving Book', 'Draft.md'), '# One\n');
    const mine = path.join(tmp, 'my-projects');
    await app.evaluate(({ dialog }, d) => {
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, mine);
    await shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await shell.getByRole('button', { name: 'Change Projects' }).click();
    await shell.locator('.kv dd', { hasText: mine }).first().waitFor();
    await shell.getByText('chosen separately').first().waitFor();
    expect(fs.readFileSync(path.join(mine, 'Moving Book', 'Draft.md'), 'utf8')).toBe('# One\n');
    expect(JSON.parse(fs.readFileSync(path.join(ud, 'studios', 'local', 'settings.json'), 'utf8')).projectsFolder).toBe(mine);

    // The AI server is pinned to this Studio: it looks only where the app says, never at another Studio's folders.
    const { rootCandidates } = await import('@cadrel/write/mcp/root');
    const { nodeFs } = await import('@cadrel/write/electron/nodeFs');
    await shell.getByRole('button', { name: 'Extensions', exact: true }).click();
    await shell.getByRole('tab', { name: 'Claude Code' }).click();
    const snippet = await shell.locator('pre.snippet').innerText();
    expect(snippet).toContain(`--root ${mine}`);
    expect(snippet).toContain(path.join(ud, 'studios', 'local', 'studio.json'));
    expect(snippet).toContain(path.join(h, 'Cadrel', 'My Studio', 'Market'));
    void rootCandidates; void nodeFs;

    // The Cadrel folder moves at the next start: it is only requested now, and nothing has moved yet.
    const other = path.join(tmp, 'other-drive');
    fs.mkdirSync(other);
    await app.evaluate(({ dialog }, d) => {
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, other);
    await shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await shell.getByRole('button', { name: 'Change Cadrel folder' }).click();
    await shell.getByText(/will move to/).waitFor();
    expect(fs.existsSync(path.join(h, 'Cadrel', 'My Studio', 'Market'))).toBe(true);
    await shell.getByRole('button', { name: 'Restart now' }).click();
    await app.waitForEvent('close').catch(() => undefined);

    ({ app, shell } = await launch({ home: h, userData: ud }));
    await shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await shell.locator('.kv dd', { hasText: path.join(other, 'Cadrel') }).first().waitFor();
    expect(fs.existsSync(path.join(h, 'Cadrel'))).toBe(false);
    expect(fs.existsSync(path.join(other, 'Cadrel', 'My Studio', 'Market', 'scout.db'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ud, 'studios', 'local', 'market', 'config.json'), 'utf8')).libraryRoot).toBe(path.join(other, 'Cadrel', 'My Studio', 'Market'));
    expect(JSON.parse(fs.readFileSync(path.join(ud, 'shell.json'), 'utf8')).cadrelFolder).toBe(path.join(other, 'Cadrel'));
    // Projects was placed separately, so the move left it where it was.
    expect(fs.existsSync(path.join(mine, 'Moving Book', 'Draft.md'))).toBe(true);
    await shell.getByRole('button', { name: 'Use the default for Projects' }).click();
    await shell.locator('.kv dd', { hasText: path.join(other, 'Cadrel', 'My Studio', 'Projects') }).first().waitFor();
    expect(fs.existsSync(path.join(other, 'Cadrel', 'My Studio', 'Projects', 'Moving Book', 'Draft.md'))).toBe(true);
    await app.close();
  }, 120_000);

  it('Projects manages the project folders: create from a template, rename, archive, delete; Write only opens them', async () => {
    const { app, shell } = await launch({ userData: path.join(tmp, 'manage-userdata'), home: path.join(tmp, 'manage-home') });
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByRole('button', { name: 'New project' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Managed Book');
    await shell.getByRole('dialog').getByLabel('Manuscript folder').selectOption('novel');
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByRole('heading', { level: 2, name: 'Managed Book' }).waitFor();
    await shell.getByText(/made from/).waitFor();

    await shell.getByRole('button', { name: 'Rename', exact: true }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Renamed Book');
    await shell.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await shell.getByRole('heading', { level: 2, name: 'Renamed Book' }).waitFor();

    await shell.getByRole('button', { name: 'Archive', exact: true }).click();
    await shell.getByRole('button', { name: 'Restore', exact: true }).waitFor();
    await shell.getByRole('button', { name: 'Restore', exact: true }).click();

    // Write lists it, offers no way to create, rename or delete it, and opens it.
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('button', { name: /Open Renamed Book/ }).waitFor();
    expect(await write.getByRole('button', { name: /New Project/ }).count()).toBe(0);
    await write.getByRole('button', { name: /Actions for Renamed Book/ }).click();
    const menu = write.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Open' }).waitFor();
    for (const gone of ['Rename…', 'Delete…', 'Duplicate…', 'Archive']) expect(await menu.getByRole('menuitem', { name: gone }).count()).toBe(0);
    await write.keyboard.press('Escape');

    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByRole('button', { name: 'Delete…' }).click();
    await shell.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await shell.locator('.tree-row', { hasText: 'Renamed Book' }).waitFor({ state: 'detached' });
    await app.close();
  }, 120_000);

  it('Admin: templates are central. Edited on the Admin page, used by Projects, not editable in Write', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Admin', exact: true }).click();
    await shell.getByRole('heading', { name: 'Governed by administrators' }).waitFor();
    // Make a new template with a name of its own and save it.
    await shell.getByRole('button', { name: 'New', exact: true }).click();
    await shell.getByLabel('Template name').fill('Serial Fiction');
    await shell.getByRole('button', { name: 'Save templates' }).click();
    await shell.getByText(/Saved\. New projects use these templates/).waitFor();

    // Projects offers it, and the folder it makes is in the Projects folder.
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByRole('button', { name: 'New project' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Serial One');
    await shell.getByRole('dialog').getByLabel('Manuscript folder').selectOption({ label: /Serial Fiction/ as never }).catch(async () => {
      const value = await shell.getByRole('dialog').getByLabel('Manuscript folder').locator('option', { hasText: 'Serial Fiction' }).getAttribute('value');
      await shell.getByRole('dialog').getByLabel('Manuscript folder').selectOption(value!);
    });
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByText(/made from Serial Fiction/).waitFor();
    expect(fs.existsSync(path.join(home, 'Cadrel', 'My Studio', 'Projects', 'Serial One', '.cadrel', 'project.json'))).toBe(true);

    // Write has no templates of its own: no Projects/Templates tab in its settings.
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    expect(await write.evaluate(() => (window as any).cadrelWrite.getProjectsConfig().then((c: any) => c.templates.some((t: any) => t.name === 'Serial Fiction')))).toBe(true);
    await write.keyboard.press('Control+,');
    await write.getByRole('dialog', { name: /Settings/ }).waitFor().catch(() => undefined);
    expect(await write.getByRole('tab', { name: /^(Projects|Templates)$/ }).count()).toBe(0);

    // A member (not an owner or admin) neither sees Admin nor can change templates.
    await app.close();
    const ud = path.join(tmp, 'member-userdata');
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'shell.json'), JSON.stringify({ page: 'admin' }));
    fs.writeFileSync(path.join(ud, 'studios.json'), JSON.stringify({ activeId: 'sinvited', studios: [{ id: 'sinvited', name: 'Their Studio', role: 'member', status: 'ready', memberRole: 'author', url: 'http://127.0.0.1:1/w/x', fingerprint: '0123-4567-89AB-CDEF' }] }));
    const m = await launch({ userData: ud });
    expect(await m.shell.locator('.rail-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).not.toContain('Admin');
    expect(await m.shell.evaluate(() => (window as any).cadrel.admin.save({ templates: [], defaultTemplateId: '' }).then(() => 'saved', (e: Error) => e.message))).toMatch(/Only an administrator/);
    await m.app.close();
  }, 120_000);

  it('Extensions: the kit and the Claude extension download from one page, and the settings can be copied', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Extensions', exact: true }).click();
    await shell.getByRole('heading', { name: 'Download' }).waitFor();
    await shell.getByRole('button', { name: 'Download the AI Kit' }).click();
    const saved = shell.getByRole('status').filter({ hasText: /Saved to .*Cadrel AI Kit/ });
    await saved.waitFor();
    const kit = (await saved.innerText()).match(/Saved to (.*Cadrel AI Kit)\./)![1]!;
    expect(fs.readdirSync(kit)).toEqual(expect.arrayContaining(['README.txt', 'cadrel.mcpb', 'skills']));
    await shell.getByRole('button', { name: 'Download the Claude Desktop extension' }).click();
    const ext = shell.getByRole('status').filter({ hasText: /Saved .*Cadrel\.mcpb/ });
    await ext.waitFor();
    expect(fs.existsSync((await ext.innerText()).match(/Saved (.*Cadrel\.mcpb)\./)![1]!)).toBe(true);
    // The hand setup names the one server; the assistant reads the Projects folder.
    await shell.getByRole('tab', { name: 'Claude Code' }).click();
    expect(await shell.locator('pre.snippet').innerText()).toMatch(/claude mcp add cadrel/);
    await shell.getByText(path.join(home, 'Cadrel', 'My Studio', 'Projects')).first().waitFor();
    // Online access stays off until turned on.
    await shell.getByRole('heading', { name: /Online apps/ }).waitFor();
    expect(await shell.getByText('Access token', { exact: true }).count()).toBe(0);
    // The old places are gone: Market's own settings point here instead.
    await shell.getByRole('button', { name: 'Market', exact: true }).click();
    const market = await waitFor(() => moduleView(app, 'market'), 'the Market view');
    await market.getByRole('tab', { name: 'Settings' }).click();
    await market.getByLabel('AI assistants').waitFor();
    expect(await market.getByRole('button', { name: 'Install in Claude Desktop' }).count()).toBe(0);
    await app.close();
  }, 120_000);

  it('Updates: a development build is offered development releases only, with a note and an Update button', async () => {
    const rel = (tag: string, pre: boolean) => ({ tag_name: tag, prerelease: pre, draft: false, html_url: `https://github.com/blaashford-ux/cadrel/releases/tag/${tag}`, body: `Notes for ${tag}`, assets: [{ name: `Cadrel-Setup-${tag}.exe`, browser_download_url: `https://github.com/blaashford-ux/cadrel/releases/download/${tag}/Cadrel-Setup-${tag}.exe`, size: 10 }] });
    const file = path.join(tmp, 'releases.json');
    fs.writeFileSync(file, JSON.stringify([rel('v0.9.0', false), rel('v0.2.0-dev.20', true), rel('v0.2.0-dev.7', true)]));
    const { app, shell } = await launch({ env: { CADREL_TEST_RELEASES: file, CADREL_TEST_VERSION: '0.2.0-dev.7' } });
    // It looks by itself shortly after starting, and the rail says so.
    await shell.locator('.rail-dot').waitFor();
    await shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await shell.getByText(/development build: updates come from development releases only/).waitFor();
    await shell.getByRole('button', { name: 'Check for updates' }).click();
    await shell.getByText('Version 0.2.0-dev.20 is available.').waitFor(); // not 0.9.0
    await shell.getByText('What changed').click();
    await shell.getByText('Notes for v0.2.0-dev.20').waitFor();
    // Windows installs; elsewhere there is no installer button, only the release page.
    const canInstall = process.platform === 'win32';
    expect(await shell.getByRole('button', { name: 'Update to 0.2.0-dev.20' }).count()).toBe(canInstall ? 1 : 0);
    await app.close();

    // Up to date: no note, no dot.
    fs.writeFileSync(file, JSON.stringify([rel('v0.2.0-dev.7', true)]));
    const again = await launch({ env: { CADREL_TEST_RELEASES: file, CADREL_TEST_VERSION: '0.2.0-dev.7' } });
    await again.shell.getByRole('button', { name: 'Settings', exact: true }).click();
    await again.shell.getByRole('button', { name: 'Check for updates' }).click();
    await again.shell.getByText(/Cadrel is up to date/).waitFor();
    expect(await again.shell.locator('.rail-dot').count()).toBe(0);
    await again.app.close();
  }, 120_000);

  it('Studios: the Studio Manager is off until enabled; it checks Cloudflare details; a Studio that is not built is not connected, on every page', async () => {
    const ud = path.join(tmp, 'studios-userdata');
    const h = path.join(tmp, 'studios-home');
    let { app, shell } = await launch({ userData: ud, home: h });

    // Everyone gets a Studio menu on Home; with one Studio it names it.
    const switcher = () => shell.getByLabel('Studio', { exact: true });
    await switcher().waitFor();
    expect(await switcher().locator('option').allInnerTexts()).toEqual(['My Studio']);

    // Admin → Studio Manager starts switched off, and one press turns it on.
    await shell.getByRole('button', { name: 'Admin', exact: true }).click();
    await shell.getByRole('heading', { name: 'Studio Manager' }).waitFor();
    expect(await shell.getByLabel('New Studio name').count()).toBe(0);
    await shell.getByRole('button', { name: 'Enable Studio Manager' }).click();
    await shell.getByLabel('New Studio name').fill('Acme Books');
    await shell.getByRole('button', { name: 'Create Studio' }).click();
    const detail = shell.getByRole('region', { name: 'Acme Books settings' });
    await detail.waitFor();
    await detail.getByText('Acme Books', { exact: true }).first().waitFor(); // its folder

    // Provision: bad details are refused in words, before anything is sent.
    await detail.getByLabel('Account ID').fill('not-an-id');
    await detail.getByLabel('API token').fill('cf-token-0123456789abcdefghijklmnopqrstuv');
    await detail.getByRole('button', { name: 'Provision', exact: true }).click();
    await shell.getByRole('alert').filter({ hasText: /account ID is 32/ }).waitFor();
    expect(await detail.getByRole('button', { name: 'Create invitation' }).count()).toBe(0); // people come once it is built
    expect(fs.readFileSync(path.join(ud, 'studios.json'), 'utf8')).not.toContain('cf-token');

    // Switching restarts Cadrel into the other Studio's folders, and an unbuilt Studio explains itself on every page.
    await shell.getByRole('button', { name: 'Home', exact: true }).click();
    await switcher().selectOption({ label: 'Acme Books' });
    await app.waitForEvent('close');
    ({ app, shell } = await launch({ userData: ud, home: h }));
    await shell.getByRole('heading', { name: 'Acme Books is not connected yet' }).waitFor();
    expect(await shell.getByText('Your projects').count()).toBe(0);
    for (const p of ['Projects', 'Notes', 'Write', 'Market']) {
      await shell.getByRole('button', { name: p, exact: true }).click();
      await shell.getByRole('heading', { name: 'Acme Books is not connected yet' }).waitFor();
    }
    expect((await views(app)).every((v) => !v.visible)).toBe(true);

    // Remove it from this computer: back to My Studio at the next start.
    await shell.getByRole('button', { name: 'Admin', exact: true }).click();
    await shell.getByRole('button', { name: 'Acme Books' }).click();
    await shell.getByRole('button', { name: 'Remove from this computer…' }).click();
    await shell.getByRole('button', { name: 'Remove', exact: true }).click();
    await shell.getByRole('button', { name: 'Home', exact: true }).click();
    await shell.getByText('Your projects').waitFor();
    await app.close();
  }, 120_000);

  it('Studios: build one in Cloudflare, keep the token, invite someone who joins from another computer, and keep every Studio’s data apart', async () => {
    const cf = await serveFakeCloudflare();
    try {
      const udA = path.join(tmp, 'owner-userdata');
      const hA = path.join(tmp, 'owner-home');
      const env = { CADREL_TEST_CF: cf.url };
      let { app, shell } = await launch({ userData: udA, home: hA, env });

      // Something in My Studio, to show it does not appear in the other one.
      await shell.evaluate(() => (window as any).cadrel.studio.createProject({ name: 'Secret Series', kind: 'Series' }));

      await shell.getByRole('button', { name: 'Admin', exact: true }).click();
      await shell.getByRole('button', { name: 'Enable Studio Manager' }).click();
      await shell.getByLabel('New Studio name').fill('Acme Books');
      await shell.getByRole('button', { name: 'Create Studio' }).click();
      const detail = shell.getByRole('region', { name: 'Acme Books settings' });
      await detail.getByLabel('Account ID').fill(ACCOUNT);
      await detail.getByLabel('API token').fill(TOKEN);
      await detail.getByLabel(/Keep this token on this computer/).check();
      await detail.getByRole('button', { name: 'Provision', exact: true }).click();

      // Built: it has an address, the Worker holds the owner's key, and the token is kept for upgrades (and can be forgotten).
      await detail.getByText('Ready', { exact: true }).waitFor();
      await detail.getByText(/\/w\/cadrel-studio-/).waitFor();
      expect(cf.workers.size).toBe(1);
      expect(cf.db.size).toBe(1);
      const id = fs.readdirSync(path.join(udA, 'studios')).find((d) => d !== 'local')!;
      expect(fs.existsSync(path.join(udA, 'studios', id, 'secrets', 'cf-token.bin'))).toBe(true);
      expect(fs.existsSync(path.join(udA, 'studios', id, 'secrets', 'studio-key.bin'))).toBe(true);
      await detail.getByRole('button', { name: 'Forget it' }).click();
      await detail.getByRole('button', { name: 'Forget it' }).waitFor({ state: 'detached' });
      expect(fs.existsSync(path.join(udA, 'studios', id, 'secrets', 'cf-token.bin'))).toBe(false);

      // Invite: the link is shown once, and the invitation is listed until someone uses it.
      await detail.getByLabel('Who the invitation is for').fill('Alice');
      await detail.getByLabel('Role for the invitation').selectOption('author');
      await detail.getByRole('button', { name: 'Create invitation' }).click();
      const link = await detail.getByLabel('Invitation link').inputValue();
      expect(link).toMatch(/^cadrel:\/\/join\?/);
      await detail.getByRole('list', { name: 'People in this Studio' }).getByText(/Invitation for Alice/).waitFor();

      // Another computer (its own profile, home and data) joins from the link, and is a member, not an owner.
      const udB = path.join(tmp, 'member-userdata-2');
      const hB = path.join(tmp, 'member-home-2');
      let b = await launch({ userData: udB, home: hB, env });
      await b.shell.getByRole('button', { name: 'Join a Studio…' }).click();
      const dlg = b.shell.getByRole('dialog', { name: 'Join a Studio' });
      await dlg.getByLabel('Invitation link').fill(link);
      await dlg.getByLabel('Your name in this Studio').fill('Alice Author');
      await dlg.getByRole('button', { name: 'Join', exact: true }).click();
      await dlg.getByText(/You are in/).waitFor();
      await dlg.getByRole('button', { name: 'Done' }).click();
      expect(await b.shell.getByLabel('Studio', { exact: true }).locator('option').allInnerTexts()).toEqual(['My Studio', 'Acme Books (invited)']);
      // Joining the same Studio twice is refused here, before anything is sent.
      await b.shell.getByRole('button', { name: 'Join a Studio…' }).click();
      await dlg.getByLabel('Invitation link').fill(link);
      await dlg.getByLabel('Your name in this Studio').fill('Someone Else');
      await dlg.getByLabel(/What to call the Studio/).fill('Second copy');
      await dlg.getByRole('button', { name: 'Join', exact: true }).click();
      await dlg.getByRole('alert').filter({ hasText: /already in that Studio/ }).waitFor();
      await dlg.getByRole('button', { name: 'Cancel' }).click();

      // The owner sees them join, and can remove them.
      await detail.getByRole('button', { name: 'Create invitation' }).waitFor(); // still on the same screen
      await shell.getByRole('button', { name: 'Home', exact: true }).click();
      await shell.getByRole('button', { name: 'Admin', exact: true }).click();
      await shell.getByRole('button', { name: 'Acme Books' }).click();
      const list = shell.getByRole('list', { name: 'People in this Studio' });
      await list.getByText('Alice Author').waitFor();
      expect(await list.getByText(/Invitation for/).count()).toBe(0);

      // B switches into the Studio: it restarts into its own folders, as a Member with no Admin page.
      await b.shell.getByLabel('Studio', { exact: true }).selectOption({ label: 'Acme Books (invited)' });
      await b.app.waitForEvent('close');
      b = await launch({ userData: udB, home: hB, env });
      await b.shell.getByLabel('Studio', { exact: true }).waitFor();
      expect(await b.shell.getByLabel('Studio', { exact: true }).inputValue()).toBe(fs.readdirSync(path.join(udB, 'studios')).find((d) => d !== 'local'));
      await b.shell.getByText('Member', { exact: true }).waitFor();
      expect(await b.shell.locator('.rail-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).not.toContain('Admin');
      for (const d of ['Projects', 'Write', 'Market']) expect(fs.existsSync(path.join(hB, 'Cadrel', 'Acme Books', d))).toBe(true);
      await b.app.close();

      await list.getByRole('button', { name: 'Remove Alice Author' }).click();
      await list.getByText('Alice Author').waitFor({ state: 'detached' });

      // A removed member is shut out for good.
      const gone = await fetch(`${cf.url}/w/${[...cf.workers.keys()][0]}/v1/me`);
      expect(gone.status).toBe(401); // unsigned; and a signed request from Alice's key is refused by the server (see the server tests)

      // The owner opens the Studio: its own folders, and none of My Studio's projects.
      await shell.getByRole('button', { name: 'Home', exact: true }).click();
      await shell.getByLabel('Studio', { exact: true }).selectOption({ label: 'Acme Books' });
      await app.waitForEvent('close');
      ({ app, shell } = await launch({ userData: udA, home: hA, env }));
      await shell.getByRole('button', { name: 'Projects', exact: true }).click();
      await shell.getByText('Start with a project').waitFor();
      expect(await shell.getByText('Secret Series').count()).toBe(0);
      expect(fs.existsSync(path.join(hA, 'Cadrel', 'Acme Books', 'Projects'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(udA, 'studios', 'local', 'studio.json'), 'utf8')).tree.projects.map((p: any) => p.name)).toEqual(['Secret Series']);
      expect(fs.existsSync(path.join(udA, 'studios', id, 'studio.json'))).toBe(false); // nothing was written there
      await app.close();
    } finally {
      await cf.close();
    }
  }, 240_000);

  it('closing with unsaved edits in Write brings Write forward, asks it, and only then closes', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByRole('heading', { name: 'Projects' }).waitFor();
    // Write's own page answers the question (it really has nothing unsaved, so it says yes). To observe the moment
    // between the question and the close, the test holds the final close from the main process.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      (globalThis as any).__hold = true;
      w.on('close', (e) => (globalThis as any).__hold && e.preventDefault());
    });
    await write.evaluate(() => {
      (window as any).__asked = 0;
      (window as any).cadrelWrite.onCloseRequested(() => (window as any).__asked++);
      (window as any).cadrelWrite.setDirtyFiles(['chapter-1.md']); // the shell only asks when Write reports unsaved files
    });
    await shell.getByRole('button', { name: 'Home', exact: true }).click();
    await waitFor(async () => (await views(app)).every((x) => !x.visible), 'Write to be hidden');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await waitFor(() => write.evaluate(() => (window as any).__asked > 0), 'Write to be asked about its unsaved edits');
    await waitFor(async () => (await shell.locator('.rail-btn[aria-current="page"]').getAttribute('aria-label')) === 'Write', 'Write to be brought forward');
    expect((await views(app)).some((x) => x.visible)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // With nothing holding it, the window now closes.
    const closed = app.waitForEvent('close');
    await app.evaluate(() => ((globalThis as any).__hold = false));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await closed;
  }, 90_000);
});
