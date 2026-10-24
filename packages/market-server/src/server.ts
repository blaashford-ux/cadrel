import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_SAMPLE_PAGES, detectKind, saveSamplePage, type IngestResult, type Library, type PageCrop, type PageKind } from '@cadrel/market-library';
import { tokensEqual } from './token.js';

export const DEFAULT_PORT = 47321;
const DEFAULT_MAX_BODY = 48 * 1024 * 1024;
const MAX_COVERS = 12;
const MAX_COVER_BYTES = 8 * 1024 * 1024;

export interface ServerOptions {
  library: Library;
  token: string;
  /** Extension origins allowed to call the server, e.g. "chrome-extension://abc...". Empty = any chrome-extension origin. */
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  /**
   * Pairing by short code: the app shows a code, the extension sends it, and gets the token back. `redeem` returns the
   * token for a valid code (and uses it up), otherwise null.
   */
  pairing?: { redeem: (code: string) => string | null };
  /** Called after each successful capture. */
  onCapture?: (r: IngestResult) => void;
  /** Called after each sample-page screenshot is stored. */
  onSamplePage?: (e: { asin: string; session: string; pages: number; index: number; duplicate: boolean; bytes: number }) => void;
  /** Called when the extension says a sample session is over; the app reads the pages from there. */
  onSampleFinished?: (e: { asin: string; session: string }) => void;
  /**
   * Called for everything worth knowing about a sample capture: notes the extension reports about what it sees
   * (source "extension"), and requests the app refused (source "app"). Never receives page content.
   */
  onSampleLog?: (e: SampleLogEvent) => void;
}

export interface SampleLogEvent {
  source: 'extension' | 'app';
  level: 'info' | 'warn' | 'error';
  asin: string | null;
  session: string | null;
  event: string;
  detail: string;
}

const MAX_SAMPLE_IMAGE = 12 * 1024 * 1024;

interface CaptureBody {
  kind?: PageKind;
  url?: string;
  html?: string;
  capturedAt?: string;
  covers?: { asin?: string; ext?: string; dataBase64?: string }[];
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isAmazonUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'www.amazon.com' || url.hostname === 'amazon.com');
  } catch {
    return false;
  }
}

export function createIngestServer(opts: ServerOptions): http.Server {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const allowed = opts.allowedOrigins ?? [];
  const pairFails: number[] = [];

  const originOk = (origin: string | undefined): boolean => {
    if (origin === undefined) return true; // non-browser clients (curl, the desktop app itself)
    if (!origin.startsWith('chrome-extension://')) return false; // never a web page
    return allowed.length === 0 || allowed.includes(origin);
  };

  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, origin?: string) => {
      const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (origin && originOk(origin)) {
        headers['access-control-allow-origin'] = origin;
        headers['vary'] = 'Origin';
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    const origin = req.headers.origin;
    let sampleCtx: { asin: string | null; session: string | null } = { asin: null, session: null };
    try {
      // DNS-rebinding guard: only loopback host names are served.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') throw new HttpError(403, 'bad host');
      if (!originOk(origin)) throw new HttpError(403, 'origin not allowed');

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': origin ?? '',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-max-age': '600',
          vary: 'Origin',
        });
        res.end();
        return;
      }

      if (new URL(req.url ?? '/', 'http://x').pathname === '/v1/pair') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST only');
        if (!opts.pairing) throw new HttpError(404, 'not found');
        const now = Date.now();
        while (pairFails.length && now - pairFails[0]! > 60_000) pairFails.shift();
        if (pairFails.length >= 5) throw new HttpError(429, 'too many wrong codes; wait a minute');
        const body = (await readJson(req, 1024)) as { code?: unknown };
        const token = typeof body.code === 'string' && /^\d{6}$/.test(body.code) ? opts.pairing.redeem(body.code) : null;
        if (!token) {
          pairFails.push(now);
          throw new HttpError(401, 'that code is wrong or has expired');
        }
        send(200, { ok: true, token }, origin);
        return;
      }

      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      if (!m || !tokensEqual(m[1]!, opts.token)) throw new HttpError(401, 'bad token');

      const route = (req.url ?? '').split('?')[0];
      if (route === '/v1/ping' && req.method === 'GET') {
        send(200, { ok: true, app: 'bookscout' }, origin);
        return;
      }
      if ((route === '/v1/capture' || route === '/v1/sample/page' || route === '/v1/sample/finish') && opts.library.rebuilding) {
        throw new HttpError(503, 'BookScout is re-reading the library; try again in a minute');
      }
      if (route === '/v1/capture') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST only');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json only');
        const body = await readJson(req, maxBody);
        send(200, handleCapture(opts.library, body, opts.onCapture), origin);
        return;
      }
      if (route === '/v1/sample/log') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST only');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json only');
        send(200, handleSampleLog(opts, (await readJson(req, 16 * 1024)) as SampleLogBody), origin);
        return;
      }
      if (route === '/v1/sample/page' || route === '/v1/sample/finish') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST only');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json only');
        const body = (await readJson(req, maxBody)) as SampleBody;
        sampleCtx = { asin: typeof body.asin === 'string' ? body.asin.slice(0, 10) : null, session: typeof body.session === 'string' ? body.session.slice(0, 16) : null };
        send(200, route === '/v1/sample/page' ? handleSamplePage(opts, body) : handleSampleFinish(opts, body), origin);
        return;
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const where = (req.url ?? '').split('?')[0] ?? '';
      if (where.startsWith('/v1/sample/') && where !== '/v1/sample/log') {
        const status = e instanceof HttpError ? e.status : 500;
        opts.onSampleLog?.({ source: 'app', level: 'warn', ...sampleCtx, event: 'request refused', detail: `${where}: HTTP ${status}, ${e instanceof Error ? e.message : String(e)}` }); // the real cause goes in the log; the client only sees "internal error"
      }
      if (e instanceof HttpError) send(e.status, { ok: false, error: e.message }, origin);
      else send(500, { ok: false, error: 'internal error' }, origin);
    }
  });
}

interface SampleBody {
  asin?: string;
  session?: string;
  ext?: string;
  image?: string;
  crop?: Partial<PageCrop> | null;
  capturedAt?: string;
}

function sampleIds(lib: Library, b: SampleBody): { asin: string; session: string } {
  if (typeof b.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(b.asin)) throw new HttpError(400, 'bad asin');
  if (typeof b.session !== 'string' || !/^\d{8}T\d{6}Z$/.test(b.session)) throw new HttpError(400, 'bad session');
  if (!lib.db.scalar('SELECT 1 FROM book WHERE asin = ?', b.asin)) throw new HttpError(409, 'capture the book page first');
  return { asin: b.asin, session: b.session };
}

function handleSamplePage(opts: ServerOptions, b: SampleBody) {
  const { asin, session } = sampleIds(opts.library, b);
  if (b.ext !== 'png' && b.ext !== 'jpg') throw new HttpError(400, 'ext must be png or jpg');
  if (typeof b.image !== 'string') throw new HttpError(400, 'image missing');
  const bytes = Buffer.from(b.image, 'base64');
  if (bytes.length < 200 || bytes.length > MAX_SAMPLE_IMAGE) throw new HttpError(400, 'image has an unusable size');
  const okMagic = b.ext === 'png' ? bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!okMagic) throw new HttpError(400, 'image is not a valid ' + b.ext);
  let crop: PageCrop | null = null;
  const c = b.crop;
  if (c && [c.left, c.top, c.width, c.height].every((n) => typeof n === 'number' && Number.isFinite(n)) && c.width! > 50 && c.height! > 50) {
    crop = { left: c.left!, top: c.top!, width: c.width!, height: c.height! };
  }
  let capturedAt: string | undefined;
  if (b.capturedAt !== undefined) {
    const t = Date.parse(b.capturedAt);
    if (Number.isNaN(t)) throw new HttpError(400, 'bad capturedAt');
    capturedAt = new Date(t).toISOString();
  }
  try {
    const r = saveSamplePage(opts.library.root, asin, session, bytes, b.ext, { crop, capturedAt });
    opts.onSamplePage?.({ asin, session, pages: r.pages, index: r.index, duplicate: r.duplicate, bytes: bytes.length });
    return { ok: true, ...r, max: MAX_SAMPLE_PAGES };
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : 'could not store page');
  }
}

interface SampleLogBody {
  asin?: unknown;
  session?: unknown;
  level?: unknown;
  event?: unknown;
  detail?: unknown;
}

/** One line from the extension about what it saw. Kept short and single-line; the app writes it to the sample log. */
function handleSampleLog(opts: ServerOptions, b: SampleLogBody) {
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').slice(0, max) : '');
  const asin = typeof b.asin === 'string' && /^[A-Z0-9]{10}$/.test(b.asin) ? b.asin : null;
  const session = typeof b.session === 'string' && /^\d{8}T\d{6}Z$/.test(b.session) ? b.session : null;
  const event = clean(b.event, 60);
  if (!event) throw new HttpError(400, 'event missing');
  const level = b.level === 'warn' || b.level === 'error' ? b.level : 'info';
  opts.onSampleLog?.({ source: 'extension', level, asin, session, event, detail: clean(b.detail, 500) });
  return { ok: true };
}

function handleSampleFinish(opts: ServerOptions, b: SampleBody) {
  const { asin, session } = sampleIds(opts.library, b);
  opts.onSampleFinished?.({ asin, session });
  return { ok: true, asin, session };
}

function handleCapture(lib: Library, b: CaptureBody, onCapture?: (r: IngestResult) => void) {
  if (typeof b.url !== 'string' || !isAmazonUrl(b.url)) throw new HttpError(400, 'url must be an https amazon.com page');
  if (typeof b.html !== 'string' || b.html.length < 100) throw new HttpError(400, 'html missing');
  const kind = b.kind ?? detectKind(b.url);
  if (kind !== 'detail' && kind !== 'list' && kind !== 'search') throw new HttpError(400, 'cannot tell if this is a book, list or search page');
  let capturedAt: string | undefined;
  if (b.capturedAt !== undefined) {
    const t = Date.parse(b.capturedAt);
    if (Number.isNaN(t)) throw new HttpError(400, 'bad capturedAt');
    capturedAt = new Date(t).toISOString();
  }
  if (b.covers !== undefined && (!Array.isArray(b.covers) || b.covers.length > MAX_COVERS)) throw new HttpError(400, 'bad covers');

  let result: IngestResult;
  try {
    result = lib.ingest({ kind, url: b.url, html: b.html, capturedAt });
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : 'could not ingest page');
  }
  let coversSaved = 0;
  for (const c of b.covers ?? []) {
    const asin = c.asin ?? result.asin;
    if (!asin || typeof c.dataBase64 !== 'string' || typeof c.ext !== 'string') continue;
    const bytes = Buffer.from(c.dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) continue;
    try {
      lib.saveAsset(asin, 'cover', bytes, c.ext, capturedAt);
      coversSaved++;
    } catch {
      /* skip a malformed cover; the page itself is already safe */
    }
  }
  onCapture?.(result);
  return {
    ok: true,
    kind: result.kind,
    asin: result.asin ?? null,
    category: result.categoryKey ?? null,
    query: result.query ?? null,
    replaced: result.replaced,
    coversSaved,
    issues: result.issues.length,
  };
}

function readJson(req: http.IncomingMessage, max: number): Promise<CaptureBody> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) return reject(new HttpError(413, 'body too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
        resolve(v as CaptureBody);
      } catch {
        reject(new HttpError(400, 'bad json'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'read error')));
  });
}

export async function startIngestServer(
  opts: ServerOptions,
  port = DEFAULT_PORT,
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const server = createIngestServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve); // loopback only
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
