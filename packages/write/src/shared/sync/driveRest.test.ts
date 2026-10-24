import { describe, expect, it } from 'vitest';
import { createDriveRest, DriveError } from './driveRest';

interface Seen { url: string; init: RequestInit }

/** A scripted fetch: each call takes the next response and is recorded. */
function script(responses: (Response | (() => Response))[]) {
  const seen: Seen[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tokens = () => {
  const asked: boolean[] = [];
  return { asked, getToken: async (force?: boolean) => (asked.push(!!force), force ? 'fresh' : 'stale') };
};
const noSleep = async () => undefined;

describe('Drive REST client', () => {
  it('lists every page and maps files, folders, parents and checksums', async () => {
    const { seen, fetchFn } = script([
      ok({ files: [{ id: 'f1', name: 'MDEdit', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-10-05T10:00:00.000Z' }], nextPageToken: 'p2' }),
      ok({ files: [{ id: 'f2', name: 'a.md', mimeType: 'text/plain', parents: ['f1'], md5Checksum: 'abc', modifiedTime: '2026-10-05T11:00:00.000Z' }] }),
    ]);
    const { getToken } = tokens();
    const files = await createDriveRest({ getToken, fetch: fetchFn, sleep: noSleep }).listAll();
    expect(files).toEqual([
      { id: 'f1', name: 'MDEdit', parentId: null, isFolder: true, md5: null, modifiedMs: Date.parse('2026-10-05T10:00:00.000Z') },
      { id: 'f2', name: 'a.md', parentId: 'f1', isFolder: false, md5: 'abc', modifiedMs: Date.parse('2026-10-05T11:00:00.000Z') },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toContain('q=trashed+%3D+false');
    expect(seen[1].url).toContain('pageToken=p2');
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer stale');
  });

  it('retries once with a fresh token after a 401', async () => {
    const { seen, fetchFn } = script([new Response('', { status: 401 }), ok({ files: [] })]);
    const t = tokens();
    await createDriveRest({ getToken: t.getToken, fetch: fetchFn, sleep: noSleep }).listAll();
    expect(t.asked).toEqual([false, true]);
    expect((seen[1].init.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it('backs off and retries rate limits and server errors, then gives up with a DriveError', async () => {
    const sleeps: number[] = [];
    const { seen, fetchFn } = script([new Response('slow down', { status: 429 }), new Response('oops', { status: 503 }), ok({ files: [] })]);
    await createDriveRest({ getToken: tokens().getToken, fetch: fetchFn, sleep: async (ms) => void sleeps.push(ms) }).listAll();
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);

    const dead = script([new Response('nope', { status: 500 })]);
    await expect(createDriveRest({ getToken: tokens().getToken, fetch: dead.fetchFn, sleep: noSleep }).listAll()).rejects.toMatchObject({ name: 'DriveError', status: 500 });
  });

  it('does not retry a plain 404', async () => {
    const { seen, fetchFn } = script([new Response('missing', { status: 404 })]);
    await expect(createDriveRest({ getToken: tokens().getToken, fetch: fetchFn, sleep: noSleep }).download('x')).rejects.toBeInstanceOf(DriveError);
    expect(seen).toHaveLength(1);
  });

  it('creates a folder, with or without a parent', async () => {
    const { seen, fetchFn } = script([ok({ id: 'n1', name: 'MDEdit', mimeType: 'application/vnd.google-apps.folder' }), ok({ id: 'n2', name: 'Novel', mimeType: 'application/vnd.google-apps.folder' })]);
    const drive = createDriveRest({ getToken: tokens().getToken, fetch: fetchFn, sleep: noSleep });
    expect((await drive.createFolder('MDEdit', null)).isFolder).toBe(true);
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ name: 'MDEdit', mimeType: 'application/vnd.google-apps.folder' });
    await drive.createFolder('Novel', 'root1');
    expect(JSON.parse(String(seen[1].init.body)).parents).toEqual(['root1']);
  });

  it('uploads a new file as multipart with the content untouched (CRLFs, accents, markdown)', async () => {
    const { seen, fetchFn } = script([ok({ id: 'n2', name: 'Ch 1.md', parents: ['p'], md5Checksum: 'x' })]);
    const content = '# Ünï\r\ncode ```\r\n\r\n';
    await createDriveRest({ getToken: tokens().getToken, fetch: fetchFn, sleep: noSleep }).createFile('Ch 1.md', 'p', content);
    const init = seen[0].init;
    const type = (init.headers as Record<string, string>)['Content-Type'];
    const boundary = type.split('boundary=')[1];
    expect(seen[0].url).toContain('uploadType=multipart');
    const body = String(init.body);
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body).toContain(JSON.stringify({ name: 'Ch 1.md', parents: ['p'] }));
    expect(body.endsWith(`\r\n\r\n${content}\r\n--${boundary}--`)).toBe(true);
  });

  it('overwrites a file’s content, downloads it, renames/moves it and trashes it', async () => {
    const { seen, fetchFn } = script([
      ok({ id: 'f', name: 'a.md', md5Checksum: 'm' }),
      new Response('the text', { status: 200 }),
      ok({ id: 'f', name: 'b.md' }),
      ok({ id: 'f' }),
    ]);
    const drive = createDriveRest({ getToken: tokens().getToken, fetch: fetchFn, sleep: noSleep });
    await drive.updateFile('f', 'new text');
    expect(seen[0].url).toContain('/upload/drive/v3/files/f?uploadType=media');
    expect(seen[0].init.method).toBe('PATCH');
    expect(seen[0].init.body).toBe('new text');
    expect(await drive.download('f')).toBe('the text');
    expect(seen[1].url).toContain('/drive/v3/files/f?alt=media');
    await drive.rename('f', 'b.md', { from: 'old', to: 'new' });
    expect(seen[2].url).toContain('addParents=new');
    expect(seen[2].url).toContain('removeParents=old');
    expect(JSON.parse(String(seen[2].init.body))).toEqual({ name: 'b.md' });
    await drive.trash('f');
    expect(JSON.parse(String(seen[3].init.body))).toEqual({ trashed: true });
  });

  it('shares a read-only file so viewers can download it, and a writable file without letting writers re-share it', async () => {
    const patchBody = (seen: Seen[]) => JSON.parse(String(seen.find((x) => x.init.method === 'PATCH')!.init.body));
    const reader = script([ok({ id: 'f' }), ok({ permissions: [] }), ok({ id: 'p' })]);
    await createDriveRest({ getToken: tokens().getToken, fetch: reader.fetchFn, sleep: noSleep }).shareByLink('f', 'reader');
    expect(patchBody(reader.seen)).toEqual({ writersCanShare: false, copyRequiresWriterPermission: false }); // downloading must stay possible
    const writer = script([ok({ id: 'f' }), ok({ permissions: [] }), ok({ id: 'p' })]);
    await createDriveRest({ getToken: tokens().getToken, fetch: writer.fetchFn, sleep: noSleep }).shareByLink('f', 'writer');
    expect(patchBody(writer.seen)).toEqual({ writersCanShare: false, copyRequiresWriterPermission: true });
  });
});
