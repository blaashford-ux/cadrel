import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Read the pairing token, creating it (owner-only) on first use. */
export function loadOrCreateToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  return rotateToken(file);
}

/** Replace the token; the extension must be re-paired afterwards. */
export function rotateToken(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = newToken();
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

export function tokensEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
