// The one thing jsdom cannot say: that a design drawn in a real browser comes out as the picture the person saw. A design is drawn through the
// same SVG, canvas and PNG path the app uses, in Chromium, and the picture is read back. Skipped where no Chromium can be launched.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FONTS = path.resolve(__dirname, '../assets/cover-fonts');
type Browser = { close(): Promise<void>; newPage(): Promise<Page> };
type Page = { evaluate<T, A>(fn: (a: A) => T | Promise<T>, arg: A): Promise<T>; setContent(h: string): Promise<void>; addScriptTag(o: { content: string; type?: string }): Promise<unknown>; on(e: string, f: (m: { text(): string }) => void): void };

async function launch(): Promise<Browser | null> {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const { chromium } = (await import(mod)) as { chromium: { launch(o?: object): Promise<Browser> } };
      for (const o of [{}, { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }]) {
        try { return await chromium.launch(o); } catch { /* try the next way */ }
      }
    } catch { /* not installed */ }
  }
  return null;
}

let browser: Browser | null = null;
let page: Page;
let ready = false;
const b64 = (rel: string) => readFileSync(path.join(FONTS, rel)).toString('base64');

beforeAll(async () => {
  browser = await launch();
  if (!browser) return;
  const out = await build({ entryPoints: [path.resolve(__dirname, 'coverBrowserEntry.ts')], bundle: true, format: 'esm', write: false, platform: 'browser', target: 'es2022', logLevel: 'silent', loader: { '.css': 'empty' } });
  page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ type: 'module', content: out.outputFiles[0]!.text });
  await page.evaluate(async (fonts) => {
    // the bridge the runtime asks for fonts through, answered from the files
    (window as unknown as { cadrel: unknown }).cadrel = { cover: { fonts: async (families: string[]) => families.flatMap((f) => (fonts as Record<string, { weight: number; dataUrl: string }[]>)[f] ?? []).map((x) => ({ ...x })) } };
  }, {});
  ready = true;
}, 120_000);
afterAll(async () => void (await browser?.close()));

// the fonts are read in Node and handed to the page, as the app's main process hands them over
const fontData = () => ({
  Cinzel: [{ family: 'Cinzel', weight: 700, dataUrl: `data:font/woff2;base64,${b64('cinzel/latin-700-normal.woff2')}` }, { family: 'Cinzel', weight: 400, dataUrl: `data:font/woff2;base64,${b64('cinzel/latin-400-normal.woff2')}` }]
});

const run = <T>(fn: (a: { fonts: ReturnType<typeof fontData> }) => Promise<T>) => page.evaluate(fn as never, { fonts: fontData() }) as Promise<T>;

describe('drawn in a real browser', () => {
  it('comes out at the design’s size with the right pixels: a lit title, a darkened band, an unmistakable background', async (ctx) => {
    if (!ready) return ctx.skip();
    const r = await run(async ({ fonts }) => {
      const c = (window as any).cover;
      (window as any).cadrel = { cover: { fonts: async (f: string[]) => f.flatMap((x) => (fonts as any)[x] ?? []) } };
      const book = new c.FontBook();
      await book.ensure(['Cinzel']);
      const pics = new c.Pictures(async () => { throw new Error('none'); });
      const measure = c.makeMeasure();
      let d = c.newDesign('ebook', { w: 600, h: 960 });
      d = { ...d, background: { type: 'solid', color: '#101820' } };
      const t = c.newText('DRAGON', { font: 'Cinzel', weight: 700, size: 0.14, align: 'center', fill: { type: 'solid', color: '#ffe9a8' }, frame: { x: 0.05, y: 0.4, w: 0.9, h: 0.15, rot: 0 } });
      d = c.addLayer(d, t);
      const plain = await c.drawDesign(d, pics, book, measure, 1);
      const withBand = await c.drawDesign(c.addScrim(d, t.id, { dir: 'around', strength: 0.9, color: '#ff0000' }).design, pics, book, measure, 1);
      const px = (cv: HTMLCanvasElement, x: number, y: number) => Array.from(cv.getContext('2d')!.getImageData(x, y, 1, 1).data);
      const avgRed = (cv: HTMLCanvasElement) => { const a = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data; let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i]!; return s / (a.length / 4); };
      // count the pixels near the title's colour: the glyphs are there
      const lit = (cv: HTMLCanvasElement) => { const a = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i]! > 200 && a[i + 1]! > 180 && a[i + 2]! > 100) n++; return n; };
      const png = await c.canvasPng(plain);
      return { w: plain.width, h: plain.height, corner: px(plain, 3, 3), litPlain: lit(plain), redPlain: avgRed(plain), redBand: avgRed(withBand), pngMagic: Array.from(png.slice(0, 4)), pngLen: png.length };
    });
    expect([r.w, r.h]).toEqual([600, 960]);
    expect(r.corner.slice(0, 3)).toEqual([16, 24, 32]); // the background, exactly
    expect(r.litPlain).toBeGreaterThan(800); // the title's letters are drawn
    expect(r.redBand).toBeGreaterThan(r.redPlain + 8); // the red band is on the cover, behind the words
    expect(r.pngMagic).toEqual([137, 80, 78, 71]);
  }, 120_000);

  it('uses the embedded font, not a stand-in: the same words in Cinzel and in a missing font are different pictures', async (ctx) => {
    if (!ready) return ctx.skip();
    const r = await run(async ({ fonts }) => {
      const c = (window as any).cover;
      (window as any).cadrel = { cover: { fonts: async (f: string[]) => f.flatMap((x) => (fonts as any)[x] ?? []) } };
      const book = new c.FontBook();
      await book.ensure(['Cinzel']);
      const pics = new c.Pictures(async () => { throw new Error('none'); });
      const measure = c.makeMeasure();
      const make = (font: string) => c.addLayer(c.newDesign('ebook', { w: 600, h: 400 }), c.newText('Quick Wizards', { font, weight: 700, size: 0.2, frame: { x: 0.05, y: 0.3, w: 0.9, h: 0.3, rot: 0 } }));
      const a = (await c.drawDesign(make('Cinzel'), pics, book, measure, 1)).toDataURL();
      const b = (await c.drawDesign(make('Not A Real Font'), pics, book, measure, 1)).toDataURL();
      // and the on-screen measure agrees with the font: Cinzel's capitals are wider than the stand-in's lower case
      const spec = (font: string) => ({ font, weight: 700, italic: false, px: 100, trackingPx: 0 });
      return { differ: a !== b, wideCinzel: measure('WIZARDS', spec('Cinzel')), wideOther: measure('WIZARDS', spec('Not A Real Font')) };
    });
    expect(r.differ).toBe(true);
    expect(r.wideCinzel).not.toBe(r.wideOther);
  }, 120_000);

  it('never puts the paperback template into the picture, however it is set', async (ctx) => {
    if (!ready) return ctx.skip();
    const r = await run(async ({ fonts }) => {
      const c = (window as any).cover;
      (window as any).cadrel = { cover: { fonts: async (f: string[]) => f.flatMap((x) => (fonts as any)[x] ?? []) } };
      const book = new c.FontBook();
      const pics = new c.Pictures(async (p: string) => {
        // a loud red picture standing in for the KDP template
        const cv = document.createElement('canvas'); cv.width = 50; cv.height = 40; const x = cv.getContext('2d')!; x.fillStyle = '#ff0000'; x.fillRect(0, 0, 50, 40);
        const blob: Blob = await new Promise((ok) => cv.toBlob((b) => ok(b!), 'image/png'));
        return { path: p, mime: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()), width: 50, height: 40, version: 1, hash: 'h' };
      });
      await pics.load('t.png');
      const measure = c.makeMeasure();
      const base = c.newDesign('paperback', { w: 500, h: 400 });
      const withT = { ...base, template: { src: { path: 't.png', hash: 'h' }, opacity: 0.9, hidden: false, back: 0.4, front: 0.6 } };
      const a = (await c.drawDesign(base, pics, book, measure, 1)).toDataURL();
      const b = (await c.drawDesign(withT, pics, book, measure, 1)).toDataURL();
      const front = await c.renderPictures(withT, pics, book, measure);
      const img = new Image(); img.src = URL.createObjectURL(new Blob([front.front], { type: 'image/png' })); await img.decode();
      return { same: a === b, frontW: img.naturalWidth, frontH: img.naturalHeight };
    });
    expect(r.same).toBe(true);
    expect(r).toMatchObject({ frontW: 200, frontH: 400 }); // from the front edge (60%) to the right
  }, 120_000);

  it('draws every effect and texture and every library piece without failing, and each changes the picture', async (ctx) => {
    if (!ready) return ctx.skip();
    const r = await run(async () => {
      const c = (window as any).cover;
      const book = new c.FontBook();
      const pics = new c.Pictures(async () => { throw new Error('none'); });
      const measure = c.makeMeasure();
      const flat = c.addLayer(c.newDesign('ebook', { w: 300, h: 300 }), c.newShape('rect', { frame: { x: 0.2, y: 0.2, w: 0.6, h: 0.6, rot: 0 }, fill: { type: 'solid', color: '#c9a24a' } }));
      const id = flat.layers[0].id;
      const base = (await c.drawDesign(flat, pics, book, measure, 1)).toDataURL();
      const out: Record<string, boolean> = {};
      const fxs: Record<string, any> = { glow: { glow: { color: '#00ffff', size: 0.02, strength: 1 } }, shadow: { shadow: { color: '#000', dx: 0.03, dy: 0.03, blur: 0.01, opacity: 1 } }, outline: { outline: { color: '#f00', width: 0.01 } }, blur: { blur: 0.01 }, opacity: { opacity: 0.3 }, blend: { blend: 'multiply' } };
      for (const t of ['grain', 'paper', 'brushed', 'foil', 'stone', 'cloth', 'distress']) fxs[`texture ${t}`] = { texture: { id: t, strength: 1, scale: 1 } };
      for (const [k, v] of Object.entries(fxs)) out[k] = (await c.drawDesign(c.patchFx(flat, id, v), pics, book, measure, 1)).toDataURL() !== base;
      // every library piece draws something
      for (const item of c.LIBRARY) {
        const d = c.addLayer(c.newDesign('ebook', { w: 300, h: 300 }), c.newShape('symbol', { symbol: item.id, frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 * (item.vb.h / item.vb.w), rot: 0 }, fill: { type: 'solid', color: '#ffffff' } }));
        const cv = await c.drawDesign({ ...d, background: { type: 'solid', color: '#000000' } }, pics, book, measure, 1);
        const a = cv.getContext('2d')!.getImageData(0, 0, 300, 300).data; let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i]! > 128) n++;
        out[`library ${item.id}`] = n > 40;
      }
      return out;
    });
    const failed = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failed).toEqual([]);
  }, 180_000);

  it('turns the first page of a PDF into a picture at 300 dpi (a KDP template comes as a PDF)', async (ctx) => {
    if (!ready) return ctx.skip();
    // one page, 612 × 792 points, with a red box at (100, 100) from the bottom left, 200 × 100
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>'];
    const stream = '1 0 0 rg 100 100 200 100 re f';
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    let pdf = '%PDF-1.4\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = [...Buffer.from(pdf, 'latin1')];
    const r = await page.evaluate(async (b: number[]) => {
      const c = (window as any).cover;
      const out = await c.rasterisePdf(Uint8Array.from(b));
      const img = new Image(); img.src = URL.createObjectURL(new Blob([out.png], { type: 'image/png' })); await img.decode();
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const x = cv.getContext('2d')!; x.drawImage(img, 0, 0);
      const s = 300 / 72;
      const at = (px: number, py: number) => Array.from(x.getImageData(Math.round(px * s), Math.round(py * s), 1, 1).data);
      // the box covers x 100..300 and, from the top, y 792-200..792-100 = 592..692 points
      return { w: out.width, h: out.height, pages: out.pages, inside: at(200, 642), outside: at(50, 50), pngW: img.naturalWidth };
    }, bytes as never);
    expect([r.w, r.h, r.pngW, r.pages]).toEqual([2550, 3300, 2550, 1]);
    expect(r.inside.slice(0, 3)).toEqual([255, 0, 0]);
    expect(r.outside.slice(0, 3)).toEqual([255, 255, 255]);
  }, 120_000);
});
