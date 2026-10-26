import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppService, buildMcpSnippets } from '../src/main/service.js';
import { HashingEmbedder } from '@cadrel/market-library';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const gz = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');

let tmp: string, userData: string, libRoot: string;
let opened: string[];
let svc: AppService;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-svc-'));
  userData = path.join(tmp, 'user');
  libRoot = path.join(tmp, 'lib');
  opened = [];
  svc = new AppService({ userData, openExternal: (u) => void opened.push(u), revealInFolder: () => {} });
});
afterEach(async () => {
  await svc.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function post(port: number, token: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ agent: false, host: '127.0.0.1', port, method: 'POST', path: '/v1/capture', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(t) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('AppService', () => {
  it('starts with no library and reports it', async () => {
    await svc.start();
    expect(svc.status()).toMatchObject({ libraryRoot: null, serverRunning: false });
    expect(() => svc.queue()).toThrow(/no library/);
  });

  it('remembers the library and port across restarts', async () => {
    await svc.setLibrary(libRoot);
    await svc.setPort(48123);
    await svc.stop();
    const again = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {} });
    await again.start();
    expect(again.status()).toMatchObject({ libraryRoot: libRoot, port: 48123, serverRunning: true });
    await again.stop();
  });

  it('rejects bad ports', async () => {
    await expect(svc.setPort(80)).rejects.toThrow();
    await expect(svc.setPort(1.5)).rejects.toThrow();
  });

  it('reports a port that is already taken', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const port = (blocker.address() as { port: number }).port;
    await svc.setLibrary(libRoot);
    await svc.setPort(port);
    expect(svc.status()).toMatchObject({ serverRunning: false, serverError: `port ${port} is already in use` });
    blocker.close();
  });

  it('reconnects once whatever was holding the port lets go of it', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const port = (blocker.address() as { port: number }).port;
    await svc.setLibrary(libRoot);
    await svc.setPort(port);
    expect(svc.status().serverRunning).toBe(false);
    await new Promise<void>((r) => blocker.close(() => r()));
    expect(await svc.reconnect()).toMatchObject({ serverRunning: true, serverError: null });
  });

  it('turns a capture over the wire into queue items, then Open next opens and marks one', async () => {
    await svc.setLibrary(libRoot);
    await svc.setPort(48124);
    let captures = 0;
    svc.onCapture(() => captures++);
    const r = await post(48124, svc.token(), {
      url: 'https://www.amazon.com/zgbs/digital-text/11650864011',
      html: gz('bestsellers-kindle-humorous-fantasy.html.gz'),
    });
    expect(r.json.ok).toBe(true);
    expect(captures).toBe(1);
    expect(svc.queue().length).toBeGreaterThanOrEqual(30);

    const first = await svc.openNext();
    expect(first?.asin).toBe('B0C1R52V2J');
    expect(opened).toEqual(['https://www.amazon.com/dp/B0C1R52V2J']);
    expect(svc.queue()[0]).toMatchObject({ asin: 'B0C1R52V2J', state: 'opened' });
    expect((await svc.openNext())?.asin).toBe('B0HKTD6M9Z');

    // capturing the book removes it from the queue and shows it in the library with its history
    await post(48124, svc.token(), { url: 'https://www.amazon.com/dp/B0C1R52V2J', html: gz('detail-kindle-B0C1R52V2J.html.gz') });
    expect(svc.queue().some((q) => q.asin === 'B0C1R52V2J')).toBe(false);
    expect(svc.books()).toHaveLength(1);
    expect(svc.book('B0C1R52V2J')?.history).toHaveLength(1);
  }, 30000);

  it('refuses to open anything but a valid ASIN', async () => {
    await svc.setLibrary(libRoot);
    await expect(svc.openBook('../evil')).rejects.toThrow();
  });

  it('rotating the token invalidates the old one', async () => {
    await svc.setLibrary(libRoot);
    await svc.setPort(48125);
    const old = svc.token();
    const fresh = await svc.rotateToken();
    expect(fresh).not.toBe(old);
    const body = { url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') };
    expect((await post(48125, old, body)).status).toBe(401);
    expect((await post(48125, fresh, body)).status).toBe(200);
  }, 30000);

  describe('search index and MCP config', () => {
    const captureList = (port: number) =>
      post(port, svc.token(), { url: 'https://www.amazon.com/dp/B0C1R52V2J', html: gz('detail-kindle-B0C1R52V2J.html.gz') });

    it('builds a basic index with progress and reports it', async () => {
      await svc.setLibrary(libRoot);
      await svc.setPort(48130);
      await captureList(48130);
      let notified = 0;
      svc.onIndex(() => notified++);
      const before = await svc.indexStatus();
      expect(before).toMatchObject({ embedded: 0, model: null, running: false });
      expect(before.chunks).toBeGreaterThan(0);
      const after = await svc.buildIndex('basic');
      expect(after).toMatchObject({ embedded: before.chunks, model: 'hashing-v1:256', running: false, error: null });
      expect(notified).toBeGreaterThan(0);
    }, 30000);

    it('reports a failed model download and can be retried', async () => {
      let attempts = 0;
      const s2 = new AppService({
        userData, openExternal: () => {}, revealInFolder: () => {},
        neuralEmbedder: async (_dir, onDownload) => {
          onDownload(50);
          if (attempts++ === 0) throw new Error('could not reach huggingface.co');
          return new HashingEmbedder(64);
        },
      });
      await s2.setLibrary(libRoot);
      await s2.setPort(48131);
      await post(48131, s2.token(), { url: 'https://www.amazon.com/dp/B0C1R52V2J', html: gz('detail-kindle-B0C1R52V2J.html.gz') });
      expect(await s2.buildIndex('neural')).toMatchObject({ error: 'could not reach huggingface.co', embedded: 0, running: false });
      expect(await s2.buildIndex('neural')).toMatchObject({ error: null, model: 'hashing-v1:64' });
      await s2.stop();
    }, 30000);

    it('keeps an existing index current after a capture, but not before one is built', async () => {
      await svc.setLibrary(libRoot);
      await svc.setPort(48132);
      await captureList(48132);
      await new Promise((r) => setTimeout(r, 2200));
      expect((await svc.indexStatus()).embedded).toBe(0); // no index yet: nothing happens on its own
      await svc.buildIndex('basic');
      await post(48132, svc.token(), { url: 'https://www.amazon.com/dp/B0HKTD6M9Z', html: gz('detail-kindle-B0HKTD6M9Z.html.gz') });
      await new Promise((r) => setTimeout(r, 2500));
      const st = await svc.indexStatus();
      expect(st.chunks).toBeGreaterThan(st.embedded === 0 ? 0 : 1);
      expect(st.embedded).toBe(st.chunks);
    }, 30000);

    it('builds copy-paste settings for each client', () => {
      const m = buildMcpSnippets({ command: 'C:\\Program Files\\Cadrel Market\\Cadrel Market.exe', args: ['C:\\r\\main.mjs', '--library', 'D:\\My Books'], env: { ELECTRON_RUN_AS_NODE: '1' } });
      const desktop = JSON.parse(m.claudeDesktop);
      expect(desktop.mcpServers['cadrel-market']).toEqual({ command: 'C:\\Program Files\\Cadrel Market\\Cadrel Market.exe', args: ['C:\\r\\main.mjs', '--library', 'D:\\My Books'], env: { ELECTRON_RUN_AS_NODE: '1' } });
      expect(m.claudeCode).toBe('claude mcp add cadrel-market -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\Cadrel Market\\Cadrel Market.exe" C:\\r\\main.mjs --library "D:\\My Books"');
      expect(m.codex).toContain('[mcp_servers.cadrel-market]');
      expect(m.codex).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    });

    it('points the config at the chosen library', async () => {
      await svc.setLibrary(libRoot);
      expect(svc.mcpConfig().args.slice(-2)).toEqual(['--library', libRoot]);
    });
  });

  describe('book text', () => {
    const ASIN = 'B0C1R52V2J';
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
    const prep = async (port: number, ocr?: AppService['opts']['ocrFactory']) => {
      const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, ocrFactory: ocr });
      await s.setLibrary(libRoot);
      await s.setPort(port);
      await post(port, s.token(), { url: `https://www.amazon.com/dp/${ASIN}`, html: gz(`detail-kindle-${ASIN}.html.gz`) });
      return s;
    };
    const page = (port: number, token: string, n: number, session: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/sample/page', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject);
        req.end(JSON.stringify({ asin: ASIN, session, ext: 'png', image: Buffer.concat([PNG, Buffer.from(String(n))]).toString('base64'), crop: { left: 0, top: 0, width: 600, height: 800 } }));
      });
    const finish = (port: number, token: string, session: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/sample/finish', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject);
        req.end(JSON.stringify({ asin: ASIN, session }));
      });

    it('attaches an uploaded EPUB-like text file and reports its metrics', async () => {
      const s = await prep(48140);
      const file = path.join(tmp, 'my book.txt');
      fs.writeFileSync(file, 'Chapter 1\n\n"Hello," said the dragon. ' + 'The baker sighed. '.repeat(40) + '\n\nChapter 2\n\nLater. ' + 'Nothing happened. '.repeat(40));
      const t = await s.attachManuscriptPath(ASIN, file);
      expect(t.manuscripts[0]).toMatchObject({ source: 'upload', kind: 'txt', label: 'my book.txt', chapters: 2 });
      expect(t.metrics).toMatchObject({ source: 'upload' });
      expect(t.metrics!.metrics.chapters.count).toBe(2);
      expect(s.books().find((b) => b.asin === ASIN)!.text).toBe('manuscript');
      expect(t.job).toBeNull();
      expect(s.removeText(ASIN, 'upload').manuscripts).toEqual([]);
      await s.stop();
    }, 30000);

    it('refuses unsupported and unreadable files with a clear message, and unknown books', async () => {
      const s = await prep(48141);
      const bad = path.join(tmp, 'x.exe');
      fs.writeFileSync(bad, 'x');
      await expect(s.attachManuscriptPath(ASIN, bad)).rejects.toThrow(/unsupported/);
      const empty = path.join(tmp, 'empty.txt');
      fs.writeFileSync(empty, '   ');
      await expect(s.attachManuscriptPath(ASIN, empty)).rejects.toThrow(/no readable text/);
      const ok = path.join(tmp, 'ok.txt');
      fs.writeFileSync(ok, 'Some real text that is long enough to be a book sample.');
      await expect(s.attachManuscriptPath('B000000000', ok)).rejects.toThrow(/capture the book's page first/);
      expect(s.bookText(ASIN).manuscripts).toEqual([]);
      await s.stop();
    }, 30000);

    it('reads a captured sample after the extension finishes it, dropping the end-of-sample screen', async () => {
      const texts = ['The dragon looked at the baker and', 'sighed. "Not again," she said.', "You've reached the end of your free sample. Buy now to continue."];
      let closed = false;
      let call = 0;
      const s = await prep(48142, async () => ({ recognize: async () => ({ text: texts[call++]!, confidence: 90 }), close: async () => void (closed = true) }));
      const S = '20261019T100000Z';
      let changes = 0;
      s.onText(() => changes++);
      for (let i = 0; i < 3; i++) expect(await page(48142, s.token(), i, S)).toBe(200);
      expect(await finish(48142, s.token(), S)).toBe(200);
      await vi.waitFor(() => expect(s.bookText(ASIN).manuscripts.some((m) => m.source === 'sample')).toBe(true), { timeout: 10000 });
      const t = s.bookText(ASIN);
      expect(t.manuscripts[0]).toMatchObject({ source: 'sample', kind: 'ocr', pages: 2, quality: 90, complete: true });
      expect(t.sampleSessions).toEqual([{ session: S, pages: 3, read: 3 }]);
      expect(closed).toBe(true);
      expect(changes).toBeGreaterThan(3);
      const text = fs.readFileSync(path.join(libRoot, 'books', ASIN, 'extracted', 'sample.txt'), 'utf8');
      expect(text).toBe('The dragon looked at the baker and sighed. "Not again," she said.');
      expect(t.metrics!.source).toBe('sample');
      // the sample log, in a logs folder, tells the story of the session
      const log = fs.readFileSync(path.join(userData, 'logs', 'sample-capture.log'), 'utf8');
      expect(s.sampleLogFile).toBe(path.join(userData, 'logs', 'sample-capture.log'));
      expect(log).toMatch(new RegExp(`INFO \\[${ASIN} ${S}\\] app: page stored \\| #1, `));
      expect(log.match(/app: page stored/g)).toHaveLength(3);
      expect(log).toMatch(/app: extension finished the session/);
      expect(log).toMatch(/app: reading started \| 3 pages, 0 already read/);
      expect(log).toMatch(/app: page 1 read poorly \| confidence 90, 34 characters/);
      expect(log).toMatch(/WARN \[\S+ \S+\] app: reading finished \| 2 book pages, 1 end-of-sample screen, quality 90.*2 pages read poorly/);
      await s.stop();
    }, 30000);

    it('reports an OCR failure and can be retried without re-reading finished pages', async () => {
      let fail = true;
      let reads = 0;
      const s = await prep(48143, async () => ({
        recognize: async () => { reads++; if (fail && reads === 2) throw new Error('engine crashed'); return { text: 'Some page text that is long enough to count as text.', confidence: 88 }; },
        close: async () => {},
      }));
      const S = '20261019T100000Z';
      for (let i = 0; i < 3; i++) await page(48143, s.token(), i, S);
      await expect(s.readSample(ASIN, S)).rejects.toThrow('engine crashed');
      expect(s.bookText(ASIN).sampleSessions[0]).toMatchObject({ pages: 3, read: 1 });
      fail = false;
      const t = await s.readSample(ASIN, S);
      expect(reads).toBe(4); // pages 2 and 3 only: page 1 was already read
      expect(t.manuscripts[0]).toMatchObject({ source: 'sample', pages: 3 });
      expect(t.error).toBeNull();
      const log = fs.readFileSync(path.join(userData, 'logs', 'sample-capture.log'), 'utf8');
      expect(log).toMatch(/ERROR \[\S+ \S+\] app: page 2 could not be read \| engine crashed/);
      expect(log).toMatch(/ERROR \[\S+ \S+\] app: reading failed \| engine crashed/);
      expect(log).toMatch(/WARN \[\S+ \S+\] app: reading finished .*closing "end of sample" screen was never captured/);
      await s.stop();
    }, 30000);

    it('logs the extension\'s notes and refused pages', async () => {
      const s = await prep(48145);
      const post = (path_: string, body: unknown) =>
        new Promise<number>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: 48145, method: 'POST', path: path_, headers: { authorization: `Bearer ${s.token()}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
          req.on('error', reject);
          req.end(JSON.stringify(body));
        });
      expect(await post('/v1/sample/log', { asin: ASIN, session: '20261019T100000Z', level: 'warn', event: 'reader not found', detail: 'no reader frame is visible' })).toBe(200);
      expect(await post('/v1/sample/page', { asin: ASIN, session: '20261019T100000Z', ext: 'png', image: 'AAAA' })).toBe(400);
      const log = fs.readFileSync(s.sampleLogFile, 'utf8');
      expect(log).toMatch(/WARN \[\S+ 20261019T100000Z\] extension: reader not found \| no reader frame is visible/);
      expect(log).toMatch(/WARN \[\S+ 20261019T100000Z\] app: request refused \| \/v1\/sample\/page: HTTP 400, image has an unusable size/);
      await s.stop();
    }, 30000);

    it('says so when there is nothing to read', async () => {
      const s = await prep(48144);
      await expect(s.readSample(ASIN)).rejects.toThrow(/no sample pages/);
      await s.stop();
    }, 30000);
  });

  describe('hardening', () => {
    const ASIN = 'B0C1R52V2J';
    const prep = async (port: number) => {
      await svc.setLibrary(libRoot);
      await svc.setPort(port);
      await post(port, svc.token(), { url: `https://www.amazon.com/dp/${ASIN}`, html: gz(`detail-kindle-${ASIN}.html.gz`) });
    };

    it('rejects malformed identifiers before they reach the file system', async () => {
      await svc.setLibrary(libRoot);
      for (const bad of ['../../etc', 'b0c1r52v2j', '', 'B0C1R52V2J/..', 5 as unknown as string]) {
        expect(() => svc.book(bad)).toThrow(/bad ASIN/);
        expect(() => svc.cover(bad)).toThrow(/bad ASIN/);
        expect(() => svc.bookText(bad)).toThrow(/bad ASIN/);
        expect(() => svc.revealBook(bad)).toThrow(/bad ASIN/);
        expect(() => svc.setQueueState(bad, 'skipped')).toThrow(/bad ASIN/);
        expect(() => svc.excludeFromCategory(bad, 'k')).toThrow(/bad ASIN/);
        expect(() => svc.restoreToCategory(bad, 'k')).toThrow(/bad ASIN/);
        expect(() => svc.removeBook(bad)).toThrow(/bad ASIN/);
        expect(() => svc.bookLists(bad)).toThrow(/bad ASIN/);
        await expect(svc.openBook(bad)).rejects.toThrow();
      }
      expect(() => svc.setQueueState(ASIN, 'hacked' as 'skipped')).toThrow(/bad state/);
      await expect(svc.readSample(ASIN, '../../x')).rejects.toThrow(/bad session/);
      await expect(svc.attachManuscriptPath(ASIN, 'relative/path.txt')).rejects.toThrow(/bad file path/);
      expect(() => svc.removeText(ASIN, 'evil' as 'upload')).toThrow(/bad source/);
    });

    it('takes a book out of a category or the library, tells the window to reload, and can restore', async () => {
      await prep(48145);
      const key = 'amazon.com:kindle:11650864011';
      expect((await post(48145, svc.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
      let reloads = 0;
      svc.onCapture(() => { reloads++; });
      const queued = svc.queue()[0]!;
      svc.excludeFromCategory(queued.asin, key);
      expect(svc.queue().map((q) => q.asin)).not.toContain(queued.asin);
      expect(svc.categoryExclusions(key).map((x) => x.asin)).toEqual([queued.asin]);
      svc.restoreToCategory(queued.asin, key);
      expect(svc.queue().map((q) => q.asin)).toContain(queued.asin);
      expect(svc.bookLists(ASIN).map((c) => c.key)).toContain(key);
      expect(svc.removeBook(ASIN, true)).toMatchObject({ asin: ASIN, snapshots: 1 });
      expect(svc.book(ASIN)).toBeNull();
      expect(reloads).toBe(3);
      expect(() => svc.removeBook(ASIN)).toThrow(/no captured book/);
      await svc.stop();
    }, 30000);

    it('refuses a network share as the library', async () => {
      await expect(svc.setLibrary('\\\\server\\share\\books')).rejects.toThrow(/network share/);
      await expect(svc.setLibrary('relative/dir')).rejects.toThrow(/bad folder/);
    });

    it('pairs by code once, within two minutes, and the code is not the token', async () => {
      await svc.setLibrary(libRoot);
      await svc.setPort(48150);
      const { code, expiresAt } = svc.pairingCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(expiresAt - Date.now()).toBeGreaterThan(110_000);
      expect(code).not.toBe(svc.token());
      const redeem = (c: string) =>
        new Promise<{ status: number; json: any }>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: 48150, method: 'POST', path: '/v1/pair', headers: { 'content-type': 'application/json', origin: 'chrome-extension://abc' } }, (res) => {
            let t = '';
            res.on('data', (d) => (t += d));
            res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(t) }));
          });
          req.on('error', reject);
          req.end(JSON.stringify({ code: c }));
        });
      expect((await redeem(code)).json).toEqual({ ok: true, token: svc.token() });
      expect((await redeem(code)).status).toBe(401); // used up
      const second = svc.pairingCode();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(second.expiresAt + 1000);
      expect((await redeem(second.code)).status).toBe(401); // expired
      vi.useRealTimers();
    });

    it('persists settings and rejects unknown ones', async () => {
      expect(svc.settings()).toEqual({ keepRunningInTray: true, startWithWindows: false, suggestAmazon: true, suggestGoogle: true, suggestBing: true });
      svc.setSettings({ startWithWindows: true });
      const again = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {} });
      expect(again.settings()).toEqual({ keepRunningInTray: true, startWithWindows: true, suggestAmazon: true, suggestGoogle: true, suggestBing: true });
      expect(() => svc.setSettings({ evil: true } as never)).toThrow(/unknown setting/);
    });

    it('re-reads all pages as a job with progress, and refuses a second job at the same time', async () => {
      await prep(48151);
      const seen: string[] = [];
      svc.onMaintenance(() => seen.push(svc.maintenanceStatus().kind ?? 'idle'));
      const first = svc.rebuild();
      await expect(svc.rebuild()).rejects.toThrow(/another job/);
      expect(await first).toEqual({ detail: 1, list: 0, search: 0 });
      expect(seen[0]).toBe('rebuild');
      expect(seen.at(-1)).toBe('idle');
      expect(svc.maintenanceStatus()).toMatchObject({ kind: null, message: expect.stringContaining('Re-read 1 book page') });
      expect(svc.books()).toHaveLength(1);
    }, 30000);

    it('captures sent during a rebuild are told to wait, not lost silently', async () => {
      await prep(48152);
      const during = svc.rebuild();
      const r = await post(48152, svc.token(), { url: `https://www.amazon.com/dp/${ASIN}`, html: gz(`detail-kindle-${ASIN}.html.gz`), capturedAt: '2026-10-20T00:00:00Z' });
      await during;
      expect([200, 503]).toContain(r.status);
      if (r.status === 503) expect(r.json.error).toMatch(/try again/);
    }, 30000);

    it('backs up, then moves, and carries on from the copy', async () => {
      await prep(48153);
      const backup = path.join(tmp, 'backup');
      await svc.backupTo(backup);
      expect(fs.existsSync(path.join(backup, 'scout.db'))).toBe(true);
      expect(svc.maintenanceStatus().message).toMatch(/Backed up/);
      const dest = path.join(tmp, 'moved');
      await svc.moveTo(dest);
      expect(svc.status()).toMatchObject({ libraryRoot: dest, serverRunning: true });
      expect(svc.books()).toHaveLength(1);
      expect(fs.existsSync(libRoot)).toBe(true); // the old folder is left alone
      expect(svc.verifyLibrary().ok).toBe(true);
      // a new capture lands in the new library
      await post(48153, svc.token(), { url: 'https://www.amazon.com/dp/B0HKTD6M9Z', html: gz('detail-kindle-B0HKTD6M9Z.html.gz') });
      expect(fs.existsSync(path.join(dest, 'books', 'B0HKTD6M9Z'))).toBe(true);
      expect(fs.existsSync(path.join(libRoot, 'books', 'B0HKTD6M9Z'))).toBe(false);
    }, 60000);

    it('exports a data pack and imports it into another library', async () => {
      await prep(48155);
      const pack = path.join(tmp, 'share.pack');
      await svc.exportData(pack, null);
      expect(svc.maintenanceStatus().message).toMatch(/Exported 1 book page/);
      await expect(svc.exportData(pack, null)).rejects.toThrow(/already exists/);
      await expect(svc.exportData(path.join(tmp, 'none.pack'), [])).rejects.toThrow(/at least one/);

      const other = new AppService({ userData: path.join(tmp, 'user2'), openExternal: () => {}, revealInFolder: () => {} });
      await other.setLibrary(path.join(tmp, 'lib2'));
      expect(await other.importData(pack)).toMatchObject({ added: 1, skipped: 0 });
      expect(other.books()).toHaveLength(1);
      expect(other.maintenanceStatus().message).toMatch(/Imported 1 book page/);
      expect(await other.importData(pack)).toMatchObject({ added: 0, skipped: 0 });
      await other.stop();
    }, 60000);

    it('a failed move changes nothing', async () => {
      await prep(48154);
      fs.mkdirSync(path.join(tmp, 'occupied'));
      fs.writeFileSync(path.join(tmp, 'occupied', 'x'), '1');
      await expect(svc.moveTo(path.join(tmp, 'occupied'))).rejects.toThrow(/not empty/);
      expect(svc.status().libraryRoot).toBe(libRoot);
      expect(svc.maintenanceStatus()).toMatchObject({ kind: null, error: expect.stringContaining('not empty') });
    }, 30000);

    it('exposes parser health', async () => {
      await prep(48155);
      expect(svc.parserHealth()[0]).toMatchObject({ kind: 'book pages', captures: 1 });
    }, 30000);
  });
});

describe('about and updates', () => {
  const body = Buffer.from('MZ pretend installer '.repeat(40));
  const digest = 'sha256:' + require('node:crypto').createHash('sha256').update(body).digest('hex');
  const rel = (tag: string) => new Response(JSON.stringify({ tag_name: tag, body: 'Fixes', assets: [{ id: 9, name: `Cadrel-Setup-${tag.slice(1)}.exe`, size: body.length, url: 'u', digest }] }), { status: 200 });
  const secrets = { available: () => true, encrypt: (s: string) => Buffer.from('enc:' + s), decrypt: (b: Buffer) => b.toString().replace(/^enc:/, '') };
  const make = (extra: Partial<ConstructorParameters<typeof AppService>[0]> = {}) => {
    const launched: string[] = [];
    const calls: { url: string; auth: string | undefined }[] = [];
    const s = new AppService({
      userData, openExternal: () => {}, revealInFolder: () => {}, version: '0.2.0', secrets,
      launchInstaller: (f) => void launched.push(f), openRelease: (u) => void opened.push(u),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
        return url.includes('/releases/latest') ? rel('v0.3.0') : new Response(new Uint8Array(body), { status: 200 });
      }) as unknown as typeof fetch,
      ...extra,
    });
    return { s, launched, calls };
  };

  it('reports what is running', () => {
    const { s } = make();
    expect(s.appInfo()).toMatchObject({ name: 'Cadrel Market', version: '0.2.0', repo: 'blaashford-ux/cadrel', canInstall: true, dataFolder: userData });
    expect(make({ launchInstaller: undefined }).s.appInfo().canInstall).toBe(false);
  });

  it('stores the GitHub token encrypted, validates it, and can remove it', () => {
    const { s } = make();
    expect(s.githubTokenStatus()).toMatchObject({ saved: false, canSave: true });
    expect(() => s.setGithubToken('short')).toThrow(/does not look like a GitHub token/);
    expect(s.setGithubToken('github_pat_' + 'a'.repeat(30)).saved).toBe(true);
    expect(fs.readFileSync(path.join(userData, 'github-token.bin'), 'utf8')).not.toContain('github_pat_' + 'a'.repeat(30) + '\n'); // encrypted form, not the bare token
    expect(fs.readFileSync(path.join(userData, 'github-token.bin'), 'utf8').startsWith('enc:')).toBe(true);
    expect(s.setGithubToken(null).saved).toBe(false);
    expect(() => make({ secrets: { ...secrets, available: () => false } }).s.setGithubToken('github_pat_' + 'a'.repeat(30))).toThrow(/cannot encrypt/);
  });

  it('checks, downloads with the saved token, verifies and launches the installer', async () => {
    const { s, launched, calls } = make();
    s.setGithubToken('github_pat_' + 'a'.repeat(30));
    const checked = await s.checkForUpdates();
    expect(checked).toMatchObject({ phase: 'available', info: { latest: '0.3.0', updateAvailable: true } });
    expect(calls[0]!.auth).toBe('Bearer github_pat_' + 'a'.repeat(30));
    const done = await s.installUpdate();
    expect(done.phase).toBe('launching');
    expect(launched).toEqual([path.join(userData, 'updates', 'Cadrel-Setup-0.3.0.exe')]);
    expect(fs.readFileSync(launched[0]!).equals(body)).toBe(true);
    const log = fs.readFileSync(path.join(userData, 'logs', 'updates.log'), 'utf8');
    expect(log).toMatch(/checked: running 0\.2\.0, latest 0\.3\.0 \(update available\)/);
    expect(log).toMatch(/downloaded and verified/);
    expect(log).not.toContain('github_pat_'); // the token is never logged
  });

  it('reports "up to date", and refuses to install without a newer release or where installing is unsupported', async () => {
    const { s: cur } = make({ version: '0.3.0' });
    expect((await cur.checkForUpdates()).phase).toBe('current');
    expect((await cur.installUpdate()).error).toMatch(/Check for updates first/);
    const { s: noInstall } = make({ launchInstaller: undefined });
    await noInstall.checkForUpdates();
    expect((await noInstall.installUpdate()).error).toMatch(/only available in the installed Windows app/);
  });

  it('turns a failed check or download into a message and a log line, not an exception', async () => {
    const { s } = make({ fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch });
    const r = await s.checkForUpdates();
    expect(r).toMatchObject({ phase: 'error' });
    expect(r.error).toMatch(/private/);
    expect(fs.readFileSync(path.join(userData, 'logs', 'updates.log'), 'utf8')).toMatch(/ERROR update check failed: GitHub shows no release/);
    let n = 0;
    const { s: s2 } = make({ fetch: (async (url: string) => (url.includes('/releases/latest') ? rel('v0.3.0') : (n++, new Response(new Uint8Array(Buffer.from('truncated')), { status: 200 })))) as unknown as typeof fetch });
    await s2.checkForUpdates();
    expect((await s2.installUpdate()).error).toMatch(/incomplete/);
    expect(fs.existsSync(path.join(userData, 'updates', 'Cadrel-Setup-0.3.0.exe'))).toBe(false);
  });

  it('opens only this repository’s release page', async () => {
    const { s } = make();
    await expect(s.openReleasePage()).rejects.toThrow(/Check for updates first/);
    await s.checkForUpdates();
    await s.openReleasePage();
    expect(opened).toEqual(['https://github.com/blaashford-ux/cadrel/releases/tag/v0.3.0']);
  });
});

describe('community sources', () => {
  it('links a subreddit to a category, syncs the last 7 days through the injected network, and reports progress state', async () => {
    const now = Math.floor(Date.now() / 1000);
    const urls: string[] = [];
    const s = new AppService({
      userData, openExternal: () => {}, revealInFolder: () => {},
      fetch: (async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        const rows = u.pathname === '/api/posts/search' ? [{ id: 'abc123', title: 'Cozy fantasy recs', selftext: 'Found family please', created_utc: now - 3600, score: 5, link_flair_text: 'Recs', author: 'x' }]
          : u.pathname === '/api/comments/search' ? [{ id: 'k1', link_id: 't3_abc123', parent_id: 't3_abc123', body: 'Try Legends and Lattes', created_utc: now - 1800, score: 2, author: 'y' }] : [];
        return new Response(JSON.stringify({ data: rows.filter((r) => r.created_utc > Number(u.searchParams.get('after'))) }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await s.setLibrary(libRoot);
    const port = s.status().port;
    expect((await post(port, s.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
    const key = s.categories()[0]!.key;
    await expect(s.syncCommunity(key)).rejects.toThrow(/add a subreddit/);
    expect(s.addCommunitySource(key, 'r/CozyFantasy')[0]).toMatchObject({ subreddit: 'cozyfantasy', posts: 0 });
    const [r] = await s.syncCommunity(key);
    expect(r).toMatchObject({ newPosts: 1, newComments: 1, truncated: false });
    expect(s.communityStatus()).toBeNull();
    expect(urls.every((u) => u.startsWith('https://arctic-shift.photon-reddit.com/api/'))).toBe(true);
    expect(urls.some((u) => /fields=[^&]*author/.test(u))).toBe(true); // asked for (bot filter), never stored
    expect(s.communitySources(key)[0]).toMatchObject({ posts: 1, comments: 1 });
    expect(s.removeCommunitySource(key, 'cozyfantasy')).toEqual([]);
    await s.stop();
  }, 30000);
});

describe('community sync control', () => {
  it('can be stopped while running, reports progress, and keeps the app usable afterwards', async () => {
    const hung: string[] = [];
    const s = new AppService({
      userData, openExternal: () => {}, revealInFolder: () => {},
      fetch: ((url: string, init?: RequestInit) => new Promise((_res, rej) => {
        hung.push(url);
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch,
    });
    await s.setLibrary(libRoot);
    expect((await post(s.status().port, s.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
    const key = s.categories()[0]!.key;
    s.addCommunitySource(key, 'cozyfantasy');
    expect(s.stopCommunity()).toBe(false); // nothing running
    const run = s.syncCommunity(key);
    await vi.waitFor(() => expect(hung.length).toBeGreaterThan(0));
    expect(s.communityStatus()).toMatchObject({ subreddit: 'cozyfantasy', day: 1, days: 7, subredditCount: 1, stopping: false });
    await expect(s.syncCommunity(key)).rejects.toThrow(/already running/);
    expect(s.stopCommunity()).toBe(true);
    expect(s.communityStatus()!.stopping).toBe(true);
    const [r] = await run;
    expect(r).toMatchObject({ cancelled: true, daysDone: 0, days: 7 });
    expect(s.communityStatus()).toBeNull();
    await s.stop();
  }, 30000);
});

describe('keywords', () => {
  const answer = (urls: string[]) => (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const prefix = u.searchParams.get('prefix') ?? u.searchParams.get('q') ?? u.searchParams.get('query') ?? '';
    const list = prefix === 'cozy fantasy' ? ['cozy fantasy books', 'cozy fantasy romance'] : [];
    return new Response(JSON.stringify(u.hostname === 'completion.amazon.com' ? { suggestions: list.map((value) => ({ value })) } : [prefix, list]), { status: 200 });
  }) as unknown as typeof fetch;

  it('falls back to a shorter phrase when no source has suggestions for the one asked about', async () => {
    const urls: string[] = [];
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, fetch: answer(urls), keywordDelayMs: 0 });
    await s.setLibrary(libRoot);
    s.setSettings({ suggestBing: false });
    const r = await s.keywordLookup('cozy fantasy dungeon');
    expect(r.fallback).toEqual({ requested: 'cozy fantasy dungeon', used: 'cozy fantasy' });
    expect(r.table.seed).toBe('cozy fantasy');
    expect(r.notes.map((n) => [n.source, n.count])).toEqual([['amazon', 2], ['google', 2]]);
    expect(urls).toHaveLength(108); // both phrases, both sources, 27 queries each
    // nothing to fall back to: reported on the phrase asked about, no fallback
    const none = await s.keywordLookup('quiet moss garden');
    expect(none.fallback).toBeUndefined();
    expect(none.table.seed).toBe('quiet moss garden');
    expect(none.notes.map((n) => n.count)).toEqual([0, 0]);
    await s.stop();
  }, 30000);

  it('files a search and an imported trend under the chosen category, and lists history for it', async () => {
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, fetch: answer([]), keywordDelayMs: 0 });
    await s.setLibrary(libRoot);
    expect((await post(s.status().port, s.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
    const key = s.categories()[0]!.key;
    s.setSettings({ suggestBing: false });
    await s.keywordLookup('cozy fantasy', { categoryKey: key });
    await s.keywordLookup('cozy fantasy', { categoryKey: 'amazon.com:kindle:nope' }); // not a category here: nothing more is filed
    expect(s.keywordHistory('amazon.com:kindle:nope')).toEqual([]);
    expect(s.keywordHistory().map((h) => [h.seed, h.categories.length])).toEqual([['cozy fantasy', 1]]);
    expect(s.keywordHistory(key).map((h) => [h.seed, h.categories])).toEqual([['cozy fantasy', [key]]]);
    s.importTrends('Category: All categories\n\nWeek,cozy mystery: (United States)\n2026-01-04,50\n2026-01-11,60\n', key);
    expect(s.keywordHistory(key)).toHaveLength(1);
    expect(s.exportData).toBeTypeOf('function');
    await s.stop();
  }, 30000);

  it('asks only the sources that are switched on, shows the cache on a repeat, and reports each source', async () => {
    const urls: string[] = [];
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, fetch: answer(urls), keywordDelayMs: 0 });
    await s.setLibrary(libRoot);
    s.setSettings({ suggestBing: false });
    const r = await s.keywordLookup('Cozy Fantasy');
    expect(r.notes.map((n) => [n.source, n.cached, n.requests, n.count])).toEqual([['amazon', false, 27, 2], ['google', false, 27, 2]]);
    expect(urls).toHaveLength(54);
    expect(urls.some((u) => u.includes('bing.com'))).toBe(false);
    expect(r.table.rows.map((x) => x.keyword)).toEqual(['cozy fantasy', 'cozy fantasy books', 'cozy fantasy romance']);
    expect(r.table.rows[1]).toMatchObject({ listedBy: 2, amazon: { position: 1 }, google: { position: 1 }, bing: null });
    const again = await s.keywordLookup('cozy fantasy');
    expect(again.notes.every((n) => n.cached && n.requests === 27)).toBe(true);
    expect(urls).toHaveLength(54); // no new requests
    expect(s.keywordTable('cozy fantasy').lookups).toHaveLength(2);
    expect(s.keywordStatus()).toBeNull();
    s.setSettings({ suggestAmazon: false, suggestGoogle: false });
    await expect(s.keywordLookup('anything')).rejects.toThrow(/at least one source/);
    await s.stop();
  }, 30000);

  it('can be stopped while running', async () => {
    const hung: string[] = [];
    const s = new AppService({
      userData, openExternal: () => {}, revealInFolder: () => {}, keywordDelayMs: 0,
      fetch: ((url: string, init?: RequestInit) => new Promise((_res, rej) => { hung.push(url); init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); })) as unknown as typeof fetch,
    });
    await s.setLibrary(libRoot);
    expect(s.stopKeywords()).toBe(false);
    const run = s.keywordLookup('dragon');
    await vi.waitFor(() => expect(hung.length).toBe(1));
    expect(s.keywordStatus()).toMatchObject({ seed: 'dragon', source: 'amazon', sourceCount: 3 });
    await expect(s.keywordLookup('elf')).rejects.toThrow(/already running/);
    expect(s.stopKeywords()).toBe(true);
    const r = await run;
    expect(r.notes[0]!.stopped).toBe('cancelled');
    expect(s.keywordStatus()).toBeNull();
    await s.stop();
  }, 30000);

  it('imports a Trends CSV, and opens only the Trends comparison and the Kindle-store search in the browser', async () => {
    const urls: string[] = [];
    const s = new AppService({ userData, openExternal: (u) => void urls.push(u), revealInFolder: () => {}, fetch: answer([]), keywordDelayMs: 0 });
    await s.setLibrary(libRoot);
    expect(s.importTrends('Week,cozy fantasy: (United States)\n2026-10-04,40\n2026-10-11,60').keywords).toEqual(['cozy fantasy']);
    expect(s.keywordTable('cozy fantasy').rows[0]!.trend).toMatchObject({ latest: 50, peak: 60 });
    expect(() => s.importTrends('not,a,trends file')).toThrow(/Trends/);
    s.removeTrend('cozy fantasy');
    expect(s.keywordTable('cozy fantasy').rows[0]!.trend).toBeNull();
    await s.openTrends(['cozy fantasy', 'dark romance']);
    await s.openAmazonSearch('cozy fantasy');
    expect(urls).toEqual(['https://trends.google.com/trends/explore?q=cozy+fantasy%2Cdark+romance&geo=US&date=today+5-y', 'https://www.amazon.com/s?k=cozy+fantasy&i=digital-text#cadrel-market-capture']);
    await expect(s.openAmazonSearch('x')).rejects.toThrow(/2-80/);
    await s.stop();
  }, 30000);
});

describe('sales calibration', () => {
  it('imports a KDP report and a rank file, previews and applies a fit, resets, and refuses bad uploads', async () => {
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {} });
    await s.setLibrary(libRoot);
    const enc = (t: string) => new TextEncoder().encode(t);
    expect(s.calibrationPreview()).toMatchObject({ fit: null, current: null });
    expect(() => s.importSales('x.csv', 'not bytes' as never)).toThrow(/bad file/);
    expect(() => s.importSales('x.csv', enc('a,b\n1,2'))).toThrow(/daily sales table/);
    expect(() => s.importRanks('r.csv', enc('Date,Rank\n2026-10-10,500'))).toThrow(/choose which book/);
    expect(() => s.importRanks('r.csv', enc('Date,Rank\n2026-10-10,500'), 'nope')).toThrow(/bad ASIN/);

    const asin = 'B0G7R6X55V';
    const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'];
    const sales = s.importSales('orders.csv', enc(['Date,ASIN,Marketplace,Paid Units', ...days.map((d) => `${d},${asin},Amazon.com,${d <= '2026-10-10' ? 30 : 3}`)].join('\n')));
    expect(sales).toMatchObject({ rows: 6, books: 1, from: '2026-10-08', to: '2026-10-13' });
    s.importRanks('ranks.csv', enc('Date,Rank\n2026-10-10,800\n2026-10-13,9000\n'), asin);
    expect(s.salesStatus()).toMatchObject({ days: 6, books: 1, rankImported: 2 });

    const prev = s.calibrationPreview();
    expect(prev.points.map((p) => [p.rank, p.unitsPerDay])).toEqual([[800, 30], [9000, 3]]);
    expect(prev.fit).toMatchObject({ n: 2, mode: 'fixed-slope' });
    expect(prev.comparison).toHaveLength(4);
    const cal = s.applyCalibration();
    expect(s.salesCurve()).toEqual({ a: cal.a, b: cal.b });
    expect(s.calibrationPreview().current).toMatchObject({ n: 2 });
    s.resetCalibration();
    expect(s.salesCurve()).toEqual({ a: 13300, b: 0.79 });
    s.clearSalesData();
    expect(s.salesStatus().days).toBe(0);
    await s.stop();
  }, 30000);
});

describe('sales calibration with Kindle Unlimited', () => {
  it('estimates borrows from pages read and a page count, offers both fits, and applies the chosen one', async () => {
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {} });
    await s.setLibrary(libRoot);
    const enc = (t: string) => new TextEncoder().encode(t);
    const asin = 'B0G7R6X55V';
    const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'];
    s.importSales('orders.csv', enc(['Date,ASIN,Marketplace,Paid Units', ...days.map((d) => `${d},${asin},Amazon.com,2`)].join('\n')));
    const k = s.importSales('kenp.csv', enc(['Date,Title,Author Name,ASIN,Marketplace,KENP Read', ...days.map((d) => `${d},T,A,${asin},Amazon.com,${d <= '2026-10-10' ? 3000 : 300}`)].join('\n')));
    expect(k.contains).toEqual(['kenp']);
    s.importRanks('ranks.csv', enc('Date,Rank\n2026-10-10,800\n2026-10-13,9000\n'), asin);
    expect(s.salesStatus()).toMatchObject({ days: 6, kenpDays: 6, kenpBooks: 1 });

    // no page count yet: the Kindle Unlimited readings are left out and the books are listed
    let prev = s.calibrationPreview();
    expect(prev).toMatchObject({ kuAvailable: true, includeKu: true });
    expect(prev.noKenpc.map((b) => b.asin)).toEqual([asin]);
    expect(prev.fit).toBeNull();
    expect(prev.fitPaid).toMatchObject({ n: 2 });

    s.setKenpc(asin, 300);
    expect(() => s.setKenpc('bad', 300)).toThrow(/ASIN/);
    prev = s.calibrationPreview();
    expect(prev.points.map((p) => [p.rank, p.paidPerDay, p.borrowsPerDay, p.unitsPerDay])).toEqual([[800, 2, 10, 12], [9000, 2, 1, 3]]);
    expect(prev.kuBooks[0]).toMatchObject({ kenpc: 300, kenpcFrom: 'you', pagesRead: 9900 });
    expect(prev.comparison[0]).toMatchObject({ paid: expect.anything(), ku: expect.anything() });

    expect(s.calibrationPreview({ includeKu: false }).points.map((p) => p.unitsPerDay)).toEqual([2, 2]);
    expect(s.setKuCompletion(0.5)).toBe(0.5);
    expect(s.calibrationPreview().points[0]!.borrowsPerDay).toBe(20);
    expect(() => s.setKuCompletion(2)).toThrow(/between/);

    const cal = s.applyCalibration();
    expect(cal).toMatchObject({ includesKu: true, completion: 0.5 });
    expect(s.calibrationPreview().current).toMatchObject({ includesKu: true });
    s.applyCalibration({ includeKu: false });
    expect(s.calibrationPreview().current).toMatchObject({ includesKu: false });
    await s.stop();
  }, 30000);
});

describe('My Books', () => {
  it('creates the user\'s books from imported reports, opens an uncaptured one on Amazon, and fills it in when the extension sends the page', async () => {
    const opened: string[] = [];
    const s = new AppService({ userData, openExternal: (u) => void opened.push(u), revealInFolder: () => {} });
    await s.setLibrary(libRoot);
    const enc = (t: string) => new TextEncoder().encode(t);
    const asin = 'B0G7R6X55V';
    expect(s.ownBooks()).toEqual([]);
    const r = s.importSales('orders.csv', enc(`Date,Title,Author Name,ASIN,Marketplace,Paid Units\n2026-10-16,My Dragon Book,Jo Writer,${asin},Amazon.com,3\n2026-10-17,Other One,Jo Writer,B0C1R52V2J,Amazon.com,1`));
    expect(r).toMatchObject({ newBooks: 2 });
    expect(s.ownBooks().map((b) => [b.asin, b.title, b.snapshots])).toEqual([[asin, 'My Dragon Book', 0], ['B0C1R52V2J', 'Other One', 0]]);
    expect(s.ownBook(asin)).toMatchObject({ title: 'My Dragon Book', paidUnits: 3 });
    expect(s.book(asin)).toBeNull(); // not captured: the detail view shows the "open on Amazon" page for it
    await s.openBook(asin);
    expect(opened).toEqual([`https://www.amazon.com/dp/${asin}`]);

    // the user sends the page from Amazon with the extension
    const port = s.status().port;
    expect((await post(port, s.token(), { kind: 'detail', url: `https://www.amazon.com/dp/${asin}`, html: gz(`detail-kindle-${asin}.html.gz`) })).status).toBe(200);
    const mine = s.ownBooks();
    expect(mine[0]).toMatchObject({ asin, snapshots: 1 });
    expect(mine[0]!.title).not.toBe('My Dragon Book');
    expect(s.books({}).find((b) => b.asin === asin)!.own).toBe(1);

    // flag by hand / unflag; bad input is refused
    expect(() => s.setOwnBook('bad', true)).toThrow(/ASIN/);
    s.setOwnBook('B0GPRVQ8QJ', true);
    expect(s.ownBook('B0GPRVQ8QJ')).toMatchObject({ source: 'manual' });
    s.setOwnBook('B0GPRVQ8QJ', false);
    expect(s.ownBook('B0GPRVQ8QJ')).toBeNull();
    await s.stop();
  }, 30000);
});

describe('keyword history and suggestions', () => {
  const answer = (async (url: string) => {
    const u = new URL(url);
    const prefix = u.searchParams.get('prefix') ?? u.searchParams.get('q') ?? u.searchParams.get('query') ?? '';
    const list = prefix === 'cozy fantasy' ? ['cozy fantasy books', 'cozy fantasy romance'] : [];
    return new Response(JSON.stringify(u.hostname === 'completion.amazon.com' ? { suggestions: list.map((value) => ({ value })) } : [prefix, list]), { status: 200 });
  }) as unknown as typeof fetch;

  it('remembers each search once, reopens it from the saved answers with no request, and can forget it', async () => {
    let calls = 0;
    const counting = ((u: string, i?: RequestInit) => { calls++; return (answer as any)(u, i); }) as unknown as typeof fetch;
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, fetch: counting, keywordDelayMs: 0 });
    await s.setLibrary(libRoot);
    expect(s.keywordHistory()).toEqual([]);
    await s.keywordLookup('Cozy Fantasy');
    await s.keywordLookup('nothing found here'); // no source suggests anything: not worth keeping
    expect(s.keywordHistory().map((h) => h.seed)).toEqual(['cozy fantasy']);
    const first = s.keywordHistory()[0]!;
    expect(first).toMatchObject({ searches: 1, phrases: 3, saved: true });
    expect([...first.sources].sort()).toEqual(['amazon', 'bing', 'google']);

    const before = calls;
    const reopened = s.keywordTable(first.seed); // what clicking a history entry shows
    expect(reopened.rows.map((r) => r.keyword)).toEqual(['cozy fantasy', 'cozy fantasy books', 'cozy fantasy romance']);
    expect(calls).toBe(before);

    await s.keywordLookup('cozy fantasy'); // a repeat updates the one row
    expect(s.keywordHistory()).toHaveLength(1);
    expect(s.keywordHistory()[0]).toMatchObject({ searches: 2 });
    s.removeKeywordHistory('Cozy Fantasy');
    expect(s.keywordHistory()).toEqual([]);
    await s.keywordLookup('cozy fantasy');
    s.clearKeywordHistory();
    expect(s.keywordHistory()).toEqual([]);
    await s.stop();
  }, 30000);

  it('suggests five phrases for a captured category, and says so when the category is unknown', async () => {
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, fetch: answer, keywordDelayMs: 0 });
    await s.setLibrary(libRoot);
    const port = s.status().port;
    expect((await post(port, s.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
    for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) expect((await post(port, s.token(), { kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: gz(`detail-kindle-${a}.html.gz`) })).status).toBe(200);
    const key = s.categories()[0]!.key;
    const ideas = s.keywordIdeas(key);
    expect(ideas).toHaveLength(5);
    expect(ideas.every((i) => !/\b(?:humorous|fantasy)\b/.test(i.keyword))).toBe(true);
    expect(new Set(ideas.map((i) => i.keyword)).size).toBe(5);
    // clicking a suggestion runs that search, which then appears in the history
    await s.keywordLookup(ideas[0]!.keyword);
    expect(() => s.keywordIdeas('no such category')).toThrow(/no category matches/);
    // the same library gives keyword strings for the KDP boxes: at most seven, 50 characters each, no word twice
    const strings = s.keywordStrings(key);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.length).toBeLessThanOrEqual(7);
    const words = strings.flatMap((k) => k.keyword.split(' '));
    expect(new Set(words).size).toBe(words.length);
    expect(strings.every((k) => k.chars === k.keyword.length && k.chars <= 50)).toBe(true);
    expect(() => s.keywordStrings('no such category')).toThrow(/no category matches/);
    await s.stop();
  }, 30000);
});

describe('shelves on Amazon', () => {
  it('opens a known category\'s Best Sellers page, and nothing built from a caller\'s text', async () => {
    const opened: string[] = [];
    const s = new AppService({ userData, openExternal: (u) => void opened.push(u), revealInFolder: () => {} });
    await s.setLibrary(libRoot);
    expect((await post(s.status().port, s.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
    await s.openShelf('amazon.com:kindle:11650864011');
    expect(opened).toEqual(['https://www.amazon.com/gp/bestsellers/digital-text/11650864011']);
    await expect(s.openShelf('amazon.com:kindle:999')).rejects.toThrow(/unknown category/);
    await expect(s.openShelf('https://evil.example/')).rejects.toThrow(/unknown category/);
    await expect(s.openShelf(42 as never)).rejects.toThrow(/bad category/);
    expect(opened).toHaveLength(1);
    await s.stop();
  }, 30000);
});

describe('community insights', () => {
  it('analyses the synced subreddit text for a category, and opens only Reddit thread addresses', async () => {
    const opened: string[] = [];
    const s = new AppService({ userData, openExternal: (u) => void opened.push(u), revealInFolder: () => {} });
    await s.setLibrary(libRoot);
    const port = s.status().port;
    expect((await post(port, s.token(), { kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gz('bestsellers-kindle-humorous-fantasy.html.gz') })).status).toBe(200);
    const key = s.categories()[0]!.key;
    expect(s.communityInsights(key).coverage.threads).toBe(0);
    expect(() => s.communityInsights('no such category')).toThrow(/no category matches/);
    s.addCommunitySource(key, 'cozyfantasy');
    const lib = (s as any).need();
    const ins = lib.db.prepare("INSERT INTO community_item (kind, id, subreddit, link_id, parent_id, title, body, score, flair, created_utc) VALUES ('post', ?, 'cozyfantasy', ?, NULL, ?, 'I love found family.', 5, NULL, ?)");
    for (const [i, t] of ['Looking for found family', 'Recs for found family please', 'Any books with found family?'].entries()) ins.run(`t${i}`, `t${i}`, t, 1_790_000_000 + i);
    const r = s.communityInsights(key);
    expect(r.coverage).toMatchObject({ threads: 3, subreddits: ['cozyfantasy'] });
    expect(r.elements.find((e) => e.element === 'found family')).toMatchObject({ threads: 3, asked: 3 });
    expect(r.requests[0]!.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/cozyfantasy\/comments\/t\d\/$/);

    await s.openThread('https://www.reddit.com/r/cozyfantasy/comments/t0/');
    await s.openThread('https://www.reddit.com/r/cozyfantasy/comments/t0/_/k1/');
    expect(opened).toHaveLength(2);
    for (const bad of ['https://evil.example/r/x/comments/a/', 'https://www.reddit.com/user/someone', 'http://www.reddit.com/r/cozyfantasy/comments/t0/', 'https://www.reddit.com/r/cozyfantasy/comments/t0/\nhttps://evil', 42 as never]) await expect(s.openThread(bad)).rejects.toThrow(/not a Reddit thread/);
    expect(opened).toHaveLength(2);
    await s.stop();
  }, 30000);
});

describe('Claude Desktop extension', () => {
  it('builds an installable .mcpb whose launcher starts the configured server and passes stdio through', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const { spawn } = await import('node:child_process');
    const echo = path.join(tmp, 'echo.cjs');
    fs.writeFileSync(echo, "process.stdin.on('data', (d) => process.stdout.write('echo:' + d + '|' + process.argv.slice(2).join(',')));");
    const icon = path.join(tmp, 'icon.png');
    fs.writeFileSync(icon, 'png');
    const s = new AppService({ userData, openExternal: () => {}, revealInFolder: () => {}, version: '0.2.2', iconFile: () => icon, mcpLaunch: () => ({ command: process.execPath, args: [echo], env: { X_TEST: '1' } }) });
    await s.setLibrary(libRoot);
    const { file, earlyHandshake } = await s.buildClaudeExtension();
    expect(earlyHandshake).toBe(false); // the stand-in server cannot say what it answers to initialize, so the launcher only passes stdio through
    expect(path.basename(file)).toBe('Cadrel Market.mcpb');
    const z = unzipSync(new Uint8Array(fs.readFileSync(file)));
    expect(Object.keys(z).sort()).toEqual(['icon.png', 'manifest.json', 'server/launch.js']);
    const m = JSON.parse(strFromU8(z['manifest.json']!));
    expect(m).toMatchObject({ manifest_version: '0.2', name: 'cadrel-market', version: '0.2.2', server: { type: 'node', entry_point: 'server/launch.js', mcp_config: { command: 'node', args: ['${__dirname}/server/launch.js'] } } });
    // run the launcher as Claude Desktop would
    const dir = path.join(tmp, 'ext');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'launch.js'), z['server/launch.js']!);
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(dir, 'server', 'launch.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
      let t = '';
      p.stdout.on('data', (c) => { t += c; p.stdin.end(); });
      p.on('close', () => resolve(t));
      p.on('error', reject);
      p.stdin.write('hello');
    });
    expect(out).toBe(`echo:hello|--library,${libRoot}`);
    await s.stop();
  }, 30000);
});
