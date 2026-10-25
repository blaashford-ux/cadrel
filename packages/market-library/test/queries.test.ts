import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, listAnnotations, listBooks, listCategories, getBook, listIssues, queue, nextInQueue, openNext, setQueueState } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const LIST = 'amazon.com:kindle:11650864011';

let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-market-q-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const capture = (asin: string, at = '2026-10-18T13:00:00Z') =>
  lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${asin}`, html: read(`detail-kindle-${asin}.html.gz`), capturedAt: at });

describe('queue', () => {
  it('lists uncaptured books by rank and drops them once captured', () => {
    const q = queue(lib.db);
    expect(q.length).toBeGreaterThanOrEqual(30);
    expect(q.map((i) => i.rank)).toEqual([...q.map((i) => i.rank)].sort((a, b) => a - b));
    expect(q[0]).toMatchObject({ asin: 'B0C1R52V2J', rank: 1, state: 'pending' });
    capture('B0C1R52V2J');
    const after = queue(lib.db);
    expect(after.some((i) => i.asin === 'B0C1R52V2J')).toBe(false);
    expect(after[0]!.asin).toBe('B0HKTD6M9Z');
  });

  it('openNext marks the first pending item opened and moves on', () => {
    const first = nextInQueue(lib.db)!;
    const opened = openNext(lib.db)!;
    expect(opened.asin).toBe(first.asin);
    expect(opened.url).toBe(`https://www.amazon.com/dp/${first.asin}`);
    expect(queue(lib.db).find((i) => i.asin === first.asin)!.state).toBe('opened');
    expect(nextInQueue(lib.db)!.asin).not.toBe(first.asin);
  });

  it('skips hide items unless asked, and can be undone', () => {
    const first = nextInQueue(lib.db)!;
    setQueueState(lib.db, first.asin, 'skipped');
    expect(queue(lib.db).some((i) => i.asin === first.asin)).toBe(false);
    expect(queue(lib.db, { includeSkipped: true }).find((i) => i.asin === first.asin)!.state).toBe('skipped');
    setQueueState(lib.db, first.asin, 'pending');
    expect(nextInQueue(lib.db)!.asin).toBe(first.asin);
  });

  it('queues uncaptured search results as uncategorised, leaving books already on a list where they are', () => {
    const listed = queue(lib.db)[0]!;
    const row = (asin: string, title: string) => `<div data-component-type="s-search-result" data-asin="${asin}"><h2 aria-label="${title}"><span>${title}</span></h2></div>`;
    const html = `<html><body>${row(listed.asin, 'Listed')}${row('B0SEARCH01', 'Only in search')}</body></html>`;
    lib.ingest({ kind: 'search', url: 'https://www.amazon.com/s?k=cozy+fantasy', html, capturedAt: '2026-10-19T12:00:00Z' });
    const inSearch = queue(lib.db).filter((i) => i.categoryKey === 'uncategorised');
    expect(inSearch.map((i) => i.asin)).toEqual(['B0SEARCH01']);
    expect(inSearch[0]).toMatchObject({ categoryName: 'Uncategorised', title: 'Only in search', state: 'pending' });
    expect(queue(lib.db).find((i) => i.asin === listed.asin)!.categoryKey).toBe(LIST);
    expect(queue(lib.db, { categoryKey: LIST }).some((i) => i.asin === 'B0SEARCH01')).toBe(false);
    expect(queue(lib.db, { categoryKey: 'uncategorised' }).map((i) => i.asin)).toEqual(['B0SEARCH01']);
  });

  it('filters by category and returns null when nothing is left', () => {
    expect(queue(lib.db, { categoryKey: 'amazon.com:kindle:nope' })).toEqual([]);
    expect(openNext(lib.db, 'amazon.com:kindle:nope')).toBeNull();
  });

  it('survives rebuild (queue state is user data, not derived)', () => {
    const first = nextInQueue(lib.db)!;
    setQueueState(lib.db, first.asin, 'skipped');
    lib.rebuild();
    expect(queue(lib.db, { includeSkipped: true }).find((i) => i.asin === first.asin)!.state).toBe('skipped');
  });
});

describe('categories and books', () => {
  it("keeps the list page's category name when a book page names the same node differently", () => {
    const before = listCategories(lib.db)[0]!.name;
    capture('B0C1R52V2J');
    expect(listCategories(lib.db)[0]!.name).toBe(before);
    lib.rebuild();
    expect(listCategories(lib.db)[0]!.name).toBe(before);
  });

  it('summarises the listed category and tracks captured books', () => {
    let [c] = listCategories(lib.db);
    expect(c).toMatchObject({ key: LIST, listCaptures: 1, capturedBooks: 0 });
    expect(c!.listedBooks).toBeGreaterThanOrEqual(30);
    capture('B0C1R52V2J');
    [c] = listCategories(lib.db);
    expect(c!.capturedBooks).toBe(1);
  });

  it('lists books with the newest snapshot, searchable', () => {
    capture('B0C1R52V2J', '2026-10-18T13:00:00Z');
    capture('B0C1R52V2J', '2026-10-19T13:00:00Z');
    capture('B0HKTD6M9Z');
    const all = listBooks(lib.db);
    expect(all).toHaveLength(2);
    const b = all.find((r) => r.asin === 'B0C1R52V2J')!;
    expect(b.snapshots).toBe(2);
    expect(b.lastSeen).toBe('2026-10-19T13:00:00Z');
    expect(listBooks(lib.db, { search: 'B0HKTD6M9Z' })).toHaveLength(1);
    expect(listBooks(lib.db, { search: "%'; DROP TABLE book;--" })).toEqual([]);
    expect(listBooks(lib.db, { categoryKey: 'amazon.com:kindle:nope' })).toEqual([]);
  });

  it('gives each book its last recorded list rank, within the chosen category when there is one', () => {
    capture('B0C1R52V2J');
    capture('B0HKTD6M9Z');
    const q = queue(lib.db, { categoryKey: LIST, includeSkipped: true });
    const all = listBooks(lib.db);
    const inCat = listBooks(lib.db, { categoryKey: LIST });
    expect(all.length).toBeGreaterThan(0);
    for (const b of all) expect(b.listRank).toBeGreaterThan(0);
    expect(inCat.map((b) => b.listRank)).toEqual(all.filter((b) => inCat.some((c) => c.asin === b.asin)).map((b) => b.listRank));
    expect(all[0]!.listCategory).toBe('Humorous');
    // a second list capture moves the rank: the newest one wins
    const html = read('bestsellers-kindle-humorous-fantasy.html.gz');
    lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html, capturedAt: '2026-10-19T12:00:00Z' });
    expect(listBooks(lib.db).find((b) => b.asin === 'B0C1R52V2J')!.listRank).toBe(all.find((b) => b.asin === 'B0C1R52V2J')!.listRank);
    expect(q.length).toBeGreaterThan(0);
  });

  it('gives book detail with history, ranks and raw location', () => {
    capture('B0C1R52V2J', '2026-10-18T13:00:00Z');
    capture('B0C1R52V2J', '2026-10-19T13:00:00Z');
    const d = getBook(lib.db, 'B0C1R52V2J')!;
    expect(d.history.map((h) => h.capturedAt)).toEqual(['2026-10-18T13:00:00Z', '2026-10-19T13:00:00Z']);
    expect(d.ranks.length).toBeGreaterThan(0);
    expect(d.formats.length).toBeGreaterThan(0);
    expect(d.rawDir).toBe('books/B0C1R52V2J/snapshots/20261019T130000Z');
    expect(getBook(lib.db, 'B000000000')).toBeNull();
  });

  it('lists parse issues from both kinds of capture', () => {
    capture('B0C1R52V2J');
    expect(Array.isArray(listIssues(lib.db))).toBe(true);
  });
});

describe('user data', () => {
  it('annotates books, dedupes, validates, and lists', () => {
    capture('B0C1R52V2J');
    expect(lib.annotate('B0C1R52V2J', 'tag', ' Cozy ')).toBe(true);
    expect(lib.annotate('B0C1R52V2J', 'tag', 'cozy')).toBe(false);
    lib.annotate('B0C1R52V2J', 'note', 'Great hook in the first line');
    expect(listAnnotations(lib.db, { asin: 'B0C1R52V2J' }).map((a) => `${a.kind}:${a.value}`)).toEqual(['tag:cozy', 'note:Great hook in the first line']);
    expect(listAnnotations(lib.db, { kind: 'tag', value: 'COZY' })).toHaveLength(1);
    expect(() => lib.annotate('B000000000', 'tag', 'x')).toThrow(/no captured book/);
    expect(() => lib.annotate('B0C1R52V2J', 'tag', '  ')).toThrow();
    expect(lib.unannotate('B0C1R52V2J', 'tag', 'cozy')).toBe(true);
  });

  it('restores queue state and annotations after the database is deleted', () => {
    capture('B0C1R52V2J');
    lib.annotate('B0C1R52V2J', 'tag', 'keeper');
    const next = nextInQueue(lib.db)!;
    lib.setQueue(next.asin, 'skipped');
    lib.close();
    for (const f of fs.readdirSync(root).filter((f) => f.startsWith('scout.db'))) fs.rmSync(path.join(root, f));
    lib = Library.open(root);
    expect(listAnnotations(lib.db).map((a) => a.value)).toEqual(['keeper']);
    expect(lib.db.scalar('SELECT state FROM queue_item WHERE asin = ?', next.asin)).toBe('skipped');
  });
});
