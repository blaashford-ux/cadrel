import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TextLine {
  text: string;
  /** Left edge / right edge in points from the left of the page. */
  x0: number;
  x1: number;
  /** Baseline in points from the *top* of the page. */
  y: number;
}
export interface PdfPage {
  width: number;
  height: number;
  lines: TextLine[];
}

/** Extracts the size and positioned text lines of every page (pdf.js, no rendering needed). */
export async function analyzePdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [, , width, height] = page.view;
    const content = await page.getTextContent();
    // group runs that share a baseline into lines
    const byY = new Map<number, { x0: number; x1: number; parts: { x: number; s: string }[] }>();
    for (const it of content.items as { str: string; transform: number[]; width: number }[]) {
      if (!it.str.trim()) continue;
      const y = Math.round((height - it.transform[5]) * 2) / 2;
      const x = it.transform[4];
      const row = byY.get(y) ?? { x0: Infinity, x1: -Infinity, parts: [] };
      row.x0 = Math.min(row.x0, x);
      row.x1 = Math.max(row.x1, x + it.width);
      row.parts.push({ x, s: it.str });
      byY.set(y, row);
    }
    const lines = [...byY.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([y, r]) => ({ y, x0: r.x0, x1: r.x1, text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim() }));
    pages.push({ width, height, lines });
    page.cleanup();
  }
  await task.destroy();
  return pages;
}

/** Output of poppler's `pdffonts`, or null if it isn't installed. */
export function pdfFonts(bytes: Uint8Array): { name: string; embedded: boolean }[] | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdffonts-'));
  try {
    const f = path.join(dir, 'x.pdf');
    writeFileSync(f, bytes);
    const r = spawnSync('pdffonts', [f], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout
      .split('\n')
      .slice(2)
      .filter((l) => l.trim())
      .map((l) => {
        const cols = l.trim().split(/\s+/);
        const emb = cols.findIndex((c) => c === 'yes' || c === 'no');
        return { name: cols[0], embedded: cols[emb] === 'yes' };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
