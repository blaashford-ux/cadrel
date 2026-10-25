// Runs the real built Electron app (under a virtual display if needed) and drives the UI.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PKG = path.resolve(__dirname, '..');
const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const gz = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const electronBin = path.resolve(PKG, '../../node_modules/electron/dist/electron');
// Set to the installed app's executable (see `npm run pack`) to run this whole suite against the packaged build.
const PACKAGED = process.env.CADREL_MARKET_PACKAGED_BIN;
const have = (PACKAGED ? fs.existsSync(PACKAGED) : fs.existsSync(electronBin)) && !!(process.env.DISPLAY || fs.existsSync('/usr/bin/xvfb-run') === false);
const PORT = 48200;

let tmp: string, app: ElectronApplication, page: Page;

function post(token: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/capture', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe.skipIf(!have)('desktop app in Electron', () => {
  beforeAll(async () => {
    if (!PACKAGED) execFileSync('node', ['scripts/build.mjs'], { cwd: PKG });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-app-'));
    fs.mkdirSync(path.join(tmp, 'user'));
    fs.mkdirSync(path.join(tmp, 'exports'));
    // a real PDF, so the installed app's PDF reader (pdf.js, loaded from inside the app bundle) is exercised too
    const pdfBytes = await new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument({ size: 'A5', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      for (const [i, title] of ['Chapter One', 'Chapter Two'].entries()) {
        if (i) doc.addPage();
        doc.fontSize(18).text(title).moveDown(1);
        for (let n = 0; n < 12; n++) doc.fontSize(11).text(`"Not again," said the dragon to Mrs. Pell. The baker sighed and looked at the oven, number ${n}.`).moveDown(0.8);
      }
      doc.end();
    });
    fs.writeFileSync(path.join(tmp, 'quiet-dragon.pdf'), pdfBytes);
    fs.writeFileSync(path.join(tmp, 'user', 'config.json'), JSON.stringify({ libraryRoot: null, port: PORT }));
    app = await electron.launch({
      executablePath: PACKAGED ?? electronBin,
      args: PACKAGED ? ['--no-sandbox'] : ['--no-sandbox', PKG],
      env: { ...process.env, CADREL_TEST: '1', CADREL_MARKET_USER_DATA: path.join(tmp, 'user'), CADREL_MARKET_TEST_LIBRARY: path.join(tmp, 'lib'), CADREL_MARKET_TEST_EXPORT_DIR: path.join(tmp, 'exports'), CADREL_MARKET_TEST_MANUSCRIPT: path.join(tmp, 'quiet-dragon.pdf') },
    });
    page = await app.firstWindow();
  }, 90000);

  afterAll(async () => {
    await app?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('asks for a library on first run, then shows the empty queue', async () => {
    await page.getByRole('heading', { name: 'Welcome to Cadrel Market' }).waitFor();
    await page.getByRole('button', { name: /Choose library folder/ }).click();
    await page.getByRole('heading', { name: 'Capture queue' }).waitFor();
    await page.getByText(`Listening on port ${PORT}`).waitFor();
    await page.getByText(/Nothing to capture/).waitFor();
    fs.mkdirSync(path.join(tmp, 'shots'), { recursive: true });
    await page.screenshot({ path: path.join(tmp, 'shots', 'queue-empty.png') });
  }, 60000);

  it('fills the queue live when the extension sends a list, and Open next works', async () => {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    const token = (await page.getByLabel('Pairing token').textContent())!.trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(await post(token, { url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).toBe(200);

    await page.getByRole('tab', { name: 'Queue' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"]').waitFor();
    await page.getByRole('button', { name: 'Open next' }).click();
    await page.getByRole('status').filter({ hasText: /^Opened/ }).waitFor();
    expect(await page.evaluate(() => (window as any).cadrelMarket.__opened())).toEqual(['https://www.amazon.com/dp/B0C1R52V2J']);
    await page.locator('tr[data-asin="B0C1R52V2J"] .pill.opened').waitFor();
    await page.screenshot({ path: path.join(tmp, 'shots', 'queue.png') });
  }, 60000);

  it('moves a captured book from the queue into the library', async () => {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    const token = (await page.getByLabel('Pairing token').textContent())!.trim();
    expect(await post(token, { url: 'https://www.amazon.com/dp/B0C1R52V2J', html: gz('detail-kindle-B0C1R52V2J.html.gz'), covers: [{ ext: 'png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }] })).toBe(200);

    await page.getByRole('tab', { name: 'Queue' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"]').waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'Library' }).click();
    // every column sorts and filters
    await page.locator('tr[data-asin="B0C1R52V2J"]').waitFor();
    await page.getByRole('button', { name: 'Rank', exact: true }).click();
    await page.locator('th[aria-sort="ascending"]').waitFor();
    await page.getByLabel('Filter Title').fill('zzz-no-such-title');
    await page.locator('tr[data-asin="B0C1R52V2J"]').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Clear filters and sorting' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"]').waitFor();
    await page.locator('tr[data-asin="B0C1R52V2J"] button.link').click();
    await page.getByRole('heading', { level: 1 }).filter({ hasText: /\S/ }).waitFor();
    await page.getByText(/History \(1 capture\)/).waitFor();
    await page.getByRole('img', { name: 'Cover' }).waitFor();
    await page.screenshot({ path: path.join(tmp, 'shots', 'book.png') });
    fs.mkdirSync('/tmp/cadrel-market-shots', { recursive: true });
    for (const f of fs.readdirSync(path.join(tmp, 'shots'))) fs.copyFileSync(path.join(tmp, 'shots', f), path.join('/tmp/cadrel-market-shots', f));
  }, 60000);

  it('builds a search index, and the copied Claude Desktop setting really starts a working MCP server on the library', async () => {
    await page.getByRole('tab', { name: 'Settings' }).click();
    const card = page.getByLabel('Search index');
    await card.getByText(/not built yet/).waitFor();
    await card.getByRole('button', { name: /Build basic index/ }).click();
    await card.getByText(/model hashing-v1:256/).waitFor();
    const m = (await card.textContent())!.match(/([\d,]+) text chunks · ([\d,]+) indexed/)!;
    expect(m[1]).toBe(m[2]);
    expect(Number(m[1]!.replace(/,/g, ''))).toBeGreaterThan(0);

    const connect = page.getByLabel('Connect an AI');
    await connect.getByRole('button', { name: 'Claude Code' }).click();
    expect(await connect.locator('code').first().textContent()).toMatch(/^claude mcp add cadrel-market /);
    // one click writes Cadrel Market.mcpb and shows it in its folder, with the steps (recorded, not shown, under test)
    await connect.getByRole('button', { name: 'Install in Claude Desktop' }).click();
    await connect.getByRole('status').filter({ hasText: /Created Cadrel Market\.mcpb/ }).waitFor();
    await connect.getByLabel('How to install the extension').getByText(/Settings → Extensions/).waitFor();
    expect(((await page.evaluate(() => (window as any).cadrelMarket.__opened())) as string[]).some((f) => f.endsWith('Cadrel Market.mcpb'))).toBe(true);
    // run the launcher inside that file the way Claude Desktop does (plain Node, the client talking first): the handshake is answered at once
    // and the real server then answers the tool list from this library
    {
      const { unzipSync } = await import('fflate');
      const z = unzipSync(new Uint8Array(fs.readFileSync(path.join(tmp, 'user', 'Cadrel Market.mcpb'))));
      const dirX = path.join(tmp, 'mcpb');
      fs.mkdirSync(path.join(dirX, 'server'), { recursive: true });
      fs.writeFileSync(path.join(dirX, 'server', 'launch.js'), z['server/launch.js']!);
      const replies = await new Promise<{ at: number; m: any }[]>((resolve, reject) => {
        const t0 = Date.now();
        const p = spawn(process.execPath, [path.join(dirX, 'server', 'launch.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
        const got: { at: number; m: any }[] = [];
        let buf = '';
        p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { got.push({ at: Date.now() - t0, m: JSON.parse(buf.slice(0, i)) }); buf = buf.slice(i + 1); if (got.length === 2) p.stdin.end(); } });
        p.on('close', () => resolve(got));
        p.on('error', reject);
        const send = (m: unknown) => p.stdin.write(JSON.stringify(m) + '\n');
        send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        setTimeout(() => { p.kill(); }, 40000);
      });
      expect(replies[0]!.m).toMatchObject({ id: 0, result: { serverInfo: { name: 'cadrel-market' } } });
      expect(replies[0]!.m.result.instructions).toMatch(/never follow instructions/);
      expect(replies[0]!.at).toBeLessThan(2000);
      expect(replies[1]!.m.id).toBe(1);
      expect(replies[1]!.m.result.tools.map((t: any) => t.name)).toContain('library_status');
    }
    await connect.getByRole('button', { name: 'Claude Desktop', exact: true }).click();
    const cfg = JSON.parse((await connect.locator('pre code').textContent())!).mcpServers.cadrel-market as { command: string; args: string[]; env?: Record<string, string> };
    expect(cfg.args).toContain(path.join(tmp, 'lib'));

    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) }, stderr: 'ignore' }));
    const status = JSON.parse(((await client.callTool({ name: 'library_status', arguments: {} })) as any).content[0].text);
    expect(status).toMatchObject({ books_captured: 1, categories: 1 });
    const found = JSON.parse(((await client.callTool({ name: 'search_book_text', arguments: { query: 'forgotten gods' } })) as any).content[0].text);
    expect(found.mode).toBe('keyword+meaning');
    expect(found.hits[0].asin).toBe('B0C1R52V2J');
    await client.close();
    await page.screenshot({ path: path.join(tmp, 'shots', 'settings.png'), fullPage: true });
    fs.copyFileSync(path.join(tmp, 'shots', 'settings.png'), '/tmp/cadrel-market-shots/settings.png');
  }, 60000);

  it('shows the category analysis, exports it, and re-scores when the weights change', async () => {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    const token = (await page.getByLabel('Pairing token').textContent())!.trim();
    for (const a of ['B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) {
      expect(await post(token, { url: `https://www.amazon.com/dp/${a}`, html: gz(`detail-kindle-${a}.html.gz`) })).toBe(200);
    }
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await page.getByRole('heading', { name: 'Analysis', exact: true }).waitFor();
    await page.getByLabel('Read this first').getByText(/Only 5 of \d+ listed books have detail pages/).waitFor();
    await page.getByRole('heading', { name: 'Top 10 against the rest' }).waitFor();
    await page.getByRole('img', { name: 'Price bands, top cohort against the rest' }).waitFor();
    await page.getByRole('img', { name: 'List rank against price' }).waitFor();
    await page.getByRole('heading', { name: 'Covers' }).waitFor();
    await page.locator('tr[data-asin="B0C1R52V2J"]').waitFor();
    const first = await page.locator('tr[data-asin="B0C1R52V2J"] td').nth(2).textContent();
    expect(first).toMatch(/\d/);

    await page.getByLabel('Top N').selectOption('5');
    await page.getByRole('heading', { name: 'Top 5 against the rest' }).waitFor();

    // opportunity, trope clusters and sub-category shelves
    const opp = page.getByLabel('Opportunity', { exact: true });
    await opp.getByRole('heading', { name: 'Opportunity' }).waitFor();
    await opp.locator('tr[data-component="reviewBarrier"]').waitFor();
    await opp.locator('tr[data-component="churn"]').getByText('Missing').waitFor(); // one list capture only
    await page.getByRole('heading', { name: 'Sub-category shelves' }).waitFor();
    // the text-derived sections live on their own sub-tab
    await page.getByLabel('Community sources').getByRole('button', { name: 'Sync last 7 days' }).waitFor();
    await page.getByRole('button', { name: 'Text Analysis' }).click();
    await page.getByRole('heading', { name: 'Trope clusters' }).waitFor();
    await page.getByRole('heading', { name: 'Main character and love interest(s)' }).waitFor();
    await page.getByRole('button', { name: 'Re-run character analysis' }).click();
    await page.getByRole('button', { name: 'Category Analysis' }).click();
    await page.getByRole('heading', { name: 'Sub-category shelves' }).waitFor();
    await opp.getByLabel('Curve exponent b').fill('0.8');
    await opp.getByRole('button', { name: 'Save sales curve' }).click();
    await opp.getByRole('status').filter({ hasText: 'Sales curve saved' }).waitFor();
    expect(await page.evaluate(() => window.cadrelMarket.salesCurve())).toMatchObject({ b: 0.8 });
    await opp.getByLabel('Curve exponent b').fill('0.79');
    await opp.getByRole('button', { name: 'Save sales curve' }).click();

    // rank-only weighting puts the #1 book at exactly 100
    await page.getByLabel('Stability').fill('0');
    await page.getByLabel('Velocity').fill('0');
    await page.getByRole('button', { name: 'Apply weights' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"] td').nth(2).filter({ hasText: '100' }).waitFor();

    await page.getByRole('button', { name: 'Export CSV' }).click();
    await page.getByRole('status').filter({ hasText: /Saved .*\.csv/ }).waitFor();
    await page.getByRole('button', { name: 'Export report' }).click();
    await page.getByRole('status').filter({ hasText: /Saved .*\.md/ }).waitFor();
    const files = fs.readdirSync(path.join(tmp, 'exports')).sort();
    expect(files.map((f) => path.extname(f))).toEqual(['.csv', '.md']);
    const csv = fs.readFileSync(path.join(tmp, 'exports', files[0]!), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('B0C1R52V2J');
    expect(fs.readFileSync(path.join(tmp, 'exports', files[1]!), 'utf8')).toMatch(/^# Humorous: category report/);
    await page.screenshot({ path: path.join(tmp, 'shots', 'analysis.png'), fullPage: true });
    fs.copyFileSync(path.join(tmp, 'shots', 'analysis.png'), '/tmp/cadrel-market-shots/analysis.png');
  }, 90000);

  it('keeps the tab bar visible while a long page scrolls, and has an About page with a working update check', async () => {
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await page.getByRole('heading', { name: 'Analysis', exact: true }).waitFor();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => window.scrollY > 300);
    const bar = await page.locator('header.tabs').boundingBox();
    expect(bar!.y).toBe(0);
    expect(await page.getByRole('tab', { name: 'About' }).count()).toBe(0); // About lives in the menu, beside Window
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label));
    expect(labels.indexOf('About')).toBe(labels.indexOf('Window') + 1);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('about')!.click()); // reachable while scrolled
    await page.getByRole('heading', { name: 'About Cadrel Market' }).waitFor();
    expect(await page.getByTestId('version').textContent()).toBe(JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version);
    await page.getByRole('button', { name: 'Check for updates' }).click();
    // offline or private repository: a clear message; online and public: a result. Either way it answers.
    await page.getByLabel('Updates').getByRole('alert').or(page.getByLabel('Updates').getByRole('status')).first().waitFor({ timeout: 30000 });
    await page.getByLabel('GitHub token').waitFor();
    await page.screenshot({ path: path.join(tmp, 'shots', 'about.png'), fullPage: true });
    fs.copyFileSync(path.join(tmp, 'shots', 'about.png'), '/tmp/cadrel-market-shots/about.png');
  }, 60000);

  it('attaches a book file and shows what the text says; reads a captured sample with real OCR', async () => {
    await page.getByRole('tab', { name: 'Library' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"] button.link').click();
    const card = page.getByLabel('Book text');
    await card.getByRole('button', { name: 'Choose file…' }).click();
    await card.getByText(/quiet-dragon\.pdf/).waitFor();
    await card.getByText(/2 chapters/).waitFor();
    await card.getByRole('heading', { name: 'What the text shows' }).waitFor();
    await card.getByText('Dialogue share').waitFor();
    await card.getByText(/Opening \(first/).waitFor();
    await page.screenshot({ path: path.join(tmp, 'shots', 'text.png'), fullPage: true });
    fs.copyFileSync(path.join(tmp, 'shots', 'text.png'), '/tmp/cadrel-market-shots/text.png');

    // the Library list now shows the book has its text
    await page.getByRole('button', { name: '← Back' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"] td').last().filter({ hasText: 'book' }).waitFor();

    // a sample captured by the extension: three screenshots, the last being the reader's end-of-sample screen
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    const token = (await page.getByLabel('Pairing token').textContent())!.trim();
    const render = (lines: string[]) =>
      sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="100%" height="100%" fill="#fbf7ee"/><rect width="1000" height="50" fill="#232f3e"/>${lines.map((l, i) => `<text x="80" y="${130 + i * 46}" font-family="DejaVu Serif, serif" font-size="28" fill="#111">${l}</text>`).join('')}</svg>`)).png().toBuffer();
    const pages = [
      await render(['The dragon looked at the baker and sighed.', '"Not again," she said. "It is Tuesday."']),
      await render(['Mrs. Pell wiped her hands and walked to the oven.', 'The bread had risen far too high again.']),
      await render(["You've reached the end of your free sample."]),
    ];
    const S = '20261019T100000Z';
    const postJson = (p: string, body: unknown) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: p, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    for (const img of pages) expect(await postJson('/v1/sample/page', { asin: 'B0C1R52V2J', session: S, ext: 'png', image: img.toString('base64'), crop: { left: 0, top: 60, width: 1000, height: 640 } })).toBe(200);
    expect(await postJson('/v1/sample/finish', { asin: 'B0C1R52V2J', session: S })).toBe(200);

    await page.getByRole('tab', { name: 'Library' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"] button.link').click();
    await card.getByText(/reached the end of the sample/).waitFor({ timeout: 60000 });
    const text = fs.readFileSync(path.join(tmp, 'lib', 'books', 'B0C1R52V2J', 'extracted', 'sample.txt'), 'utf8');
    expect(text).toContain('The dragon looked at the baker and sighed.');
    expect(text).toContain('The bread had risen far too high again.');
    expect(text).not.toMatch(/end of your free sample/i);
  }, 120000);
  it('My Books: importing a KDP report creates the user\'s books, an uncaptured one opens to "Open on Amazon", and captured ones are marked', async () => {
    await page.getByRole('tab', { name: 'Library' }).click();
    const back = page.getByRole('button', { name: '← Back' });
    if (await back.isVisible()) await back.click(); // the previous test left a book open
    await page.getByRole('button', { name: 'My Books' }).click();
    await page.getByText(/No books of yours yet/).waitFor();
    const csv = ['Date,Title,Author Name,ASIN,Marketplace,Paid Units', '2026-10-16,Waiting One,Jo Writer,B0AAAAAAAA,Amazon.com,9', '2026-10-17,A Book I Captured,Jo Writer,B0C1R52V2J,Amazon.com,3', '2026-10-18,Joint Venture,Jo Writer & Sam Partner,B0BBBBBBBB,Amazon.com,2'].join('\n');
    await page.locator('input[type=file]').first().setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByText(/3 new books added to My Books/).waitFor();
    const waiting = page.locator('tr[data-asin]').filter({ hasText: 'Waiting One' });
    await waiting.waitFor();
    await page.getByText(/1 of 3 captured/).waitFor();
    // the Library's columns, with Pen Name where Mine was, and Orders and KU added; Pen Name filters and sorts
    for (const name of ['Title', 'Author', 'Rank', 'Store rank', 'Rating', 'Ratings', 'Price', 'Captures', 'Text', 'Pen Name', 'Orders', 'KU pages read']) await page.getByRole('button', { name, exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Mine', exact: true }).count()).toBe(0);
    await waiting.getByText('Jo Writer').waitFor();
    // a collaboration shows every pen name, and filtering by either name finds it
    const joint = page.locator('tr[data-asin="B0BBBBBBBB"]');
    await joint.getByText('Jo Writer, Sam Partner').first().waitFor();
    await page.getByLabel('Filter Pen Name').selectOption('Sam Partner');
    await page.getByText('1 of 3 books').waitFor();
    await page.getByLabel('Filter Pen Name').selectOption('Jo Writer');
    await page.getByText('3 books').first().waitFor();
    await page.getByLabel('Filter Pen Name').selectOption('');
    await page.getByRole('button', { name: 'Pen Name', exact: true }).click();
    await page.locator('th[aria-sort="ascending"]').getByText('Pen Name').waitFor();
    await page.screenshot({ path: path.join(tmp, 'shots', 'mybooks.png'), fullPage: true });

    // the book that was never captured has a page of its own with the way to capture it
    await waiting.getByRole('button', { name: 'Waiting One' }).click();
    await page.getByRole('heading', { name: 'Waiting One' }).waitFor();
    await page.getByText(/Bring this book into the library/).waitFor();
    await page.getByText('Not captured yet').waitFor();
    await page.getByText(/9 paid units/).waitFor();
    await page.getByRole('button', { name: 'Open on Amazon' }).click();
    expect((await page.evaluate(() => (window as any).cadrelMarket.__opened())) as string[]).toContain('https://www.amazon.com/dp/B0AAAAAAAA');
    await page.getByRole('button', { name: '← Back' }).click();

    // the captured one shows its real data, and All books marks it
    await page.getByRole('button', { name: 'All books' }).click();
    await page.locator('tr[data-asin="B0C1R52V2J"] td').filter({ hasText: '★' }).waitFor();
  }, 60000);
  it('Analysis has a Reader Community tab that says what to do before any subreddit is synced', async () => {
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await page.getByRole('button', { name: 'Reader Community' }).click();
    await page.getByText(/Nothing synced for this category yet/).waitFor();
    await page.getByRole('button', { name: 'Category Analysis' }).click();
    await page.getByRole('heading', { name: 'Success score' }).waitFor();
  }, 60000);
  it('Keywords: suggests phrases for a captured category above the search, and has a Search History tab', async () => {
    await page.getByRole('tab', { name: 'Keywords' }).click();
    await page.getByRole('heading', { name: 'Suggest Keywords' }).waitFor();
    await page.getByLabel('Category', { exact: true }).waitFor();
    const chips = page.getByLabel('Suggest Keywords').getByRole('listitem');
    await chips.first().waitFor();
    expect(await chips.count()).toBeGreaterThanOrEqual(1);
    expect(await chips.count()).toBeLessThanOrEqual(5);
    expect(((await chips.first().textContent()) ?? '').length).toBeGreaterThan(2);
    await page.getByRole('button', { name: /^Search History/ }).click();
    await page.getByText(/No searches (yet|have been filed)/).waitFor();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('heading', { name: 'Suggest Keywords' }).waitFor();
  }, 60000);
});
