import fs from 'node:fs';
import zlib from 'node:zlib';
import { detectKind, type IngestResult, type Library, type PageKind } from './library.js';

/** The address a browser recorded in a page it saved: Chrome's "saved from url" comment, else the canonical link. */
export function savedPageUrl(html: string): string | null {
  const head = html.slice(0, 200_000);
  const saved = head.match(/<!--\s*saved from url=\(\d+\)(\S+)\s*-->/i)?.[1];
  const canonical = head.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? head.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1];
  return [saved, canonical].find((u) => u && /^https?:\/\/(?:www\.)?amazon\.com\//.test(u) && detectKind(u)) ?? saved ?? canonical ?? null;
}

export interface SavedPageResult extends IngestResult { file: string; url: string }

/**
 * Import a page saved from the browser ("Save page as", or its HTML copied out) as if the extension had captured it: book, list, search and
 * author "All Books" pages are told apart by their address. The page is scrubbed of the signed-in person's details like any capture.
 * `capturedAt` defaults to the file's time, so a page saved yesterday is dated yesterday.
 */
export function importSavedPage(lib: Library, file: string, opts: { url?: string; kind?: PageKind; capturedAt?: string } = {}): SavedPageResult {
  const raw = fs.readFileSync(file);
  const html = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const url = opts.url ?? savedPageUrl(html);
  if (!url) throw new Error('cannot tell which Amazon page this is: pass its address (url)');
  const kind = opts.kind ?? detectKind(url);
  if (!kind) throw new Error(`not a book, list, search or author "All Books" page: ${url}`);
  const address = kind === 'author' ? url.split(/[?#]/)[0]!.replace(/\/$/, '') : url; // the query on a store page is only tracking
  const capturedAt = opts.capturedAt ?? fs.statSync(file).mtime.toISOString();
  return { ...lib.ingest({ kind, url: address, html, capturedAt }), file, url: address };
}
