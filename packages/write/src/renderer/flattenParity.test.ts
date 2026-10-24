// @vitest-environment jsdom
import { Editor, defaultValueCtx, parserCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { describe, expect, it } from 'vitest';
import { flattenMarkdown } from '../shared/agent/flatten';
import { alignPlugins } from './alignPlugin';
import { flatten } from './reviewPlugin';

// The AI tools anchor notes to `flattenMarkdown`; the app finds them in `flatten(editor document)`. They must agree.
const SAMPLES: Record<string, string> = {
  prose: '# Chapter One\n\nShe walked *slowly* to the **door**.\n\n"Don\'t," he said — and left.\n',
  hardBreak: '# T\n\nline one  \nline two\n\nafter\n',
  lists: '# T\n\n- apples\n- pears\n  - nested\n\n1. one\n2. two\n',
  quote: '# T\n\n> quoted *text*\n>\n> second\n\nafter\n',
  links: '# T\n\nA [link](http://x.y) and `code` and \\*escaped\\* and ~~gone~~.\n',
  sceneBreak: '# T\n\nbefore\n\n***\n\nafter\n',
  code: '# T\n\n```\nlet a = 1\nlet b = 2\n```\n\nafter\n',
  table: '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n',
  entities: '# T\n\nTom &amp; Jerry &copy; “curly” ‘quotes’\n',
  aligned: '# T\n\nbefore\n\n::: center\nCentred *line*\n\nand another\n:::\n\nafter\n',
  alignedCompact: '::: right\none\n:::\n',
  preamble: 'Just text before any heading.\n\nMore.\n',
};

async function viaEditor(md: string): Promise<string> {
  const editor = await Editor.make()
    .config((ctx) => ctx.set(defaultValueCtx, md))
    .use(commonmark)
    .use(gfm)
    .use(alignPlugins)
    .create();
  return flatten(editor.action((ctx) => ctx.get(parserCtx)(md))).text;
}

describe('the AI tools flatten Markdown the way the editor does', () => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    it(name, async () => {
      expect(flattenMarkdown(md)).toBe(await viaEditor(md));
    });
  }
});
