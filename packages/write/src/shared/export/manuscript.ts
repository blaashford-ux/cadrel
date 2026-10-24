import type { Content, PhrasingContent, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { splitChapters } from '../chapters';
import { countWords } from '../words';
import { hasTypographicQuotes, smartenString } from './quotes';
import type { SmartQuotes } from './model';

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'em'; children: Inline[] }
  | { t: 'strong'; children: Inline[] }
  | { t: 'link'; url: string; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'br' };

export type Block =
  | { t: 'para'; inlines: Inline[] }
  | { t: 'sub'; level: 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { t: 'scene' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; items: Block[][] }
  | { t: 'code'; text: string };

export interface ManuscriptChapter {
  /** Heading text exactly as written (inline markup removed). */
  title: string;
  blocks: Block[];
  words: number;
}

export interface Manuscript {
  chapters: ManuscriptChapter[];
  warnings: string[];
}

const parser = unified().use(remarkParse);

export function inlinesToPlain(inlines: Inline[]): string {
  return inlines
    .map((i) => {
      switch (i.t) {
        case 'text':
        case 'code':
          return i.text;
        case 'br':
          return ' ';
        default:
          return inlinesToPlain(i.children);
      }
    })
    .join('');
}

class Ctx {
  warnings: string[] = [];
  constructor(
    public chapter: string,
    /** The heading level that starts a chapter; deeper headings become sub-headings relative to it. */
    public chapterLevel = 1
  ) {}
  warn(msg: string) {
    this.warnings.push(`${this.chapter ? `“${this.chapter}”: ` : ''}${msg}`);
  }
}

function toInlines(nodes: PhrasingContent[], ctx: Ctx): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out.push({ t: 'text', text: n.value.replace(/\s*\n\s*/g, ' ') });
        break;
      case 'emphasis':
        out.push({ t: 'em', children: toInlines(n.children, ctx) });
        break;
      case 'strong':
        out.push({ t: 'strong', children: toInlines(n.children, ctx) });
        break;
      case 'link':
        out.push({ t: 'link', url: n.url, children: toInlines(n.children, ctx) });
        break;
      case 'inlineCode':
        out.push({ t: 'code', text: n.value });
        break;
      case 'break':
        out.push({ t: 'br' });
        break;
      case 'image':
        ctx.warn('an image was left out (images are not supported yet)');
        if (n.alt) out.push({ t: 'text', text: n.alt });
        break;
      case 'html':
        ctx.warn('inline HTML was left out');
        break;
      default:
        break; // footnotes, references: ignored
    }
  }
  return out;
}

function toBlocks(nodes: Content[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph': {
        const inlines = toInlines(n.children, ctx);
        if (inlinesToPlain(inlines).trim() !== '' || inlines.length > 0) out.push({ t: 'para', inlines });
        break;
      }
      case 'heading':
        out.push({ t: 'sub', level: Math.min(6, Math.max(2, n.depth - ctx.chapterLevel + 1)) as 2 | 3 | 4 | 5 | 6, inlines: toInlines(n.children, ctx) });
        break;
      case 'thematicBreak':
        out.push({ t: 'scene' });
        break;
      case 'blockquote':
        out.push({ t: 'quote', blocks: toBlocks(n.children, ctx) });
        break;
      case 'list':
        out.push({
          t: 'list',
          ordered: !!n.ordered,
          items: n.children.map((li) => toBlocks(li.children, ctx))
        });
        break;
      case 'code':
        out.push({ t: 'code', text: n.value });
        break;
      case 'html':
        ctx.warn('HTML was left out');
        break;
      default:
        break; // definitions, footnotes
    }
  }
  return out;
}

/** Drops leading/trailing scene breaks and collapses repeated ones. */
function tidyScenes(blocks: Block[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.t === 'scene' && (out.length === 0 || out[out.length - 1].t === 'scene')) continue;
    out.push(b);
  }
  if (out.length && out[out.length - 1].t === 'scene') {
    out.pop();
    ctx.warn('ended with a scene break, which was removed');
  }
  return out;
}

const YAML_FRONT = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Parses a manuscript file into chapters (one per heading of `chapterLevel`, default Heading 1), ready for any output format. */
export function parseManuscript(source: string, chapterLevel = 1): Manuscript {
  const doc = splitChapters(source, chapterLevel);
  const level = doc.level;
  const chapters: ManuscriptChapter[] = [];
  const warnings: string[] = [];

  for (const c of doc.chapters) {
    if (c.isPreamble) {
      const text = c.raw.replace(YAML_FRONT, '').trim();
      if (text) warnings.push(`Text before the first Heading ${level} was left out (${countWords(text).toLocaleString()} words).`);
      continue;
    }
    const tree = parser.parse(c.raw) as Root;
    const headIdx = tree.children.findIndex((n) => n.type === 'heading' && n.depth === level);
    const head = tree.children[headIdx];
    const title = head && head.type === 'heading' ? inlinesToPlain(toInlines(head.children, new Ctx(''))) : c.title;
    const ctx = new Ctx(title || '(untitled)', level);
    const body = tree.children.filter((_, i) => i !== headIdx);
    const blocks = tidyScenes(toBlocks(body, ctx), ctx);
    if (blocks.length === 0) ctx.warn('this chapter is empty');
    warnings.push(...ctx.warnings);
    chapters.push({ title: title.trim(), blocks, words: countWords(c.raw) });
  }
  return { chapters, warnings };
}

// ---- smart quotes ------------------------------------------------------------------------

/** Applies smartenString across the text runs of one paragraph so quotes stay correct across <em>, links… */
function smartenInlines(inlines: Inline[]): Inline[] {
  // 1. flatten to one string; non-text inlines become a stand-in character so context is right
  let flat = '';
  const walk = (list: Inline[]) => {
    for (const i of list) {
      if (i.t === 'text') flat += i.text;
      else if (i.t === 'code') flat += 'x';
      else if (i.t === 'br') flat += '\n';
      else walk(i.children);
    }
  };
  walk(inlines);
  const smart = smartenString(flat);

  // 2. hand the converted characters back, run by run
  let pos = 0;
  const rebuild = (list: Inline[]): Inline[] =>
    list.map((i): Inline => {
      switch (i.t) {
        case 'text': {
          const text = smart.slice(pos, pos + i.text.length);
          pos += i.text.length;
          return { t: 'text', text };
        }
        case 'code':
          pos += 1;
          return i;
        case 'br':
          pos += 1;
          return i;
        default:
          return { ...i, children: rebuild(i.children) };
      }
    });
  return rebuild(inlines);
}

function smartenBlocks(blocks: Block[]): Block[] {
  return blocks.map((b): Block => {
    switch (b.t) {
      case 'para':
        return { t: 'para', inlines: smartenInlines(b.inlines) };
      case 'sub':
        return { ...b, inlines: smartenInlines(b.inlines) };
      case 'quote':
        return { t: 'quote', blocks: smartenBlocks(b.blocks) };
      case 'list':
        return { ...b, items: b.items.map(smartenBlocks) };
      default:
        return b;
    }
  });
}

/** Returns the manuscript with typographic quotes, unless it already uses them (mode 'auto'). */
export function applySmartQuotes(m: Manuscript, mode: SmartQuotes): { manuscript: Manuscript; applied: boolean } {
  if (mode === 'never') return { manuscript: m, applied: false };
  if (mode === 'auto') {
    const all = m.chapters.map((c) => JSON.stringify(c.blocks) + c.title).join('\n');
    if (hasTypographicQuotes(all)) return { manuscript: m, applied: false };
  }
  return {
    manuscript: {
      ...m,
      chapters: m.chapters.map((c) => ({
        ...c,
        title: smartenString(c.title),
        blocks: smartenBlocks(c.blocks)
      }))
    },
    applied: true
  };
}
