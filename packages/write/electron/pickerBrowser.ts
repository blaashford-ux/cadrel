import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JOIN_PAGE } from '../src/shared/review/link';

const ID = /^[A-Za-z0-9_-]{2,128}$/;
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs Google's file picker in the user's own browser and waits for the answer. The picker stays blank when it is embedded
 * two frames deep inside the app, but works as an ordinary page, so the app opens the invitation page in the browser and
 * listens on 127.0.0.1 for the page to send the picked ids back (the same loopback idea as the Google sign-in).
 * Resolves to the ids, or null when the picker was cancelled or the wait ran out. `open` shows a URL in the browser.
 */
export function pickInBrowser(pageUrl: string, open: (url: string) => Promise<void>, timeoutMs = TIMEOUT_MS): Promise<string[] | null> {
  if (!pageUrl.startsWith(JOIN_PAGE)) return Promise.reject(new Error("Refusing to open a page outside MDEdit's invitation page."));
  const state = randomBytes(18).toString('base64url');
  return new Promise<string[] | null>((resolve, reject) => {
    let finished = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/picked' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end();
        return;
      }
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((s) => ID.test(s));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>MDEdit</title><body style="font:16px system-ui;padding:40px;text-align:center"><h2>Done</h2><p>You can close this tab and go back to MDEdit.</p>');
      finish(ids.length ? ids : null);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    function finish(result: string[] | null, error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 500).unref(); // after the reply has gone out
      server.closeIdleConnections?.();
      if (error) reject(error);
      else resolve(result);
    }
    server.once('error', (e) => finish(null, e));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const page = new URL(pageUrl);
      const frag = new URLSearchParams(page.hash.slice(1));
      frag.set('ret', `http://127.0.0.1:${port}/picked?state=${state}`);
      page.hash = frag.toString();
      open(page.toString()).catch((e) => finish(null, e instanceof Error ? e : new Error(String(e))));
    });
  });
}
