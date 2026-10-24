import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, categoryCsv, categoryReport, reportMarkdown } from '../src/index.js';

const FIX = path.resolve(__dirname, '../../../fixtures/amazon-com');
const read = (n: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIX, n))).toString('utf8');
const KEY = 'amazon.com:kindle:11650864011';
let root: string;
let lib: Library;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookscout-r-'));
  lib = Library.open(root);
  lib.ingest({ kind: 'list', url: 'https://www.amazon.com/zgbs/digital-text/11650864011', html: read('bestsellers-kindle-humorous-fantasy.html.gz'), capturedAt: '2026-10-18T12:00:00Z' });
  for (const a of ['B0C1R52V2J', 'B0HKTD6M9Z', 'B0GZNJHYRW', 'B0GSCPBJLJ', 'B0GPRVQ8QJ']) lib.ingest({ kind: 'detail', url: `https://www.amazon.com/dp/${a}`, html: read(`detail-kindle-${a}.html.gz`), capturedAt: '2026-10-18T13:00:00Z' });
});
afterEach(() => {
  lib.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('categoryReport', () => {
  it('composes every section and states its limits', () => {
    const r = categoryReport(lib.db, 'humorous', 5, '2026-10-19T00:00:00Z');
    expect(r.category.key).toBe(KEY);
    expect(r.booksWithDetail).toBe(5);
    expect(r.scores[0]!.asin).toBe('B0C1R52V2J');
    expect(r.caveats.join(' ')).toMatch(/Only 5 of \d+ listed books have detail pages/);
    expect(r.caveats.join(' ')).toMatch(/Only 1 capture/);
    expect(r.trends.median_price).toHaveLength(1);
    expect(r.characters.readable.top + r.characters.readable.rest).toBeGreaterThan(0);
    expect(r.characters.mainCharacterGender.map((t) => t.label)).toEqual(['Female', 'Male', 'Non-binary', 'Not stated']);
    expect(() => categoryReport(lib.db, 'nope')).toThrow(/no category matches/);
  });
  it('renders a readable markdown report with the caveats first', () => {
    const md = reportMarkdown(categoryReport(lib.db, KEY, 5, '2026-10-19T00:00:00Z'));
    expect(md).toMatch(/^# Humorous: category report/);
    expect(md.indexOf('## Read this first')).toBeLessThan(md.indexOf('## Price'));
    for (const h of ['## Top 5 against the rest', '## Price', '## Freshness', '## Packaging', '## What readers talk about', '## Success score']) expect(md).toContain(h);
    expect(md).not.toContain('## Covers'); // none analysed yet
    expect(md).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe('categoryCsv', () => {
  it('has a header, one row per book, and CRLF line ends', () => {
    const csv = categoryCsv(lib.db, KEY);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^list_rank,asin,title,/);
    expect(lines.length).toBeGreaterThanOrEqual(31);
    expect(lines[1]).toContain('B0C1R52V2J');
  });
  it('neutralises spreadsheet formulas in third-party text and quotes commas', () => {
    lib.db.prepare("UPDATE list_entry SET title = '=HYPERLINK(\"http://x\",\"hi\")' WHERE rank = 7").run();
    lib.db.prepare("UPDATE list_entry SET title = 'Comma, and \"quote\"' WHERE rank = 8").run();
    const csv = categoryCsv(lib.db, KEY);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""hi"")"`);
    expect(csv).toContain('"Comma, and ""quote"""');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});
