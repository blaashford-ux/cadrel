import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../src/shared/api.js';

// The preload script is sandboxed and cannot import the shared list, so it keeps its own copy. A channel missing from it
// shows up in the app as "api.x is not a function" (exportData and importData once did).
describe('preload', () => {
  it('exposes every channel the app declares, and no other', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/preload/index.cts'), 'utf8');
    const block = src.slice(src.indexOf('const channels = ['), src.indexOf('];'));
    const preload = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...preload].sort()).toEqual([...CHANNELS].sort());
  });
});
