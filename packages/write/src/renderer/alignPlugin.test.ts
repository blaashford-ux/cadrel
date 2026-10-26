// @vitest-environment jsdom
import { Editor, commandsCtx, defaultValueCtx, editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { TextSelection } from '@milkdown/kit/prose/state';
import { getMarkdown } from '@milkdown/kit/utils';
import { describe, expect, it } from 'vitest';
import { alignPlugins, setAlignCommand, wrapFences } from './alignPlugin';

const make = async (md: string) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return Editor.make()
    .config((ctx) => {
      ctx.set(defaultValueCtx, md);
      ctx.set(editorViewCtx as never, undefined as never);
    })
    .use(commonmark)
    .use(gfm)
    .use(alignPlugins)
    .create();
};
const shape = (editor: Editor, md: string) =>
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(md);
    const out: string[] = [];
    doc.forEach((n) => out.push(n.type.name === 'alignBlock' ? `${n.attrs.align}[${n.childCount}]` : n.type.name));
    return out;
  });
const md = (editor: Editor) => editor.action(getMarkdown());

describe('alignment fences in the editor', () => {
  it('reads fences into blocks, in every spelling of the Markdown', async () => {
    const editor = await make('x');
    expect(shape(editor, '# T\n\n::: center\nHello\n\nWorld\n:::\n\nafter\n')).toEqual(['heading', 'center[2]', 'paragraph']);
    expect(shape(editor, '# T\n\n::: right\nOne line\n:::\n')).toEqual(['heading', 'right[1]']); // no blank lines
    expect(shape(editor, '::: left\n*emph* then text\n:::\n')).toEqual(['left[1]']);
    expect(shape(editor, '::: centre\n> quoted\n\n- a\n- b\n:::\n')).toEqual(['center[2]']);
    expect(shape(editor, '::: justify\nnever closed\n\nmore\n')).toEqual(['justify[2]']);
    expect(shape(editor, 'a\n\n:::\n\nstray closer stays text\n')).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(shape(editor, '::: left\na\n::: right\nb\n:::\n')).toEqual(['left[1]', 'right[1]']);
  });

  it('writes fences back, and the result reads the same', async () => {
    const editor = await make('# T\n\n::: center\nHello *there*\n\nSecond\n:::\n\nafter\n');
    const out = md(editor);
    expect(out).toContain('::: center\n\nHello *there*\n\nSecond\n\n:::');
    expect(shape(editor, out)).toEqual(['heading', 'center[2]', 'paragraph']);
    expect(out).not.toContain('\\:');
  });

  it('applies, changes and removes an alignment on the selection', async () => {
    const editor = await make('# T\n\nplain one\n\nplain two\n');
    const select = (needle: string, to?: string) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let from = -1;
        let end = -1;
        view.state.doc.descendants((n, pos) => {
          if (n.isText && n.text?.includes(needle) && from < 0) from = pos + 1;
          if (n.isText && to && n.text?.includes(to)) end = pos + 2;
          return true;
        });
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, end > 0 ? end : from)));
      });
    const run = (a: string | null) => editor.action((ctx) => ctx.get(commandsCtx).call(setAlignCommand.key, a as never));

    select('plain one', 'plain two');
    run('right');
    expect(md(editor)).toContain('::: right\n\nplain one\n\nplain two\n\n:::');
    select('plain one');
    run('center'); // changes the fence it is in
    expect(md(editor)).toContain('::: center');
    expect(md(editor)).not.toContain('::: right');
    run('center'); // the same alignment again removes it
    expect(md(editor)).not.toContain(':::');
    select('plain one');
    run('left');
    expect(md(editor)).toContain('::: left');
    run(null);
    expect(md(editor)).not.toContain(':::');
  });

  it('does not nest fences when the selection already holds one', async () => {
    const editor = await make('::: center\nin\n:::\n\nout\n');
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)));
      ctx.get(commandsCtx).call(setAlignCommand.key, 'right' as never);
    });
    const out = md(editor);
    expect(out.match(/:::/g)).toHaveLength(2);
    expect(out).toContain('::: right');
  });

  it('wrapFences leaves ordinary documents alone', () => {
    const doc = [{ type: 'heading' }, { type: 'paragraph', children: [{ type: 'text', value: 'Time: 10:30' }] }];
    expect(wrapFences(doc)).toEqual(doc);
  });
});
