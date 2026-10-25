// Draws the app icon from the brand emblem (build/brand/cadrel-emblem.svg): a warm paper tile with the emblem on it, so it
// reads on a dark taskbar as well as a light one. Writes build/icon.png (512) and build/icon.ico (16 to 256).
// Run by hand when the artwork changes (`node scripts/make-icons.mjs`); the results are committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emblem = fs.readFileSync(path.join(root, 'build', 'brand', 'cadrel-emblem.svg'), 'utf8');
const inner = emblem.replace(/^[\s\S]*?<defs>/, '<defs>').replace(/<\/svg>\s*$/, '');

// The emblem's own 512 box has the C centred with a little air; the tile gives it a margin and a rounded corner.
const tile = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="108" fill="#FAF8F3"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="107.5" fill="none" stroke="#D1C7B8" stroke-width="1.5"/>
  <g transform="translate(256 256) scale(0.82) translate(-256 -256)">${inner}</g>
</svg>`;

const png = (size) => sharp(Buffer.from(tile(size))).resize(size, size).png().toBuffer();

fs.writeFileSync(path.join(root, 'build', 'icon.png'), await png(512));

// An .ico is a small directory followed by the images; PNG-compressed entries are valid from Windows Vista on.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s === 256 ? 0 : s, e);
  head.writeUInt8(s === 256 ? 0 : s, e + 1);
  head.writeUInt8(0, e + 2);
  head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(images[i].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([head, ...images]));
console.log('wrote build/icon.png and build/icon.ico');
