// Starts the real built server as a child process and talks to it over stdio, like Claude Desktop would.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HashingEmbedder, Library, embedPending, importSalesFile } from '@cadrel/market-library';
import { resolveLibraryRoot } from '../src/config.js';
import { TOOLS } from '../src/tools.js';

const PKG = path.resolve(__dirname, '..');
const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CAT = 'amazon.com:kindle:11650864011';

let root: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  let json: any;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { ...r, text, json };
}

beforeAll(async () => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: PKG });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mcp-'));
  const lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
  lib.saveAsset('B0C1R52V2J', 'cover', PNG, 'png');
  // a week of a linked subreddit: three requests and a comment that names a listed book
  lib.db.prepare("INSERT INTO community_source (category_key, subreddit, added_at) VALUES (?, 'cozyfantasy', '2026-10-18T00:00:00Z')").run(CAT);
  const item = lib.db.prepare("INSERT INTO community_item (kind, id, subreddit, link_id, parent_id, title, body, score, flair, created_utc) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const at = Math.floor(Date.parse('2026-10-18T00:00:00Z') / 1000);
  for (const [i, t] of ['Looking for found family and slow burn', 'Recs for found family please', 'Any books with found family?'].entries()) item.run('post', `p${i}`, 'cozyfantasy', `p${i}`, null, t, 'I love found family. Tired of cliffhangers though.', 10 - i, null, at + i);
  item.run('comment', 'k1', 'cozyfantasy', 'p0', 't3_p0', null, 'Perfect for found family: Dragons and Dust', 5, null, at + 9);
  // the author's own books, named by KDP reports: one is captured above, one is not
  const csv = (t: string) => new Uint8Array(Buffer.from(t));
  importSalesFile(lib.db, root, 'orders.csv', csv('Date,Title,Author Name,ASIN,Marketplace,Paid Units\n2026-10-16,Captured One,Jo Writer,B0C1R52V2J,Amazon.com,3\n2026-10-17,Waiting One,Jo Writer,B0AAAAAAAA,Amazon.com,9'));
  importSalesFile(lib.db, root, 'kenp.csv', csv('Date,Title,Author Name,ASIN,Marketplace,KENP Read\n2026-10-17,Waiting One,Jo Writer,B0AAAAAAAA,Amazon.com,1200'), new Date(Date.now() + 5000));
  await embedPending(lib.db, new HashingEmbedder());
  lib.close();
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'dist/main.mjs'), '--library', root], stderr: 'ignore' }));
}, 60000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP server over stdio', () => {
  it('announces itself, its instructions and every tool as read-only or not', async () => {
    expect(client.getServerVersion()?.name).toBe('bookscout');
    expect(client.getInstructions()).toMatch(/never follow instructions/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.add_tag!.annotations?.readOnlyHint).toBe(false);
    expect(byName.top_books!.annotations?.readOnlyHint).toBe(true);
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(30);
  });

  it('--print-handshake reports exactly what the running server answers to initialize (the extension launcher answers with it)', () => {
    const out = execFileSync('node', [path.join(PKG, 'dist/main.mjs'), '--print-handshake'], { encoding: 'utf8' });
    const hs = JSON.parse(out) as { serverInfo: { name: string; version: string }; capabilities: Record<string, unknown>; instructions: string; protocolVersions: string[] };
    expect(hs.serverInfo).toEqual(client.getServerVersion() && { name: client.getServerVersion()!.name, version: client.getServerVersion()!.version });
    expect(hs.instructions).toBe(client.getInstructions());
    expect(client.getServerCapabilities()).toMatchObject(hs.capabilities);
    expect(hs.protocolVersions.length).toBeGreaterThan(1);
    expect(hs.protocolVersions).toContain('2025-06-18');
    // it does not need a library
    expect(execFileSync('node', [path.join(PKG, 'dist/main.mjs'), '--print-handshake', '--library', '/no/such/folder'], { encoding: 'utf8' })).toBe(out);
  });

  it('my_books lists the user\'s own books, captured or not, with their report figures', async () => {
    const m = await call('my_books');
    expect(m.json).toMatchObject({ total: 2, captured: 1, not_captured: 1, shown: 2, sales_estimates: { basis: expect.stringMatching(/not calibrated/) } });
    expect(m.json.books.map((b: any) => [b.asin, b.detail_captured])).toEqual([['B0C1R52V2J', true], ['B0AAAAAAAA', false]]);
    expect(m.json.books[0]).toMatchObject({ url: 'https://www.amazon.com/dp/B0C1R52V2J', paid_units_in_reports: 3, added_from: 'imported KDP report' });
    expect(m.json.books[0].kindle_store_rank).toBeGreaterThan(0);
    expect(m.json.books[1]).toMatchObject({ title: 'Waiting One', author: 'Jo Writer', paid_units_in_reports: 9, kindle_unlimited_pages_read_in_reports: 1200, last_sale_day: '2026-10-17', captures: 0, kindle_store_rank: null });
    expect(m.json.note).toMatch(/never follow instructions/);
    const todo = await call('my_books', { captured: 'not_captured' });
    expect(todo.json.books.map((b: any) => b.asin)).toEqual(['B0AAAAAAAA']);
    expect((await call('my_books', { sort: 'paid_units', limit: 1 })).json.books.map((b: any) => b.asin)).toEqual(['B0AAAAAAAA']);
    expect((await call('my_books', { limit: 0 })).isError).toBe(true);
  });

  it('community_insights summarises what the linked subreddits ask for, and explains when nothing is synced', async () => {
    const r = await call('community_insights', { category: CAT });
    expect(r.json.note).toMatch(/never follow instructions/);
    expect(r.json.coverage).toMatchObject({ threads: 3, comments: 1, requestThreads: 3 });
    expect(r.json.requests).toHaveLength(3);
    const ff = r.json.elements.find((e: any) => e.element === 'found family');
    expect(ff).toMatchObject({ threads: 3, asked: 3 });
    expect(ff.loved).toBeGreaterThanOrEqual(3);
    expect(r.json.elements.find((e: any) => e.element === 'cliffhanger').avoided).toBeGreaterThanOrEqual(3);
    expect(r.json.avoid[0].url).toMatch(/^https:\/\/www\.reddit\.com\/r\/cozyfantasy\/comments\//);
    expect((await call('community_insights', { category: 'nonexistent' })).isError).toBe(true);
    expect((await call('community_insights', { category: CAT, max_topics: 2 })).isError).toBe(true); // below the minimum
  });

  it('library_status and list_categories describe what is there', async () => {
    const s = await call('library_status');
    expect(s.json).toMatchObject({ books_captured: 3, list_captures: 1, categories: 1 });
    expect(s.json.search).toMatchObject({ vectorSearch: true, model: 'hashing-v1:256' });
    const c = await call('list_categories');
    expect(c.json[0]).toMatchObject({ key: CAT, books_with_detail_pages: 3 });
  });

  it('category_overview and top_books cite books and say what is missing', async () => {
    const o = await call('category_overview', { category: 'Humorous' });
    expect(o.json.top_10).toHaveLength(10);
    expect(o.json.top_10[0]).toMatchObject({ asin: 'B0C1R52V2J', list_rank: 1, detail_captured: true, url: 'https://www.amazon.com/dp/B0C1R52V2J' });
    expect(o.json.cohort_top10_vs_rest.top.metrics.pages.known).toBeLessThan(10);
    const t = await call('top_books', { category: CAT, sort: 'rating_count', limit: 3, captured_only: true });
    expect(t.json.books).toHaveLength(3);
    expect(t.json.books.every((b: any) => b.detail_captured)).toBe(true);
    expect(t.json.books[0].rating_count).toBeGreaterThanOrEqual(t.json.books[1].rating_count);
  });

  it('get_book, book_history, compare_books, get_text_block', async () => {
    const b = await call('get_book', { asin: 'B0C1R52V2J' });
    expect(b.json).toMatchObject({ asin: 'B0C1R52V2J', captured_at: '2026-10-18T13:00:00Z', pages: 694 });
    expect(b.json.note).toMatch(/third-party/);
    expect(b.json.ranks.length).toBeGreaterThan(0);
    expect((await call('book_history', { asin: 'B0C1R52V2J' })).json.points).toHaveLength(1);
    const cmp = await call('compare_books', { asins: ['B0C1R52V2J', 'B0HKTD6M9Z', 'B000000000'] });
    expect(cmp.json.books[2]).toMatchObject({ error: 'not captured' });
    const blurb = await call('get_text_block', { asin: 'B0C1R52V2J', kind: 'blurb' });
    expect(blurb.json.text).toContain('pantheon');
    expect((await call('get_text_block', { asin: 'B0C1R52V2J', kind: 'about_author', ordinal: 9 })).isError).toBe(true);
  });

  it('search_book_text uses keywords and meaning, with filters', async () => {
    const r = await call('search_book_text', { query: 'forgotten gods and a rapidly deteriorating AI system', limit: 3 });
    expect(r.json.mode).toBe('keyword+meaning');
    expect(r.json.hits.some((h: any) => h.asin === 'B0C1R52V2J' && h.kind === 'blurb')).toBe(true);
    const f = await call('search_book_text', { query: 'crawlers', category: 'humorous', kinds: ['blurb'] });
    expect(f.json.hits.every((h: any) => h.kind === 'blurb')).toBe(true);
    expect((await call('search_book_text', { query: 'x', category: 'nope' })).isError).toBe(true);
  });

  it('cohort_stats and distribution', async () => {
    const s = await call('cohort_stats', { category: CAT, top_n: 5 });
    expect(s.json.top.books).toBe(5);
    const d = await call('distribution', { category: CAT, metric: 'price', bins: 4 });
    expect(d.json.bins).toHaveLength(4);
    expect(d.json.bins.reduce((n: number, b: any) => n + b.count, 0)).toBe(d.json.summary.known);
  });

  it('get_cover returns an image', async () => {
    const r = (await client.callTool({ name: 'get_cover', arguments: { asin: 'B0C1R52V2J' } })) as { content: { type: string; mimeType?: string }[] };
    expect(r.content.find((c) => c.type === 'image')?.mimeType).toBe('image/png');
    expect((await call('get_cover', { asin: 'B0HKTD6M9Z' })).isError).toBe(true);
  });

  it('tags and notes persist and show up in get_book and list_books_by_tag', async () => {
    expect((await call('add_tag', { asin: 'B0C1R52V2J', tag: 'Comp Title' })).json).toEqual({ added: true });
    expect((await call('add_tag', { asin: 'B0C1R52V2J', tag: 'comp title' })).json).toEqual({ added: false });
    await call('add_note', { asin: 'B0C1R52V2J', note: 'Opens on a joke' });
    const b = await call('get_book', { asin: 'B0C1R52V2J' });
    expect(b.json.tags).toEqual(['comp title']);
    expect(b.json.notes[0].note).toBe('Opens on a joke');
    expect((await call('list_books_by_tag', { tag: 'COMP TITLE' })).json).toHaveLength(1);
    expect((await call('add_tag', { asin: 'B000000000', tag: 'x' })).isError).toBe(true);
  });

  it('excludes a book from one category and restores it', async () => {
    const asin = 'B0HKTD6M9Z';
    const onList = async () => ((await call('category_overview', { category: CAT })).json.top_10 as { asin: string }[]).some((b) => b.asin === asin);
    const before = (await call('category_overview', { category: CAT })).json.books_on_list;
    expect(await onList()).toBe(true);
    expect((await call('exclude_from_category', { asin, category: CAT })).json).toMatchObject({ category: CAT });
    expect((await call('category_overview', { category: CAT })).json.books_on_list).toBe(before - 1);
    expect(await onList()).toBe(false);
    expect((await call('get_book', { asin })).isError).toBeFalsy(); // still in the library
    await call('restore_to_category', { asin, category: CAT });
    expect(await onList()).toBe(true);
    expect((await call('exclude_from_category', { asin: 'nope', category: CAT })).isError).toBe(true);
  });

  it('rejects bad input without crashing', async () => {
    expect((await call('get_book', { asin: 'nope' })).isError).toBe(true);
    expect((await call('top_books', { category: CAT, limit: 9999 })).isError).toBe(true);
    expect((await call('library_status')).isError).toBeFalsy();
  });
});

describe('analysis tools', () => {
  it('category_report is a readable report that starts with the caveats', async () => {
    const r = await call('category_report', { category: CAT, top_n: 3 });
    expect(r.json.markdown).toMatch(/^# Humorous: category report/);
    expect(r.json.markdown.indexOf('Read this first')).toBeGreaterThan(0);
    expect(r.json.markdown).toContain('## Success score');
    expect(r.json.markdown).toContain('## Covers'); // the stored cover was analysed on demand
  });
  it('market_shape, packaging_stats, reader_voice', async () => {
    const m = await call('market_shape', { category: CAT, top_n: 3 });
    expect(m.json.priceBands.top).toHaveLength(6);
    expect(m.json.scatter).toBeUndefined();
    const p = await call('packaging_stats', { category: CAT, top_n: 3 });
    expect(p.json.books.withBlurb.top).toBe(3);
    const v = await call('reader_voice', { category: CAT, top_n: 3 });
    expect(v.json.note).toMatch(/third-party/);
    expect(v.json.top.withText).toBeGreaterThan(0);
  });
  it('success_scores shows every input', async () => {
    const s = await call('success_scores', { category: CAT, limit: 2 });
    expect(s.json.books).toHaveLength(2);
    expect(s.json.books[0]).toMatchObject({ asin: 'B0C1R52V2J', list_rank: 1 });
    expect(s.json.books[0].components.velocity.basis).toMatch(/lifetime/);
    expect(s.json.weights).toEqual({ rank: 0.5, stability: 0.2, velocity: 0.3 });
  });
  it('category_opportunity, rank_categories, find_subcategories, estimate_sales', async () => {
    const o = await call('category_opportunity', { category: CAT, top_n: 3 });
    expect(o.json.components.reviewBarrier.basis).toMatch(/ratings/);
    expect(o.json.missing).toContain('churn');
    expect(o.json.note).toMatch(/not a forecast/);
    const r = await call('rank_categories', { top_n: 3 });
    expect(r.json.length).toBeGreaterThan(0);
    expect(r.json[0]).toHaveProperty('score');
    const f = await call('find_subcategories', { min_books: 1 });
    expect(f.json.sales_curve).toEqual({ a: 13300, b: 0.79 });
    expect(Array.isArray(f.json.shelves)).toBe(true);
    const e = await call('estimate_sales', { rank: 1000 });
    expect(e.json.est_daily_sales).toBeGreaterThan(30);
    expect(e.json.est_daily_sales_range).toMatchObject({ basis: 'methods' });
    expect(e.json.est_daily_sales_range.low).toBeLessThan(e.json.est_daily_sales_range.high);
    expect((await call('estimate_sales', { rank: 0 })).isError).toBe(true);
  });
  it('trope_clusters reports coverage and caveats', async () => {
    const t = await call('trope_clusters', { category: CAT, top_n: 3 });
    expect(t.json.note).toMatch(/third-party/);
    expect(t.json.books).toBeGreaterThan(0);
    expect(Array.isArray(t.json.clusters)).toBe(true);
    expect(t.json.caveats.join(' ')).toMatch(/word overlap/);
  });
  it('trend says when there is too little history', async () => {
    const t = await call('trend', { category: CAT, metric: 'median_price' });
    expect(t.json.points).toHaveLength(1);
    expect(t.json.caveat).toMatch(/not enough/);
    expect((await call('trend', { category: CAT, metric: 'bogus' })).isError).toBe(true);
  });
  it('cover_stats analyses on demand', async () => {
    const c = await call('cover_stats', { category: CAT, top_n: 3 });
    expect(c.json.top.known).toBe(1);
    expect(c.json.books[0]).toMatchObject({ asin: 'B0C1R52V2J' });
  });

  it('deletes a book only when told to, and then it is gone from the library and its category', async () => {
    const asin = 'B0GZNJHYRW';
    expect((await call('remove_book', { asin })).isError).toBe(true); // no confirmation
    expect((await call('get_book', { asin })).isError).toBeFalsy();
    const r = await call('remove_book', { asin, confirm: true, also_exclude_from_categories: true });
    expect(r.json).toMatchObject({ asin, snapshots: 1 });
    expect((await call('get_book', { asin })).isError).toBe(true);
    const top = (await call('category_overview', { category: CAT })).json.top_10 as { asin: string }[];
    expect(top.some((b) => b.asin === asin)).toBe(false);
    expect((await call('remove_book', { asin, confirm: true })).isError).toBe(true); // already gone
  });
});

describe('startup', () => {
  it('exits with a clear message when no library can be found', () => {
    const r = spawnSync(process.execPath, [path.join(PKG, 'dist/main.mjs')], { env: { ...process.env, BOOKSCOUT_LIBRARY: '', HOME: '/nonexistent', APPDATA: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' }, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no library found/);
  });
  it('resolves the library from flag, env or the desktop app config', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-cfg-'));
    expect(resolveLibraryRoot(['--library', '/a/b'], {}, cfg)).toBe(path.resolve('/a/b'));
    expect(resolveLibraryRoot([], { BOOKSCOUT_LIBRARY: '/c' }, cfg)).toBe(path.resolve('/c'));
    expect(resolveLibraryRoot([], {}, cfg)).toBeNull();
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ libraryRoot: '/from/app' }));
    expect(resolveLibraryRoot([], {}, cfg)).toBe('/from/app');
    fs.rmSync(cfg, { recursive: true });
  });
});

describe('manuscript tools', () => {
  it('say what is missing, then work once text is attached', async () => {
    expect((await call('get_manuscript_excerpt', { asin: 'B0C1R52V2J' })).text).toMatch(/no text is stored/);
    expect((await call('book_content', { asin: 'B0C1R52V2J' })).isError).toBe(true);
    const empty = await call('content_stats', { category: CAT, top_n: 3 });
    expect(empty.json.caveats.join(' ')).toMatch(/No book in this category has text yet/);

    const lib = Library.open(root);
    const book = `Chapter One\n\n"Not again," said the dragon. "It is Tuesday."\n\n${'The baker sighed and looked at the oven. '.repeat(30)}\n\nChapter Two\n\n${'Nothing happened for a very long time. '.repeat(30)}`;
    const i = book.indexOf('Chapter Two');
    lib.attachText('B0C1R52V2J', { source: 'upload', kind: 'txt', label: 'b.txt', text: book, chapters: [{ title: 'Chapter One', start: 0, end: i }, { title: 'Chapter Two', start: i, end: book.length }] });
    lib.close();

    const e = await call('get_manuscript_excerpt', { asin: 'B0C1R52V2J', chapter: 1, chars: 300 });
    expect(e.json).toMatchObject({ asin: 'B0C1R52V2J', basis: 'whole book', chapter: 'Chapter Two', more: true });
    expect(e.json.text.startsWith('Chapter Two')).toBe(true);
    expect(e.json.note).toMatch(/third-party/);
    expect(e.json.chapters).toHaveLength(2);
    expect((await call('get_manuscript_excerpt', { asin: 'B0C1R52V2J', chapter: 9 })).isError).toBe(true);

    const c = await call('book_content', { asin: 'B0C1R52V2J' });
    expect(c.json).toMatchObject({ basis: 'whole book', chapters: { count: 2 } });
    expect(c.json.opening.startsWithDialogue).toBe(true);

    const stats = await call('content_stats', { category: CAT, top_n: 3, include_books: true });
    expect(stats.json.top).toMatchObject({ known: 1, fullManuscripts: 1 });
    expect(stats.json.books[0]).toMatchObject({ asin: 'B0C1R52V2J', basis: 'whole book' });

    const status = await call('library_status');
    expect(status.json.books_with_text).toBe(1);
    expect((await call('get_book', { asin: 'B0C1R52V2J' })).json.full_text[0]).toMatchObject({ source: 'whole book', chapters: 2 });
    const found = await call('search_book_text', { query: 'baker sighed oven', kinds: ['manuscript'], limit: 3 });
    expect(found.json.hits[0]).toMatchObject({ asin: 'B0C1R52V2J', kind: 'manuscript' });
  });
});
