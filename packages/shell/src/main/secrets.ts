/**
 * Things that must not sit on disk in the clear: a person's private key for a Studio, and (if they chose to keep it) their Cloudflare
 * token. Each is one small file in the Studio's own data folder, encrypted by the operating system's store (Electron's safeStorage:
 * DPAPI on Windows). If that store is not available the secret is not kept at all, except under test, which uses a marked plain file.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export class SecretsError extends Error {}

export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

const ENCRYPTED = 0x01;
const PLAIN_FOR_TESTS = 0x00;

export class Secrets {
  constructor(private readonly dir: string, private readonly cipher: Cipher, private readonly allowPlain = false) {}

  private file(name: string): string {
    if (!/^[\w.-]+$/.test(name)) throw new SecretsError('That is not a name a secret can have.');
    return path.join(this.dir, `${name}.bin`);
  }

  async put(name: string, value: string): Promise<void> {
    const file = this.file(name);
    let body: Buffer;
    if (this.cipher.available()) body = Buffer.concat([Buffer.from([ENCRYPTED]), this.cipher.encrypt(value)]);
    else if (this.allowPlain) body = Buffer.concat([Buffer.from([PLAIN_FOR_TESTS]), Buffer.from(value, 'utf8')]);
    else throw new SecretsError('This computer has no secure place to keep a secret, so it is not kept.');
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async get(name: string): Promise<string | null> {
    let data: Buffer;
    try {
      data = await fsp.readFile(this.file(name));
    } catch {
      return null;
    }
    if (data[0] === ENCRYPTED) {
      try {
        return this.cipher.decrypt(data.subarray(1));
      } catch {
        return null; // made by another user or another computer: it cannot be read here
      }
    }
    return data[0] === PLAIN_FOR_TESTS && this.allowPlain ? data.subarray(1).toString('utf8') : null;
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  async delete(name: string): Promise<void> {
    await fsp.rm(this.file(name), { force: true });
  }
}
