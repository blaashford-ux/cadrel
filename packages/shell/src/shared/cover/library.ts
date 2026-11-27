/**
 * The built-in library: dividers, frames, ornaments, badges and plain symbols, drawn here as vector paths (nothing is third-party, so there is
 * no licence to track). Each is a path in its own box (`vb`), filled with whatever colour or gradient the layer has. Recolouring is the layer's fill.
 */
export type LibraryGroup = 'dividers' | 'frames' | 'ornaments' | 'badges' | 'symbols';
export interface LibraryItem {
  id: string;
  name: string;
  group: LibraryGroup;
  /** The path's own size. The layer's frame is fitted to it keeping these proportions. */
  vb: { w: number; h: number };
  d: string;
  /** `evenodd` for pieces with holes. */
  evenodd?: boolean;
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** A star with `n` points inside a 100 box. */
function star(n: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? 50 : 50 * inner;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push(`${f(50 + r * Math.cos(a))} ${f(50 + r * Math.sin(a))}`);
  }
  return `M${pts.join('L')}Z`;
}
/** A scalloped rosette / seal: `n` bumps. */
function rosette(n: number): string {
  const pts: string[] = [];
  const steps = n * 12;
  for (let i = 0; i < steps; i++) {
    const a = (Math.PI * 2 * i) / steps - Math.PI / 2;
    const r = 44 + 6 * Math.cos(n * (a + Math.PI / 2));
    pts.push(`${f(50 + r * Math.cos(a))} ${f(50 + r * Math.sin(a))}`);
  }
  return `M${pts.join('L')}Z`;
}
/** A sun: a disc with `n` pointed rays standing off it. */
function sun(n: number): string {
  let d = 'M27 50a23 23 0 1 0 46 0a23 23 0 1 0 -46 0Z';
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const w = Math.PI / n / 2.2;
    const p = (r: number, da: number) => `${f(50 + r * Math.cos(a + da))} ${f(50 + r * Math.sin(a + da))}`;
    d += `M${p(31, -w)}L${p(49, 0)}L${p(31, w)}Z`;
  }
  return d;
}
/** A ring of a given thickness as a path with a hole. */
const ring = (r: number, t: number): string => `M${50 - r} 50a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0ZM${50 - r + t} 50a${r - t} ${r - t} 0 1 1 ${2 * (r - t)} 0a${r - t} ${r - t} 0 1 1 ${-2 * (r - t)} 0Z`;
/** A diamond centred at (cx, cy). */
const diamond = (cx: number, cy: number, r: number): string => `M${f(cx)} ${f(cy - r)}L${f(cx + r)} ${f(cy)}L${f(cx)} ${f(cy + r)}L${f(cx - r)} ${f(cy)}Z`;

export const LIBRARY: readonly LibraryItem[] = [
  // dividers: wide and short
  { id: 'rule', name: 'Plain rule', group: 'dividers', vb: { w: 300, h: 10 }, d: 'M0 4h300v2H0Z' },
  { id: 'rule-diamond', name: 'Rule with a diamond', group: 'dividers', vb: { w: 300, h: 24 }, d: `M0 11h126v2H0ZM174 11h126v2H174Z${diamond(150, 12, 10)}` },
  { id: 'rule-dots', name: 'Rule with three diamonds', group: 'dividers', vb: { w: 300, h: 24 }, d: `M0 11h112v2H0ZM188 11h112v2H188Z${diamond(150, 12, 9)}${diamond(128, 12, 4.5)}${diamond(172, 12, 4.5)}` },
  { id: 'flourish', name: 'Curled flourish', group: 'dividers', vb: { w: 300, h: 40 }, d: 'M0 20C30 20 40 6 62 6c14 0 20 9 12 15-6 4-14-1-10-7M300 20C270 20 260 6 238 6c-14 0-20 9-12 15 6 4 14-1 10-7M62 6C100 6 118 20 150 20S200 6 238 6C200 8 182 26 150 26S100 8 62 6Z' },
  { id: 'swash', name: 'Swash', group: 'dividers', vb: { w: 300, h: 30 }, d: 'M0 15C60 15 90 3 150 15C210 27 240 15 300 15C240 19 210 31 150 19C90 7 60 19 0 15Z' },
  { id: 'wave', name: 'Wave line', group: 'dividers', vb: { w: 300, h: 20 }, d: 'M0 10C25 0 50 0 75 10S125 20 150 10S200 0 225 10S275 20 300 10v3C275 23 250 23 225 13S175 3 150 13S100 23 75 13S25 3 0 13Z' },
  { id: 'chevrons', name: 'Chevrons', group: 'dividers', vb: { w: 300, h: 20 }, d: 'M0 0l10 10L0 20h6l10-10L6 0ZM284 0l10 10-10 10h6l10-10L290 0ZM140 2l10 8-10 8h6l10-8-10-8Z' },
  // frames: the whole cover
  { id: 'frame-line', name: 'Thin frame', group: 'frames', vb: { w: 100, h: 160 }, d: 'M4 4h92v152H4ZM6 6v148h88V6Z', evenodd: true },
  { id: 'frame-double', name: 'Double frame', group: 'frames', vb: { w: 100, h: 160 }, d: 'M3 3h94v154H3ZM4.2 4.2v151.6h91.6V4.2ZM7 7h86v146H7ZM8.2 8.2v143.6h83.6V8.2Z', evenodd: true },
  { id: 'frame-corners', name: 'Corner brackets', group: 'frames', vb: { w: 100, h: 160 }, d: 'M4 4h22v1.6H5.6V26H4ZM96 4H74v1.6h20.4V26H96ZM4 156h22v-1.6H5.6V134H4ZM96 156H74v-1.6h20.4V134H96Z' },
  { id: 'frame-notched', name: 'Notched frame', group: 'frames', vb: { w: 100, h: 160 }, d: 'M10 4h80l6 6v140l-6 6H10l-6-6V10ZM11.4 6l-5.4 5.4v137.2L11.4 154h77.2l5.4-5.4V11.4L88.6 6Z', evenodd: true },
  // ornaments
  { id: 'fleur', name: 'Fleur-de-lis', group: 'ornaments', vb: { w: 100, h: 100 }, d: 'M50 4C42 18 40 30 50 48 60 30 58 18 50 4ZM44 52C32 38 14 40 10 54c-3 12 8 18 20 12-8 6-14 2-12-6 2-4 8-4 14 2 4 4 4 10 2 16h12c-2-6-2-12 2-16 6-6 12-6 14-2 2 4-4 12-12 6 12 6 23 0 20-12C86 40 68 38 56 52L50 60ZM42 84h16l4 10H38Z' },
  { id: 'laurel', name: 'Laurel sprig', group: 'ornaments', vb: { w: 200, h: 100 }, d: 'M10 90C60 80 110 60 190 20C150 30 100 30 60 60C40 74 20 80 10 90ZM60 60c-6-12-4-24 4-34 4 12 2 24-4 34ZM90 46c-4-12-2-22 6-32 2 12 0 22-6 32ZM120 36c-2-10 2-20 10-28 0 10-4 20-10 28Z' },
  { id: 'diamond', name: 'Diamond', group: 'ornaments', vb: { w: 100, h: 100 }, d: diamond(50, 50, 48) },
  { id: 'cross-star', name: 'Four-point star', group: 'ornaments', vb: { w: 100, h: 100 }, d: 'M50 2C54 30 70 46 98 50 70 54 54 70 50 98 46 70 30 54 2 50 30 46 46 30 50 2Z' },
  // badges
  { id: 'seal', name: 'Seal', group: 'badges', vb: { w: 100, h: 100 }, d: rosette(16) },
  { id: 'burst', name: 'Starburst', group: 'badges', vb: { w: 100, h: 100 }, d: star(20, 0.82) },
  { id: 'circle-badge', name: 'Ring badge', group: 'badges', vb: { w: 100, h: 100 }, d: ring(48, 3), evenodd: true },
  { id: 'circle-double', name: 'Double ring', group: 'badges', vb: { w: 100, h: 100 }, d: `${ring(48, 3)}${ring(42, 1.5)}`, evenodd: true },
  { id: 'ribbon', name: 'Ribbon', group: 'badges', vb: { w: 200, h: 60 }, d: 'M0 8h26l12 12V48H0l10-14ZM200 8h-26l-12 12V48h38l-10-14ZM38 14h124v40H38Z' },
  // symbols
  { id: 'star5', name: 'Star', group: 'symbols', vb: { w: 100, h: 100 }, d: star(5, 0.42) },
  { id: 'star6', name: 'Six-point star', group: 'symbols', vb: { w: 100, h: 100 }, d: star(6, 0.55) },
  { id: 'heart', name: 'Heart', group: 'symbols', vb: { w: 100, h: 100 }, d: 'M50 90C20 66 6 50 6 32 6 18 17 8 30 8c9 0 16 5 20 12 4-7 11-12 20-12 13 0 24 10 24 24 0 18-14 34-44 58Z' },
  { id: 'moon', name: 'Crescent moon', group: 'symbols', vb: { w: 100, h: 100 }, d: 'M66 6A44 44 0 1 0 94 70 36 36 0 0 1 66 6Z' },
  { id: 'sun', name: 'Sun', group: 'symbols', vb: { w: 100, h: 100 }, d: sun(12) },
  { id: 'crown', name: 'Crown', group: 'symbols', vb: { w: 100, h: 80 }, d: 'M6 66 0 14l24 24L50 4l26 34L100 14l-6 52ZM6 72h88v8H6Z' },
  { id: 'leaf', name: 'Leaf', group: 'symbols', vb: { w: 100, h: 100 }, d: 'M12 88C8 40 40 8 92 8 94 56 62 92 14 90ZM16 86C34 62 54 42 76 26 56 46 38 66 20 90Z', evenodd: true },
  { id: 'key', name: 'Key', group: 'symbols', vb: { w: 100, h: 100 }, d: 'M6 50a18 18 0 1 0 36 0a18 18 0 1 0 -36 0ZM16 50a8 8 0 1 1 16 0a8 8 0 1 1 -16 0ZM42 45h54v10H42ZM76 55h8v16h-8ZM88 55h8v12h-8Z', evenodd: true },
  { id: 'sword', name: 'Sword', group: 'symbols', vb: { w: 40, h: 120 }, d: 'M20 0l6 12v62H14V12ZM2 76h36v8H24v22l4 4v8H12v-8l4-4V84H2Z' },
  { id: 'dagger', name: 'Dagger', group: 'symbols', vb: { w: 40, h: 100 }, d: 'M20 0l8 10v42H12V10ZM4 54h32v6H4ZM16 62h8v28h-8Z' },
  { id: 'skull', name: 'Skull', group: 'symbols', vb: { w: 100, h: 100 }, d: 'M50 4C26 4 10 22 10 44c0 12 5 20 12 26v18h12v-8h8v8h16v-8h8v8h12V70c7-6 12-14 12-26C90 22 74 4 50 4ZM32 42a10 10 0 1 1 0 .1ZM68 42a10 10 0 1 1 0 .1ZM46 60h8l-4 10Z', evenodd: true },
  { id: 'dragon-eye', name: 'Eye', group: 'symbols', vb: { w: 100, h: 60 }, d: 'M0 30C20 6 80 6 100 30 80 54 20 54 0 30ZM50 14a16 16 0 1 0 0 32 16 16 0 0 0 0-32ZM47 18h6v24h-6Z', evenodd: true },
  { id: 'arrow', name: 'Arrow', group: 'symbols', vb: { w: 100, h: 60 }, d: 'M0 24h66V6l34 24-34 24V36H0Z' },
  { id: 'drop', name: 'Drop', group: 'symbols', vb: { w: 60, h: 100 }, d: 'M30 2C14 30 4 48 4 66a26 26 0 0 0 52 0C56 48 46 30 30 2Z' },
  { id: 'flame', name: 'Flame', group: 'symbols', vb: { w: 80, h: 100 }, d: 'M40 2C46 24 70 38 70 66a30 30 0 0 1-60 0c0-14 6-22 14-30 0 10 4 14 8 16C28 30 32 14 40 2Z' },
  { id: 'rose', name: 'Rose', group: 'symbols', vb: { w: 100, h: 100 }, d: 'M50 10C30 10 14 26 14 46c0 22 18 40 36 44 18-4 36-22 36-44C86 26 70 10 50 10ZM50 22c12 0 22 10 22 22S62 66 50 66 28 56 28 44c0-8 6-12 12-12 8 0 10 8 6 12-2 2 2 6 6 4 8-4 6-16-2-22Z', evenodd: true }
];

export const libraryItem = (id: string): LibraryItem | undefined => LIBRARY.find((i) => i.id === id);
export const GROUP_NAME: Record<LibraryGroup, string> = { dividers: 'Dividers', frames: 'Frames', ornaments: 'Ornaments', badges: 'Badges', symbols: 'Symbols' };
