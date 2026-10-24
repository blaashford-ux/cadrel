/** The real Google Drive v3 REST client behind `DriveApi`. Only `fetch` and an access-token provider are needed. */
import type { DriveApi, DriveFile } from './drive';

export class DriveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveRestOptions {
  /** A valid access token for the `drive.file` scope; `forceRefresh` asks for a fresh one after a 401. */
  getToken(forceRefresh?: boolean): Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,mimeType,parents,md5Checksum,modifiedTime';
const FOLDER = 'application/vnd.google-apps.folder';

interface RawFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  md5Checksum?: string;
  modifiedTime?: string;
}

const toFile = (f: RawFile): DriveFile => ({
  id: f.id,
  name: f.name,
  parentId: f.parents?.[0] ?? null,
  isFolder: f.mimeType === FOLDER,
  md5: f.md5Checksum ?? null,
  modifiedMs: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
});

export function createDriveRest(o: DriveRestOptions): DriveApi {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** One request with a bearer token; a 401 gets one fresh token, rate limits and server errors a few backed-off retries. */
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await o.getToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await o.getToken(true);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(await res.clone().text().catch(() => '')));
      if (retryable && attempt < 4) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new DriveError(`Drive ${res.status}: ${body.slice(0, 200) || res.statusText}`, res.status);
    }
  }

  const json = async (url: string, init?: RequestInit): Promise<RawFile> => (await call(url, init)).json();
  const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });

  return {
    async listAll() {
      const out: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q: 'trashed = false', pageSize: '1000', fields: `nextPageToken,files(${FIELDS})`, spaces: 'drive' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = (await (await call(`${FILES}?${params}`)).json()) as { files?: RawFile[]; nextPageToken?: string };
        out.push(...(page.files ?? []).map(toFile));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    async createFolder(name, parentId) {
      return toFile(await json(`${FILES}?fields=${FIELDS}`, jsonInit('POST', { name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) })));
    },

    async createFile(name, parentId, content) {
      const boundary = `mdedit${Math.random().toString(36).slice(2)}${Date.now()}`;
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId] })}\r\n` +
        `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      return toFile(await json(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }));
    },

    async updateFile(id, content) {
      return toFile(await json(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: content }));
    },

    async download(id) {
      return (await call(`${FILES}/${encodeURIComponent(id)}?alt=media`)).text();
    },

    async rename(id, name, move) {
      const params = new URLSearchParams({ fields: FIELDS });
      if (move) {
        params.set('addParents', move.to);
        if (move.from) params.set('removeParents', move.from);
      }
      return toFile(await json(`${FILES}/${encodeURIComponent(id)}?${params}`, jsonInit('PATCH', { name })));
    },

    async getFile(id) {
      try {
        return toFile(await json(`${FILES}/${encodeURIComponent(id)}?fields=${FIELDS}`));
      } catch (e) {
        if (e instanceof DriveError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }
    },

    async shareByLink(id, role) {
      const base = `${FILES}/${encodeURIComponent(id)}`;
      // Writers must not be able to hand the file on (or change who has access). "Copying requires writer permission" also
      // stops viewers downloading ("This file cannot be downloaded by the user"), so it is only set for a file people write to:
      // a read-only link has to stay downloadable, and is switched back on for files that were shared before this was understood.
      await call(`${base}?fields=id`, jsonInit('PATCH', { writersCanShare: false, copyRequiresWriterPermission: role === 'writer' }));
      const perms = (await (await call(`${base}/permissions?fields=permissions(id,type,role)`)).json()) as { permissions?: { id: string; type: string; role: string }[] };
      const anyone = perms.permissions?.find((p) => p.type === 'anyone');
      if (anyone) {
        if (anyone.role !== role) await call(`${base}/permissions/${encodeURIComponent(anyone.id)}?fields=id`, jsonInit('PATCH', { role }));
        return;
      }
      await call(`${base}/permissions?fields=id`, jsonInit('POST', { type: 'anyone', role, allowFileDiscovery: false }));
    },

    async unshare(id) {
      const base = `${FILES}/${encodeURIComponent(id)}`;
      const perms = (await (await call(`${base}/permissions?fields=permissions(id,type)`)).json()) as { permissions?: { id: string; type: string }[] };
      for (const p of perms.permissions ?? []) if (p.type === 'anyone') await call(`${base}/permissions/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    },

    async trash(id) {
      await call(`${FILES}/${encodeURIComponent(id)}?fields=id`, jsonInit('PATCH', { trashed: true }));
    },
  };
}
