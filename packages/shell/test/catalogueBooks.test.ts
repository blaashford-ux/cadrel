import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyTree, createProject, type ProjectTree } from '@cadrel/kernel';
import { CATALOGUE_CALLS, CatalogueError, addFromMarket, catalogueCall, catalogueDetail, catalogueList, primaryAsin, type Sources } from '../src/main/catalogueBooks';
import type { BookService } from '../src/main/mybooks';
import { PeopleHost } from '../src/main/people';

let dir: string, host: PeopleHost;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cadrel-cat-'));
  host = new PeopleHost();
  await host.open({ file: path.join(dir, 'records.db'), studioId: 'local', owned: true, ownerName: 'Ana Reyes' });
});
afterEach(async () => {
  await host.close();
  await rm(dir, { recursive: true, force: true });
});

const own = (asin: string, title: string, pen = 'Blake') => ({ asin, title, penNames: [pen], authorNames: [pen], snapshots: 1, overallRank: 1200, listRank: null, kindlePrice: 4.99, ratingValue: 4.5, ratingCount: 10, paidUnits: 7, kenpPages: 0, lastSaleDay: '2026-10-01', source: 'report', addedAt: '2026-01-01', lastCaptured: null, listCategory: null, text: null, firstSaleDay: null });
const OWN = [own('B0AAAAAAA1', 'Lead Me'), own('B0BBBBBBB2', 'Follow Me')];
/** The part of Market's service the catalogue reads: the list of your own books and the money by month (none here). */
const market = (library = true): BookService =>
  ({ status: () => ({ libraryRoot: library ? '/lib' : null }), ownBooks: () => OWN, ownBook: (a: string) => OWN.find((o) => o.asin === a) ?? null, moneyMonths: () => [], moneyAnalysis: () => ({ books: [], months: [] }) }) as unknown as BookService;

const sources = (over: Partial<Sources> = {}): Sources => ({ people: host, tree: emptyTree(), stages: {}, write: [], market: market(), financeVisible: false, ...over });

describe('My Books on the catalogue', () => {
  it('lists Market’s own books that the catalogue lacks, and adds them as books with an ebook edition', async () => {
    let l = await catalogueList(sources());
    expect(l).toMatchObject({ available: true, marketAvailable: true, books: [], may: { create: true, edit: true, archive: true } });
    expect(l.unlisted.map((u) => u.asin)).toEqual(['B0AAAAAAA1', 'B0BBBBBBB2']);
    const r = await addFromMarket(host, market(), ['B0AAAAAAA1', 'B0AAAAAAA1', 'B0ZZZZZZZZ']);
    expect(r).toEqual({ added: ['B0AAAAAAA1'], skipped: [{ asin: 'B0ZZZZZZZZ', reason: 'Market does not know this book.' }] });
    l = await catalogueList(sources());
    expect(l.books.map((b) => [b.title, b.penName, b.asin, b.editions.map((e) => e.format)])).toEqual([['Lead Me', 'Blake', 'B0AAAAAAA1', ['ebook']]]);
    expect(l.books[0]!.market).toMatchObject({ asin: 'B0AAAAAAA1', overallRank: 1200, kindlePrice: 4.99 }); // joined by ASIN
    expect(l.unlisted.map((u) => u.asin)).toEqual(['B0BBBBBBB2']);
    expect((await addFromMarket(host, market(), ['B0AAAAAAA1'])).skipped[0]!.reason).toMatch(/already|exists|taken/i); // not added twice
  });

  it('adds a book whose title is taken under its title and ASIN', async () => {
    await host.service!.as(host.me).catalogue.createBook({ title: 'Lead Me' });
    const r = await addFromMarket(host, market(), ['B0AAAAAAA1']);
    expect(r.added).toEqual(['B0AAAAAAA1']);
    expect((await catalogueList(sources())).books.map((b) => b.title).sort()).toEqual(['Lead Me', 'Lead Me (B0AAAAAAA1)']);
  });

  it('shows a book’s series and position, and its project’s stage and manuscript progress', async () => {
    const cat = host.service!.as(host.me).catalogue;
    const series = await cat.createSeries({ name: 'Dragon Rider' });
    const book = await cat.createBook({ title: 'Lead Me', seriesId: series.id, position: 1 });
    await cat.addEdition(book.id, { format: 'paperback', isbn: '9780306406157' });
    await cat.addEdition(book.id, { format: 'ebook', asin: 'B0AAAAAAA1' });
    let tree: ProjectTree = emptyTree();
    tree = createProject(tree, { name: 'Lead Me project', workflowId: 'w', stage: 'drafting' }).tree;
    const project = tree.projects[0]!;
    tree = { ...tree, links: [{ projectId: project.id, module: 'write', ref: 'Lead Me Folder' }] };
    await catalogueCall(host, tree, 'linkProject', [book.id, project.id]);
    const src = sources({ tree, stages: { [project.id]: { workflowId: 'w', workflowName: 'W', stage: { key: 'drafting', name: 'Drafting', color: '#3f7cac', category: 'active' } } }, write: [{ name: 'Lead Me Folder', words: 41000, goalWords: 80000 }] });
    const l = await catalogueList(src);
    expect(l.projects).toEqual([]); // linked, so not offered again
    expect(l.books[0]).toMatchObject({ seriesName: 'Dragon Rider', position: 1, asin: 'B0AAAAAAA1', projectName: 'Lead Me project', stage: 'Drafting', stageColor: '#3f7cac', words: 41000, goalWords: 80000 });
    expect(l.books[0]!.editions.map((e) => e.format).sort()).toEqual(['ebook', 'paperback']);
    expect(await catalogueDetail(src, book.id)).toMatchObject({ book: { title: 'Lead Me' }, may: { edit: true } });
    expect(await catalogueDetail(src, 'nope')).toBeNull();
  });

  it('stands for a book by its ebook’s ASIN, else the first edition that has one, else none', () => {
    const e = (format: string, asin: string | null, archivedAt: string | null = null) => ({ format, asin, archivedAt }) as never;
    expect(primaryAsin({ editions: [e('paperback', 'B0PAPER000'), e('ebook', 'B0EBOOK000')] })).toBe('B0EBOOK000');
    expect(primaryAsin({ editions: [e('paperback', 'B0PAPER000'), e('audiobook', 'B0AUDIO000')] })).toBe('B0PAPER000');
    expect(primaryAsin({ editions: [e('paperback', null), e('ebook', 'B0OLD00000', '2026-01-01')] })).toBeNull();
  });

  it('lists books with no library: the catalogue stands alone', async () => {
    await host.service!.as(host.me).catalogue.createBook({ title: 'Unpublished' });
    const l = await catalogueList(sources({ market: null }));
    expect(l).toMatchObject({ available: true, marketAvailable: false, unlisted: [] });
    expect(l.books.map((b) => [b.title, b.asin, b.market])).toEqual([['Unpublished', null, null]]);
  });

  it('only does the changes it lists, to projects that exist', async () => {
    const book = await host.service!.as(host.me).catalogue.createBook({ title: 'B' });
    for (const bad of ['constructor', '__proto__', 'books', 'byAsin']) await expect(catalogueCall(host, emptyTree(), bad, [])).rejects.toThrow(CatalogueError);
    await expect(catalogueCall(host, emptyTree(), 'linkProject', [book.id, 'ghost'])).rejects.toThrow(/no such project/);
    expect(CATALOGUE_CALLS).toContain('updateEdition');
  });

  it('says so where this computer holds no records', async () => {
    const joined = new PeopleHost();
    await joined.open({ file: path.join(dir, 'j.db'), studioId: 'x', owned: false, ownerName: 'Ana' });
    expect(await catalogueList(sources({ people: joined }))).toMatchObject({ available: false, reason: expect.stringMatching(/owner/) });
    await expect(catalogueCall(joined, emptyTree(), 'createBook', [{ title: 'x' }])).rejects.toThrow(/owner/);
  });
});
