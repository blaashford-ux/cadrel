import { describe, expect, it } from 'vitest';
import { checkCommunities, communitiesFor, sanitizeCommunities, CommunityError } from './community';

let n = 0;
const id = () => `new${++n}`;

describe('community links', () => {
  it('check puts https:// on a bare address, keeps ids, gives new ones ids, and keeps the order', () => {
    const r = checkCommunities([{ id: 'a', name: ' Reader  Discord ', url: 'discord.gg/readers' }, { name: 'Group', url: 'http://example.com/g' }], id);
    expect(r).toEqual([{ id: 'a', name: 'Reader Discord', url: 'https://discord.gg/readers' }, { id: 'new1', name: 'Group', url: 'http://example.com/g' }]);
  });
  it('check says which one is wrong, rather than dropping it', () => {
    expect(() => checkCommunities([{ name: '', url: 'https://a.com' }], id)).toThrow(/Community 1 needs a name/);
    expect(() => checkCommunities([{ name: 'X', url: '' }], id)).toThrow(/Community 1 \(X\) needs a web address/);
    for (const bad of ['javascript:alert(1)', 'ftp://a.com/x', 'mailto:a@b.com', 'not a link']) expect(() => checkCommunities([{ name: 'X', url: bad }], id), bad).toThrow(CommunityError);
    expect(() => checkCommunities('no' as unknown, id)).toThrow(/list/);
  });
  it('check never gives two the same id', () => {
    const r = checkCommunities([{ id: 'a', name: 'One', url: 'https://a.com' }, { id: 'a', name: 'Two', url: 'https://b.com' }], id);
    expect(new Set(r.map((x) => x.id)).size).toBe(2);
  });
  it('a saved file is read defensively: bad entries and addresses are dropped', () => {
    const r = sanitizeCommunities({ links: [{ id: 'a', name: 'Ok', url: 'https://a.com' }, { id: 'b', name: 'Bad', url: 'javascript:x' }, { id: 'a', name: 'Dup', url: 'https://d.com' }, { name: 'no id', url: 'https://e.com' }] });
    expect(r.map((x) => x.name)).toEqual(['Ok']);
    expect(sanitizeCommunities('junk')).toEqual([]);
  });
  it('a book includes every community except those it switched off', () => {
    const all = [{ id: 'a', name: 'A', url: 'https://a.com' }, { id: 'b', name: 'B', url: 'https://b.com' }];
    expect(communitiesFor(all, [])).toHaveLength(2);
    expect(communitiesFor(all, ['a', 'gone']).map((x) => x.id)).toEqual(['b']);
  });
});
