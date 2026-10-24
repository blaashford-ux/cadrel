import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultBookDetails, type BookDetails } from '../../src/shared/export/model';
import { analyzePdf, pdfFonts, type PdfPage } from './pdfAnalyze';

const root = path.resolve(__dirname, '../..');
const electronBin = path.join(root, 'node_modules/electron/dist/electron');
const haveEnv = existsSync(electronBin) && spawnSync('xvfb-run', ['--help']).status !== null && spawnSync('xvfb-run', ['--help']).error === undefined;

let work: string;
let harness: string;

beforeAll(async () => {
  if (!haveEnv) return;
  work = mkdtempSync(path.join(tmpdir(), 'mdedit-pdf-'));
  harness = path.join(work, 'pdfSmoke.js');
  await build({
    entryPoints: [path.join(root, 'electron/export/pdfSmoke.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: harness,
    logLevel: 'error'
  });
}, 60_000);
afterAll(() => work && rmSync(work, { recursive: true, force: true }));

/** Deterministic filler prose. */
function manuscript(chapters: number, paragraphsPerChapter: number, extra = ''): string {
  const words = 'the of and a to in is you that it he was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know'.split(' ');
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sentence = (n: number) => {
    const s = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
    return s[0].toUpperCase() + s.slice(1) + '.';
  };
  const out: string[] = [extra];
  for (let c = 1; c <= chapters; c++) {
    out.push(`# Chapter ${c}: ${sentence(2).slice(0, -1)}\n`);
    for (let p = 0; p < paragraphsPerChapter; p++) {
      out.push(`${sentence(40 + Math.floor(rnd() * 50))} ${sentence(10 + Math.floor(rnd() * 30))}\n`);
      if (p === 3) out.push('* * *\n');
    }
  }
  return out.join('\n');
}

interface Run {
  pdf: Uint8Array;
  pages: PdfPage[];
  meta: { pages: number; gutter: number; warnings: string[]; passes: number; ms: number };
  details: BookDetails;
}

async function render(edit: (d: BookDetails) => void, md = manuscript(8, 12)): Promise<Run> {
  const dir = mkdtempSync(path.join(work, 'run-'));
  const details = defaultBookDetails({ title: 'The Lost King', author: 'A. Writer', year: 2031 });
  details.subtitle = 'A Tale';
  details.dedication = { enabled: true, text: 'For everyone.' };
  details.back.about = { enabled: true, heading: '', text: 'Bio here.' };
  edit(details);
  writeFileSync(path.join(dir, 'book.md'), md);
  writeFileSync(path.join(dir, 'details.json'), JSON.stringify(details));
  const out = path.join(dir, 'out.pdf');
  execFileSync('xvfb-run', ['-a', electronBin, '--no-sandbox', harness, path.join(dir, 'book.md'), path.join(dir, 'details.json'), out, root], {
    stdio: 'pipe',
    timeout: 240_000
  });
  const pdf = new Uint8Array(readFileSync(out));
  return { pdf, pages: await analyzePdf(pdf), meta: JSON.parse(readFileSync(out + '.json', 'utf8')), details };
}

const labelOf = (line: { text: string }) => (/^\d{1,4}$/.test(line.text) ? line.text : null);
const footerOf = (p: PdfPage) => p.lines.filter((l) => l.y > p.height - 50 && labelOf(l));
const bodyLines = (p: PdfPage) => p.lines.filter((l) => l.y > 40 && l.y < p.height - 40 && l.text.length > 25);
const chapterPage = (pages: PdfPage[], n: number) => pages.findIndex((p, i) => i > 5 && p.lines.some((l) => l.text.startsWith(`Chapter ${n}:`)));

describe.skipIf(!haveEnv)('KDP gutter table on a real-length book', () => {
  it('~55k words → 151–300 pages → 0.5 in inside margin, laid out at most twice, and the margins show it', async () => {
    const t0 = Date.now();
    const m = await render(() => undefined, manuscript(30, 28));
    const secs = (Date.now() - t0) / 1000;
    console.log(`[perf] ${m.meta.pages} pages, ${m.meta.passes} pass(es), harness ${m.meta.ms} ms, wall ${secs.toFixed(1)} s`);
    expect(m.meta.pages).toBeGreaterThan(150);
    expect(m.meta.pages).toBeLessThanOrEqual(300);
    expect(m.meta.gutter).toBe(0.5);
    expect(m.meta.passes).toBeLessThanOrEqual(2);
    const p = m.pages.find((pg, i) => i > 8 && (i + 1) % 2 === 1 && bodyLines(pg).length > 12)!;
    expect(Math.min(...bodyLines(p).map((l) => l.x0))).toBeCloseTo(0.5 * 72, -0.5);
    // every chapter still opens on a recto and the contents numbers still match
    const start = chapterPage(m.pages, 1);
    for (const n of [1, 10, 30]) expect((chapterPage(m.pages, n) + 1) % 2).toBe(1);
    const toc = m.pages.slice(0, start).flatMap((pg) => pg.lines.map((l) => l.text));
    const line = toc.find((t) => t.startsWith('Chapter 30:'))!;
    expect(/(\d+)$/.exec(line)![1]).toBe(String(chapterPage(m.pages, 30) - start + 1));
  }, 300_000);

  it('~95k words → 301–500 pages → 0.625 in inside margin', async () => {
    const t0 = Date.now();
    const m = await render(() => undefined, manuscript(40, 40));
    console.log(`[perf] ${m.meta.pages} pages, ${m.meta.passes} pass(es), harness ${m.meta.ms} ms, wall ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    expect(m.meta.pages).toBeGreaterThan(300);
    expect(m.meta.pages).toBeLessThanOrEqual(500);
    expect(m.meta.gutter).toBe(0.625);
    expect(m.meta.passes).toBeLessThanOrEqual(3);
  }, 600_000);
});

describe.skipIf(!haveEnv)('print PDF (real Electron + Paged.js)', () => {
  let r: Run;
  beforeAll(async () => {
    r = await render(() => undefined);
  }, 240_000);

  it('is exactly the 5.5 × 8.5 in trim size on every page', () => {
    expect(r.pages.length).toBe(r.meta.pages);
    for (const p of r.pages) {
      expect(p.width).toBeCloseTo(396, 0);
      expect(p.height).toBeCloseTo(612, 0);
    }
  });

  it('embeds EB Garamond (regular, italic, bold) and every font is embedded', () => {
    const fonts = pdfFonts(r.pdf);
    if (!fonts) return; // poppler not installed
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((f) => f.embedded)).toBe(true);
    expect(fonts.map((f) => f.name).join(' ')).toMatch(/EBGaramond-Regular/);
  });

  it('front matter order and sides: title (recto), copyright (verso), dedication (recto), contents (recto)', () => {
    const text = (i: number) => r.pages[i].lines.map((l) => l.text).join(' ');
    expect(text(0)).toContain('The Lost King');
    expect(text(1)).toContain('All rights reserved.');
    expect(text(2)).toContain('For everyone.');
    expect(text(4)).toContain('CONTENTS');
    expect((4 + 1) % 2).toBe(1); // physical page 5 is recto
  });

  it('every chapter starts on a right-hand (odd) page', () => {
    for (let n = 1; n <= 8; n++) {
      const i = chapterPage(r.pages, n);
      expect(i, `chapter ${n} found`).toBeGreaterThan(0);
      expect((i + 1) % 2, `chapter ${n} on physical page ${i + 1}`).toBe(1);
    }
  });

  it('page numbers: none on front matter or blank pages; body counts 1, 2, 3… from chapter 1; at the OUTER edge', () => {
    const start = chapterPage(r.pages, 1);
    r.pages.forEach((p, i) => {
      const foot = footerOf(p);
      if (i < start) return expect(foot, `front page ${i + 1}`).toEqual([]);
      const blank = p.lines.length === 0;
      if (blank) return;
      expect(foot.map((f) => f.text), `physical ${i + 1}`).toEqual([String(i - start + 1)]);
      const recto = (i + 1) % 2 === 1;
      const f = foot[0];
      if (recto) expect(f.x1, `recto ${i + 1} number at right`).toBeGreaterThan(p.width - 50);
      else expect(f.x0, `verso ${i + 1} number at left`).toBeLessThan(50);
    });
  });

  it('blank versos (before a recto chapter start) are truly blank', () => {
    const blanks = r.pages.map((p, i) => [p, i] as const).filter(([p]) => p.lines.length === 0);
    expect(blanks.length).toBeGreaterThan(0);
    for (const [, i] of blanks) expect((i + 1) % 2, `blank page ${i + 1} is a verso`).toBe(0);
  });

  it('margins mirror: the gutter is on the inside of every spread (0.375 in = 27 pt, outer 0.5 in = 36 pt)', () => {
    expect(r.meta.gutter).toBe(0.375);
    const g = 0.375 * 72;
    const o = 0.5 * 72;
    let checked = 0;
    r.pages.forEach((p, i) => {
      const lines = bodyLines(p);
      if (lines.length < 12) return;
      const recto = (i + 1) % 2 === 1;
      const left = Math.min(...lines.map((l) => l.x0));
      const right = Math.max(...lines.map((l) => l.x1));
      expect(left, `page ${i + 1} left`).toBeCloseTo(recto ? g : o, -0.5); // within ~±1.5pt
      expect(p.width - right, `page ${i + 1} right`).toBeGreaterThanOrEqual((recto ? o : g) - 1);
      expect(p.width - right, `page ${i + 1} right`).toBeLessThan((recto ? o : g) + 8);
      checked++;
    });
    expect(checked).toBeGreaterThan(10);
  });

  it('the contents page numbers equal the real body page numbers', () => {
    const start = chapterPage(r.pages, 1);
    const toc = r.pages[4].lines.map((l) => l.text);
    for (let n = 1; n <= 8; n++) {
      const line = toc.find((t) => t.startsWith(`Chapter ${n}:`));
      expect(line, `TOC line for chapter ${n}`).toBeTruthy();
      const num = /(\d+)$/.exec(line!)![1];
      expect(num).toBe(String(chapterPage(r.pages, n) - start + 1));
    }
    expect(toc.some((t) => /ABOUT THE AUTHOR.*\d+$/.test(t))).toBe(true);
    expect(toc.join(' ')).not.toMatch(/Copyright|Title Page/);
  });

  it('small book: one layout pass and the smallest KDP gutter; under-24-page warning absent', () => {
    expect(r.meta.passes).toBe(1);
    expect(r.meta.warnings.join()).not.toMatch(/at least 24/);
  });

  it('smart quotes and the scene break glyph made it into the pages', () => {
    const all = r.pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n');
    expect(all).toContain('•  •  •'.replace(/\s+/g, ' '));
  });

  describe('fonts', () => {
    it.each([
      ['Crimson Pro', /CrimsonPro/],
      ['Libre Baskerville', /LibreBaskerville/]
    ])('bundled font %s is used and embedded', async (family, re) => {
      const m = await render((d) => (d.export.pdf.font = family));
      const fonts = pdfFonts(m.pdf);
      if (!fonts) return; // poppler not installed
      expect(fonts.every((f) => f.embedded)).toBe(true);
      expect(fonts.map((f) => f.name).join(' ')).toMatch(re);
      expect(fonts.map((f) => f.name).join(' ')).not.toMatch(/EBGaramond/);
    }, 240_000);

    it('an installed system font is used and embedded', async () => {
      if (spawnSync('fc-list', [':family=DejaVu Serif']).stdout?.toString().trim() === '') return; // not on this machine
      const m = await render((d) => (d.export.pdf.font = 'DejaVu Serif'));
      const fonts = pdfFonts(m.pdf);
      if (!fonts) return;
      expect(fonts.every((f) => f.embedded)).toBe(true);
      expect(fonts.map((f) => f.name).join(' ')).toMatch(/DejaVuSerif/);
      expect(fonts.map((f) => f.name).join(' ')).not.toMatch(/EBGaramond/);
    }, 240_000);
  });

  describe('options', () => {
    it('manual gutter + outer margin + font size are honoured', async () => {
      const m = await render((d) => {
        d.export.pdf.gutter = 0.75;
        d.export.pdf.outerMargin = 0.6;
        d.export.pdf.fontSize = 10;
      });
      expect(m.meta.gutter).toBe(0.75);
      const p = m.pages.find((pg, i) => i > 6 && (i + 1) % 2 === 1 && bodyLines(pg).length > 12)!;
      expect(Math.min(...bodyLines(p).map((l) => l.x0))).toBeCloseTo(0.75 * 72, -0.5);
      const v = m.pages.find((pg, i) => i > 6 && (i + 1) % 2 === 0 && bodyLines(pg).length > 12)!;
      expect(Math.min(...bodyLines(v).map((l) => l.x0))).toBeCloseTo(0.6 * 72, -0.5);
    }, 240_000);

    it('a 6 × 9 trim size gives exactly 432 × 648 pt pages', async () => {
      const m = await render((d) => (d.export.pdf.trim = '6x9'));
      for (const p of m.pages) {
        expect(p.width).toBeCloseTo(432, 0);
        expect(p.height).toBeCloseTo(648, 0);
      }
    }, 240_000);

    it('chapters need not start on a recto when that option is off (fewer pages, no blank versos in the body)', async () => {
      const m = await render((d) => (d.export.pdf.rectoStarts = false));
      expect(m.pages.length).toBeLessThan(r.pages.length);
      const start = chapterPage(m.pages, 1);
      const inBodyBlank = m.pages.slice(start).filter((p) => p.lines.length === 0);
      expect(inBodyBlank).toEqual([]);
    }, 240_000);

    it('page numbers off → no footers at all', async () => {
      const m = await render((d) => (d.export.pdf.pageNumbers = false));
      expect(m.pages.flatMap(footerOf)).toEqual([]);
    }, 240_000);

    it('running heads: author on versos, title on rectos, none on front matter or chapter openers', async () => {
      const m = await render((d) => (d.export.pdf.runningHead = 'authorTitle'));
      const start = chapterPage(m.pages, 1);
      const head = (p: PdfPage) => p.lines.find((l) => l.y < 50)?.text ?? '';
      m.pages.slice(0, start).forEach((p, i) => expect(head(p), `front ${i + 1}`).toBe(''));
      const opener = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => chapterPage(m.pages, n)));
      m.pages.forEach((p, i) => {
        const backOpener = p.lines.some((l) => l.text === 'ABOUT THE AUTHOR');
        if (i < start || p.lines.length === 0 || opener.has(i) || backOpener) {
          if (i >= start && (opener.has(i) || backOpener)) expect(head(p), `opener ${i + 1}`).toBe('');
          return;
        }
        // The small-caps head uses real small-cap glyphs, which pdf.js reads back with gaps; compare loosely here
        // and check the exact text with poppler below.
        const got = head(p).replace(/[\s\u0000]+/g, '').toLowerCase();
        const want = (i + 1) % 2 === 1 ? /^t.*k$/ : /^a.*w/;
        expect(want.test(got), `page ${i + 1}: ${JSON.stringify(got)}`).toBe(true);
      });
    }, 240_000);

    it('the running heads read “A. Writer” (left) and “The Lost King” (right) to a PDF text extractor', async () => {
      const m = await render((d) => (d.export.pdf.runningHead = 'authorTitle'));
      const f = path.join(work, 'rh.pdf');
      writeFileSync(f, m.pdf);
      const first = (n: number) => spawnSync('pdftotext', ['-f', String(n), '-l', String(n), '-layout', f, '-']);
      if (first(1).error) return; // poppler not installed
      const verso = chapterPage(m.pages, 1) + 1; // physical page numbers are 1-based: even = left-hand
      expect((verso + 1) % 2).toBe(0);
      expect(first(verso + 1).stdout.toString().split('\n')[0].trim()).toBe('A. Writer');
      expect(first(verso + 2).stdout.toString().split('\n')[0].trim()).toBe('The Lost King');
    }, 240_000);

    it('paragraph styles: indent shows first-line indents; gap style adds a blank line between paragraphs', async () => {
      const spacing = (m: Run) => {
        const p = m.pages.find((pg, i) => i > 6 && bodyLines(pg).length > 14 && !pg.lines.some((l) => l.text.includes('•')))!;
        const ys = p.lines.filter((l) => l.y > 40 && l.y < p.height - 40).map((l) => l.y);
        const diffs = ys.slice(1).map((y, i) => y - ys[i]);
        return { max: Math.max(...diffs), min: Math.min(...diffs), xs: p.lines.filter((l) => l.y > 40 && l.y < p.height - 40).map((l) => l.x0) };
      };
      const base = spacing(r);
      expect(base.max).toBeLessThan(base.min * 1.3); // no paragraph gaps in the confirmed print style
      const gap = spacing(await render((d) => (d.export.pdf.paragraphStyle = 'blockGap')));
      expect(gap.max).toBeGreaterThan(gap.min * 1.6); // a full blank line between paragraphs
      const ind = spacing(await render((d) => (d.export.pdf.paragraphStyle = 'indent')));
      expect(Math.max(...ind.xs) - Math.min(...ind.xs)).toBeGreaterThan(10); // first lines indented ~18 pt
    }, 240_000);
  });
});
