import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { normalizeText, unwrap } from './normalize.js';

export interface OcrPage {
  text: string;
  /** Tesseract's mean word confidence, 0 to 100. */
  confidence: number;
}

export interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Lines that belong to the reader, not the book. */
const CHROME = /^\s*(?:\d{1,3}\s?%|page\s+\d+(?:\s+of\s+\d+)?|location\s+\d+.*|\d+\s+of\s+\d+|kindle\s+(?:cloud\s+)?reader.*|sample)\s*$/i;

/** Hard-wrapped OCR output to paragraphs, without the reader's own chrome. */
export function cleanOcr(raw: string): string {
  return unwrap(normalizeText(raw).split('\n').filter((l) => !CHROME.test(l)).join('\n'));
}

/** Pages are screenshots, so a sentence can run across a page turn: join those instead of breaking the paragraph. */
export function assemblePages(pages: string[]): string {
  let out = '';
  for (const p of pages) {
    const t = p.trim();
    if (!t) continue;
    if (!out) out = t;
    else if (!/[.!?…"”’)]$/.test(out) && /^[a-z]/.test(t)) out += ' ' + t;
    else out += '\n\n' + t;
  }
  return out;
}

const END_OF_SAMPLE = [/reached the end of (?:your|the) (?:free )?sample/i, /end of (?:the |your )?(?:free )?sample/i, /continue reading (?:this|the) (?:book|story)/i, /buy (?:the )?(?:full )?(?:book )?to continue/i, /thank you for (?:reading|sampling)/i];

/** True when OCR text shows the reader's "you've reached the end of the sample" screen. */
export function looksLikeEndOfSample(text: string): boolean {
  return END_OF_SAMPLE.some((re) => re.test(text));
}

export class Ocr {
  private constructor(private readonly worker: Worker) {}

  static async create(opts: { langPath?: string } = {}): Promise<Ocr> {
    const langPath = opts.langPath ?? (createRequire(import.meta.url)('@tesseract.js-data/eng') as { langPath: string }).langPath;
    return new Ocr(await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' }));
  }

  /** Read one page image. Small images are enlarged first because OCR does poorly below about 20 px letters. */
  async recognize(image: Buffer, crop?: Crop): Promise<OcrPage> {
    let img = sharp(image).rotate();
    const meta = await img.metadata();
    const W = meta.width ?? 0, H = meta.height ?? 0;
    if (crop && W && H) {
      const c = {
        left: Math.max(0, Math.min(W - 1, Math.round(crop.left))),
        top: Math.max(0, Math.min(H - 1, Math.round(crop.top))),
        width: 0, height: 0,
      };
      c.width = Math.max(1, Math.min(W - c.left, Math.round(crop.width)));
      c.height = Math.max(1, Math.min(H - c.top, Math.round(crop.height)));
      img = img.extract(c);
    }
    const width = crop ? Math.round(crop.width) : W;
    const grey = await img.flatten({ background: '#ffffff' }).greyscale().resize({ width: Math.max(width, 1600) }).png().toBuffer();
    // Readers offer dark themes (light text on a dark page); OCR expects dark text on light.
    const dark = (await sharp(grey).stats()).channels[0]!.mean < 110;
    const data = dark ? await sharp(grey).negate().png().toBuffer() : grey;
    const r = await this.worker.recognize(data);
    return { text: cleanOcr(r.data.text), confidence: Math.round(r.data.confidence) };
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
