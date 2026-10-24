import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleAuth, type TokenVault } from './googleAuth';

const memVault = (initial: string | null = null): TokenVault & { value: string | null } => ({
  value: initial,
  load: async function () { return this.value; },
  save: async function (t) { this.value = t; },
});

interface Call { url: string; body: URLSearchParams }
const tokenServer = (reply: (body: URLSearchParams) => unknown) => {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(reply(body)), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
};

/** Plays the browser: reads the consent URL, then "redirects" back to the loopback address like Google would. */
const browser = (params: (u: URL) => Record<string, string>) => async (url: string) => {
  const u = new URL(url);
  const redirect = new URL(u.searchParams.get('redirect_uri')!);
  for (const [k, v] of Object.entries(params(u))) redirect.searchParams.set(k, v);
  setTimeout(() => void fetch(redirect), 5);
};

describe('GoogleAuth (installed-app flow)', () => {
  const base = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' };

  it('signs in: opens consent with PKCE and the narrow scope, catches the redirect, exchanges the code, saves the refresh token', async () => {
    const vault = memVault();
    let consent!: URL;
    const { calls, fetchFn } = tokenServer(() => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
    const auth = new GoogleAuth({ ...base, vault, fetch: fetchFn, openUrl: async (url) => { consent = new URL(url); await browser((u) => ({ code: 'the-code', state: u.searchParams.get('state')! }))(url); } });

    expect(await auth.signIn()).toBe('AT');
    expect(vault.value).toBe('RT');
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(consent.searchParams.get('client_id')).toBe(base.clientId);
    expect(consent.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('access_type')).toBe('offline');
    expect(consent.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const exchange = calls[0].body;
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('client_secret')).toBe('shh');
    expect(exchange.get('redirect_uri')).toBe(consent.searchParams.get('redirect_uri'));
    // PKCE: the verifier sent now must hash to the challenge sent in the browser
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(consent.searchParams.get('code_challenge'));
  });

  it('ignores a redirect with the wrong state (it is not ours) and waits for the real one', async () => {
    const { fetchFn } = tokenServer(() => ({ access_token: 'AT', refresh_token: 'RT' }));
    const auth = new GoogleAuth({
      ...base, vault: memVault(), fetch: fetchFn,
      openUrl: async (url) => {
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        setTimeout(() => void fetch(`${back}?code=evil&state=wrong`).then(() => fetch(`${back}?code=good&state=${u.searchParams.get('state')}`)), 5);
      },
    });
    expect(await auth.signIn()).toBe('AT');
  });

  it('reports a cancelled sign-in', async () => {
    const auth = new GoogleAuth({ ...base, vault: memVault(), openUrl: browser((u) => ({ error: 'access_denied', state: u.searchParams.get('state')! })) });
    await expect(auth.signIn()).rejects.toThrow('Google sign-in was cancelled.');
  });

  it('gives up when nobody finishes in the browser, and frees the port', async () => {
    const auth = new GoogleAuth({ ...base, vault: memVault(), timeoutMs: 80, openUrl: () => undefined });
    await expect(auth.signIn()).rejects.toThrow(/timed out/);
  });

  it('refuses politely when the build has no Google client configured', async () => {
    const auth = new GoogleAuth({ clientId: base.clientId, clientSecret: '', vault: memVault(), openUrl: () => undefined });
    await expect(auth.signIn()).rejects.toThrow(/isn’t set up/);
  });

  it('uses the saved sign-in silently and caches the access token', async () => {
    const { calls, fetchFn } = tokenServer(() => ({ access_token: 'FRESH', expires_in: 3600 }));
    let opened = 0;
    const auth = new GoogleAuth({ ...base, vault: memVault('RT'), fetch: fetchFn, openUrl: () => void opened++ });
    expect(await auth.accessToken()).toBe('FRESH');
    expect(await auth.accessToken()).toBe('FRESH');
    expect(calls).toHaveLength(1); // one refresh, then cached
    expect(calls[0].body.get('grant_type')).toBe('refresh_token');
    expect(calls[0].body.get('refresh_token')).toBe('RT');
    expect(opened).toBe(0);
  });

  it('drops a revoked sign-in and asks the user to connect again', async () => {
    const vault = memVault('RT');
    const { fetchFn } = tokenServer(() => ({ error: 'invalid_grant' }));
    const auth = new GoogleAuth({ ...base, vault, fetch: fetchFn, openUrl: () => undefined });
    await expect(auth.accessToken()).rejects.toThrow(/Connect Google Drive again/);
    expect(vault.value).toBeNull();
  });

  it('signs out: clears the saved token and asks Google to revoke it', async () => {
    const vault = memVault('RT');
    const { calls, fetchFn } = tokenServer(() => ({}));
    await new GoogleAuth({ ...base, vault, fetch: fetchFn, openUrl: () => undefined }).signOut();
    expect(vault.value).toBeNull();
    expect(calls[0].url).toContain('oauth2.googleapis.com/revoke?token=RT');
  });
});
