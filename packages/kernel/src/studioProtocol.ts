/// <reference lib="dom" />
/**
 * How the app and a Studio's server know each other, with nothing but public-key signatures: no passwords, no email, no Cloudflare
 * credentials for anyone but the owner. Used by both sides (the desktop app and the Worker), so it relies only on Web Crypto, which
 * Node, Electron and Workers all have.
 *
 *  - The owner's key pair is made when the Studio is built; the Worker is given the public half and nothing else can administer it.
 *  - A member's key pair is made on their own computer when they accept an invitation; the Worker records the public half.
 *  - Every request after that carries the key, a timestamp and a signature over the method, the path, the timestamp and the body.
 *  - A person is recognised by a fingerprint of the owner's key, carried in the invitation, so the app only joins the Studio it was told about.
 */

/** Changes when the requests or answers change in a way an older app could not follow. */
export const STUDIO_API_VERSION = 1;
/** Changes when the Studio's database changes. Only ever added to: an older app must keep working on a newer database. */
export const STUDIO_SCHEMA_VERSION = 6;

export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const enc = new TextEncoder();

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array {
  const pad = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const hex = (bytes: ArrayBuffer | Uint8Array): string => [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export interface KeyPair {
  /** The raw public key, base64url. Safe to share. */
  publicKey: string;
  /** The private key (PKCS #8), base64url. Never leaves the computer that made it. */
  privateKey: string;
}

// Workers' older runtimes name the algorithm NODE-ED25519; everything current says Ed25519.
const ALGOS: (AlgorithmIdentifier | { name: string; namedCurve: string })[] = [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }];

async function importKey(format: 'raw' | 'pkcs8', data: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  let last: unknown;
  for (const a of ALGOS) {
    try {
      return await crypto.subtle.importKey(format, data as BufferSource, a as never, false, [usage]);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export async function generateKeyPair(): Promise<KeyPair> {
  let last: unknown;
  for (const a of ALGOS) {
    try {
      const k = (await crypto.subtle.generateKey(a as never, true, ['sign', 'verify'])) as CryptoKeyPair;
      return { publicKey: b64u(await crypto.subtle.exportKey('raw', k.publicKey)), privateKey: b64u(await crypto.subtle.exportKey('pkcs8', k.privateKey)) };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** What a person compares by eye or by link: the first 8 bytes of the SHA-256 of the raw public key, as XXXX-XXXX-XXXX-XXXX. */
export async function fingerprint(publicKey: string): Promise<string> {
  return (hex((await sha256(fromB64u(publicKey))).slice(0, 8)).toUpperCase().match(/.{4}/g) ?? []).join('-');
}

/** The exact text that is signed. A change to any part of the request changes it. */
export async function signedText(method: string, path: string, ts: string, body: string): Promise<string> {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${hex(await sha256(body))}`;
}

export type SignedHeaders = { 'x-cadrel-key': string; 'x-cadrel-ts': string; 'x-cadrel-sig': string };

export async function signRequest(o: { method: string; path: string; body?: string; key: KeyPair; now?: number }): Promise<SignedHeaders> {
  const ts = String(o.now ?? Date.now());
  const text = await signedText(o.method, o.path, ts, o.body ?? '');
  const k = await importKey('pkcs8', fromB64u(o.key.privateKey), 'sign');
  const sig = await crypto.subtle.sign(k.algorithm as never, k, enc.encode(text));
  return { 'x-cadrel-key': o.key.publicKey, 'x-cadrel-ts': ts, 'x-cadrel-sig': b64u(sig) };
}

export type Verified = { ok: true; publicKey: string; signature: string } | { ok: false; reason: string };

/** Checks a request's signature and that it is recent. Who the key belongs to is the caller's business. */
export async function verifyRequest(o: { method: string; path: string; body: string; headers: (name: string) => string | null; now?: number }): Promise<Verified> {
  const key = o.headers('x-cadrel-key');
  const ts = o.headers('x-cadrel-ts');
  const sig = o.headers('x-cadrel-sig');
  if (!key || !ts || !sig) return { ok: false, reason: 'unsigned' };
  const at = Number(ts);
  if (!Number.isFinite(at) || Math.abs((o.now ?? Date.now()) - at) > SIGNATURE_WINDOW_MS) return { ok: false, reason: 'stale' };
  try {
    const raw = fromB64u(key);
    if (raw.length !== 32) return { ok: false, reason: 'bad key' };
    const text = await signedText(o.method, o.path, ts, o.body);
    const k = await importKey('raw', raw, 'verify');
    const good = await crypto.subtle.verify(k.algorithm as never, k, fromB64u(sig) as BufferSource, enc.encode(text));
    return good ? { ok: true, publicKey: key, signature: sig } : { ok: false, reason: 'bad signature' };
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
}

/** An invitation as a link a person can paste: where the Studio is, the one-time code, and the fingerprint of its owner. */
export interface Invitation {
  url: string;
  code: string;
  fingerprint: string;
  /** What the owner calls the Studio: a suggestion for what to call it on the joiner's computer. */
  studioName?: string;
}

export function invitationLink(i: Invitation): string {
  return `cadrel://join?s=${encodeURIComponent(i.url)}&c=${encodeURIComponent(i.code)}&f=${encodeURIComponent(i.fingerprint)}${i.studioName ? `&n=${encodeURIComponent(i.studioName)}` : ''}`;
}

export function parseInvitation(text: string): Invitation | null {
  const m = /^cadrel:\/\/join\?(.+)$/i.exec(text.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const url = q.get('s') ?? '';
  const code = q.get('c') ?? '';
  const fp = q.get('f') ?? '';
  if (!/^(https:\/\/[A-Za-z0-9.-]+|http:\/\/(127\.0\.0\.1|localhost))(:\d+)?(\/.*)?$/.test(url) || !/^[A-Za-z0-9_-]{16,64}$/.test(code) || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(fp)) return null;
  const name = (q.get('n') ?? '').trim().slice(0, 60);
  return { url: url.replace(/\/+$/, ''), code, fingerprint: fp, ...(name ? { studioName: name } : {}) };
}
