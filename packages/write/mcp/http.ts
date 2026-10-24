/**
 * MDEdit's AI tools over HTTP, for apps that can't launch a program on this PC (the ChatGPT app, a Custom GPT, claude.ai):
 *   POST /mcp      MCP over Streamable HTTP
 *   /api/...       the same tools as REST, described at GET /openapi.json
 * Every call except /health and /openapi.json needs `Authorization: Bearer <token>`. It listens on this PC only
 * (127.0.0.1); making it reachable from the internet is the user's choice, with a tunnel.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { agentFromClient, createServer, type ServerOptions } from './server';
import { handleRest, openApiDocument } from './rest';

export interface HttpOptions extends ServerOptions {
  token: string;
  /** 0 picks a free port. */
  port: number;
  host?: string;
}

const MAX_BODY = 1_000_000;
const MAX_SESSIONS = 20;
const IDLE_MS = 30 * 60 * 1000;

const digest = (s: string) => createHash('sha256').update(s).digest();
export const tokenMatches = (header: string | undefined, token: string): boolean => {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return !!m && timingSafeEqual(digest(m[1]), digest(token));
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('That request is too large.'), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('The request body is not valid JSON.'), { status: 400 });
  }
}

/** The address the outside world used, so the OpenAPI file points back at the right place (it may be a tunnel). */
function baseUrl(req: IncomingMessage): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export async function startHttp(o: HttpOptions): Promise<{ port: number; host: string; server: Server; close(): Promise<void> }> {
  if (o.token.length < 16) throw new Error('The access token must be at least 16 characters.');
  const host = o.host ?? '127.0.0.1';
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer; last: number }>();
  // Sessions nobody has used for a while are closed, so abandoned clients can't pile up.
  const sweep = setInterval(() => {
    for (const [sid, s] of sessions) if (Date.now() - s.last > IDLE_MS) void s.transport.close();
  }, 60_000);
  sweep.unref();

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { name: 'mdedit', ok: true });
        if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openApiDocument(baseUrl(req)));
        if (!tokenMatches(req.headers.authorization, o.token)) {
          res.setHeader('www-authenticate', 'Bearer');
          return send(res, 401, { error: 'A valid access token is required.' });
        }

        if (url.pathname === '/mcp') {
          const id = req.headers['mcp-session-id'];
          const known = typeof id === 'string' ? sessions.get(id) : undefined;
          if (known) {
            known.last = Date.now();
            return await known.transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
          }
          // No session yet: only an `initialize` request may start one. A session remembers who the client is, so notes are signed with its name.
          if (req.method !== 'POST') return send(res, 400, { error: 'Start a session by POSTing an initialize request.' });
          const body = await readBody(req);
          if (!isInitializeRequest(body)) return send(res, 400, { error: 'Unknown or expired session. Send an initialize request first.' });
          if (sessions.size >= MAX_SESSIONS) return send(res, 503, { error: 'Too many open sessions. Try again shortly.' });
          const mcp = createServer(o);
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: (sid) => {
              sessions.set(sid, { transport, mcp, last: Date.now() });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await mcp.connect(transport);
          return await transport.handleRequest(req, res, body);
        }

        if (url.pathname.startsWith('/api/')) {
          const body = req.method === 'POST' ? await readBody(req) : undefined;
          // REST callers aren't MCP clients, so they are named by the --agent option, or by the x-mdedit-agent header, or "GPT".
          const named = agentFromClient(String(req.headers['x-mdedit-agent'] ?? ''), o.agent);
          const ctx = { fs: o.fs, root: o.root, ...(named.agent === 'ai' ? { agent: 'gpt', agentName: 'GPT' } : named) };
          const r = await handleRest(ctx, req.method ?? 'GET', url, body);
          return send(res, r.status, r.json);
        }
        send(res, 404, { error: 'Not found.' });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        if (status === 413) {
          // The rest of the upload was never read, so this connection can't be reused.
          res.setHeader('connection', 'close');
          res.once('finish', () => req.destroy());
        }
        if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong.' : (e as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, host, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    host,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        for (const s of sessions.values()) void s.transport.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
