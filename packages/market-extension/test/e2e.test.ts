// Loads the unpacked extension into real Chromium, serves fixture pages in place of amazon.com,
// and checks that a capture lands in a real library through the real ingest server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, type BrowserContext, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Library } from '@cadrel/market-library';
import { startIngestServer, type SampleLogEvent } from '@cadrel/market-server';

const SRC = path.resolve(__dirname, '..');
/**
 * Screenshots need either the activeTab permission (granted when the user clicks the toolbar button or menu item, which
 * automation cannot do) or <all_urls>. The tests run a copy of the extension with <all_urls> added; the shipped manifest
 * relies on activeTab only.
 */
let EXT = SRC;
const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const ASIN = 'B0G7R6X55V';
const TOKEN = 'e2e-token-'.padEnd(43, 'x');
/**
 * CADREL_MARKET_CHROMIUM, else the Chromium Playwright installed (`npx playwright install chromium`), else the one in /opt/pw-browsers.
 * Not CHROME_BIN: CI runners set it to branded Google Chrome, which ignores --load-extension, so the extension never loads. */
function findChrome(): string | undefined {
  const candidates = [process.env.CADREL_MARKET_CHROMIUM, chromium.executablePath()];
  try {
    candidates.push(...fs.readdirSync('/opt/pw-browsers').filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`));
  } catch {
    /* not there */
  }
  return candidates.find((c) => c && fs.existsSync(c));
}
const chromePath = findChrome();
const haveBrowser = !!chromePath && fs.existsSync(chromePath);

const gunzip = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n)));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** When the extension's service worker never starts, say why: version, launch flags and what chrome://extensions shows. */
async function diagnose(c: BrowserContext, exe: string, ext: string): Promise<string> {
  const out: string[] = [`exe=${exe}`, `ext=${ext} files=${fs.readdirSync(ext).join(',')}`];
  try {
    const p = await c.newPage();
    await p.goto('chrome://version', { timeout: 10000 });
    out.push('VERSION: ' + (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 1500));
    await p.goto('chrome://extensions', { timeout: 10000 });
    await p.waitForTimeout(1500);
    out.push(
      'EXTENSIONS: ' +
        (await p.evaluate(() => {
          const m = document.querySelector('extensions-manager')?.shadowRoot;
          const items = m?.querySelectorAll('extensions-item-list')[0]?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
          return [...items].map((i) => (i.shadowRoot as ShadowRoot).textContent?.replace(/\s+/g, ' ').trim()).join(' | ') || (m?.textContent ?? 'no manager').replace(/\s+/g, ' ').slice(0, 800);
        })),
    );
  } catch (e) {
    out.push('diagnose failed: ' + (e as Error).message);
  }
  out.push('workers=' + c.serviceWorkers().map((w) => w.url()).join(','), 'pages=' + c.pages().map((q) => q.url()).join(','));
  return out.join('\n');
}

let root: string, profile: string;
let lib: Library;
let srv: Awaited<ReturnType<typeof startIngestServer>>;
const sampleLog: SampleLogEvent[] = [];
let ctx: BrowserContext;
let worker: Worker;

const capture = (urlPart: string) =>
  worker.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.includes(part));
    // @ts-expect-error exposed by background.js
    return captureTab(tab);
  }, urlPart);
const badge = (urlPart: string) =>
  worker.evaluate(async (part) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(part))!;
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, urlPart);

describe.skipIf(!haveBrowser)('extension in Chromium', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-lib-'));
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-prof-'));
    EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-ext-'));
    fs.cpSync(path.join(SRC, 'src'), path.join(EXT, 'src'), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push('<all_urls>');
    fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest));
    lib = Library.open(root);
    srv = await startIngestServer({ library: lib, token: TOKEN, onSampleLog: (e) => sampleLog.push(e) }, 0);
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: chromePath,
      headless: false,
      // Playwright passes --disable-extensions by default, which stops --load-extension from starting the service worker
      // on current Chromium builds (it worked on older ones).
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await ctx.route('https://www.amazon.com/**', (route) => {
      const u = route.request().url();
      if (u.includes('/dp/')) return route.fulfill({ contentType: 'text/html', body: gunzip(`detail-kindle-${ASIN}.html.gz`) });
      if (u.includes('/zgbs/')) return route.fulfill({ contentType: 'text/html', body: gunzip('bestsellers-kindle-humorous-fantasy.html.gz') });
      return route.fulfill({ status: 404, body: '' });
    });
    await ctx.route('https://m.media-amazon.com/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
    try {
      worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${await diagnose(ctx, chromePath!, EXT)}`);
    }
  }, 60000);

  afterAll(async () => {
    await ctx?.close();
    await srv?.close();
    lib?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(EXT, { recursive: true, force: true });
  });

  const configure = (token: string, port: number) =>
    worker.evaluate(([t, p]) => chrome.storage.local.set({ token: t, port: p }), [token, port] as const);

  it('refuses until paired', async () => {
    const page = await ctx.newPage();
    await page.goto(`https://www.amazon.com/Some-Title/dp/${ASIN}`);
    expect(await capture(`/dp/${ASIN}`)).toMatchObject({ ok: false, error: 'not paired' });
    expect(await badge(`/dp/${ASIN}`)).toBe('?');
    await page.close();
  });

  it('captures a book page and its cover into the library', async () => {
    await configure(TOKEN, srv.port);
    const page = await ctx.newPage();
    await page.goto(`https://www.amazon.com/Some-Title/dp/${ASIN}`);
    const r = await capture(`/dp/${ASIN}`);
    expect(r).toMatchObject({ ok: true, kind: 'detail', asin: ASIN });
    expect(await badge(`/dp/${ASIN}`)).toBe('✓');
    expect(lib.db.scalar('SELECT count(*) FROM snapshot')).toBe(1);
    const t = lib.db.prepare('SELECT title, rating_count FROM snapshot').get() as { title: string; rating_count: number };
    expect(t.title).toBeTruthy();
    expect(t.rating_count).toBeGreaterThan(0);
    expect(r.coversSaved).toBe(1);
    expect(fs.readdirSync(path.join(root, 'books', ASIN, 'covers'))).toHaveLength(1);
    await page.close();
  }, 60000);

  it('captures a list page', async () => {
    const page = await ctx.newPage();
    await page.goto('https://www.amazon.com/Best-Sellers-Kindle-Store/zgbs/digital-text/11650864011');
    const r = await capture('/zgbs/');
    expect(r).toMatchObject({ ok: true, kind: 'list', category: 'amazon.com:kindle:11650864011' });
    expect(lib.db.scalar('SELECT count(*) FROM list_entry')).toBeGreaterThanOrEqual(30);
    await page.close();
  }, 60000);

  it('reports a wrong token and a stopped app', async () => {
    await configure('wrong-token'.padEnd(43, 'y'), srv.port);
    const page = await ctx.newPage();
    await page.goto(`https://www.amazon.com/Some-Title/dp/${ASIN}`);
    expect(await capture(`/dp/${ASIN}`)).toMatchObject({ ok: false, error: 'bad token' });
    expect(await badge(`/dp/${ASIN}`)).toBe('!');
    await configure(TOKEN, 1); // nothing listens here
    expect(await capture(`/dp/${ASIN}`)).toMatchObject({ ok: false, error: 'Cadrel Market is not running' });
    await page.close();
  }, 60000);

  it('captures the free sample page by page while the reader is open, skipping repeats and page-turn animation', async () => {
    await configure(TOKEN, srv.port);
    sampleLog.length = 0;
    // a stand-in for Amazon's reader: a cross-origin iframe whose "page" the test turns
    await ctx.route('https://read.amazon.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><body style="margin:0;background:#fbf7ee;font:28px serif"><div id="p" style="padding:40px"></div>
          <script>window.show=(n)=>{document.getElementById('p').innerHTML='<h1>Page '+n+'</h1>'+'<p>The dragon looked at the baker and sighed, again.</p>'.repeat(n)};show(1)</script></body></html>`,
      }),
    );
    const page = await ctx.newPage();
    await page.goto(`https://www.amazon.com/Some-Title/dp/${ASIN}`);
    // no reader yet
    const started = await worker.evaluate(async (part) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(part))!;
      // @ts-expect-error exposed by background.js
      return startSample(tab);
    }, `/dp/${ASIN}`);
    expect(started).toMatchObject({ ok: true });
    await page.getByText(/turn the pages/i).waitFor();
    await page.waitForTimeout(2500);
    expect(fs.existsSync(path.join(root, 'books', ASIN, 'lookinside'))).toBe(false); // nothing saved without a reader

    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = 'https://read.amazon.com/sample';
      f.setAttribute('style', 'position:fixed;left:80px;top:60px;width:640px;height:520px;border:0;z-index:99999;background:#fff');
      document.body.appendChild(f);
    });
    const frame = await (await page.waitForSelector('iframe[src*="read.amazon.com"]')).contentFrame();
    await frame!.waitForFunction(() => typeof (window as any).show === 'function');
    const saved = async () => {
      const base = path.join(root, 'books', ASIN, 'lookinside');
      if (!fs.existsSync(base)) return 0;
      const sess = fs.readdirSync(base)[0]!;
      return JSON.parse(fs.readFileSync(path.join(base, sess, 'pages.json'), 'utf8')).length as number;
    };
    await expect.poll(saved, { timeout: 15000 }).toBe(1);
    await page.waitForTimeout(2500);
    expect(await saved()).toBe(1); // the same page is not saved again

    await frame!.evaluate(() => (window as any).show(3));
    await expect.poll(saved, { timeout: 15000 }).toBe(2);
    await frame!.evaluate(() => (window as any).show(6));
    await expect.poll(saved, { timeout: 15000 }).toBe(3);

    const base = path.join(root, 'books', ASIN, 'lookinside');
    const sess = fs.readdirSync(base)[0]!;
    const pages = JSON.parse(fs.readFileSync(path.join(base, sess, 'pages.json'), 'utf8'));
    expect(pages[0].crop).toMatchObject({ left: expect.any(Number), width: expect.any(Number) });
    expect(pages[0].crop.width).toBeGreaterThan(500);
    expect(fs.statSync(path.join(base, sess, 'page-001.png')).size).toBeGreaterThan(1000);

    await page.getByRole('button', { name: 'Finish' }).click();
    await expect.poll(() => page.getByText(/turn the pages/i).count()).toBe(0);
    expect(await badge(`/dp/${ASIN}`)).toBe('✓');
    await page.close();

    // the extension told the app what it saw, once per condition rather than once per tick
    await expect.poll(() => sampleLog.map((e) => e.event)).toEqual(expect.arrayContaining(['session started', 'reader not found', 'page saved', 'session finished']));
    expect(sampleLog.filter((e) => e.event === 'reader not found')).toHaveLength(1);
    expect(sampleLog.filter((e) => e.event === 'page saved')).toHaveLength(3);
    expect(JSON.stringify(sampleLog.filter((e) => e.source !== 'extension' || e.asin !== ASIN))).toBe('[]');
  }, 90000);

  it('logs every error the user would see, including Chrome\'s capture-rate refusal, once with a repeat count', async () => {
    await configure(TOKEN, srv.port);
    sampleLog.length = 0;
    const page = await ctx.newPage();
    await page.goto(`https://www.amazon.com/Some-Title/dp/${ASIN}`);
    await worker.evaluate(async (part) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(part))!;
      // @ts-expect-error exposed by background.js
      await startSample(tab);
      (globalThis as any).__realShot = chrome.tabs.captureVisibleTab;
      chrome.tabs.captureVisibleTab = (() => Promise.reject(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'))) as any;
      // @ts-expect-error exposed by background.js
      for (let i = 0; i < 3; i++) await sampleTick(tab.id, null, true);
      // @ts-expect-error exposed by background.js
      await finishSample(tab.id);
      chrome.tabs.captureVisibleTab = (globalThis as any).__realShot;
    }, `/dp/${ASIN}`);
    await expect.poll(() => sampleLog.map((e) => e.event)).toEqual(expect.arrayContaining(['capture rate limit hit', 'capture rate limit hit (repeated)', 'session finished with no pages']));
    const first = sampleLog.find((e) => e.event === 'capture rate limit hit')!;
    expect(first).toMatchObject({ level: 'error', asin: ASIN });
    expect(first.detail).toMatch(/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
    expect(sampleLog.filter((e) => e.event === 'capture rate limit hit')).toHaveLength(1);
    expect(sampleLog.find((e) => e.event === 'capture rate limit hit (repeated)')!.detail).toMatch(/^2 more identical/);
    await page.close();

    // an error shown on the toolbar button is logged too, even outside a sample session
    sampleLog.length = 0;
    const other = await ctx.newPage();
    await other.goto(`https://www.amazon.com/Some-Title/dp/${ASIN}`);
    await worker.evaluate(async (part) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(part))!;
      // @ts-expect-error exposed by background.js
      await captureTab({ id: tab.id, url: 'https://www.amazon.com/gp/cart/view.html' });
    }, `/dp/${ASIN}`);
    await expect.poll(() => sampleLog.map((e) => e.event)).toContain('error shown to user');
    expect(sampleLog.find((e) => e.event === 'error shown to user')).toMatchObject({ level: 'error', session: null, detail: expect.stringMatching(/open an amazon\.com book page/) });
    await other.close();
  }, 60000);

  it('registers the right-click menu item', async () => {
    const ok = await worker.evaluate(
      () => new Promise<boolean>((res) => chrome.contextMenus.update('cadrel-market-send', {}, () => res(!chrome.runtime.lastError))),
    );
    expect(ok).toBe(true);
  });
});
