// Draws the app icon (an open book with a magnifier) to build/icon.png. Run once; the PNG is committed.
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../build/icon.png');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="110" fill="#2b5d9b"/>
  <path d="M96 150c46-24 100-24 160 6v230c-60-30-114-30-160-6z" fill="#fbf7ee"/>
  <path d="M416 150c-46-24-100-24-160 6v230c60-30 114-30 160-6z" fill="#e6dfcf"/>
  <g stroke="#2b5d9b" stroke-width="10" stroke-linecap="round" opacity=".55"><path d="M130 205h92M130 245h92M130 285h92M290 205h92M290 245h92"/></g>
  <circle cx="352" cy="318" r="56" fill="#fbf7ee" stroke="#1d1d1b" stroke-width="18"/>
  <path d="M392 360l62 62" stroke="#1d1d1b" stroke-width="26" stroke-linecap="round"/>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile(out);
