import { randomBytes } from 'node:crypto';
import type { AiRemoteStatus } from '../src/shared/agent/config';
import type { FsPort } from '../src/shared/fsPort';
import { startHttp } from '../mcp/http';

export const DEFAULT_REMOTE_PORT = 47831;

interface Saved {
  enabled: boolean;
  port: number;
  token: string;
}

/**
 * The optional online door to the AI tools: off until the user turns it on, listening on this PC only, behind a token that
 * is made here and kept in the app's data folder. The user decides whether to make it reachable from the internet.
 */
export class AiRemote {
  private saved: Saved = { enabled: false, port: DEFAULT_REMOTE_PORT, token: '' };
  private http: Awaited<ReturnType<typeof startHttp>> | null = null;
  private error: string | null = null;

  constructor(private o: { file: string; fs: FsPort; root(): string; version?: string; port?: number }) {
    this.saved.port = o.port ?? DEFAULT_REMOTE_PORT;
  }

  private newToken = () => randomBytes(24).toString('base64url');

  /** Reads the saved choice, and starts listening if it was left on. */
  async load(): Promise<void> {
    try {
      const d = JSON.parse(await this.o.fs.readText(this.o.file)) as Partial<Saved>;
      if (typeof d.token === 'string' && d.token.length >= 16) this.saved.token = d.token;
      if (typeof d.enabled === 'boolean') this.saved.enabled = d.enabled;
      if (typeof d.port === 'number' && d.port >= 0 && d.port < 65536 && this.o.port === undefined) this.saved.port = d.port;
    } catch {
      /* first run, or unreadable: start from the defaults */
    }
    if (!this.saved.token) this.saved.token = this.newToken();
    if (this.saved.enabled) await this.start();
  }

  private async save(): Promise<void> {
    await this.o.fs.writeText(this.o.file, JSON.stringify(this.saved, null, 2));
  }

  private async start(): Promise<void> {
    await this.stop();
    this.error = null;
    if (!this.saved.token) this.saved.token = this.newToken();
    try {
      this.http = await startHttp({ fs: this.o.fs, root: this.o.root(), token: this.saved.token, port: this.saved.port, version: this.o.version });
    } catch (e) {
      const code = (e as { code?: string }).code;
      this.error = code === 'EADDRINUSE' ? `Port ${this.saved.port} is already in use by another program.` : e instanceof Error ? e.message : String(e);
    }
  }

  async stop(): Promise<void> {
    const h = this.http;
    this.http = null;
    if (h) await h.close();
  }

  status(): AiRemoteStatus {
    const port = this.http?.port ?? this.saved.port;
    const base = `http://127.0.0.1:${port}`;
    return { enabled: this.saved.enabled, running: !!this.http, port, token: this.saved.token, mcpUrl: `${base}/mcp`, apiUrl: `${base}/api`, openApiUrl: `${base}/openapi.json`, error: this.error };
  }

  async setEnabled(enabled: boolean): Promise<AiRemoteStatus> {
    this.saved.enabled = enabled;
    await this.save();
    if (enabled) await this.start();
    else {
      await this.stop();
      this.error = null;
    }
    return this.status();
  }

  /** A new token locks out whatever used the old one. */
  async resetToken(): Promise<AiRemoteStatus> {
    this.saved.token = this.newToken();
    await this.save();
    if (this.saved.enabled) await this.start();
    return this.status();
  }
}
