/**
 * Books' earnings between the publisher and the authors of a Studio that has a server. The publisher's Cadrel (the one with the KDP reports)
 * publishes each book's months to the Studio when the figures change; an Author's Cadrel reads back the books they wrote. Electron-free; tested
 * in test/bookFinance.test.ts. What may be published and who may read which book is decided by the Studio's server, not here.
 */
import { createHash } from 'node:crypto';
import { authorFinance, type AuthorFinance, type PublishedBook } from '@cadrel/finance-desktop/src/main/authorFinance';
import type { AppService } from '@cadrel/market-desktop/src/main/service';

/** The Studio's `finance` calls, as the person using the app. */
export interface FinanceCalls {
  publish(input: { asin: string; title: string; months: { month: string; report: unknown }[] }): Promise<unknown>;
  books(): Promise<{ asin: string; title: string; months: string[] }[]>;
  book(asin: string): Promise<{ month: string; report: unknown }[]>;
}

export type FigureSource = Pick<AppService, 'status' | 'ownBooks' | 'bookFinanceForAuthors'>;

export interface PublishResult {
  /** Books whose figures were sent. */
  published: number;
  /** Books already up to date on the Studio (nothing had changed since they were last sent). */
  unchanged: number;
  /** Why it stopped, in words, if it did. */
  error: string | null;
}

/**
 * Sends the Studio each of the publisher's books' months (replacing what was there). A book whose figures have gone (the sales data was cleared)
 * is sent with no months, so its authors stop seeing figures that no longer exist. `sent` remembers what the Studio already holds, so a change
 * that touches one book sends one book.
 */
export async function publishFigures(source: FigureSource, studio: Pick<FinanceCalls, 'publish'>, sent: Map<string, string>): Promise<PublishResult> {
  const out: PublishResult = { published: 0, unchanged: 0, error: null };
  if (!source.status().libraryRoot) return out;
  for (const b of source.ownBooks()) {
    const data = source.bookFinanceForAuthors(b.asin);
    const months = data ? data.months : [];
    const body = { asin: b.asin, title: data?.title ?? b.title ?? b.asin, months };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (sent.get(b.asin) === hash) {
      out.unchanged++;
      continue;
    }
    // a book that never had figures and has none now is not worth a request
    if (!data && !sent.has(b.asin)) {
      out.unchanged++;
      continue;
    }
    try {
      await studio.publish(body);
      sent.set(b.asin, hash);
      out.published++;
    } catch (e) {
      out.error = String((e as Error)?.message ?? e);
      return out;
    }
  }
  return out;
}

/**
 * The books an Author wrote, with their published months, read from the Studio and kept for a short while, since every question the Finance
 * page asks (the months, a period, a month) is answered from the same books.
 */
export class AuthorFigures {
  private cached: { at: number; fin: AuthorFinance } | null = null;
  private loading: Promise<AuthorFinance> | null = null;
  constructor(private readonly studio: FinanceCalls, private readonly o: { ttlMs?: number; now?: () => number } = {}) {}

  invalidate(): void {
    this.cached = null;
  }

  async get(): Promise<AuthorFinance> {
    const now = (this.o.now ?? Date.now)();
    if (this.cached && now - this.cached.at < (this.o.ttlMs ?? 120_000)) return this.cached.fin;
    this.loading ??= this.load().finally(() => (this.loading = null));
    const fin = await this.loading;
    this.cached = { at: now, fin };
    return fin;
  }

  private async load(): Promise<AuthorFinance> {
    let list: Awaited<ReturnType<FinanceCalls['books']>>;
    try {
      list = await this.studio.books();
    } catch {
      return authorFinance([]); // a role that may not read any figures sees an empty page, not an error
    }
    const books: PublishedBook[] = [];
    for (const b of list) {
      const months = await this.studio.book(b.asin);
      books.push({ asin: b.asin, title: b.title, months: months as PublishedBook['months'] });
    }
    return authorFinance(books);
  }
}
