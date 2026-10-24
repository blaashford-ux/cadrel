import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import {
  compileFind,
  expandReplacement,
  findInText,
  matchAtOrAfter,
  type Compiled,
  type FindOptions,
  type FindStatus
} from '../shared/find';
import type { FindApi, FindJump } from './sceneNav';

export interface PmMatch {
  from: number;
  to: number;
  match: RegExpExecArray;
}

interface FindState {
  opts: FindOptions | null;
  matches: PmMatch[];
  current: number;
  decos: DecorationSet;
}

interface Meta {
  opts?: FindOptions | null;
  current?: number;
}

export const findKey = new PluginKey<FindState>('mdedit-find');

/** Matches inside each text block (a match never spans two paragraphs). One character = one document position. */
export function collectMatches(doc: PmNode, compiled: Compiled): PmMatch[] {
  const out: PmMatch[] = [];
  if (!compiled || !compiled.re) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, '\n', '￼');
    for (const m of findInText(text, compiled)) out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m.length, match: m.match });
    return false;
  });
  return out;
}

const decorate = (doc: PmNode, matches: PmMatch[], current: number) =>
  DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'find-match find-current' : 'find-match' }))
  );

/** Highlights the matches of the active search. All state lives in the editor state, one search per editor. */
export const findPlugin = new Plugin<FindState>({
  key: findKey,
  state: {
    init: () => ({ opts: null, matches: [], current: -1, decos: DecorationSet.empty }),
    apply(tr, prev, _old, next: EditorState) {
      const meta = tr.getMeta(findKey) as Meta | undefined;
      if (!meta && !tr.docChanged) return prev;
      const opts = meta && 'opts' in meta ? (meta.opts ?? null) : prev.opts;
      if (!opts) return { opts: null, matches: [], current: -1, decos: DecorationSet.empty };
      const compiled = compileFind(opts);
      const matches = collectMatches(next.doc, compiled);
      let current: number;
      if (meta?.current !== undefined) current = Math.min(meta.current, matches.length - 1);
      else current = matches.length ? matchAtOrAfter(matches.map((m) => ({ index: m.from })), next.selection.from) : -1;
      return { opts, matches, current, decos: decorate(next.doc, matches, current) };
    }
  },
  props: {
    decorations: (state) => findKey.getState(state)?.decos
  }
});

const stateOf = (view: EditorView) => findKey.getState(view.state)!;

function reveal(view: EditorView, pos: number): void {
  const at = view.domAtPos(pos).node;
  const el = at.nodeType === 3 ? at.parentElement : (at as HTMLElement);
  el?.scrollIntoView({ block: 'center' });
}

/** Moves the document selection onto match `i` (without taking keyboard focus) and scrolls it into view. */
function select(view: EditorView, i: number): void {
  const m = stateOf(view).matches[i];
  if (!m) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).setMeta(findKey, { current: i }));
  reveal(view, m.from);
}

const status = (view: EditorView): FindStatus => {
  const s = stateOf(view);
  return { count: s.matches.length, current: s.current >= 0 ? s.current + 1 : 0, ...(s.opts && compileFind(s.opts)?.error ? { error: compileFind(s.opts)!.error } : {}) };
};

function ensure(view: EditorView, o: FindOptions): void {
  const s = stateOf(view);
  if (!s.opts || JSON.stringify(s.opts) !== JSON.stringify(o)) view.dispatch(view.state.tr.setMeta(findKey, { opts: o.query ? o : null }));
}

/** The find & replace operations for one ProseMirror view. */
export function findApiFor(getView: () => EditorView | null): FindApi {
  const withView = <T,>(fallback: T, fn: (v: EditorView) => T): T => {
    const v = getView();
    return v ? fn(v) : fallback;
  };
  const none: FindStatus = { count: 0, current: 0 };

  return {
    search: (o, jump: FindJump) =>
      withView(none, (view) => {
        view.dispatch(view.state.tr.setMeta(findKey, { opts: o.query ? o : null }));
        const s = stateOf(view);
        if (!s.matches.length) return status(view);
        const sel = view.state.selection;
        const i =
          jump === 'first' ? 0 : jump === 'last' ? s.matches.length - 1 : jump === 'keep' ? Math.max(0, s.current) : matchAtOrAfter(s.matches.map((m) => ({ index: m.from })), sel.from);
        select(view, i);
        return status(view);
      }),

    step: (o, dir, wrap) =>
      withView({ ...none, moved: false }, (view) => {
        ensure(view, o);
        const { matches } = stateOf(view);
        if (!matches.length) return { ...status(view), moved: false };
        const { from, to, empty } = view.state.selection;
        let i: number;
        if (dir === 1) {
          i = matches.findIndex((m) => m.from >= (empty ? from : to));
          if (i === -1) i = wrap ? 0 : -1;
        } else {
          i = -1;
          for (let k = matches.length - 1; k >= 0; k--) if (matches[k].to <= from) { i = k; break; }
          if (i === -1) i = wrap ? matches.length - 1 : -1;
        }
        if (i === -1) return { ...status(view), moved: false };
        select(view, i);
        return { ...status(view), moved: true };
      }),

    replaceOne: (o, replacement) =>
      withView(none, (view) => {
        ensure(view, o);
        const { matches } = stateOf(view);
        if (!matches.length) return status(view);
        const { from, to } = view.state.selection;
        let m = matches.find((x) => x.from === from && x.to === to);
        m ??= matches.find((x) => x.from >= from) ?? matches[0];
        const text = expandReplacement(m.match, replacement, o.regex);
        const tr = view.state.tr;
        if (text === '') tr.delete(m.from, m.to);
        else tr.insertText(text, m.from, m.to);
        tr.setSelection(TextSelection.create(tr.doc, m.from + text.length));
        view.dispatch(tr);
        const s = stateOf(view);
        if (s.matches.length) select(view, matchAtOrAfter(s.matches.map((x) => ({ index: x.from })), m.from + text.length));
        return status(view);
      }),

    replaceAll: (o, replacement) =>
      withView(0, (view) => {
        ensure(view, o);
        const { matches } = stateOf(view);
        if (!matches.length) return 0;
        const tr = view.state.tr;
        for (let k = matches.length - 1; k >= 0; k--) {
          const m = matches[k];
          const text = expandReplacement(m.match, replacement, o.regex);
          if (text === '') tr.delete(m.from, m.to);
          else tr.insertText(text, m.from, m.to);
        }
        view.dispatch(tr);
        return matches.length;
      }),

    clear: () => withView(undefined, (view) => void view.dispatch(view.state.tr.setMeta(findKey, { opts: null }))),

    selectedText: () =>
      withView('', (view) => {
        const { from, to, empty } = view.state.selection;
        if (empty || to - from > 200) return '';
        const t = view.state.doc.textBetween(from, to, '\n', ' ');
        return t.includes('\n') ? '' : t;
      })
  };
}
