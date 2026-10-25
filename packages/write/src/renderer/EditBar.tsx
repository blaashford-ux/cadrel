import { useEffect, useState } from 'react';
import { activeEditor, copySelection, cutSelection, hasSelection, pasteInto } from './editMenu';
import { Icon } from './Icon';
import type { FormatApi } from './sceneNav';

/** Distance between the bottom of the layout and the bottom of what is actually visible (the on-screen keyboard). */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/** Where the caret is (an editor has focus, so the keyboard is up) and whether text is selected there. */
function useEditorState(): { focused: boolean; selected: boolean } {
  const [state, setState] = useState({ focused: false, selected: false });
  useEffect(() => {
    const read = () => {
      const host = activeEditor();
      const next = { focused: host !== null, selected: host !== null && hasSelection(host) };
      setState((cur) => (cur.focused === next.focused && cur.selected === next.selected ? cur : next));
    };
    read();
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', read);
    document.addEventListener('selectionchange', read);
    return () => {
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', read);
      document.removeEventListener('selectionchange', read);
    };
  }, []);
  return state;
}

interface Props {
  /** Formatting (the formatted editor only). */
  format?: FormatApi;
  /** Attach a note to the selection (absent outside a project, or in the source box). */
  onComment?(): void;
  onSuggest?(): void;
  onFind(): void;
}

/**
 * The phone's editing actions, docked above the keyboard. Selecting text is left entirely to the system (long press,
 * its handles); nothing opens over the text, so the handles are never covered. With text selected the bar offers
 * Cut / Copy / Paste and notes; otherwise formatting. Buttons take no focus, so the keyboard and selection stay put.
 */
export function EditBar({ format, onComment, onSuggest, onFind }: Props) {
  const inset = useKeyboardInset();
  const { focused, selected } = useEditorState();
  if (!focused) return null;
  const keep = (e: { preventDefault(): void }) => e.preventDefault();
  const host = () => activeEditor();
  const btn = (label: string, title: string, run: () => void, cls = '') => (
    <button key={title} type="button" className={`fb-btn ${cls}`} aria-label={title} title={title} onPointerDown={keep} onMouseDown={keep} onClick={run}>
      {label}
    </button>
  );
  const aligns = format
    ? (['left', 'center', 'right', 'justify'] as const).map((a) => {
        const title = `Align ${a === 'center' ? 'centre' : a}`;
        return (
          <button key={title} type="button" className="fb-btn" aria-label={title} title={`${title}; tap again to remove`} onPointerDown={keep} onMouseDown={keep} onClick={() => format.align(a)}>
            <Icon name={a === 'left' ? 'alignLeft' : a === 'center' ? 'alignCenter' : a === 'right' ? 'alignRight' : 'alignJustify'} size={18} />
          </button>
        );
      })
    : [];
  const clip = [
    btn('Copy', 'Copy', () => { const h = host(); if (h) copySelection(h); }, 'word'),
    btn('Cut', 'Cut', () => { const h = host(); if (h) cutSelection(h); }, 'word'),
    btn('Paste', 'Paste', () => { const h = host(); if (h) pasteInto(h); }, 'word')
  ];
  const notes = [onComment && btn('Comment', 'Add comment', onComment, 'word'), onSuggest && btn('Suggest', 'Suggest a change', onSuggest, 'word')];
  const inline = format ? [btn('B', 'Bold', format.bold, 'b'), btn('I', 'Italic', format.italic, 'i')] : [];
  const blocks = format
    ? [
        btn('H1', 'Chapter heading', () => format.heading(1)),
        btn('H2', 'Heading', () => format.heading(2)),
        btn('❝', 'Quote', format.quote),
        btn('•', 'Bulleted list', format.bullets),
        btn('1.', 'Numbered list', format.numbered),
        btn('⁂', 'Scene break', format.sceneBreak),
        ...aligns,
        btn('↶', 'Undo', format.undo),
        btn('↷', 'Redo', format.redo)
      ]
    : [];
  return (
    <div className="format-bar" role="toolbar" aria-label="Editing" style={{ bottom: inset }}>
      {selected ? [...clip, ...notes, ...inline, ...aligns, btn('Find', 'Find', onFind, 'word')] : [...inline, ...blocks, btn('Paste', 'Paste', () => { const h = host(); if (h) pasteInto(h); }, 'word'), btn('Find', 'Find', onFind, 'word')]}
    </div>
  );
}
