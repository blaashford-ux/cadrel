import type { Chapter, MarkdownDoc } from '../shared/chapters';
import { estimateRows, type RowEnv } from '../shared/rows';

type Mode = 'visual' | 'source';

interface Env extends RowEnv {
  /** Changes whenever the font or width changes, so cached estimates are not reused for another layout. */
  key: string;
}

let canvas: CanvasRenderingContext2D | null = null;
const ctx = () => (canvas ??= document.createElement('canvas').getContext('2d'));

/** The text area of the open editor of this kind (its width and font), or sensible defaults before one exists. */
function readEnv(mode: Mode): Env {
  const el = document.querySelector<HTMLElement>(mode === 'visual' ? '.pane:not([hidden]) .ProseMirror' : '.pane:not([hidden]) textarea.source-editor');
  const probe = (mode === 'visual' ? el?.querySelector<HTMLElement>('p') : null) ?? el;
  let font = mode === 'visual' ? '16px Inter, sans-serif' : "13px 'Cascadia Mono', Consolas, monospace";
  let width = mode === 'visual' ? 760 : 840;
  if (el && probe) {
    const cs = getComputedStyle(probe);
    font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const box = getComputedStyle(el);
    width = el.clientWidth - parseFloat(box.paddingLeft || '0') - parseFloat(box.paddingRight || '0');
  }
  width = Math.max(120, Math.round(width));
  const c = ctx();
  const base = c ? ((c.font = font), true) : false;
  return {
    key: `${mode}|${font}|${width}`,
    width,
    measure: (text, scale) => (base && c ? (c.font = font, c.measureText(text).width * scale) : text.length * 8 * scale)
  };
}

const cache = new WeakMap<Chapter, Map<string, number>>();

/** Rows in a chapter as the open editor would lay it out (cached per chapter and layout). */
export function chapterRowsEstimate(chapter: Chapter, mode: Mode, env: Env = readEnv(mode)): number {
  let per = cache.get(chapter);
  if (!per) cache.set(chapter, (per = new Map()));
  const hit = per.get(env.key);
  if (hit !== undefined) return hit;
  const rows = estimateRows(chapter.raw, env);
  per.set(env.key, rows);
  return rows;
}

/** Estimated rows of every chapter of a file, and a key that changes when the layout does. */
export function docRows(doc: MarkdownDoc, mode: Mode): { rows: number[]; key: string } {
  const env = readEnv(mode);
  return { rows: doc.chapters.map((c) => chapterRowsEstimate(c, mode, env)), key: env.key };
}
