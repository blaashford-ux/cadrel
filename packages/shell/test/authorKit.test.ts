import { describe, expect, it } from 'vitest';
import { buildAuthorKit } from '../src/main/authorKit';

const profile = { displayName: 'Ann', penNames: ['Ann Pen'], bio: 'Writes.', patreonUrl: 'https://www.patreon.com/ann', patreonCta: 'Read ahead.' };

describe('the author kit for Book Details', () => {
  it('lists My Books with their Amazon links, and takes the series and place from the catalogue by ASIN', () => {
    const kit = buildAuthorKit({
      profile,
      own: [{ asin: 'B0AAAAAAA1', title: 'One', penNames: ['Ann Pen'] }, { asin: 'B0AAAAAAA2', title: null, penNames: [] }],
      books: [{ title: 'One', seriesId: 's1', position: 2, editions: [{ asin: 'B0AAAAAAA1' }, { asin: null }] }],
      series: [{ id: 's1', name: 'Saga' }]
    });
    expect(kit.profile).toEqual(profile);
    expect(kit.books).toEqual([
      { asin: 'B0AAAAAAA1', title: 'One', url: 'https://www.amazon.com/dp/B0AAAAAAA1', penNames: ['Ann Pen'], series: 'Saga', position: 2 },
      { asin: 'B0AAAAAAA2', title: 'B0AAAAAAA2', url: 'https://www.amazon.com/dp/B0AAAAAAA2', penNames: [], series: null, position: null }
    ]);
  });

  it('also offers catalogue books the library does not have, under the catalogue’s pen name, and no book twice', () => {
    const kit = buildAuthorKit({
      profile,
      own: [{ asin: 'B0AAAAAAA1', title: 'One', penNames: ['Ann Pen'] }],
      books: [
        { title: 'One', penName: 'Ann Pen', seriesId: null, position: null, editions: [{ asin: 'B0AAAAAAA1' }] },
        { title: 'Two', penName: 'Ann Pen', seriesId: null, position: null, editions: [{ asin: null }, { asin: 'B0AAAAAAA9' }] },
        { title: 'Unpublished', seriesId: null, position: null, editions: [{ asin: null }] }
      ],
      series: []
    });
    expect(kit.books.map((b) => [b.asin, b.title, b.penNames])).toEqual([['B0AAAAAAA1', 'One', ['Ann Pen']], ['B0AAAAAAA9', 'Two', ['Ann Pen']]]);
  });
});
