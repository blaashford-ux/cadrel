import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

export function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/[‎‏​]/g, '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

export function parsePrice(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d[\d,]*\.\d{2})/);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

export function parseIntLoose(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d[\d,]*)/);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "August 12, 2026" -> "2026-08-12". */
export function parseLongDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1]!.toLowerCase());
  if (mo < 0) return null;
  return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

export function marketplaceFromUrl(url: string | null | undefined): string | null {
  const m = url?.match(/^https?:\/\/(?:www\.)?(amazon\.[a-z.]+)\//i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * A saved page source is often several documents back to back (above-the-fold, then below-the-fold).
 * A live DOM capture is one document. Both are accepted; the result is one parsed tree per document.
 */
export function loadDocs(html: string): CheerioAPI[] {
  const parts = html.split(/(?=<!doctype html)/i).filter((p) => p.trim() !== '');
  return (parts.length ? parts : [html]).map((p) => cheerio.load(p));
}

/** Query across several documents; first match wins. */
export class Docs {
  constructor(readonly trees: CheerioAPI[]) {}
  first(sel: string) {
    for (const $ of this.trees) {
      const el = $(sel).first();
      if (el.length) return el;
    }
    return null;
  }
  all(sel: string) {
    return this.trees.flatMap(($) => $(sel).toArray().map((el) => $(el)));
  }
}
