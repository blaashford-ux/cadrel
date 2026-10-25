import type * as FontList from 'font-list';

// `require` (not `import`): the package's ESM build uses import.meta, which breaks in our CommonJS main bundle.
const { getFonts } = require('font-list') as typeof FontList;

let cache: Promise<string[]> | null = null;

/** Normalises what the OS reports: unique, sorted, no empty names, no quotes. */
export function tidyFontNames(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const n = raw.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    if (n && !n.startsWith('.') && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Font families installed on this computer (cached for the session). Empty if the OS can't say. */
export function listInstalledFonts(): Promise<string[]> {
  cache ??= getFonts({ disableQuoting: true })
    .then(tidyFontNames)
    .catch(() => []);
  return cache;
}
