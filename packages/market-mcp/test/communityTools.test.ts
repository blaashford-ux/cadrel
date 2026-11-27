import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, addCommunitySource } from '@cadrel/market-library';
import { createServer } from '../src/server.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-sync-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fake archive: every subreddit has one thread a day; `gate` holds requests until released. */
function archive(o: { gate?: Promise<void>; seen?: string[] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const sub = u.searchParams.get('subreddit') ?? '';
    if (o.gate) await Promise.race([o.gate, new Promise((r) => init?.signal?.addEventListener('abort', r))]);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (u.pathname.endsWith('/posts/search') && u.searchParams.get('limit') === '1') return new Response(JSON.stringify({ data: [{ id: 'x', created_utc: now }] }), { status: 200 });
    if (u.pathname.endsWith('/posts/search')) {
      o.seen?.push(sub);
      const after = Number(u.searchParams.get('after') ?? now - 3600);
      return new Response(JSON.stringify({ data: [{ id: `${sub}${after}`.slice(0, 12), title: `Looking for books ${sub}`, selftext: 'found family please', created_utc: after + 60, score: 3, link_flair_text: null, author: 'a' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function connect(fetchImpl: typeof fetch) {
  const server = createServer({ lib, embedderFor: async () => null, arcticShift: { fetch: fetchImpl, delayMs: 0, sleep: async () => {} } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-cowork', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    let json: any; try { json = JSON.parse(r.content[0]!.text); } catch { /* error text */ }
    return { isError: !!r.isError, text: r.content[0]!.text, json };
  };
  return { call, client };
}

describe('community sync tools', () => {
  it('are listed with honest annotations', async () => {
    const { client } = await connect(archive());
    const t = Object.fromEntries((await client.listTools()).tools.map((x) => [x.name, x]));
    expect(t.start_community_sync!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(t.community_sync_status!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(t.stop_community_sync).toBeTruthy();
  });

  it('scans one subreddit, and wait_seconds returns when it has finished', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy');
    addCommunitySource(lib.db, root, KEY, 'fantasy');
    const seen: string[] = [];
    const { call } = await connect(archive({ seen }));
    const s = await call('start_community_sync', { category: KEY, subreddit: 'r/CozyFantasy' });
    expect(s.json).toMatchObject({ started: true, mode: 'subreddit', finished: false });
    expect(s.json.order.map((i: any) => i.subreddit)).toEqual(['cozyfantasy']);
    const done = await call('community_sync_status', { job_id: s.json.job_id, wait_seconds: 30 });
    expect(done.json).toMatchObject({ finished: true, state: 'finished', totals: { failed: 0 } });
    expect(done.json.order[0]).toMatchObject({ subreddit: 'cozyfantasy', state: 'done' });
    expect(done.json.totals.new_threads).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['cozyfantasy']));
    const src = await call('community_sources', { category: KEY });
    expect(src.json.sources.find((x: any) => x.subreddit === 'cozyfantasy').last_synced).not.toBeNull();
  });

  it('Sync All runs the given category order once per subreddit, and refuses a second job while one runs', async () => {
    const other = 'amazon.com:kindle:999';
    lib.db.prepare("INSERT INTO category (key, marketplace, store, node_id, name) VALUES (?, 'amazon.com', 'kindle', '999', 'LitRPG')").run(other);
    lib.db.prepare("INSERT INTO list_capture (category_key, list_kind, page, captured_at, dir, listed_count, rendered_count) VALUES (?, 'bestsellers', 1, '2026-10-18T12:00:00Z', 'x', 0, 0)").run(other);
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy', '2026-10-01T00:00:00Z');
    addCommunitySource(lib.db, root, other, 'litrpg', '2026-10-01T00:00:00Z');
    addCommunitySource(lib.db, root, other, 'cozyfantasy', '2026-10-02T00:00:00Z'); // shared: read once
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { call } = await connect(archive({ gate }));
    const s = await call('start_community_sync', { all: true, order: [other, KEY] });
    expect(s.json.mode).toBe('all');
    expect(s.json.order.map((i: any) => [i.category, i.subreddit])).toEqual([[other, 'litrpg'], [other, 'cozyfantasy']]);
    expect((await call('start_community_sync', { all: true })).isError).toBe(true);
    // the wait times out while the archive is held, and says it is still running
    const still = await call('community_sync_status', { wait_seconds: 1 });
    expect(still.json).toMatchObject({ finished: false, state: 'running' });
    release();
    const done = await call('community_sync_status', { job_id: s.json.job_id, wait_seconds: 30 });
    expect(done.json.finished).toBe(true);
    expect(done.json.order.map((i: any) => i.state)).toEqual(['done', 'done']);
  });

  it('stop ends the job, leaves the rest unscanned, and rejects bad arguments', async () => {
    addCommunitySource(lib.db, root, KEY, 'cozyfantasy', '2026-10-01T00:00:00Z');
    addCommunitySource(lib.db, root, KEY, 'fantasy', '2026-10-02T00:00:00Z');
    const gate = new Promise<void>(() => {});
    const { call } = await connect(archive({ gate }));
    const s = await call('start_community_sync', { category: KEY });
    expect((await call('stop_community_sync')).json.stopping).toBe(true);
    const done = await call('community_sync_status', { job_id: s.json.job_id, wait_seconds: 30 });
    expect(done.json).toMatchObject({ finished: true, state: 'stopped' });
    expect(done.json.order.map((i: any) => i.state)).toEqual(['stopped', 'stopped']);
    expect((await call('stop_community_sync')).isError).toBe(true);
    expect((await call('start_community_sync', {})).isError).toBe(true);
    expect((await call('start_community_sync', { category: KEY, all: true })).isError).toBe(true);
    expect((await call('start_community_sync', { category: 'nonexistent' })).isError).toBe(true);
    expect((await call('community_sync_status', { job_id: 'nope' })).isError).toBe(true);
  });
});
