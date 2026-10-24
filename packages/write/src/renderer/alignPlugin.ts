import { commandsCtx } from '@milkdown/kit/core';
import { wrapIn } from '@milkdown/kit/prose/commands';
import { keymap } from '@milkdown/kit/prose/keymap';
import type { Node as PmNode, NodeType } from '@milkdown/kit/prose/model';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { findWrapping } from '@milkdown/kit/prose/transform';
import { $command, $nodeSchema, $prose, $remark } from '@milkdown/kit/utils';
import { isCloser, openerAlign, type Align } from '../shared/align';

/**
 * Alignment fences in the formatted editor. A `::: center` … `:::` run in the Markdown becomes one block holding the
 * paragraphs between the fences, drawn aligned; saving writes the fences back. Four steps:
 *   1. a remark transform turns the fence paragraphs into an `alignBlock` mdast node,
 *   2. the `alignBlock` node (below) holds the blocks,
 *   3. its Markdown serialiser writes the two fence lines around them,
 *   4. `setAlignCommand` applies, changes or removes an alignment on the selection.
 */

interface Mdast {
  type: string;
  value?: string;
  children?: Mdast[];
  [k: string]: unknown;
}

type Piece = { fence: 'open'; align: Align } | { fence: 'close' } | { node: Mdast };

const isSoftBreak = (n: Mdast) => n.type === 'break' && (n.data as { isInline?: boolean } | undefined)?.isInline === true;

/** A paragraph's inline nodes as lines: soft line breaks (which the editor's line-break plugin has already made `break` nodes) split them. */
function linesOf(p: Mdast): Mdast[][] {
  const lines: Mdast[][] = [[]];
  for (const c of p.children ?? []) {
    if (isSoftBreak(c)) lines.push([]);
    else if (c.type === 'text' && typeof c.value === 'string' && c.value.includes('\n')) {
      c.value.split('\n').forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ type: 'text', value: part });
      });
    } else lines[lines.length - 1].push(c);
  }
  return lines.filter((l) => l.length > 0);
}

/** The fence a line is made of, if it is only that. */
function fenceOf(line: Mdast[]): Piece | null {
  if (line.length !== 1 || line[0].type !== 'text' || typeof line[0].value !== 'string') return null;
  const text = line[0].value;
  const align = openerAlign(text);
  if (align) return { fence: 'open', align };
  return isCloser(text) ? { fence: 'close' } : null;
}

/** Takes fence lines out of a paragraph (at its start, end or middle); the text between them stays paragraphs. */
function splitParagraph(p: Mdast): Piece[] {
  const lines = linesOf(p);
  if (!lines.some((l) => fenceOf(l))) return [{ node: p }];
  const out: Piece[] = [];
  let cur: Mdast[][] = [];
  const flush = () => {
    if (!cur.length) return;
    const children: Mdast[] = [];
    cur.forEach((line, i) => {
      if (i > 0) children.push({ type: 'break', data: { isInline: true } });
      children.push(...line);
    });
    out.push({ node: { type: 'paragraph', children } });
    cur = [];
  };
  for (const line of lines) {
    const f = fenceOf(line);
    if (f) {
      flush();
      out.push(f);
    } else cur.push(line);
  }
  flush();
  return out;
}

/** Wraps the nodes between fence paragraphs in `alignBlock` nodes (top level only). */
export function wrapFences(children: Mdast[]): Mdast[] {
  const out: Mdast[] = [];
  let open: { align: Align; items: Mdast[] } | null = null;
  const flush = () => {
    if (!open) return;
    const items = open.items.length ? open.items : [{ type: 'paragraph', children: [] }];
    out.push({ type: 'alignBlock', align: open.align, children: items });
    open = null;
  };
  for (const node of children) {
    const pieces = node.type === 'paragraph' ? splitParagraph(node) : [{ node }];
    for (const piece of pieces) {
      if ('fence' in piece) {
        if (piece.fence === 'open') {
          flush(); // an opener inside an open fence starts the next one
          open = { align: piece.align, items: [] };
        } else if (open) flush();
        else out.push({ type: 'paragraph', children: [{ type: 'text', value: ':::' }] }); // a stray closer stays text
      } else if (open) open.items.push(piece.node);
      else out.push(piece.node);
    }
  }
  flush();
  return out;
}

export const alignRemark = $remark('mdedit-align-fences', () => () => (tree: unknown) => {
  const root = tree as Mdast;
  if (root.children) root.children = wrapFences(root.children);
});

export const alignBlockSchema = $nodeSchema('alignBlock', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  attrs: { align: { default: 'center' } },
  parseDOM: [{ tag: 'div[data-md-align]', getAttrs: (dom) => ({ align: (dom as HTMLElement).dataset.mdAlign ?? 'center' }) }],
  toDOM: (node) => ['div', { 'data-md-align': String(node.attrs.align), class: 'md-align' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'alignBlock',
    runner: (state, node, type) => {
      state.openNode(type, { align: node.align as string }).next(node.children as never).closeNode();
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'alignBlock',
    runner: (state, node) => {
      state.openNode('paragraph').addNode('text', undefined, `::: ${node.attrs.align}`).closeNode();
      state.next(node.content);
      state.openNode('paragraph').addNode('text', undefined, ':::').closeNode();
    }
  }
}));

/** The alignment fence the position sits in, if any. */
function enclosing(state: EditorState, type: NodeType): { node: PmNode; pos: number } | null {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === type && $to.pos <= $from.after(d)) return { node, pos: $from.before(d) };
  }
  return null;
}

/**
 * Sets the alignment of the selected blocks: inside a fence it changes that fence (or removes it when it already has this
 * alignment, or when `align` is null); outside one it wraps the selected blocks in a new fence. Fences are never nested.
 */
export const setAlignCommand = $command('SetAlign', (ctx) => (align?: Align | null) => (state: EditorState, dispatch?: (tr: Transaction) => void) => {
  const type = alignBlockSchema.type(ctx);
  const inside = enclosing(state, type);
  if (inside) {
    if (!dispatch) return true;
    const { node, pos } = inside;
    const tr = state.tr;
    if (!align || node.attrs.align === align) tr.replaceWith(pos, pos + node.nodeSize, node.content);
    else tr.setNodeMarkup(pos, undefined, { ...node.attrs, align });
    dispatch(tr.scrollIntoView());
    return true;
  }
  if (!align) return false;
  if (!dispatch) return wrapIn(type, { align })(state);
  const tr = state.tr;
  // fences already in the selection are taken apart first, so the new one doesn't nest them
  const inner: number[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (n, p) => {
    if (n.type === type) inner.push(p);
  });
  for (const p of inner.reverse()) {
    const n = tr.doc.nodeAt(p);
    if (n) tr.replaceWith(p, p + n.nodeSize, n.content);
  }
  const $f = tr.doc.resolve(tr.mapping.map(state.selection.from));
  const $t = tr.doc.resolve(tr.mapping.map(state.selection.to));
  const range = $f.blockRange($t);
  const wrapping = range && findWrapping(range, type, { align });
  if (!range || !wrapping) return false;
  tr.wrap(range, wrapping);
  dispatch(tr.scrollIntoView());
  return true;
});

export const ALIGN_KEYS: Record<string, Align> = { 'Mod-Shift-l': 'left', 'Mod-Shift-e': 'center', 'Mod-Shift-r': 'right', 'Mod-Shift-j': 'justify' };

/** Google Docs' keys: Ctrl+Shift+L / E / R / J (Ctrl+E alone is Export). */
export const alignKeymap = $prose((ctx) =>
  keymap(Object.fromEntries(Object.entries(ALIGN_KEYS).map(([k, a]) => [k, () => ctx.get(commandsCtx).call(setAlignCommand.key, a)])))
);

export const alignPlugins = [alignRemark, alignBlockSchema, setAlignCommand, alignKeymap].flat();
