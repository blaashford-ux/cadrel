import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { stripFences } from '../align';

type Node = { type: string; value?: string; children?: Node[] };

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'tableCell']);

function inline(node: Node): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value ?? '';
    case 'break': // a hard line break is a leaf in the editor too
    case 'image':
    case 'imageReference':
      return '￼'; // the editor's placeholder for a non-text leaf
    default:
      return (node.children ?? []).map(inline).join('');
  }
}

/**
 * A chapter's Markdown as the plain text the editor shows and review notes are anchored to: every text block's text
 * with the formatting marks removed, blocks separated by one newline. Must stay in step with `flatten` in
 * src/renderer/reviewPlugin.ts, or notes written here would not find their text in the app.
 */
export function flattenMarkdown(markdown: string): string {
  const tree = fromMarkdown(stripFences(markdown.replace(/^﻿/, '')), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node;
  const blocks: string[] = [];
  const walk = (n: Node) => {
    if (TEXT_BLOCKS.has(n.type)) blocks.push(inline(n));
    else if (n.type === 'code') blocks.push(n.value ?? '');
    else for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return blocks.join('\n');
}
