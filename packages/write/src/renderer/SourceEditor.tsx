import { useEffect, useRef } from 'react';
import { chapterBody } from '../shared/chapters';
import { sceneTarget } from '../shared/sceneBreaks';
import { compileFind, expandReplacement, findInText, matchAtOrAfter, replaceAllInText, type FindOptions, type FindStatus } from '../shared/find';
import type { FindApi, SceneNav } from './sceneNav';

interface Props {
  /** The chapter as it is on disk right now. */
  raw: string;
  /** Unsaved text to start from, if any (otherwise the editor starts from `raw`). */
  draft: string | null;
  onChange(markdown: string | null): void;
  /** Bumped after each save so unsaved-ness is re-evaluated against the new on-disk text. */
  savedVersion: number;
  /** Hands the parent a way to jump between scene breaks (null on unmount). */
  onNav?(nav: SceneNav | null): void;
}

/** Plain-text editing of one chapter's exact Markdown: nothing is reformatted. */
/** Vertical position of the character at `offset`, measured on a hidden copy of the textarea. */
function offsetTop(ta: HTMLTextAreaElement, offset: number): number {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'borderLeftWidth', 'borderRightWidth', 'tabSize'] as const) {
    mirror.style[prop] = cs[prop];
  }
  mirror.style.cssText += ';position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;top:0;left:-9999px;';
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.boxSizing = 'content-box';
  mirror.textContent = ta.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

export function SourceEditor({ raw, draft, onChange, savedVersion, onNav }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef(raw);
  const onNavRef = useRef(onNav);
  onNavRef.current = onNav;
  rawRef.current = raw;

  const report = (value: string) => onChange(chapterBody(value) === chapterBody(rawRef.current) ? null : value);

  useEffect(() => {
    if (ref.current && savedVersion > 0) report(ref.current.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedVersion, raw]);

  useEffect(() => {
    const ta = () => ref.current;
    const matchesFor = (o: FindOptions) => findInText(ta()?.value ?? '', compileFind(o));
    let current = -1;
    const status = (o: FindOptions, count: number): FindStatus => ({ count, current: current >= 0 && count ? current + 1 : 0, ...(compileFind(o)?.error ? { error: compileFind(o)!.error } : {}) });
    const show = (i: number, matches: ReturnType<typeof matchesFor>) => {
      const t = ta();
      const m = matches[i];
      if (!t || !m) return;
      current = i;
      t.setSelectionRange(m.index, m.index + m.length);
      t.scrollTop = Math.max(0, offsetTop(t, m.index) - t.clientHeight / 3);
    };
    /** Replaces text through the editing pipeline so undo and the "unsaved" tracking see it. */
    const insert = (t: HTMLTextAreaElement, from: number, to: number, text: string) => {
      t.focus();
      t.setSelectionRange(from, to);
      if (!document.execCommand('insertText', false, text)) {
        t.setRangeText(text, from, to, 'end');
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    const find: FindApi = {
      search(o, jump) {
        const t = ta();
        const matches = matchesFor(o);
        if (!t || !matches.length) {
          current = -1;
          return status(o, matches.length);
        }
        const i = jump === 'first' ? 0 : jump === 'last' ? matches.length - 1 : jump === 'keep' ? Math.min(Math.max(current, 0), matches.length - 1) : matchAtOrAfter(matches, t.selectionStart);
        show(i, matches);
        return status(o, matches.length);
      },
      step(o, dir, wrap) {
        const t = ta();
        const matches = matchesFor(o);
        if (!t || !matches.length) return { ...status(o, 0), moved: false };
        const { selectionStart: a, selectionEnd: b } = t;
        let i: number;
        if (dir === 1) {
          i = matches.findIndex((m) => m.index >= (a === b ? a : b));
          if (i === -1) i = wrap ? 0 : -1;
        } else {
          i = -1;
          for (let k = matches.length - 1; k >= 0; k--) if (matches[k].index + matches[k].length <= a) { i = k; break; }
          if (i === -1) i = wrap ? matches.length - 1 : -1;
        }
        if (i === -1) return { ...status(o, matches.length), moved: false };
        show(i, matches);
        return { ...status(o, matches.length), moved: true };
      },
      replaceOne(o, replacement) {
        const t = ta();
        const matches = matchesFor(o);
        if (!t || !matches.length) return status(o, matches.length);
        const m = matches.find((x) => x.index === t.selectionStart && x.index + x.length === t.selectionEnd) ?? matches.find((x) => x.index >= t.selectionStart) ?? matches[0];
        const text = expandReplacement(m.match, replacement, o.regex);
        insert(t, m.index, m.index + m.length, text);
        const after = matchesFor(o);
        if (after.length) show(matchAtOrAfter(after, m.index + text.length), after);
        else current = -1;
        return status(o, after.length);
      },
      replaceAll(o, replacement) {
        const t = ta();
        if (!t) return 0;
        const r = replaceAllInText(t.value, o, replacement);
        if (r.count === 0) return 0;
        t.focus();
        t.select();
        if (!document.execCommand('insertText', false, r.text)) {
          t.value = r.text;
          t.dispatchEvent(new Event('input', { bubbles: true }));
        }
        t.setSelectionRange(0, 0);
        current = -1;
        return r.count;
      },
      clear() {
        current = -1;
      },
      selectedText() {
        const t = ta();
        if (!t || t.selectionStart === t.selectionEnd) return '';
        const v = t.value.slice(t.selectionStart, t.selectionEnd);
        return v.length > 200 || v.includes('\n') ? '' : v;
      }
    };

    onNavRef.current?.({
      find,
      go: (dir) => {
        const t = ref.current;
        if (!t) return false;
        const target = sceneTarget(t.value, t.selectionStart, dir);
        if (target === null) return false;
        t.focus();
        t.setSelectionRange(target, target);
        t.scrollTop = Math.max(0, offsetTop(t, target) - t.clientHeight / 3);
        return true;
      }
    });
    return () => onNavRef.current?.(null);
  }, []);

  return (
    <textarea
      ref={ref}
      className="source-editor"
      spellCheck
      aria-label="Chapter Markdown source"
      defaultValue={draft ?? raw}
      onInput={(e) => report(e.currentTarget.value)}
    />
  );
}
