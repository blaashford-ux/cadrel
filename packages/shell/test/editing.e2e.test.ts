import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { DirBlobs } from '@cadrel/store';
import { Studio } from '@cadrel/studio';
import { PeopleHost } from '../src/main/people';

const PKG = path.resolve(__dirname, '..');
// Drives the BUILT app (dist) in Electron, like shell.e2e.test.ts: the Editing page, through its own screen, on a Studio seeded with a delivered pass.
// Set SHOTS to a folder to keep a screenshot of each step.
const electronBin = (() => {
  try {
    return createRequire(path.join(PKG, 'package.json'))('electron') as string;
  } catch {
    return '';
  }
})();
const SHOTS = process.env.SHOTS;
const have = electronBin !== '' && fs.existsSync(electronBin) && (!!process.env.DISPLAY || !fs.existsSync('/usr/bin/xvfb-run'));
const shot = async (page: { screenshot(o: { path: string }): Promise<unknown> }, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};


const V1 = 'The river ran cold.\n\nShe walked slowly to the river and stopped.\n\nIt was loud, and she was tired.';
const V2 = 'The river ran cold.\n\nShe crept to the river and stopped.\n\nIt was loud, and she was tired.';

it.skipIf(!have)('briefs on a book, planning a pass, raising an item from selected text, comparing versions and checking the revision', async () => {
  if (!fs.existsSync(path.join(PKG, 'dist', 'main.mjs'))) execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-edtools-'));
  const home = path.join(tmp, 'home');
  const userData = path.join(tmp, 'userdata');
  fs.mkdirSync(home);
  const dir = path.join(userData, 'studios', 'local');
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'library'));
  fs.writeFileSync(path.join(dir, 'market', 'config.json'), JSON.stringify({ libraryRoot: path.join(tmp, 'library'), port: 48397 }));

  // seed: a Book, and a manuscript in the vault with two versions whose text is really stored
  const host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  await new Studio(path.join(dir, 'studio.json')).createProject({ name: 'Lead Me', kind: 'Book' });
  const blobs = new DirBlobs(path.join(dir, 'vault-blobs'));
  const [h1, h2] = [await blobs.put(new TextEncoder().encode(V1)), await blobs.put(new TextEncoder().encode(V2))];
  const db = (host as unknown as { db: { run(sql: string, p?: unknown[]): Promise<unknown> } }).db;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 'local', 'Lead Me/book.md', 2)");
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, comment, created_at) VALUES ('f1', 1, ?, ?, 'Ana', 'first draft', '2026-11-01T10:00:00.000Z')", [h1, V1.length]);
  await db.run("INSERT INTO file_version (file_id, n, hash, size, author, comment, created_at) VALUES ('f1', 2, ?, ?, 'Ana', 'after the edit', '2026-11-09T10:00:00.000Z')", [h2, V2.length]);
  await host.close();

  const app = await electron.launch({ executablePath: electronBin, args: ['--no-sandbox', PKG], env: { ...process.env, CADREL_TEST: '1', CADREL_USER_DATA: userData, HOME: home, USERPROFILE: home } });
  let failed = false;
  try {
    const shell = await app.firstWindow();
    await shell.waitForSelector('nav.rail', { timeout: 90_000 });

    // ---- the book's briefs: write an edit brief, then revise it (the first version stays)
    await shell.getByRole('button', { name: 'Projects', exact: true }).click();
    await shell.locator('.tree-row', { hasText: 'Lead Me' }).first().click();
    await shell.getByRole('heading', { name: 'Briefs' }).waitFor();
    await shell.getByRole('button', { name: 'New brief' }).click();
    const nb = shell.locator('form.brief-form');
    await nb.getByLabel('Kind').selectOption('edit');
    await nb.getByLabel('Title').fill('Line edit brief');
    await nb.getByLabel('Brief', { exact: true }).fill('Cut filter words. Keep the voice.');
    await shot(shell, 'b1-new-brief.png');
    await shell.getByRole('button', { name: 'Save the brief' }).click();
    const brief = shell.getByRole('article', { name: 'Line edit brief' });
    await brief.getByText('version 1').waitFor();
    await brief.getByRole('button', { name: 'Revise…' }).click();
    await brief.locator('textarea').fill('Cut filter words. Keep the voice. Watch the adverbs.');
    await brief.getByLabel('What changed (optional)').fill('added adverbs');
    await brief.getByRole('button', { name: 'Save as version 2' }).click();
    await brief.getByText('version 2').waitFor();
    await brief.getByRole('button', { name: 'Earlier versions' }).click();
    await brief.getByText('Cut filter words. Keep the voice.', { exact: true }).waitFor();
    await shot(shell, 'b2-brief-history.png');

    // ---- plan a pass over the manuscript, under that brief
    await shell.getByRole('button', { name: 'Editing', exact: true }).click();
    await shell.getByRole('button', { name: 'Plan a pass…' }).click();
    const form = shell.getByRole('region', { name: 'Plan a pass' });
    await form.getByLabel('Manuscript').selectOption({ label: 'Lead Me/book.md (version 2)' });
    await form.getByLabel('Kind of pass').selectOption('line');
    await form.getByLabel('Version to cover').selectOption('1'); // the manuscript has moved on since: the pass covers the first draft
    await form.getByLabel('Edit brief').selectOption({ label: 'Line edit brief (version 2)' });
    expect(await form.getByLabel('Editor').innerText()).toContain('Ana Reyes');
    await shot(shell, 'b3-plan.png');
    await form.getByRole('button', { name: 'Plan the pass' }).click();
    await shell.getByRole('heading', { name: 'Line edit' }).waitFor();
    await shell.getByText(/version 1, brief version 2/).waitFor();
    await shell.getByRole('button', { name: 'Start' }).click();

    // ---- read the text, select a passage, raise a suggestion about exactly that
    await shell.getByRole('button', { name: 'Read it and raise items' }).click();
    await shell.locator('pre.ed-text').waitFor();
    expect(await shell.locator('pre.ed-text').innerText()).toBe(V1); // the version the pass covers, not the newest
    const select = (needle: string) =>
      shell.evaluate((text) => {
        const pre = document.querySelector('pre.ed-text')!;
        const node = pre.firstChild as Text;
        const i = node.data.indexOf(text);
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + text.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        pre.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, needle);
    await select('walked slowly');
    await shell.getByText('Selected:').waitFor();
    await shell.getByLabel('What to raise').selectOption('suggestion');
    await shell.getByLabel('Text', { exact: true }).fill('Stronger verb.');
    await shell.getByLabel('Replace the passage with').fill('crept');
    await shot(shell, 'b4-raise.png');
    await shell.getByRole('button', { name: 'Add to the pass' }).click();
    const item = shell.getByRole('region', { name: 'Suggestion 1' });
    await item.getByText('walked slowly', { exact: true }).waitFor();
    await item.getByText('crept').waitFor();
    // a query on another passage, and a point about the whole pass that needs no selection
    await select('It was loud');
    await shell.getByLabel('What to raise').selectOption('query');
    await shell.getByLabel('Text', { exact: true }).fill('Loud how?');
    await shell.getByRole('button', { name: 'Add to the pass' }).click();
    await shell.getByRole('region', { name: 'Query 2' }).waitFor();
    await shell.getByLabel('What to raise').selectOption('comment');
    await shell.getByLabel('About the whole pass, not a passage').check();
    await shell.getByLabel('Text', { exact: true }).fill('A strong chapter.');
    await shell.getByRole('button', { name: 'Add to the pass' }).click();
    await shell.getByRole('region', { name: 'Comment 3' }).waitFor();

    // ---- the author's turn: answer, decide, respond
    await shell.getByRole('button', { name: 'Deliver to the author' }).click();
    await shell.getByRole('region', { name: 'Query 2' }).getByLabel('Your answer').fill('Loud enough to wake the street.');
    await shell.getByRole('region', { name: 'Query 2' }).getByRole('button', { name: 'Save the answer' }).click();
    await item.getByRole('button', { name: 'Accept' }).click();
    await shell.getByRole('region', { name: 'Comment 3' }).getByRole('button', { name: 'Accept' }).click();
    await shell.getByRole('button', { name: 'Mark as responded' }).click();

    // ---- the revision: version 2 exists, so the pass can be compared with it and checked against it
    await shell.getByRole('heading', { name: 'The revision' }).waitFor();
    await shell.getByRole('button', { name: 'Compare with version 1' }).click();
    await shell.locator('.ed-compare del', { hasText: 'walked slowly' }).waitFor();
    await shell.locator('.ed-compare ins', { hasText: 'crept' }).waitFor();
    await shell.getByText(/1 changed, 0 added, 0 removed/).waitFor();
    expect(await shell.locator('.ed-compare tbody tr').count()).toBe(3); // a short chapter: both neighbours of the change are shown as context
    await shot(shell, 'b5-compare.png');
    await shell.getByRole('button', { name: 'Check the accepted changes' }).click();
    await item.getByText('Revision: made').waitFor();
    await shell.getByRole('region', { name: 'Comment 3' }).getByText('Revision: unchecked').waitFor(); // a point about the whole pass has no passage to look for
    await shot(shell, 'b6-checked.png');
    await shell.getByRole('button', { name: 'Close the pass' }).click();
    await shell.getByRole('button', { name: '← All passes' }).click();
    await shell.getByRole('heading', { name: /Done/ }).waitFor();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]).catch(() => true);
    if (!closed && SHOTS) for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(SHOTS, `stuck-${i}.png`) }).catch(() => undefined);
    if (!closed && !failed) throw new Error('the app did not close');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 180_000);
