import { afterEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../src/shared/memoryFs';
import { AiRemote } from './aiRemote';

const FILE = '/data/ai-remote.json';
let fs: MemoryFs;
let remote: AiRemote | undefined;
const make = () => (remote = new AiRemote({ file: FILE, fs, root: () => '/books', port: 0 }));
afterEach(async () => remote?.stop());

const call = async (r: AiRemote, token?: string) => (await fetch(r.status().apiUrl + '/projects', { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;

describe('online access for AI apps', () => {
  it('is off until it is turned on, and makes a token of its own', async () => {
    fs = new MemoryFs();
    fs.seed('/data/keep', '');
    fs.seed('/books/Novel/.mdedit/project.json', '{}');
    const r = make();
    await r.load();
    expect(r.status()).toMatchObject({ enabled: false, running: false, error: null });
    expect(r.status().token.length).toBeGreaterThanOrEqual(32);
  });

  it('listens only while on, only answers with the token, and remembers the choice', async () => {
    fs = new MemoryFs();
    fs.seed('/data/keep', '');
    fs.seed('/books/Novel/.mdedit/project.json', '{}');
    const r = make();
    await r.load();
    const on = await r.setEnabled(true);
    expect(on).toMatchObject({ enabled: true, running: true });
    expect(on.port).toBeGreaterThan(0);
    expect(await call(r)).toBe(401);
    expect(await call(r, on.token)).toBe(200);

    await r.stop();
    const again = make(); // an app restart: it was left on, so it comes back on with the same token
    await again.load();
    expect(again.status()).toMatchObject({ enabled: true, running: true, token: on.token });

    const off = await again.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, running: false });
    await expect(fetch(on.apiUrl + '/projects', { headers: { authorization: `Bearer ${on.token}` } })).rejects.toThrow();
  });

  it('a new token locks out the old one', async () => {
    fs = new MemoryFs();
    fs.seed('/data/keep', '');
    fs.seed('/books/Novel/.mdedit/project.json', '{}');
    const r = make();
    await r.load();
    const first = await r.setEnabled(true);
    const second = await r.resetToken();
    expect(second.token).not.toBe(first.token);
    expect(await call(r, first.token)).toBe(401);
    expect(await call(r, second.token)).toBe(200);
  });

  it('says so when the port is taken', async () => {
    fs = new MemoryFs();
    fs.seed('/data/keep', '');
    const a = make();
    await a.load();
    const running = await a.setEnabled(true);
    const b = new AiRemote({ file: '/data/other.json', fs, root: () => '/books', port: running.port });
    const blocked = await b.setEnabled(true);
    expect(blocked.running).toBe(false);
    expect(blocked.error).toMatch(/already in use/);
    await b.stop();
  });
});
