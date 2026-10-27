/**
 * My Books on the catalogue. The catalogue (IP, series, books, editions: the Studio's records) says what books exist; an edition's ASIN
 * is the join to Market (listing, rank, price) and Finance (sales, royalties); the book's project in the project tree supplies its stage
 * and manuscript progress. This file assembles those into the list and the page and routes the changes, and keeps no data of its own.
 * Electron-free; tested in test/catalogueBooks.test.ts.
 *
 * Books Market knows of (your own books, from KDP reports) that the catalogue does not have yet are listed apart, to be added in one go.
 */
import { getProject, linksOf, type BookWithEditions, type ProjectTree } from '@cadrel/kernel';
import type { CatalogueBookRow, CatalogueDetail, CatalogueList, MyBookRow, ProjectStageView } from '../shared/api';
import { listBooks as marketRows, type BookService } from './mybooks';
import type { PeopleHost } from './people';

export class CatalogueError extends Error {}

/** The ASIN that stands for a book in Market and Finance: its ebook's, else the first edition that has one. */
export const primaryAsin = (b: Pick<BookWithEditions, 'editions'>): string | null => {
  const live = b.editions.filter((e) => !e.archivedAt && e.asin);
  return (live.find((e) => e.format === 'ebook') ?? live[0])?.asin ?? null;
};

export interface Sources {
  people: PeopleHost;
  tree: ProjectTree;
  stages: Record<string, ProjectStageView>;
  /** Words and goal by Write folder name. */
  write: { name: string; words: number | null; goalWords: number | null }[];
  market: BookService | null;
  financeVisible: boolean;
}

const pad = (n: number | null) => n;

function progress(tree: ProjectTree, projectId: string, write: Sources['write']): { words: number | null; goalWords: number | null } {
  const folder = linksOf(tree, projectId, 'write')[0]?.ref;
  const w = folder ? write.find((x) => x.name === folder) : undefined;
  return { words: pad(w?.words ?? null), goalWords: pad(w?.goalWords ?? null) };
}

function projectOf(src: Sources, projectId: string | undefined) {
  const p = projectId ? getProject(src.tree, projectId) : undefined;
  if (!p) return { projectId: null, projectName: null, stage: null, stageColor: null, stageCategory: null, words: null, goalWords: null };
  const s = src.stages[p.id]?.stage ?? null;
  return { projectId: p.id, projectName: p.name, stage: s?.name ?? null, stageColor: s?.color ?? null, stageCategory: s?.category ?? null, ...progress(src.tree, p.id, src.write) };
}

export async function catalogueList(src: Sources): Promise<CatalogueList> {
  const svc = src.people.service?.as(src.people.me);
  const base = { marketAvailable: !!src.market?.status().libraryRoot, financeVisible: src.financeVisible };
  if (!svc) return { available: false, reason: 'This Studio’s books are managed by its owner.', ...base, may: { create: false, edit: false, archive: false }, series: [], books: [], unlisted: [], projects: [] };
  const [books, series, links, create, edit, archive] = await Promise.all([svc.catalogue.books(), svc.catalogue.series(), svc.catalogue.projectLinks(), src.people.may('catalogue.create'), src.people.may('catalogue.edit'), src.people.may('catalogue.archive')]);
  const market = new Map<string, MyBookRow>();
  if (src.market && base.marketAvailable) for (const r of marketRows(src.market, src.financeVisible).books) market.set(r.asin, r);
  const seriesName = new Map(series.map((s) => [s.id, s.name]));
  const linkOf = new Map(links.map((l) => [l.bookId, l.projectId]));
  const inCatalogue = new Set(books.flatMap((b) => b.editions.map((e) => e.asin).filter((a): a is string => !!a)));
  const rows: CatalogueBookRow[] = books.map((b) => {
    const asin = primaryAsin(b);
    return {
      bookId: b.id, title: b.title, subtitle: b.subtitle, penName: b.penName, seriesId: b.seriesId, seriesName: b.seriesId ? seriesName.get(b.seriesId) ?? null : null, position: b.position,
      editions: b.editions.filter((e) => !e.archivedAt).map(({ id, format, asin: a, isbn, price, currency, publishedOn }) => ({ id, format, asin: a, isbn, price, currency, publishedOn })),
      asin, market: asin ? market.get(asin) ?? null : null, ...projectOf(src, linkOf.get(b.id))
    };
  });
  const linked = new Set(links.map((l) => l.projectId));
  return {
    available: true, ...base, may: { create, edit, archive }, series: series.map((s) => ({ id: s.id, name: s.name })), books: rows,
    unlisted: [...market.values()].filter((m) => !inCatalogue.has(m.asin)).map((m) => ({ asin: m.asin, title: m.title, penNames: m.penNames })),
    projects: src.tree.projects.filter((p) => p.status !== 'archived' && !linked.has(p.id)).map((p) => ({ id: p.id, name: p.name }))
  };
}

/** One book's record, for its page: the catalogue's own fields, its editions, and its project. The Market and Finance sections come from `bookPage(asin)`. */
export async function catalogueDetail(src: Sources, bookId: string): Promise<CatalogueDetail | null> {
  const list = await catalogueList(src);
  const row = list.books.find((b) => b.bookId === bookId);
  return row && list.available ? { book: row, series: list.series, projects: list.projects, may: list.may } : null;
}

/** The changes the page may ask for. A list, so inherited names such as `constructor` are not reachable. */
export const CATALOGUE_CALLS = ['createBook', 'createSeries', 'updateBook', 'moveBook', 'addEdition', 'updateEdition', 'archive', 'linkProject'] as const;

export async function catalogueCall(people: PeopleHost, tree: ProjectTree, name: string, args: unknown[]): Promise<unknown> {
  if (!(CATALOGUE_CALLS as readonly string[]).includes(name)) throw new CatalogueError('That is not something My Books can do.');
  const svc = people.service?.as(people.me);
  if (!svc) throw new CatalogueError('This Studio’s books are managed by its owner.');
  if (name === 'linkProject' && args[1] !== null && !getProject(tree, String(args[1]))) throw new CatalogueError('There is no such project.');
  return (svc.catalogue as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args);
}

/** Adds Market's own books to the catalogue as one book each, with an ebook edition carrying the ASIN. A book whose title is taken is added under its title and ASIN. */
export async function addFromMarket(people: PeopleHost, market: BookService, asins: string[]): Promise<{ added: string[]; skipped: { asin: string; reason: string }[] }> {
  const svc = people.service?.as(people.me);
  if (!svc) throw new CatalogueError('This Studio’s books are managed by its owner.');
  const added: string[] = [];
  const skipped: { asin: string; reason: string }[] = [];
  for (const asin of [...new Set(asins)]) {
    const own = market.ownBook(asin);
    if (!own) {
      skipped.push({ asin, reason: 'Market does not know this book.' });
      continue;
    }
    const title = own.title ?? asin;
    const penName = own.penNames[0] ?? '';
    try {
      let book;
      try {
        book = await svc.catalogue.createBook({ title, penName });
      } catch (e) {
        if (!/already/i.test(String((e as Error).message))) throw e;
        book = await svc.catalogue.createBook({ title: `${title} (${asin})`, penName });
      }
      try {
        await svc.catalogue.addEdition(book.id, { format: 'ebook', asin });
      } catch (e) {
        await svc.catalogue.archive('book', book.id).catch(() => undefined); // do not leave a book with no edition behind
        throw e;
      }
      added.push(asin);
    } catch (e) {
      skipped.push({ asin, reason: String((e as Error).message ?? e) });
    }
  }
  return { added, skipped };
}
