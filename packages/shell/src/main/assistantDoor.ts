/**
 * The app's local door for the assistant. The assistant (the MCP server) is a separate process and must not hold a Studio's device key, so for a
 * Studio whose records are on its server it talks to this door instead: a listener on 127.0.0.1 only, behind a token made at launch and handed to
 * that process in its arguments, which signs and forwards a short list of calls with the key the app already holds. The server still decides
 * what each call may do, as the person the key belongs to.
 *
 * What the door will carry, and nothing else: the service's calls by namespace (the same list the server accepts), the vault's reading
 * operations, and the contents of a version by hash. It closes with the app. Electron-free; tested in test/assistantDoor.test.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { decodeValue, encodeError, encodeValue } from '@cadrel/service';
import { DOOR_VAULT_METHODS, SERVICE_METHODS, SERVICE_NAMESPACES } from '@cadrel/studio-client';
import type { StudioClient } from './studioClient';

/** What the door needs from the Studio the app has open. Null where none is open on a server. */
export type DoorTarget = Pick<StudioClient, 'rpc' | 'vault' | 'getBlob'> | null;

const BODY_MAX = 1_000_000;
const HASH = /^[0-9a-f]{64}$/;

export class AssistantDoor {
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private port = 0;
  constructor(private readonly target: () => DoorTarget) {}

  /** Where the assistant's process reaches the door, once it is listening. */
  get url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.port = 0;
    if (s) await new Promise<void>((resolve) => (s.closeAllConnections?.(), s.close(() => resolve())));
  }

  private authorised(req: IncomingMessage): boolean {
    const given = Buffer.from(String(req.headers['x-cadrel-door'] ?? ''));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: string | Uint8Array, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const fail = (status: number, error: string) => send(status, JSON.stringify({ error }));
    // A page in a browser must not be able to use the door: no token, no answer, and nothing is allowed across origins.
    if (!this.authorised(req) || req.headers.origin) return fail(403, 'Not allowed.');
    const client = this.target();
    if (!client) return fail(409, 'No Studio on a server is open in Cadrel.');
    const url = new URL(req.url ?? '/', 'http://door');
    try {
      if (req.method === 'GET' && url.pathname.startsWith('/blob/')) {
        const hash = decodeURIComponent(url.pathname.slice('/blob/'.length));
        if (!HASH.test(hash)) return fail(400, 'That is not a version of a file.');
        const bytes = await client.getBlob(hash);
        return bytes ? send(200, bytes, 'application/octet-stream') : fail(404, 'Not found.');
      }
      if (req.method !== 'POST' || (url.pathname !== '/call' && url.pathname !== '/vault')) return fail(404, 'That is not something the door carries.');
      const body = await readBody(req);
      const request = decodeValue(body) as { path?: unknown; method?: unknown; args?: unknown };
      const args = Array.isArray(request.args) ? request.args : [];
      if (url.pathname === '/vault') {
        const name = typeof request.method === 'string' ? request.method : '';
        if (!(DOOR_VAULT_METHODS as readonly string[]).includes(name)) return fail(400, 'That is not something the assistant may do in the vault.');
        return send(200, encodeValue({ result: await client.vault(name, args[0]) }));
      }
      const names = Array.isArray(request.path) && request.path.every((x) => typeof x === 'string') ? (request.path as string[]) : null;
      const ok =
        names && ((names.length === 1 && (SERVICE_METHODS as readonly string[]).includes(names[0]!)) || (names.length === 2 && names[0] !== 'finance' && (SERVICE_NAMESPACES as readonly string[]).includes(names[0]!))) // the assistant never reaches what the books earned;
      if (!names || !ok) return fail(400, 'That is not something the assistant may do.');
      return send(200, encodeValue({ result: await client.rpc(names, args) }));
    } catch (e) {
      // A refusal from the Studio keeps its kind, so the assistant is told what the person's role does not allow.
      const wire = e instanceof Error ? encodeError(e) : null;
      return send(wire ? 422 : 500, wire ? encodeValue(wire) : JSON.stringify({ error: 'The Studio could not be reached.' }));
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) return reject(new Error('Too large.'));
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
