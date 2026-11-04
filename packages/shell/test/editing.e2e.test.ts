import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
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

it.skipIf(!have)('answers, decides and closes a pass through the Editing page', async () => {
  if (!fs.existsSync(path.join(PKG, 'dist', 'main.mjs'))) execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: 'ignore' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-edvis-'));
  const home = path.join(tmp, 'home');
  const userData = path.join(tmp, 'userdata');
  fs.mkdirSync(home);
  const dir = path.join(userData, 'studios', 'local');
  fs.mkdirSync(path.join(dir, 'market'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'library'));
  fs.writeFileSync(path.join(dir, 'market', 'config.json'), JSON.stringify({ libraryRoot: path.join(tmp, 'library'), port: 48399 }));

  // seed: a Book with a delivered line edit that has a query, a suggestion and a comment
  const host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
  const st = new Studio(path.join(dir, 'studio.json'));
  const book = await st.createProject({ name: 'Lead Me', kind: 'Book' });
  const db = (host as unknown as { db: { run(sql: string, p?: unknown[]): Promise<unknown> } }).db;
  await db.run("INSERT INTO vault_file (id, studio_id, path, current_version) VALUES ('f1', 'local', 'Lead Me/book.md', 3)");
  for (const n of [1, 2, 3]) await db.run("INSERT INTO file_version (file_id, n, hash, size, author, created_at) VALUES ('f1', ?, ?, 1, 'x', '2026-11-01T00:00:00.000Z')", [n, `h${n}`]);
  const me = host.service!.as(host.me);
  const p = await me.passes.create({ projectId: book.id, kind: 'line', fileId: 'f1', fileVersion: 3, editorId: host.me, title: 'Line edit, round one' });
  await me.passes.start(p.id);
  await me.queries.raise(p.id, [
    { kind: 'query', body: 'Cold how? Give the temperature or the feeling.', anchor: { quote: 'The river ran cold.', prefix: '', suffix: '', start: 0 }, category: 'clarity' },
    { kind: 'suggestion', body: 'Stronger verb.', anchor: { quote: 'walked slowly', prefix: '', suffix: '', start: 30 }, replacement: 'crept' },
    { kind: 'comment', body: 'Lovely rhythm in this paragraph.' }
  ]);
  await me.passes.deliver(p.id);
  const second = await me.passes.create({ projectId: book.id, kind: 'copy', fileId: 'f1', fileVersion: 3, editorId: host.me });
  void second;
  await host.close();

  const app = await electron.launch({ executablePath: electronBin, args: ['--no-sandbox', PKG], env: { ...process.env, CADREL_TEST: '1', CADREL_USER_DATA: userData, HOME: home, USERPROFILE: home } });
  try {
    const shell = await app.firstWindow();
    await shell.waitForSelector('nav.rail');
    await shell.getByRole('button', { name: 'Editing', exact: true }).click();
    await shell.getByRole('heading', { name: /Waiting for you/ }).waitFor({ timeout: 15000 });
    await shot(shell, '1-list.png');
    await shell.getByRole('button', { name: 'Line edit, round one' }).click();
    await shell.getByRole('heading', { name: 'Line edit, round one' }).waitFor();
    await shot(shell, '2-pass.png');
    // the "mark as responded" button is held until the query is answered and the suggestion decided
    expect(await shell.getByRole('button', { name: 'Mark as responded' }).isDisabled()).toBe(true);
    await shell.getByLabel('Your answer').fill('Freezing: it hurt to touch.');
    await shell.getByRole('button', { name: 'Save the answer' }).click();
    await shell.getByRole('button', { name: 'Change the answer' }).waitFor();
    const sug = shell.getByRole('region', { name: 'Suggestion 2' });
    await sug.getByRole('button', { name: 'Defer…' }).click();
    await sug.getByLabel('Why').fill('Wait for beta readers.');
    await sug.getByLabel('Come back to it on').fill('2026-12-01');
    await shot(shell, '3-deciding.png');
    await sug.getByRole('button', { name: 'Defer', exact: true }).click();
    await shell.getByText('Deferred to 2026-12-01').waitFor();
    expect(await shell.getByRole('button', { name: 'Mark as responded' }).isDisabled()).toBe(false);
    await shell.getByRole('button', { name: 'Mark as responded' }).click();
    await shell.getByRole('button', { name: 'Close the pass' }).waitFor();
    await shot(shell, '4-responded.png');
    await shell.getByRole('button', { name: 'Close the pass' }).click();
    await shell.getByText('Closed', { exact: true }).first().waitFor();
    await shell.getByRole('button', { name: '← All passes' }).click();
    await shell.getByRole('heading', { name: /Done/ }).waitFor();
    await shot(shell, '5-done.png');
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 120_000);
