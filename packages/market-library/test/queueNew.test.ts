import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, nextInQueue, queue } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const html = zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'bestsellers-kindle-humorous-fantasy.html.gz'))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
const capture = (at: string) => lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html, capturedAt: at } as never);
let root: string;
let lib: Library;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadrel-new-')); lib = Library.open(root); });
afterEach(() => { lib.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('new additions in the queue', () => {
  it('has none after a first capture, then only the books the earlier capture lacked', () => {
    capture('2026-10-01T12:00:00Z');
    const all = queue(lib.db);
    expect(all.length).toBeGreaterThan(2);
    expect(all.some((q) => q.isNew)).toBe(false);
    expect(queue(lib.db, { onlyNew: true })).toEqual([]);

    // Make the first capture look like it was missing two books, as if they joined the list afterwards.
    const joined = all.slice(0, 2).map((q) => q.asin);
    for (const a of joined) lib.db.prepare('DELETE FROM list_entry WHERE asin = ?').run(a);
    capture('2026-10-15T12:00:00Z');

    const fresh = queue(lib.db, { onlyNew: true });
    expect(fresh.map((q) => q.asin).sort()).toEqual([...joined].sort());
    expect(fresh.every((q) => q.isNew && q.categoryKey === KEY)).toBe(true);
    expect(queue(lib.db).filter((q) => q.isNew)).toHaveLength(2);
    expect(queue(lib.db, { categoryKey: KEY, onlyNew: true })).toHaveLength(2);
    expect(nextInQueue(lib.db, KEY, true)?.asin).toBe(fresh[0]!.asin);
  });

  it('drops a new book from the filter once its page is captured, and leaves skipped ones out unless asked', () => {
    capture('2026-10-01T12:00:00Z');
    const first = queue(lib.db)[0]!.asin;
    lib.db.prepare('DELETE FROM list_entry WHERE asin = ?').run(first);
    capture('2026-10-15T12:00:00Z');
    lib.setQueue(first, 'skipped');
    expect(queue(lib.db, { onlyNew: true })).toEqual([]);
    expect(queue(lib.db, { onlyNew: true, includeSkipped: true }).map((q) => q.asin)).toEqual([first]);
  });
});
