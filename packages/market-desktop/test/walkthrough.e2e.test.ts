// The whole journey with both real halves: Chromium with the extension talks to the running Electron app.
// Amazon is stood in for by saved pages served from the test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { _electron as electron, chromium, type BrowserContext, type ElectronApplication, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

declare const chrome: any; // exists only inside the extension's service worker, where these callbacks run
const PKG = path.resolve(__dirname, '..');
const EXT_SRC = path.resolve(__dirname, '../../market-extension');
const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const gz = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n)));
const PACKAGED = process.env.CADREL_MARKET_PACKAGED_BIN;
const electronBin = PACKAGED ?? path.resolve(PKG, '../../node_modules/electron/dist/electron');
const PORT = 48210;
const FIRST = 'B0C1R52V2J';

function findChrome(): string | undefined {
  const c = [process.env.CADREL_MARKET_CHROMIUM, chromium.executablePath()];
  try { c.push(...fs.readdirSync('/opt/pw-browsers').filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)); } catch { /* none */ }
  return c.find((x) => x && fs.existsSync(x));
}
const chromePath = findChrome();
const ready = fs.existsSync(electronBin) && !!chromePath && !!(process.env.DISPLAY || !fs.existsSync('/usr/bin/xvfb-run'));

let tmp: string;
let app: ElectronApplication;
let win: Page;
let ctx: BrowserContext;
let worker: Worker;

const capture = (part: string) =>
  worker.evaluate(async (p) => {
    const tab = (await chrome.tabs.query({})).find((t: { url?: string }) => t.url?.includes(p))!;
    // @ts-expect-error exposed by background.js
    return captureTab(tab);
  }, part);

describe.skipIf(!ready)('walkthrough: extension in Chromium + the desktop app', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-walk-'));
    fs.mkdirSync(path.join(tmp, 'user'));
    fs.writeFileSync(path.join(tmp, 'user', 'config.json'), JSON.stringify({ libraryRoot: null, port: PORT }));
    app = await electron.launch({
      executablePath: electronBin,
      args: PACKAGED ? ['--no-sandbox'] : ['--no-sandbox', PKG],
      env: { ...process.env, CADREL_TEST: '1', CADREL_MARKET_USER_DATA: path.join(tmp, 'user'), CADREL_MARKET_TEST_LIBRARY: path.join(tmp, 'lib'), CADREL_MARKET_TEST_EXPORT_DIR: tmp },
    });
    win = await app.firstWindow();

    // the extension, with <all_urls> so automation can take screenshots (a real click grants activeTab instead)
    const ext = path.join(tmp, 'ext');
    fs.cpSync(path.join(EXT_SRC, 'src'), path.join(ext, 'src'), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push('<all_urls>');
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
    ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      executablePath: chromePath, headless: false,
      args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    await ctx.route('https://www.amazon.com/**', (route) => {
      const u = route.request().url();
      if (u.includes('/dp/')) return route.fulfill({ contentType: 'text/html', body: gz(`detail-kindle-${u.match(/\/dp\/([A-Z0-9]{10})/)![1]}.html.gz`) });
      if (u.includes('/zgbs/')) return route.fulfill({ contentType: 'text/html', body: gz('bestsellers-kindle-humorous-fantasy.html.gz') });
      return route.fulfill({ status: 404, body: '' });
    });
    await ctx.route('https://m.media-amazon.com/**', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }));
    await ctx.route('https://read.amazon.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><body style="margin:0;background:#fbf7ee;font:30px 'DejaVu Serif',serif;color:#111"><div id="p" style="padding:50px"></div>
          <script>const T=['The dragon looked at the baker and sighed.<br>"Not again," she said. "It is Tuesday."','Mrs. Pell wiped her hands and walked to the oven.<br>The bread had risen far too high again.','You have reached the end of your free sample.'];
          window.show=(n)=>{document.getElementById('p').innerHTML=T[n]};show(0)</script></body></html>`,
      }),
    );
    worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  }, 120000);

  afterAll(async () => {
    await ctx?.close();
    await app?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('first run: choose a library, show a pairing code, pair the extension with it', async () => {
    await win.getByRole('button', { name: /Choose library folder/ }).click();
    await win.getByRole('tab', { name: 'Settings' }).click();
    await win.getByRole('button', { name: 'Show a pairing code' }).click();
    const code = (await win.getByLabel('Pairing code').textContent())!.trim();
    expect(code).toMatch(/^\d{6}$/);
    expect(await worker.evaluate(([c, p]) => (globalThis as any).pairWithCode(c, p), ['000000', PORT] as const)).toMatchObject({ ok: false });
    expect(await worker.evaluate(([c, p]) => (globalThis as any).pairWithCode(c, p), [code, PORT] as const)).toEqual({ ok: true });
    expect(await worker.evaluate(() => (globalThis as any).ping())).toMatchObject({ ok: true });
    // the code is single-use
    expect(await worker.evaluate(([c, p]) => (globalThis as any).pairWithCode(c, p), [code, PORT] as const)).toMatchObject({ ok: false });
  }, 60000);

  it('capture a bestseller list from the browser: the queue fills in the app', async () => {
    const page = await ctx.newPage();
    await page.goto('https://www.amazon.com/Best-Sellers-Kindle-Store/zgbs/digital-text/11650864011');
    expect(await capture('/zgbs/')).toMatchObject({ ok: true, kind: 'list' });
    await page.close();
    await win.getByRole('tab', { name: 'Queue' }).click();
    await win.locator(`tr[data-asin="${FIRST}"]`).waitFor();
  }, 60000);

  it('"Open next" names the book to visit; capturing it from the browser takes it off the queue', async () => {
    await win.getByRole('button', { name: 'Open next' }).click();
    const [url] = await win.evaluate(() => (window as any).cadrelMarket.__opened());
    expect(url).toBe(`https://www.amazon.com/dp/${FIRST}`);
    const page = await ctx.newPage();
    await page.goto(url);
    expect(await capture(`/dp/${FIRST}`)).toMatchObject({ ok: true, kind: 'detail', asin: FIRST, coversSaved: 1 });
    await win.locator(`tr[data-asin="${FIRST}"]`).waitFor({ state: 'detached' });
    await win.getByRole('tab', { name: 'Library' }).click();
    await win.locator(`tr[data-asin="${FIRST}"]`).waitFor();

    // a free sample, captured while the page turns, then read by the app
    const started = await worker.evaluate(async (p) => {
      const tab = (await chrome.tabs.query({})).find((t: { url?: string }) => t.url?.includes(p))!;
      // @ts-expect-error exposed by background.js
      return startSample(tab);
    }, `/dp/${FIRST}`);
    expect(started).toMatchObject({ ok: true });
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = 'https://read.amazon.com/sample';
      f.setAttribute('style', 'position:fixed;left:60px;top:40px;width:760px;height:560px;border:0;z-index:99999');
      document.body.appendChild(f);
    });
    const frame = await (await page.waitForSelector('iframe[src*="read.amazon.com"]')).contentFrame();
    const pagesSaved = () => {
      const base = path.join(tmp, 'lib', 'books', FIRST, 'lookinside');
      if (!fs.existsSync(base)) return 0;
      return JSON.parse(fs.readFileSync(path.join(base, fs.readdirSync(base)[0]!, 'pages.json'), 'utf8')).length as number;
    };
    await expect.poll(pagesSaved, { timeout: 20000 }).toBe(1);
    await frame!.evaluate(() => (window as any).show(1));
    await expect.poll(pagesSaved, { timeout: 20000 }).toBe(2);
    await frame!.evaluate(() => (window as any).show(2));
    await expect.poll(pagesSaved, { timeout: 20000 }).toBe(3);
    await page.getByRole('button', { name: 'Finish' }).click();

    await win.locator(`tr[data-asin="${FIRST}"] button.link`).click();
    await win.getByLabel('Book text').getByText(/reached the end of the sample/).waitFor({ timeout: 90000 });
    const text = fs.readFileSync(path.join(tmp, 'lib', 'books', FIRST, 'extracted', 'sample.txt'), 'utf8');
    expect(text).toContain('The dragon looked at the baker and sighed.');
    expect(text).toContain('The bread had risen far too high again.');
    await page.close();
  }, 180000);

  it('the analysis, search index and library check work on what was captured', async () => {
    await win.getByRole('button', { name: '← Back' }).click();
    await win.getByRole('tab', { name: 'Analysis' }).click();
    await win.getByRole('heading', { name: 'Category analysis' }).waitFor();
    await win.getByRole('heading', { name: 'Inside the books' }).waitFor();
    await win.getByRole('tab', { name: 'Settings' }).click();
    const card = win.getByLabel('Search index');
    await card.getByRole('button', { name: /Build basic index/ }).click();
    await card.getByText(/model hashing-v1:256/).waitFor();
    await win.getByRole('button', { name: 'Check the library' }).click();
    await win.getByText('The library is healthy.').waitFor();
  }, 60000);
});
