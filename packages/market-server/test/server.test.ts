import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from '@cadrel/market-library';
import { startIngestServer, loadOrCreateToken, rotateToken, isAmazonUrl } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const gunzip = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const ASIN = 'B0G7R6X55V';
const detailHtml = gunzip(`detail-kindle-${ASIN}.html.gz`);
const TOKEN = 'x'.repeat(43);

let root: string;
let lib: Library;
let srv: Awaited<ReturnType<typeof startIngestServer>>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-srv-'));
  lib = Library.open(root);
  srv = await startIngestServer({ library: lib, token: TOKEN, maxBodyBytes: 6 * 1024 * 1024 }, 0);
});
afterEach(async () => {
  await srv.close();
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Opts { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; auth?: boolean }
function call(o: Opts = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
    const req = http.request({ host: '127.0.0.1', port: srv.port, method: o.method ?? 'GET', path: o.path ?? '/v1/ping', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
const post = (payload: unknown, extra: Partial<Opts> = {}) =>
  call({ method: 'POST', path: '/v1/capture', headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) }, body: JSON.stringify(payload), ...extra, });
const good = () => ({ url: `https://www.amazon.com/dp/${ASIN}`, html: detailHtml, capturedAt: '2026-10-18T12:00:00Z' });

describe('auth and origin', () => {
  it('pings with the token', async () => {
    expect((await call()).json).toEqual({ ok: true, app: 'cadrel-market' });
  });
  it('rejects missing or wrong tokens', async () => {
    expect((await call({ auth: false })).status).toBe(401);
    expect((await call({ headers: { authorization: 'Bearer nope' } , auth: false})).status).toBe(401);
  });
  it('rejects web-page origins and foreign hosts', async () => {
    expect((await call({ headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call({ headers: { host: 'evil.example' } })).status).toBe(403);
  });
  it('accepts an extension origin and echoes it for CORS', async () => {
    const r = await call({ headers: { origin: 'chrome-extension://abcdef' } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('chrome-extension://abcdef');
  });
  it('answers preflight without a token, but only for extensions', async () => {
    const ok = await call({ method: 'OPTIONS', auth: false, headers: { origin: 'chrome-extension://abcdef' } });
    expect(ok.status).toBe(204);
    const bad = await call({ method: 'OPTIONS', auth: false, headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });
  it('can be pinned to one extension id', async () => {
    await srv.close();
    srv = await startIngestServer({ library: lib, token: TOKEN, allowedOrigins: ['chrome-extension://mine'] }, 0);
    expect((await call({ headers: { origin: 'chrome-extension://mine' } })).status).toBe(200);
    expect((await call({ headers: { origin: 'chrome-extension://other' } })).status).toBe(403);
  });
});

describe('capture', () => {
  it('ingests a book page and its cover', async () => {
    const r = await post({ ...good(), covers: [{ ext: 'jpg', dataBase64: Buffer.from('fakejpeg').toString('base64') }] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, kind: 'detail', asin: ASIN, replaced: false, coversSaved: 1 });
    expect(fs.readdirSync(path.join(root, 'books', ASIN, 'covers'))).toHaveLength(1);
  });
  it('is idempotent', async () => {
    await post(good());
    const r = await post(good());
    expect(r.json.replaced).toBe(true);
    expect(lib.db.scalar('SELECT count(*) FROM snapshot')).toBe(1);
  });
  it('ingests a list page, detecting kind from the url', async () => {
    const r = await post({ url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: gunzip('bestsellers-kindle-humorous-fantasy.html.gz') });
    expect(r.json).toMatchObject({ ok: true, kind: 'list', category: 'amazon.com:kindle:11650864011' });
  });
  it('ingests a search page, detecting kind from the url, and reports the query', async () => {
    const html = '<html><body><div class="s-desktop-toolbar">1-16 of 628 results for</div><div data-component-type="s-search-result" data-asin="B000000002"><h2 aria-label="A Book"></h2></div>' + ' '.repeat(100) + '</body></html>';
    const r = await post({ url: 'https://www.amazon.com/s?k=Cozy+Fantasy&i=digital-text', html });
    expect(r.json).toMatchObject({ ok: true, kind: 'search', query: 'cozy fantasy' });
    expect(lib.db.scalar('SELECT COUNT(*) FROM search_entry')).toBe(1);
  });
  it('rejects non-amazon urls, bad json, wrong content type, unknown pages', async () => {
    expect((await post({ ...good(), url: 'https://evil.example/dp/B0G7R6X55V' })).status).toBe(400);
    expect((await post({ ...good(), url: 'http://www.amazon.com/dp/B0G7R6X55V' })).status).toBe(400);
    expect((await call({ method: 'POST', path: '/v1/capture', headers: { 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
    expect((await call({ method: 'POST', path: '/v1/capture', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post({ ...good(), url: 'https://www.amazon.com/gp/help/customer/display.html' })).status).toBe(400);
    expect((await post({ ...good(), capturedAt: 'yesterday-ish' })).status).toBe(400);
  });
  it('returns 422 for a page that is not a book page, and stores nothing', async () => {
    const r = await post({ url: `https://www.amazon.com/dp/${ASIN}`, html: '<html>' + 'x'.repeat(200) + '</html>' });
    expect(r.status).toBe(422);
    expect(fs.existsSync(path.join(root, 'books'))).toBe(false);
  });
  it('caps body size', async () => {
    const r = await post({ ...good(), html: 'x'.repeat(7 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });
  it('404s unknown routes and 405s wrong methods', async () => {
    expect((await call({ path: '/nope' })).status).toBe(404);
    expect((await call({ path: '/v1/capture' })).status).toBe(405);
  });
});

describe('token file', () => {
  it('is created once, reused, and rotated on request', () => {
    const f = path.join(root, 'cfg', 'token');
    const a = loadOrCreateToken(f);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(loadOrCreateToken(f)).toBe(a);
    expect(rotateToken(f)).not.toBe(a);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o077).toBe(0);
  });
});

describe('isAmazonUrl', () => {
  it('only accepts https amazon.com', () => {
    expect(isAmazonUrl('https://www.amazon.com/dp/B0G7R6X55V')).toBe(true);
    expect(isAmazonUrl('https://www.amazon.com.evil.example/dp/x')).toBe(false);
    expect(isAmazonUrl('https://evil.example/www.amazon.com')).toBe(false);
  });
});

describe('sample log', () => {
  it('passes the extension\'s notes to the app, cleaned and capped, and logs refused sample requests', async () => {
    const notes: any[] = [];
    await srv.close();
    srv = await startIngestServer({ library: lib, token: TOKEN, onSampleLog: (e) => notes.push(e) }, 0);
    const post = (path: string, body: unknown) => call({ method: 'POST', path, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await post('/v1/sample/log', { asin: ASIN, session: '20261019T100000Z', level: 'warn', event: 'reader not found', detail: 'line one\nline two ' + 'x'.repeat(900) });
    expect(ok.json).toEqual({ ok: true });
    expect(notes[0]).toMatchObject({ source: 'extension', level: 'warn', asin: ASIN, session: '20261019T100000Z', event: 'reader not found' });
    expect(notes[0].detail).not.toMatch(/\n/);
    expect(notes[0].detail.length).toBe(500);
    await post('/v1/sample/log', { asin: '../x', session: 'now', level: 'loud', event: 'odd' });
    expect(notes[1]).toMatchObject({ level: 'info', asin: null, session: null });
    expect((await post('/v1/sample/log', { asin: ASIN })).status).toBe(400); // no event
    expect((await call({ path: '/v1/sample/log' })).status).toBe(405);
    expect((await call({ method: 'POST', path: '/v1/sample/log', auth: false, headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    // a refused page is logged with its reason; the log route's own errors are not echoed back into the log
    const before = notes.length;
    expect((await post('/v1/sample/page', { asin: ASIN, session: '20261019T100000Z', ext: 'png', image: 'AAAA' })).status).toBe(409);
    expect(notes[before]).toMatchObject({ source: 'app', level: 'warn', asin: ASIN, event: 'request refused' });
    expect(notes[before].detail).toMatch(/HTTP 409.*capture the book page first/);
    expect(notes.length).toBe(before + 1);
  });
});

describe('sample pages', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
  const S = '20261019T100000Z';
  const page = (over: Record<string, unknown> = {}) => ({ asin: ASIN, session: S, ext: 'png', image: PNG.toString('base64'), ...over });
  const postTo = (p: string, payload: unknown) => call({ method: 'POST', path: p, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  it('needs the book page captured first', async () => {
    expect((await postTo('/v1/sample/page', page())).status).toBe(409);
  });

  it('stores pages, reports duplicates, keeps the crop, and announces the finish', async () => {
    await post(good());
    const events: string[] = [];
    await srv.close();
    srv = await startIngestServer({ library: lib, token: TOKEN, onSamplePage: (e) => events.push(`page:${e.pages}:${e.duplicate}`), onSampleFinished: (e) => events.push(`done:${e.asin}:${e.session}`) }, 0);
    const a = await postTo('/v1/sample/page', page({ crop: { left: 5, top: 6, width: 400, height: 500 } }));
    expect(a.json).toMatchObject({ ok: true, index: 1, duplicate: false, pages: 1 });
    const b = await postTo('/v1/sample/page', page({ image: Buffer.concat([PNG, Buffer.from('x')]).toString('base64') }));
    expect(b.json).toMatchObject({ index: 2, pages: 2 });
    const dup = await postTo('/v1/sample/page', page());
    expect(dup.json).toMatchObject({ index: 1, duplicate: true, pages: 2 });
    expect(fs.existsSync(path.join(root, 'books', ASIN, 'lookinside', S, 'page-002.png'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'books', ASIN, 'lookinside', S, 'pages.json'), 'utf8'))[0].crop).toEqual({ left: 5, top: 6, width: 400, height: 500 });
    expect((await postTo('/v1/sample/finish', { asin: ASIN, session: S })).json).toMatchObject({ ok: true });
    expect(events).toEqual(['page:1:false', 'page:2:false', 'page:2:true', `done:${ASIN}:${S}`]);
  });

  it('rejects bad ids, bad images and wrong content', async () => {
    await post(good());
    expect((await postTo('/v1/sample/page', page({ asin: '../x' }))).status).toBe(400);
    expect((await postTo('/v1/sample/page', page({ session: 'yesterday' }))).status).toBe(400);
    expect((await postTo('/v1/sample/page', page({ ext: 'exe' }))).status).toBe(400);
    expect((await postTo('/v1/sample/page', page({ image: Buffer.alloc(500, 1).toString('base64') }))).status).toBe(400); // not a PNG
    expect((await postTo('/v1/sample/page', page({ image: 'AAAA' }))).status).toBe(400); // too small
    expect((await postTo('/v1/sample/page', page({ image: undefined }))).status).toBe(400);
    expect((await call({ path: '/v1/sample/page' })).status).toBe(405);
    expect((await call({ method: 'POST', path: '/v1/sample/page', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('ignores a nonsense crop instead of failing', async () => {
    await post(good());
    const r = await postTo('/v1/sample/page', page({ crop: { left: 'x', top: 1, width: 1, height: 1 } }));
    expect(r.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'books', ASIN, 'lookinside', S, 'pages.json'), 'utf8'))[0].crop).toBeNull();
  });
});

describe('while the library is being rebuilt', () => {
  it('asks the extension to try again later instead of writing', async () => {
    lib.rebuilding = true;
    const r = await post(good());
    expect(r.status).toBe(503);
    expect(r.json.error).toMatch(/try again/);
    expect(fs.existsSync(path.join(root, 'books'))).toBe(false);
    lib.rebuilding = false;
    expect((await post(good())).status).toBe(200);
  });
});

describe('pairing by code', () => {
  let codes: Record<string, string>;
  const pair = (code: unknown, headers: Record<string, string> = { origin: 'chrome-extension://abcdef' }) =>
    call({ method: 'POST', path: '/v1/pair', auth: false, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code }) });
  beforeEach(async () => {
    codes = { '123456': TOKEN };
    await srv.close();
    srv = await startIngestServer({ library: lib, token: TOKEN, pairing: { redeem: (c) => { const t = codes[c] ?? null; delete codes[c]; return t; } } }, 0);
  });

  it('hands the token to a valid code, once', async () => {
    const r = await pair('123456');
    expect(r.json).toEqual({ ok: true, token: TOKEN });
    expect((await pair('123456')).status).toBe(401);
  });
  it('refuses web pages and foreign hosts, even with a valid code', async () => {
    expect((await pair('123456', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await pair('123456', { host: 'evil.example' })).status).toBe(403);
    expect((await pair('123456')).status).toBe(200); // still unused
  });
  it('rejects malformed codes and rate-limits guessing', async () => {
    expect((await pair('12')).status).toBe(401);
    expect((await pair(123456)).status).toBe(401);
    for (let i = 0; i < 3; i++) await pair('000000');
    expect((await pair('000000')).status).toBe(429);
    expect((await pair('123456')).status).toBe(429); // even the right code waits out the lockout
  });
  it('is not there when pairing is not enabled', async () => {
    await srv.close();
    srv = await startIngestServer({ library: lib, token: TOKEN }, 0);
    expect((await pair('123456')).status).toBe(404);
  });
});
