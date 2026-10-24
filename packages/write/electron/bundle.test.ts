import { build } from 'esbuild';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main-process bundle', () => {
  it('has no import.meta (an ESM-only dependency would crash the CommonJS main at startup, silently)', async () => {
    for (const entry of ['main.ts', 'preload.ts']) {
      const out = await build({
        entryPoints: [path.resolve(__dirname, entry)],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        external: ['electron'],
        write: false,
        logLevel: 'error'
      });
      const code = out.outputFiles[0].text;
      expect(code.includes('import.meta'), `${entry} bundles import.meta`).toBe(false);
    }
  }, 60_000);
});
