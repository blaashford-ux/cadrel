import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommunityStore } from './communityStore';

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))));
const file = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'community-'));
  dirs.push(d);
  return path.join(d, 'community-links.json');
};

describe('the Studio’s community links', () => {
  it('start empty, are saved whole, and are found again after a restart', async () => {
    const f = await file();
    const s = new CommunityStore(f);
    expect(await s.list()).toEqual([]);
    const saved = await s.save([{ name: 'Reader Discord', url: 'discord.gg/readers' }, { name: 'Group', url: 'https://example.com/g' }]);
    expect(saved.map((x) => x.url)).toEqual(['https://discord.gg/readers', 'https://example.com/g']);
    expect(await new CommunityStore(f).list()).toEqual(saved);
    expect(await s.save([saved[1]!])).toEqual([saved[1]]); // removing one is saving the list without it
  });
  it('refuse a bad list and keep what was there', async () => {
    const s = new CommunityStore(await file());
    const ok = await s.save([{ name: 'A', url: 'https://a.com' }]);
    await expect(s.save([{ name: 'B', url: 'javascript:alert(1)' }])).rejects.toThrow(/web address/);
    expect(await s.list()).toEqual(ok);
  });
});
