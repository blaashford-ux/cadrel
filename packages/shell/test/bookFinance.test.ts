import { describe, expect, it } from 'vitest';
import { AuthorFigures, publishFigures, type FigureSource, type FinanceCalls } from '../src/main/bookFinance';

const month = (asin: string, m: string, usd: number) => ({
  from: m, to: m, month: m, totals: { usd, ebook: usd, print: 0, kenp: 0, units: 1, freeUnits: 0, pages: 0, estimated: 0, pending: 0 },
  months: [{ month: m, usd, ebook: usd, print: 0, kenp: 0, units: 1, freeUnits: 0, pages: 0, state: 'final' }],
  books: [{ asin, title: asin, usd, ebook: usd, print: 0, kenp: 0, units: 1, pages: 0, share: 1, estimated: 0 }],
  marketplaces: [], royaltyTypes: [], transactions: [], daily: [], missingRoyalty: [], previous: null, lastYear: null, previousByBook: {}, kenp: []
});

function publisher(figures: Record<string, number | null>) {
  const source = {
    status: () => ({ libraryRoot: '/lib' }),
    ownBooks: () => Object.keys(figures).map((asin) => ({ asin, title: `T ${asin}` })),
    bookFinanceForAuthors: (asin: string) => (figures[asin] == null ? null : { asin, title: `T ${asin}`, months: [{ month: '2026-10', report: month(asin, '2026-10', figures[asin]!) }] })
  } as unknown as FigureSource;
  const calls: { asin: string; months: number }[] = [];
  const studio = { publish: async (i: { asin: string; months: unknown[] }) => void calls.push({ asin: i.asin, months: i.months.length }) };
  return { source, studio, calls };
}

describe('publishing the publisher’s figures to the Studio', () => {
  it('sends each book that has figures, once, and sends only what changed the next time', async () => {
    const f = { B0AAAAAAA1: 10, B0AAAAAAA2: 5 } as Record<string, number | null>;
    const p = publisher(f);
    const sent = new Map<string, string>();
    expect(await publishFigures(p.source, p.studio, sent)).toEqual({ published: 2, unchanged: 0, error: null });
    expect(await publishFigures(p.source, p.studio, sent)).toEqual({ published: 0, unchanged: 2, error: null });
    f.B0AAAAAAA2 = 7; // a corrected figure
    expect(await publishFigures(p.source, p.studio, sent)).toEqual({ published: 1, unchanged: 1, error: null });
    expect(p.calls.map((c) => c.asin)).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA2']);
  });

  it('empties a book whose figures have gone, but does not trouble the Studio about a book that never had any', async () => {
    const f = { B0AAAAAAA1: 10, B0AAAAAAA2: null } as Record<string, number | null>;
    const p = publisher(f);
    const sent = new Map<string, string>();
    await publishFigures(p.source, p.studio, sent);
    expect(p.calls).toEqual([{ asin: 'B0AAAAAAA1', months: 1 }]);
    f.B0AAAAAAA1 = null; // sales data cleared
    await publishFigures(p.source, p.studio, sent);
    expect(p.calls[1]).toEqual({ asin: 'B0AAAAAAA1', months: 0 });
  });

  it('sends nothing when there is no library, and stops with the Studio’s own words when it refuses', async () => {
    const p = publisher({ B0AAAAAAA1: 1 });
    expect(await publishFigures({ ...p.source, status: () => ({ libraryRoot: null }) } as unknown as FigureSource, p.studio, new Map())).toEqual({ published: 0, unchanged: 0, error: null });
    const refused = { publish: async () => { throw new Error('You are not allowed to do that (royalties.manage)'); } };
    const r = await publishFigures(p.source, refused, new Map());
    expect(r).toMatchObject({ published: 0, error: expect.stringMatching(/royalties\.manage/) });
  });
});

describe('an author reading their books’ figures', () => {
  const studio = (calls: string[]): FinanceCalls => ({
    publish: async () => undefined,
    books: async () => (calls.push('books'), [{ asin: 'B0AAAAAAA1', title: 'One', months: ['2026-10'] }]),
    book: async (asin) => (calls.push(`book ${asin}`), [{ month: '2026-10', report: month(asin, '2026-10', 12) }])
  });

  it('reads the books once and answers every question from them for a little while', async () => {
    const calls: string[] = [];
    let t = 0;
    const fig = new AuthorFigures(studio(calls), { ttlMs: 1000, now: () => t });
    expect((await fig.get()).moneyMonth('2026-10').totals.usd).toBe(12);
    expect((await fig.get()).moneyMonths()).toEqual(['2026-10']);
    expect(calls).toEqual(['books', 'book B0AAAAAAA1']);
    t = 2000;
    await fig.get();
    expect(calls).toHaveLength(4);
    fig.invalidate();
    await fig.get();
    expect(calls).toHaveLength(6);
  });

  it('shows an empty Finance, not an error, to a role the Studio gives no figures to', async () => {
    const fig = new AuthorFigures({ ...studio([]), books: async () => { throw new Error('not allowed'); } });
    expect((await fig.get()).ready()).toBe(false);
  });
});
