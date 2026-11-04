import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
// Drives the BUILT app (dist) in Electron, like shell.e2e.test.ts: Write's rewrite mode, through the file tree's right-click menu and the two panes.
// Set SHOTS to a folder to keep a screenshot of each step.
const electronBin = (() => {
  try {
    return createRequire(path.join(PKG, 'package.json'))('electron') as string;
  } catch {
    return '';
  }
})();
const have = electronBin !== '' && fs.existsSync(electronBin) && (!!process.env.DISPLAY || !fs.existsSync('/usr/bin/xvfb-run'));
const SHOTS = process.env.SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const find = (dir: string, name: string): string | null => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.includes('.creating-')) continue; // a project is built in a temporary folder and renamed when it is done
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    }
  }
  return null;
};

/** A long chapter, so there is something to scroll. */
const CHAPTER = '# Chapter One\n\n' + Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the chapter, with enough words in it that it takes a line or two to read, and a little more besides.`).join('\n\n') + '\n';

it.skipIf(!have)('rewrite mode: start from a copy in the file tree, two panes with a read-only original, scrolling carried both ways, off and on from either file', async () => {
  if (!fs.existsSync(path.join(PKG, 'dist', 'main.mjs'))) execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-rw-'));
  const home = path.join(tmp, 'home');
  const userData = path.join(tmp, 'userdata');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(userData, 'studios', 'local', 'market'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'library'));
  fs.writeFileSync(path.join(userData, 'studios', 'local', 'market', 'config.json'), JSON.stringify({ libraryRoot: path.join(tmp, 'library'), port: 48398 }));
  const app: ElectronApplication = await electron.launch({ executablePath: electronBin, args: ['--no-sandbox', PKG], env: { ...process.env, CADREL_TEST: '1', CADREL_USER_DATA: userData, HOME: home, USERPROFILE: home } });
  let failed = false;
  try {
    const shell = await app.firstWindow();
    await shell.waitForSelector('nav.rail');
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.getByRole('button', { name: 'New project' }).click();
    await shell.getByRole('dialog').getByLabel('Name').fill('Rewrite Test');
    await shell.getByRole('dialog').getByLabel('Manuscript folder').selectOption('novel');
    await shell.getByRole('button', { name: 'Create' }).click();
    const draftOnDisk = await waitFor(() => find(home, 'Draft.md'), 'the manuscript file on disk');
    fs.writeFileSync(draftOnDisk, CHAPTER);
    await shell.getByRole('button', { name: 'Open in Write' }).click();
    const write = await waitFor(() => app.windows().find((w) => w.url().includes('/modules/write/')), 'the Write view');
    await write.getByRole('treeitem', { name: /Manuscript/ }).click();
    const draft = write.getByRole('treeitem', { name: /^Draft\.md/ });
    await draft.waitFor();

    // right-click a file that is not linked: the two ways to start a rewrite, and nothing about turning a mode on
    await draft.click({ button: 'right' });
    const menu = write.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Rewrite (Start From a Blank Page)' }).waitFor();
    expect(await menu.getByRole('menuitem', { name: /Rewrite Mode/ }).count()).toBe(0);
    await menu.getByRole('menuitem', { name: 'Rewrite (Start From a Copy)' }).click();

    // two panes now: the original on the left, read only, and the rewrite on the right
    const panes = write.locator('section.pane[data-file]:not([hidden])');
    await waitFor(async () => (await panes.count()) === 2, 'two panes');
    const left = write.locator('section.pane.rw-left');
    const right = write.locator('section.pane.rw-right');
    await left.getByText('Original, read only').waitFor();
    await right.getByText('Rewrite', { exact: true }).first().waitFor();
    expect(await left.getAttribute('data-file')).toMatch(/Draft\.md$/);
    expect(await right.getAttribute('data-file')).toMatch(/Draft \(rewrite\)\.md$/);
    expect(await left.locator('.ProseMirror').first().getAttribute('contenteditable')).toBe('false');
    expect(await right.locator('.ProseMirror').first().getAttribute('contenteditable')).toBe('true');
    expect(await left.getByText('Paragraph 40 of the chapter').count()).toBeGreaterThan(0); // the copy has the same text
    expect(await right.getByText('Paragraph 40 of the chapter').count()).toBeGreaterThan(0);
    await shot(write, '1-side-by-side.png');
    // the link is in the project, and the copy is on disk
    const copy = await waitFor(() => find(home, 'Draft (rewrite).md'), 'the rewrite on disk');
    expect(fs.readFileSync(copy, 'utf8')).toBe(CHAPTER);
    const meta = JSON.parse(fs.readFileSync(path.join(find(home, 'project.json') ?? '', ''), 'utf8')) as { rewriteLinks: { original: string; rewrite: string }[] };
    expect(meta.rewriteLinks).toEqual([{ original: 'Manuscript/Draft.md', rewrite: 'Manuscript/Draft (rewrite).md' }]);

    // scrolling the original carries the rewrite along, and the other way round
    const top = (loc: typeof left) => loc.evaluate((e) => e.scrollTop);
    expect(await left.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeGreaterThan(1000);
    await left.evaluate((e) => (e.scrollTop = 900));
    await waitFor(async () => Math.abs((await top(right)) - 900) < 40, 'the rewrite to follow the original');
    await right.evaluate((e) => (e.scrollTop = 300));
    await waitFor(async () => Math.abs((await top(left)) - 300) < 40, 'the original to follow the rewrite');
    await shot(write, '2-scrolled.png');

    // the Linked switch stops it
    await right.getByRole('button', { name: 'Linked scrolling' }).click();
    await left.evaluate((e) => (e.scrollTop = 1200));
    await new Promise((r) => setTimeout(r, 400));
    expect(Math.abs((await top(right)) - 300)).toBeLessThan(40);
    await right.getByRole('button', { name: 'Linked scrolling' }).click();

    // typing in the rewrite changes the rewrite only
    await right.locator('.ProseMirror').first().click();
    await write.keyboard.press('Control+End');
    await write.keyboard.type(' Rewritten ending.');
    await right.getByText('Rewritten ending.').first().waitFor();
    expect(await left.getByText('Rewritten ending.').count()).toBe(0);
    await right.getByRole('button', { name: /^Save/ }).click(); // saved: only the rewrite changed on disk, the original is as it was
    await waitFor(() => fs.readFileSync(copy, 'utf8').includes('Rewritten ending.'), 'the rewrite to be saved');
    expect(fs.readFileSync(draftOnDisk, 'utf8')).toBe(CHAPTER);
    const dirtyMarks = () => right.locator('.editor-head .dirty').count();
    await waitFor(async () => (await dirtyMarks()) === 0, 'the rewrite to show as saved');

    // off from the rewrite: one pane again; the menu now offers to turn it on from either file
    await right.getByRole('button', { name: 'Rewrite mode' }).click();
    await waitFor(async () => (await panes.count()) === 1, 'one pane');
    await write.getByRole('treeitem', { name: /^Draft\.md/ }).click({ button: 'right' });
    await write.getByRole('menu').getByRole('menuitem', { name: 'Rewrite Mode: Turn On' }).click();
    await waitFor(async () => (await panes.count()) === 2, 'two panes again, from the original');
    await shot(write, '3-from-original.png');
    expect(await write.locator('section.pane.rw-left').getAttribute('data-file')).toMatch(/Draft\.md$/);
    await write.getByRole('treeitem', { name: /^Draft \(rewrite\)\.md/ }).click({ button: 'right' });
    await write.getByRole('menu').getByRole('menuitem', { name: 'Rewrite Mode: Turn Off' }).click();
    await waitFor(async () => (await panes.count()) === 1, 'one pane, turned off from the rewrite');
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]).catch(() => true);
    if (!closed) {
      if (SHOTS) for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(SHOTS, `stuck-${i}.png`) }).catch(() => undefined);
      if (!failed) throw new Error('the app did not close: it is waiting on something (see the screenshots)');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 180_000);
