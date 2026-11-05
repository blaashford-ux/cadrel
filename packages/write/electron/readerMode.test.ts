import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { READER_BLOCKED_CHANNELS } from './readerMode';

const source = readFileSync(path.join(__dirname, 'module.ts'), 'utf8');
const registered = new Set([...source.matchAll(/\bhandle\('([^']+)'/g)].map((m) => m[1]));

describe('what Cadrel Reader takes away', () => {
  it('names only channels the module really registers (so a rename cannot leave one open)', () => {
    expect(READER_BLOCKED_CHANNELS.filter((c) => !registered.has(c))).toEqual([]);
  });

  it('lists each channel once', () => {
    expect(new Set(READER_BLOCKED_CHANNELS).size).toBe(READER_BLOCKED_CHANNELS.length);
  });

  it('takes away every channel that writes, exports, shares as an author, connects an AI or manages projects', () => {
    const authorSide = [...registered].filter((c) => /^(export:|ai:|projects:(create|update|rename|duplicate|delete|convert|addMissing|move)$|review:(shareStatus|invite|shareChapters|revoke|listShares|stop)$|fs:(writeFile|createFile|createFolder|renameNode|trashNode|importDocx)$)/.test(c));
    expect(authorSide.filter((c) => !READER_BLOCKED_CHANNELS.includes(c))).toEqual([]);
  });

  it('leaves what reading and giving feedback need', () => {
    for (const keep of ['fs:readFile', 'fs:scanFolder', 'review:save', 'review:list', 'review:exchange', 'review:listShared', 'review:join', 'review:pickerToken', 'sync:connect', 'update:check', 'drafts:save']) {
      expect(READER_BLOCKED_CHANNELS).not.toContain(keep);
    }
  });
});
