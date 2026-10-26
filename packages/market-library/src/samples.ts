import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './manuscripts.js';

/** A rectangle in screenshot pixels: where the sample reader sits on the captured page. */
export interface PageCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SamplePage {
  index: number;
  file: string;
  sha256: string;
  capturedAt: string;
  crop: PageCrop | null;
  ocr?: { confidence: number; chars: number };
}

export interface SampleSession {
  session: string;
  pages: SamplePage[];
}

const SESSION = /^\d{8}T\d{6}Z$/;
const sessionDir = (root: string, asin: string, session: string) => path.join(root, 'books', asin, 'lookinside', session);
const indexFile = (dir: string) => path.join(dir, 'pages.json');

function check(asin: string, session: string) {
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('bad ASIN');
  if (!SESSION.test(session)) throw new Error('bad session id');
}

function readIndex(dir: string): SamplePage[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(dir), 'utf8')) as SamplePage[];
  } catch {
    return [];
  }
}

function writeIndex(dir: string, pages: SamplePage[]) {
  const tmp = indexFile(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pages, null, 2));
  fs.renameSync(tmp, indexFile(dir));
}

export const MAX_SAMPLE_PAGES = 400;

/** Store one screenshot of the reader. An identical image already in the session is not stored twice. */
export function saveSamplePage(
  root: string,
  asin: string,
  session: string,
  image: Buffer,
  ext: 'png' | 'jpg',
  meta: { crop?: PageCrop | null; capturedAt?: string } = {},
): { index: number; duplicate: boolean; pages: number } {
  check(asin, session);
  const dir = sessionDir(root, asin, session);
  fs.mkdirSync(dir, { recursive: true });
  const pages = readIndex(dir);
  const sum = sha256(image);
  const dup = pages.find((p) => p.sha256 === sum);
  if (dup) return { index: dup.index, duplicate: true, pages: pages.length };
  if (pages.length >= MAX_SAMPLE_PAGES) throw new Error(`a sample session holds at most ${MAX_SAMPLE_PAGES} pages`);
  const index = pages.length + 1;
  const file = `page-${String(index).padStart(3, '0')}.${ext}`;
  fs.writeFileSync(path.join(dir, file), image);
  pages.push({ index, file, sha256: sum, capturedAt: meta.capturedAt ?? new Date().toISOString(), crop: meta.crop ?? null });
  writeIndex(dir, pages);
  return { index, duplicate: false, pages: pages.length };
}

export function sampleSessions(root: string, asin: string): SampleSession[] {
  const base = path.join(root, 'books', asin, 'lookinside');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((s) => SESSION.test(s))
    .sort()
    .map((session) => ({ session, pages: readIndex(path.join(base, session)) }));
}

export function readSamplePage(root: string, asin: string, session: string, page: SamplePage): Buffer {
  check(asin, session);
  const file = path.join(sessionDir(root, asin, session), path.basename(page.file));
  return fs.readFileSync(file);
}

export function saveSampleOcr(root: string, asin: string, session: string, index: number, text: string, confidence: number): void {
  check(asin, session);
  const dir = sessionDir(root, asin, session);
  fs.mkdirSync(path.join(dir, 'ocr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ocr', `page-${String(index).padStart(3, '0')}.txt`), text);
  const pages = readIndex(dir);
  const p = pages.find((x) => x.index === index);
  if (p) {
    p.ocr = { confidence, chars: text.length };
    writeIndex(dir, pages);
  }
}

export function readSampleOcr(root: string, asin: string, session: string, index: number): string | null {
  try {
    return fs.readFileSync(path.join(sessionDir(root, asin, session), 'ocr', `page-${String(index).padStart(3, '0')}.txt`), 'utf8');
  } catch {
    return null;
  }
}
