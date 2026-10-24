/**
 * Google sign-in for the Windows app: the "installed application" OAuth flow with a loopback redirect and PKCE.
 * The default browser opens Google's consent page; Google redirects to a one-shot server on 127.0.0.1, which catches
 * the code. The long-lived refresh token is kept in a vault (encrypted by the caller); access tokens live in memory.
 * Needs the app's Desktop OAuth client (id + secret; for installed apps the "secret" is not confidential).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TokenVault {
  load(): Promise<string | null>;
  save(refreshToken: string | null): Promise<void>;
}

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Defaults to the narrow `drive.file` scope. */
  scope?: string;
  openUrl(url: string): Promise<void> | void;
  vault: TokenVault;
  fetch?: typeof fetch;
  /** How long to wait for the user to finish in the browser. */
  timeoutMs?: number;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

const b64url = (b: Buffer) => b.toString('base64url');

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>MDEdit</title><body style="font:16px system-ui;margin:12vh auto;max-width:28em;text-align:center"><h2>${title}</h2><p>${body}</p></body>`;

export class GoogleAuth {
  private access: { token: string; expiresAt: number } | null = null;

  constructor(private readonly o: GoogleAuthOptions) {}

  private get doFetch(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  private ensureConfigured(): void {
    if (!this.o.clientId || !this.o.clientSecret) throw new Error('Google sign-in isn’t set up in this build of MDEdit.');
  }

  /** A usable access token: from the saved sign-in if there is one, otherwise by signing in. */
  async accessToken(): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt - 60_000) return this.access.token;
    const saved = await this.o.vault.load();
    return saved ? this.refresh(saved) : this.signIn();
  }

  /** Always shows Google's sign-in and consent in the browser. */
  async signIn(): Promise<string> {
    this.ensureConfigured();
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const { code, redirectUri } = await this.waitForCode(verifier, state);
    const res = await this.post(TOKEN_URL, {
      code, client_id: this.o.clientId, client_secret: this.o.clientSecret, redirect_uri: redirectUri,
      grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (!res.access_token) throw new Error(res.error_description || res.error || 'Google did not return an access token.');
    if (res.refresh_token) await this.o.vault.save(res.refresh_token);
    return this.remember(res.access_token, res.expires_in);
  }

  async signOut(): Promise<void> {
    const saved = await this.o.vault.load().catch(() => null);
    this.access = null;
    await this.o.vault.save(null);
    if (saved) await this.doFetch(`${REVOKE_URL}?token=${encodeURIComponent(saved)}`, { method: 'POST' }).catch(() => undefined); // best effort
  }

  private async refresh(refreshToken: string): Promise<string> {
    this.ensureConfigured();
    const res = await this.post(TOKEN_URL, { client_id: this.o.clientId, client_secret: this.o.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    if (res.error === 'invalid_grant') {
      await this.o.vault.save(null); // revoked or expired: the user has to sign in again
      this.access = null;
      throw new Error('Your Google sign-in expired. Connect Google Drive again.');
    }
    if (!res.access_token) throw new Error(res.error_description || res.error || 'Could not refresh the Google sign-in.');
    return this.remember(res.access_token, res.expires_in);
  }

  private remember(token: string, expiresIn?: number): string {
    this.access = { token, expiresAt: Date.now() + (expiresIn ?? 3600) * 1000 };
    return token;
  }

  private async post(url: string, body: Record<string, string>): Promise<TokenReply> {
    const r = await this.doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    return (await r.json().catch(() => ({}))) as TokenReply;
  }

  /** Opens the consent page and resolves with the authorisation code Google redirects back with. */
  private waitForCode(verifier: string, state: string): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      let done = false;
      let redirectUri = ''; // known once the server is listening
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        server.close();
        server.closeAllConnections?.();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('Google sign-in timed out. Try again.'))), this.o.timeoutMs ?? 5 * 60_000);

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if ((!code && !error) || url.searchParams.get('state') !== state) {
          res.writeHead(404).end(); // favicon, scanners, or something that isn't Google's redirect for this attempt
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (error || !code) {
          res.end(page('Sign-in cancelled', 'You can close this tab and go back to MDEdit.'));
          finish(() => reject(new Error(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${error}`)));
        } else {
          res.end(page('You’re signed in', 'You can close this tab and go back to MDEdit.'));
          finish(() => resolve({ code, redirectUri }));
        }
      });
      server.on('error', (e) => finish(() => reject(e)));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const params = new URLSearchParams({
          client_id: this.o.clientId, redirect_uri: redirectUri, response_type: 'code', scope: this.o.scope ?? DRIVE_FILE,
          code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state,
          access_type: 'offline', prompt: 'consent',
        });
        Promise.resolve(this.o.openUrl(`${AUTH_URL}?${params}`)).catch((e) => finish(() => reject(e)));
      });
    });
  }
}
