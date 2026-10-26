import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../memoryFs';
import { makeReviews } from './reviews';

describe('review files', () => {
  it('saves one file per reviewer and lists them all', async () => {
    const fs = new MemoryFs();
    fs.seed('/p/readme.md', 'x');
    const r = makeReviews(fs);
    expect(await r.list('/p')).toEqual([]);
    await r.save('/p', 'sam', '{"a":1}');
    await r.save('/p', 'me', '{"b":2}');
    await r.save('/p', 'sam', '{"a":3}');
    expect(await r.list('/p')).toEqual([
      { id: 'me', text: '{"b":2}' },
      { id: 'sam', text: '{"a":3}' },
    ]);
  });

  it('keeps ids to safe characters and refuses an empty one', async () => {
    const r = makeReviews(new MemoryFs());
    await expect(r.save('/p', '../..', 'x')).rejects.toThrow();
    await r.save('/p', 'a/b', 'x');
    expect((await r.list('/p'))[0].id).toBe('ab');
  });
});
