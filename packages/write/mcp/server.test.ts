import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../src/shared/memoryFs';
import { agentFromClient, createServer } from './server';
import { chooseRoot, resolveRoot, rootCandidates, settingsCandidates } from './root';

const BOOK = '# One\n\nShe walked slowly to the door.\n\n# Two\n\nThe river ran cold.\n';
let fs: MemoryFs;

beforeEach(() => {
  fs = new MemoryFs();
  fs.seed('/books/Novel/.mdedit/project.json', '{"status":"editing"}');
  fs.seed('/books/Novel/Book.md', BOOK);
});

async function connect(clientName: string, agent?: string) {
  const server = createServer({ fs, root: '/books', agent });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
  return { client, call };
}

describe('the MDEdit MCP server', () => {
  it('offers the tools, with read-only ones marked', async () => {
    const { client } = await connect('claude-ai');
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['add_notes', 'get_notes', 'list_chapters', 'list_files', 'list_projects', 'read_chapter', 'reply_to_note', 'search_text', 'set_chapters_edited', 'withdraw_note']);
    expect(tools.find((t) => t.name === 'read_chapter')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'add_notes')?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'set_chapters_edited')?.annotations?.readOnlyHint).toBe(false);
  });

  it('reads a chapter and adds a note, signed with the connecting AI’s name', async () => {
    const { call } = await connect('claude-ai');
    expect((await call('list_projects')).json()).toEqual([{ project: 'Novel', status: 'editing' }]);
    expect((await call('read_chapter', { project: 'Novel', file: 'Book.md', chapter: 1 })).json().text).toBe('Two\nThe river ran cold.');
    const added = await call('add_notes', { project: 'Novel', skill: 'line', notes: [{ file: 'Book.md', kind: 'suggestion', quote: 'river ran cold', replacement: 'river ran icy', category: 'word choice' }] });
    expect(added.json()[0]).toMatchObject({ ok: true, chapter: 1 });
    const notes = (await call('get_notes', { project: 'Novel' })).json();
    expect(notes).toMatchObject([{ kind: 'suggestion', reviewer: 'Claude · Line edit', replacement: 'river ran icy' }]);
    expect(await fs.readText('/books/Novel/Book.md')).toBe(BOOK);
  });

  it('marks chapters edited and unmarks them, and says what to fix when the request is wrong', async () => {
    const { call } = await connect('claude-ai');
    const set = await call('set_chapters_edited', { project: 'Novel', file: 'Book.md', edited: true, through: 0 });
    expect(set.json()).toMatchObject({ edited: true, changed: [{ index: 0, title: 'One' }] });
    expect((await call('list_chapters', { project: 'Novel', file: 'Book.md' })).json().chapters.map((c: { edited: boolean }) => c.edited)).toEqual([true, false]);
    await call('set_chapters_edited', { project: 'Novel', file: 'Book.md', edited: false, chapters: ['One'] });
    expect((await call('list_chapters', { project: 'Novel', file: 'Book.md' })).json().chapters.map((c: { edited: boolean }) => c.edited)).toEqual([false, false]);
    const bad = await call('set_chapters_edited', { project: 'Novel', file: 'Book.md', edited: true });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/either chapters/);
    expect(await fs.readText('/books/Novel/Book.md')).toBe(BOOK);
  });

  it('signs as just the AI when add_notes is called without a skill', async () => {
    const { call } = await connect('claude-ai');
    await call('add_notes', { project: 'Novel', notes: [{ file: 'Book.md', kind: 'comment', quote: 'slowly', body: 'Adverb.' }] });
    expect((await call('get_notes', { project: 'Novel' })).json()[0].reviewer).toBe('Claude');
  });

  it('GPT clients get the same tools and are named GPT', async () => {
    const { call } = await connect('openai-mcp');
    await call('add_notes', { project: 'Novel', skill: 'copy', notes: [{ file: 'Book.md', kind: 'comment', quote: 'slowly', body: 'Adverb.' }] });
    expect((await call('get_notes', { project: 'Novel' })).json()[0].reviewer).toBe('GPT · Copy edit');
  });

  it('turns mistakes into messages the model can act on, not crashes', async () => {
    const { call } = await connect('x');
    const bad = await call('read_chapter', { project: 'Nope', file: 'Book.md', chapter: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/list_projects/);
    const res = (await call('add_notes', { project: 'Novel', skill: 'line', notes: [{ file: 'Book.md', kind: 'comment', quote: 'absent', body: 'x' }] })).json();
    expect(res[0]).toMatchObject({ ok: false });
  });

  it('names the AI from the client, or the --agent flag', () => {
    expect(agentFromClient('Claude Desktop')).toEqual({ agent: 'claude', agentName: 'Claude' });
    expect(agentFromClient('codex-cli')).toEqual({ agent: 'gpt', agentName: 'GPT' });
    expect(agentFromClient('mystery')).toEqual({ agent: 'ai', agentName: 'AI' });
    expect(agentFromClient('claude', 'Gemini')).toEqual({ agent: 'Gemini', agentName: 'Gemini' });
  });
});

describe('finding the projects folder', () => {
  it('prefers --root, then MDEDIT_ROOT, then MDEdit’s own setting, then the default', async () => {
    const f = new MemoryFs();
    const home = '/home/me';
    const [first] = settingsCandidates({}, 'linux', home);
    f.seed(first, JSON.stringify({ projects: { rootFolder: '/data/books' } }));
    expect((await resolveRoot({ flag: '/x', env: {}, platform: 'linux', home, fs: f })).source).toBe('--root');
    expect((await resolveRoot({ env: { MDEDIT_ROOT: '/y' }, platform: 'linux', home, fs: f })).source).toBe('MDEDIT_ROOT');
    expect(await resolveRoot({ env: {}, platform: 'linux', home, fs: f })).toMatchObject({ root: '/data/books' });
    expect((await resolveRoot({ env: {}, platform: 'linux', home, fs: new MemoryFs() })).source).toBe('default');
    expect(settingsCandidates({ APPDATA: 'C:\\U\\AppData\\Roaming' }, 'win32', 'C:\\U')[0]).toMatch(/MDEdit[\\/]settings\.json$/);
  });
});

describe('when the projects folder is wrong', () => {
  const home = '/home/me';
  const seeded = () => {
    const f = new MemoryFs();
    f.seed(settingsCandidates({}, 'linux', home)[0], JSON.stringify({ projects: { rootFolder: '/data/books' } }));
    return f;
  };

  it('treats a blank or unfilled --root as not set', async () => {
    const f = seeded();
    for (const flag of ['', '  ', '${user_config.root_folder}']) {
      expect(await resolveRoot({ flag, env: {}, platform: 'linux', home, fs: f })).toMatchObject({ root: '/data/books' });
    }
  });

  it('lists each place once, in order', async () => {
    const c = await rootCandidates({ flag: '/data/books', env: { MDEDIT_ROOT: '/y' }, platform: 'linux', home, fs: seeded() });
    expect(c.map((x) => x.root)).toEqual(['/data/books', '/y', '/home/me/MDEdit']);
  });

  it('falls back to a later folder that has projects, and keeps the first when none do', async () => {
    const c = await rootCandidates({ flag: '/stale', env: {}, platform: 'linux', home, fs: seeded() });
    expect((await chooseRoot(c, async (r) => r === '/data/books')).root).toBe('/data/books');
    expect((await chooseRoot(c, async () => false)).root).toBe('/stale');
  });

  it('says where it looked when there are no projects', async () => {
    const f = new MemoryFs();
    const server = createServer({ fs: f, root: '/empty', tried: [{ root: '/empty', source: '--root' }, { root: '/home/me/MDEdit', source: 'default' }] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-ai', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
    const out = JSON.parse(r.content[0].text) as { projects: unknown[]; message: string };
    expect(out.projects).toEqual([]);
    expect(out.message).toMatch(/\/empty \(--root\); \/home\/me\/MDEdit \(default\)/);
    expect(out.message).toMatch(/Open Folder/);
  });
});
