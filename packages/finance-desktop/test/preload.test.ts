import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNELS as MARKET } from '@cadrel/market-desktop/src/shared/api.js';
import { CHANNELS } from '../src/shared/api.js';

// The preload is sandboxed and keeps its own copy of the list; a channel missing from it shows up as "api.x is not a function".
describe('Finance bridge', () => {
  it('exposes every channel the app declares, and no other', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/preload/index.cts'), 'utf8');
    const block = src.slice(src.indexOf('const channels = ['), src.indexOf('];'));
    const preload = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...preload].sort()).toEqual([...CHANNELS].sort());
  });

  it('shares no money channel with Market: what moved out of Market is not still in it', () => {
    const shared = new Set(['ownBooks', 'openBook', 'ready']);
    const money = CHANNELS.filter((c) => !shared.has(c));
    expect(money.length).toBeGreaterThan(30);
    expect(money.filter((c) => (MARKET as readonly string[]).includes(c))).toEqual([]);
  });

  it('keeps the money screens out of Market’s renderer and Market’s view of the library free of money calls', () => {
    const market = path.resolve(__dirname, '../../market-desktop/src');
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)));
    })(path.join(market, 'renderer'));
    const names = ['moneyMonths', 'moneyAnalysis', 'payoutRollup', 'recordPayout', 'setBookSplit', 'importSales', 'exportStatement', 'allocatePayment', 'setFxRate', 'setKenpRate'];
    for (const f of files.filter((x) => /\.(tsx?|cts)$/.test(x))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const n of names) expect(text.includes(`api.${n}`), `${path.relative(market, f)} calls ${n}`).toBe(false);
    }
    expect(fs.existsSync(path.join(market, 'renderer/views/Royalties.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(market, 'renderer/views/Payouts.tsx'))).toBe(false);
  });
});
