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
    expect(await shell.locator('.rail-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Home', 'Projects', 'Notes', 'Dashboard', 'Write', 'Market', 'Profile', 'Settings']);
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
    await write.getByText('Welcome to Cadrel Write').waitFor();
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
    await write.getByText('Welcome to Cadrel Write').waitFor();
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

  it('Write\'s AI Kit and Market\'s Claude connection are the same single server', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByText('Welcome to Cadrel Write').waitFor();

    // Write: the AI server settings and the kit it saves for Claude Desktop.
    const server = await write.evaluate(() => (window as any).mdedit.getAiServer());
    expect(server.args[0]).toMatch(/mcp\.mjs$/);
    const dest: string = await write.evaluate(() => (window as any).mdedit.exportAiKit());
    expect(path.basename(dest)).toBe('Cadrel AI Kit');
    const files = fs.readdirSync(dest);
    expect(files).toEqual(expect.arrayContaining(['README.txt', 'cadrel.mcpb', 'connect-settings.txt', 'skills']));
    expect(files).not.toContain('mdedit.mcpb');
    const ext = unzipSync(fs.readFileSync(path.join(dest, 'cadrel.mcpb')));
    expect(JSON.parse(strFromU8(ext['manifest.json']!))).toMatchObject({ name: 'cadrel', display_name: 'Cadrel' });
    const launcher = strFromU8(ext['server/index.js']!);
    expect(launcher).toContain("label");
    expect(launcher).toMatch(/"name":"cadrel"/); // it answers Claude's handshake as the one server
    expect(launcher).toMatch(/mcp\.mjs/);
    expect(fs.readdirSync(path.join(dest, 'skills'))).toContain('mdedit-line-edit.zip');
    expect(fs.readFileSync(path.join(dest, 'connect-settings.txt'), 'utf8')).toContain('claude mcp add cadrel --');

    // Market: its own "connect to Claude" gives the same server under the same name.
    const market = await (async () => {
      await shell.getByRole('button', { name: 'Market', exact: true }).click();
      return waitFor(() => moduleView(app, 'market'), 'the Market view');
    })();
    await market.getByRole('tab', { name: 'Queue' }).waitFor();
    const cfg = await market.evaluate(() => (window as any).bookscout.mcpConfig());
    expect(JSON.parse(cfg.claudeDesktop).mcpServers).toHaveProperty('cadrel');
    expect(cfg.args[0]).toBe(server.args[0]);
    expect(cfg.args).toContain('--library');
    const built = await market.evaluate(() => (window as any).bookscout.installClaudeExtension());
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
    await write.getByText('Welcome to Cadrel Write').waitFor();
    await write.evaluate(async () => {
      const api = (window as any).mdedit;
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

    await shell.getByRole('button', { name: 'Add subproject' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Book 1');
    await shell.getByRole('dialog').getByPlaceholder(/Series, Book/).fill('Book');
    await shell.getByRole('button', { name: 'Create' }).click();
    await shell.getByRole('heading', { level: 2, name: 'Book 1' }).waitFor();
    expect(await shell.locator('.tree-row').allInnerTexts()).toEqual(['Dragon Rider', 'Book 1']);
    expect(await shell.locator('.crumbs').innerText()).toContain('Dragon Rider');

    // A duplicate name is refused with a message, not a crash.
    await shell.locator('.tree-row', { hasText: 'Dragon Rider' }).first().click();
    await shell.getByRole('button', { name: 'Add subproject' }).click();
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
    await write.getByText('Welcome to Cadrel Write').waitFor();
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
    const key = await market.evaluate(async () => (await (window as any).bookscout.categories())[0].key);
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

    // The assistant opt-out: on by default, per-file switches follow it, and the choice is remembered.
    const optOut = shell.getByLabel('Let the AI assistant see and read my attached files');
    expect(await optOut.isChecked()).toBe(true);
    const fileSwitch = shell.locator('.attachments li', { hasText: 'Author bio.txt' }).getByLabel('AI can read');
    expect(await fileSwitch.isChecked()).toBe(true);
    // (the boxes change when the app confirms, a moment after the click, so wait rather than expect it at once)
    await fileSwitch.click();
    await waitFor(async () => !(await fileSwitch.isChecked()), 'the file to be hidden from the assistant');
    await optOut.click();
    await waitFor(async () => !(await optOut.isChecked()), 'assistant access to turn off');
    await waitFor(async () => (await fileSwitch.isDisabled()), 'the per-file switch to follow the opt-out');

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
    expect(await second.shell.getByLabel('Let the AI assistant see and read my attached files').isChecked()).toBe(false);
    await second.shell.locator('.rail .avatar img').waitFor();
    expect(fs.readFileSync(doc, 'utf8')).toBe('Blake writes fantasy.');
    const stored = fs.readdirSync(path.join(userData, 'user', 'attachments'));
    expect(stored).toHaveLength(2);
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
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByText('Welcome to Cadrel Write').waitFor();
    await write.getByRole('button', { name: 'Get started' }).click();
    // Make a project the way a person does: the Novel template, with a name.
    await write.getByRole('button', { name: /New Project/ }).first().click();
    await write.getByRole('dialog', { name: 'New project' }).getByLabel('Template').selectOption('novel');
    await write.getByRole('dialog', { name: 'New project' }).getByPlaceholder('The Lost King').fill('Export Test');
    await write.getByRole('dialog', { name: 'New project' }).getByRole('button', { name: /Create/ }).click();
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

  it('closing with unsaved edits in Write brings Write forward, asks it, and only then closes', async () => {
    const { app, shell } = await launch();
    await shell.getByRole('button', { name: 'Write', exact: true }).click();
    const write = await waitFor(() => moduleView(app, 'write'), 'the Write view');
    await write.getByText('Welcome to Cadrel Write').waitFor();
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
