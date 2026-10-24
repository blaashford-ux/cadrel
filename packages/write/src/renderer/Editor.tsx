import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, editorViewOptionsCtx } from '@milkdown/kit/core';
import { Selection } from '@milkdown/kit/prose/state';
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils';
import {
  insertHrCommand,
  toggleEmphasisCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/kit/preset/commonmark';
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
import { useEffect, useRef, useState } from 'react';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import { blockLines } from '../shared/lines';
import { pickScene } from '../shared/sceneBreaks';
import { LineGutter, lineMarksFromBlocks, type LineMark, type PlacedBlock } from './LineGutter';
import { alignPlugins, setAlignCommand } from './alignPlugin';
import type { Align } from '../shared/align';
import { findApiFor, findPlugin } from './findPlugin';
import { reviewApiFor, reviewPlugin } from './reviewPlugin';
import type { SceneNav } from './sceneNav';

interface Props {
  /** The chapter as it is on disk. Read once on mount: remount (via `key`) to load another. */
  initial: string;
  /**
   * Unsaved text to put back on top of `initial` when the editor mounts (switching from source
   * mode, crash recovery). Because it is applied after `initial`, it counts as an edit.
   */
  restore: string | null;
  /**
   * Called when the user's edits change the Markdown. Receives null when the content is
   * back to the saved state, so merely opening a chapter is never "dirty" even though
   * the editor may normalise the Markdown it was given.
   */
  onChange(markdown: string | null): void;
  /**
   * Set after each successful save: `markdown` (what was written) becomes the "clean" baseline.
   * Anything typed while the save was in flight stays dirty.
   */
  saved: { version: number; markdown: string } | null;
  /** Right-click in the text (the browser's own menu is suppressed when this is given). */
  onContextMenu?(at: { x: number; y: number }): void;
  /** Reviewers read the chapter and annotate it, but can't change it. */
  readOnly?: boolean;
  /** Hands the parent a way to jump between scene breaks (null on unmount). */
  onNav?(nav: SceneNav | null): void;
  /** The file line this chapter starts on, so the gutter shows file-wide line numbers. */
  firstLine: number;
}

/** The phone: no window chrome, so no mouse hover to hang floating menus on. */
const TOUCH = typeof window !== 'undefined' && window.mdedit?.capabilities?.windowChrome === false;

export function Editor({ initial, restore, onChange, saved, onNav, firstLine, readOnly, onContextMenu }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<LineMark[]>([]);
  const blockPos = useRef<{ start: number; end: number; pos: number }[]>([]);
  const marksRef = useRef<LineMark[]>([]);
  const measureRef = useRef<() => void>(() => {});
  const firstLineRef = useRef(firstLine);
  firstLineRef.current = firstLine;
  const crepeRef = useRef<Crepe | null>(null);
  const baseline = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const mountProps = useRef({ initial, restore, readOnly: readOnly === true });
  const onNavRef = useRef(onNav);
  onNavRef.current = onNav;

  useEffect(() => {
    // On a touch screen the system owns selection: its handles and its Cut / Copy / Paste menu. Crepe's floating
    // toolbar, hover handles and virtual caret fight with that (a second menu over the text, handles that snap back,
    // a long press that selects far too much), so they are off there; the phone gets a docked format bar instead.
    const crepe = new Crepe({
      root: host.current,
      defaultValue: mountProps.current.initial,
      features: {
        [CrepeFeature.AI]: false,
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.Latex]: false,
        ...(TOUCH ? { [CrepeFeature.Toolbar]: false, [CrepeFeature.BlockEdit]: false, [CrepeFeature.Cursor]: false } : {})
      }
    });
    let disposed = false;
    baseline.current = null;
    let frame = 0;
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => !disposed && measureRef.current());
    };
    const ro = new ResizeObserver(scheduleMeasure);
    if (host.current) ro.observe(host.current);

    crepe.on((l) => {
      l.markdownUpdated((_ctx, md) => {
        if (disposed) return;
        // An update before the baseline is known is the editor normalising its input.
        if (baseline.current === null) baseline.current = md;
        onChangeRef.current(md === baseline.current ? null : md);
        scheduleMeasure();
      });
    });
    if (mountProps.current.readOnly) crepe.editor.config((ctx) => ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false })));
    crepe.editor.use($prose(() => findPlugin)); // highlights for Find & Replace
    crepe.editor.use(alignPlugins); // ::: center fences
    crepe.editor.use($prose(() => reviewPlugin)); // highlights for comments and suggestions
    const getView = () => (crepeRef.current ? crepeRef.current.editor.action((ctx) => ctx.get(editorViewCtx)) : null);
    /**
     * Gives each top-level block its source line. While the chapter is unedited that is the file's own
     * text; once edited it is what saving would write, so the numbers match the file after a save.
     */
    const measure = () => {
      const view = getView();
      const c = crepeRef.current;
      if (!view || !c || !wrap.current) return;
      const md = c.getMarkdown();
      const count = view.state.doc.childCount;
      let blocks = blockLines(md === baseline.current ? mountProps.current.initial : md);
      // the editor keeps an empty paragraph after a trailing rule or list; it has no source line
      const fits = (b: typeof blocks) => b.length === count || (b.length < count && view.state.doc.child(count - 1).content.size === 0 && b.length === count - 1);
      if (!fits(blocks)) blocks = blockLines(md);
      if (!fits(blocks)) {
        blockPos.current = [];
        marksRef.current = [];
        setMarks([]);
        return;
      }
      const top0 = wrap.current.getBoundingClientRect().top;
      const placed: PlacedBlock[] = [];
      const spans: { start: number; end: number; pos: number }[] = [];
      view.state.doc.forEach((node, offset, i) => {
        if (i >= blocks.length) return;
        const el = view.nodeDOM(offset);
        if (!(el instanceof HTMLElement)) return;
        const r = el.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
        placed.push({ ...blocks[i], top: r.top - top0, height: r.height, lineHeight: lh });
        spans.push({ ...blocks[i], pos: offset });
      });
      // every line of the file gets a number, blank lines too (those sit in the gaps between blocks)
      const { marks: next } = lineMarksFromBlocks(placed, firstLineRef.current);
      blockPos.current = spans;
      marksRef.current = next;
      setMarks(next);
    };
    measureRef.current = measure;
    void crepe.create().then(() => {
      if (disposed) return;
      crepeRef.current = crepe;
      if (baseline.current === null) baseline.current = crepe.getMarkdown();
      const { restore: draft } = mountProps.current;
      if (draft !== null) crepe.editor.action(replaceAll(draft));
      // Only now can the parent drive the editor (scene jumps, find & replace).
      scheduleMeasure();
      const run = (cmd: Parameters<typeof callCommand>[0], payload?: unknown) => {
        const view = getView();
        if (!view) return;
        crepe.editor.action(callCommand(cmd as never, payload as never));
        view.focus(); // keep the keyboard and the selection
      };
      onNavRef.current?.({
        format: {
          bold: () => run(toggleStrongCommand.key),
          italic: () => run(toggleEmphasisCommand.key),
          heading: (level) => run(wrapInHeadingCommand.key, level),
          quote: () => run(wrapInBlockquoteCommand.key),
          bullets: () => run(wrapInBulletListCommand.key),
          numbered: () => run(wrapInOrderedListCommand.key),
          sceneBreak: () => run(insertHrCommand.key),
          undo: () => run(undoCommand.key),
          redo: () => run(redoCommand.key),
          align: (a) => run(setAlignCommand.key, a)
        },
        goToLine: (line) => {
          const view = getView();
          const spans = blockPos.current;
          const ms = marksRef.current;
          if (!view || !spans.length || !ms.length) return false;
          const hit = ms.find((m) => m.line >= line) ?? ms[ms.length - 1]; // a blank row goes to the block after it
          const target = spans[Math.min(hit.block, spans.length - 1)].pos;
          view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(target), 1)).scrollIntoView());
          view.focus();
          const el = view.nodeDOM(target);
          if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' });
          return true;
        },
        find: findApiFor(getView),
        review: reviewApiFor(getView),
        go: (dir) => {
          const view = getView();
          if (!view) return false;
          const { doc, selection } = view.state;
          // a scene starts at the block right after each horizontal rule (`* * *`, `---`)
          const starts: number[] = [];
          doc.forEach((node, offset) => {
            const end = offset + node.nodeSize;
            if (node.type.name === 'hr' && end < doc.content.size) starts.push(end);
          });
          const $from = selection.$from;
          const blockStart = $from.depth >= 1 ? $from.before(1) : $from.pos;
          const target = pickScene(starts, blockStart, dir);
          if (target === null) return false;
          view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(target), 1)).scrollIntoView());
          view.focus();
          const el = view.nodeDOM(target);
          if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' });
          return true;
        }
      });
    });

    return () => {
      onNavRef.current?.(null);
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      crepeRef.current = null;
      void crepe.destroy();
    };
  }, []);

  useEffect(() => {
    if (!saved || !crepeRef.current) return;
    baseline.current = saved.markdown;
    const current = crepeRef.current.getMarkdown();
    onChangeRef.current(current === saved.markdown ? null : current);
  }, [saved?.version]);

  useEffect(() => measureRef.current(), [firstLine]);

  return (
    <div className="editor-wrap" ref={wrap}>
      <div
        className="editor"
        ref={host}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                onContextMenu({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      />
      <LineGutter marks={marks} scroll={0} host={wrap} />
    </div>
  );
}
