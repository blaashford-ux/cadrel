import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Tracker pages are shown inside the apps in a sandboxed frame. A frame made from text inherits the app's
// Content-Security-Policy, which allows no inline scripts, so the policy lists the hash of each shipped page's script.
const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PAGES = [
  'skills/cadrel-timeline-tracker/assets/timeline-view.html',
  'skills/cadrel-litrpg-tracker/assets/litrpg-dashboard.html',
  'skills/cadrel-litrpg-tracker/assets/character-sheet.html',
  'skills/cadrel-litrpg-tracker/assets/chapter-record.html'
];
const INDEXES = ['src/renderer/index.html', 'src/mobile/index.html', '../reader/src/renderer/index.html', '../reader/src/mobile/index.html'];

const hashes = PAGES.flatMap((f) =>
  [...readFileSync(here(f), 'utf8').matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`
  )
);

describe('tracker pages under the apps’ content security policy', () => {
  it('each page has exactly one script to allow', () => {
    expect(hashes).toHaveLength(PAGES.length);
  });
  for (const index of INDEXES) {
    it(`${index} allows each page's script by hash`, () => {
      const csp = /Content-Security-Policy"\s+content="([^"]*)"/.exec(readFileSync(here(index), 'utf8'))?.[1] ?? '';
      const script = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
      for (const h of hashes) expect(script).toContain(h);
      expect(script).not.toContain('unsafe-inline');
      expect(script).not.toContain('unsafe-eval');
    });
  }
});
