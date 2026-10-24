// Drives the real built shell in Electron: Home and Dashboard, Write and Market in their own views, and the shell-level
// behaviour (navigation, layout, isolation, persistence, the unsaved-edits close guard).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

async function launch(): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await electron.launch({
    executablePath: PACKAGED ?? electronBin,
    args: PACKAGED ? ['--no-sandbox'] : ['--no-sandbox', PKG],
    env: { ...process.env, CADREL_TEST: '1', BOOKSCOUT_TEST: '1', CADREL_USER_DATA: userData, HOME: home, USERPROFILE: home }
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
    fs.mkdirSync(path.join(userData, 'market'), { recursive: true });
    // A library is needed for BookScout's capture server to start (as in the standalone app).
    fs.mkdirSync(path.join(tmp, 'library'));
    fs.writeFileSync(path.join(userData, 'market', 'config.json'), JSON.stringify({ libraryRoot: path.join(tmp, 'library'), port: PORT }));
  }, 180_000);

  afterAll(async () => {
    await Promise.all(running.map((a) => a.close().catch(() => undefined)));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('opens on Home with the rail, real data from both modules, and the capture server already listening', async () => {
    const { app, shell } = await launch();
    expect(await shell.title()).toBe('Cadrel');
    expect(await shell.locator('.rail-btn').allInnerTexts()).toEqual(['Home', 'Dashboard', 'Write', 'Market']);
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
    await write.getByText('Welcome to MDEdit').waitFor();
    expect(await write.evaluate(() => [typeof (window as any).mdedit, typeof (window as any).cadrel, typeof (window as any).bookscout])).toEqual(['object', 'undefined', 'undefined']);

    await shell.getByRole('button', { name: 'Market', exact: true }).click();
    const market = await waitFor(() => moduleView(app, 'market'), 'the Market view');
    await market.getByRole('tab', { name: 'Queue' }).waitFor();
    expect(await market.evaluate(() => [typeof (window as any).bookscout, typeof (window as any).cadrel, typeof (window as any).mdedit])).toEqual(['object', 'undefined', 'undefined']);
    expect(await shell.evaluate(() => [typeof (window as any).cadrel, typeof (window as any).mdedit, typeof (window as any).bookscout])).toEqual(['object', 'undefined', 'undefined']);

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

  it('Dashboard and Home show a project made in Write', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByText('Welcome to MDEdit').waitFor();
    await write.evaluate(async () => {
      const api = (window as any).mdedit;
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

  it('closing with unsaved edits in Write brings Write forward, asks it, and only then closes', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByText('Welcome to MDEdit').waitFor();
    // Write's own page answers the question (it really has nothing unsaved, so it says yes). To observe the moment
    // between the question and the close, the test holds the final close from the main process.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      (globalThis as any).__hold = true;
      w.on('close', (e) => (globalThis as any).__hold && e.preventDefault());
    });
    await write.evaluate(() => {
      (window as any).__asked = 0;
      (window as any).mdedit.onCloseRequested(() => (window as any).__asked++);
      (window as any).mdedit.setDirtyFiles(['chapter-1.md']); // the shell only asks when Write reports unsaved files
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
