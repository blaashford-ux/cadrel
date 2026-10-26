import { useEffect, useMemo, useRef, useState } from 'react';
import { countByChapter, type FindOptions, type FindStatus } from '../shared/find';
import { Icon } from './Icon';
import type { FindJump, SceneNav } from './sceneNav';

export interface FindForm {
  open: boolean;
  /** The Replace row is showing. */
  replace: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  scope: 'chapter' | 'file';
  /** Bumped to move focus back into the Find box (Ctrl+F while the bar is already open). */
  focusTick: number;
  /** Bumped to step to the next/previous match from outside (F3, Shift+F3, Edit menu). */
  step: { dir: 1 | -1; n: number };
}

export const initialFindForm = (): FindForm => ({
  open: false,
  replace: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: 'chapter',
  focusTick: 0,
  step: { dir: 1, n: 0 }
});

interface Props {
  form: FindForm;
  setForm(patch: Partial<FindForm>): void;
  /** The active editor, once it is ready. */
  handle: SceneNav | undefined;
  /** Index of the chapter being edited, and the text of every chapter in the file (drafts included). */
  chapterIndex: number;
  chapterTexts: string[];
  fileName: string;
  gotoChapter(index: number): Promise<boolean>;
  replaceInFile(o: FindOptions, replacement: string): Promise<number | null>;
  onClose(): void;
}

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The Find & Replace bar that sits under the chapter heading. */
export function FindBar({ form, setForm, handle, chapterIndex, chapterTexts, fileName, gotoChapter, replaceInFile, onClose }: Props) {
  const [status, setStatus] = useState<FindStatus>({ count: 0, current: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingJump = useRef<FindJump | null>(null);
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const statusRef = useRef(status);
  statusRef.current = status;
  const stepSeen = useRef(form.step.n);

  const opts = useMemo<FindOptions>(
    () => ({ query: form.query, caseSensitive: form.caseSensitive, wholeWord: form.wholeWord, regex: form.regex }),
    [form.query, form.caseSensitive, form.wholeWord, form.regex]
  );
  const inFile = useMemo(() => (form.scope === 'file' ? countByChapter(chapterTexts, opts) : null), [form.scope, chapterTexts, opts]);

  const flash = (text: string, ms = 2500) => {
    setMessage(text);
    window.setTimeout(() => setMessage((m) => (m === text ? null : m)), ms);
  };

  // focus the Find box when the bar opens or Ctrl+F is pressed again
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [form.focusTick]);

  // (re)run the search whenever what we are looking for, or the editor we are looking in, changes
  useEffect(() => {
    setConfirmAll(false);
    const h = handleRef.current;
    if (!h) {
      setStatus({ count: 0, current: 0 });
      return;
    }
    const jump = pendingJump.current ?? 'caret';
    pendingJump.current = null;
    setStatus(h.find.search(opts, jump));
  }, [opts, handle, chapterIndex]);

  // remove the highlights when the bar closes
  useEffect(() => () => handleRef.current?.find.clear(), []);

  const step = async (dir: 1 | -1) => {
    const h = handleRef.current;
    if (!h || !opts.query || busy) return;
    setMessage(null);
    const before = statusRef.current;
    const chapterOnly = form.scope === 'chapter';
    const r = h.find.step(opts, dir, chapterOnly);
    if (r.moved) {
      setStatus(r);
      if (chapterOnly && r.count > 0 && (dir === 1 ? r.current <= before.current : r.current >= before.current) && before.current > 0) flash('Wrapped around');
      return;
    }
    if (chapterOnly || !inFile || inFile.total === 0) return;
    // nothing further in this chapter: carry on in the next chapter that has a match
    const n = chapterTexts.length;
    for (let k = 1; k <= n; k++) {
      const j = (((chapterIndex + dir * k) % n) + n) % n;
      if (inFile.counts[j] === 0) continue;
      if (j === chapterIndex) {
        setStatus(h.find.step(opts, dir, true));
        flash('Wrapped around');
      } else {
        pendingJump.current = dir === 1 ? 'first' : 'last';
        setBusy(true);
        const ok = await gotoChapter(j);
        setBusy(false);
        if (!ok) pendingJump.current = null;
        else if (dir === 1 ? j < chapterIndex : j > chapterIndex) flash('Wrapped around to the ' + (dir === 1 ? 'first' : 'last') + ' chapter');
      }
      return;
    }
  };

  // Next/previous requested from outside (F3, Shift+F3, the Edit menu)
  useEffect(() => {
    if (form.step.n === stepSeen.current) return;
    stepSeen.current = form.step.n;
    void step(form.step.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.step.n]);

  const replaceOne = () => {
    const h = handleRef.current;
    if (!h || !opts.query) return;
    setMessage(null);
    setStatus(h.find.replaceOne(opts, form.replacement));
  };

  const replaceAll = async () => {
    const h = handleRef.current;
    if (!h || !opts.query || busy) return;
    if (form.scope === 'chapter') {
      const n = h.find.replaceAll(opts, form.replacement);
      setStatus(h.find.search(opts, 'keep'));
      flash(n ? `Replaced ${plural(n, 'match', 'matches')}` : 'Nothing to replace');
      return;
    }
    if (!confirmAll) {
      if (!inFile || inFile.total === 0) return flash('Nothing to replace');
      setConfirmAll(true);
      return;
    }
    setConfirmAll(false);
    setBusy(true);
    const n = await replaceInFile(opts, form.replacement);
    setBusy(false);
    if (n !== null) flash(`Replaced ${plural(n, 'match', 'matches')} in ${fileName} (saved)`, 4000);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inReplace = (e.target as HTMLElement).classList.contains('replace-input');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (confirmAll) setConfirmAll(false);
      else onClose();
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      if (inReplace) replaceOne();
      else void step(e.shiftKey ? -1 : 1);
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') setForm({ caseSensitive: !form.caseSensitive });
      else if (k === 'w') setForm({ wholeWord: !form.wholeWord });
      else if (k === 'r') setForm({ regex: !form.regex });
      else return;
      e.preventDefault();
    }
  };

  let statusText = '';
  if (status.error) statusText = `Invalid pattern: ${status.error}`;
  else if (!opts.query) statusText = '';
  else if (status.count === 0) statusText = inFile && inFile.total > 0 ? `None here · ${plural(inFile.total, 'match', 'matches')} in file` : 'No results';
  else if (inFile) statusText = `${status.current} of ${status.count} here · ${plural(inFile.total, 'match', 'matches')} in file`;
  else statusText = `${status.current} of ${status.count}`;

  const toggle = (label: string, title: string, pressed: boolean, on: () => void) => (
    <button type="button" className={'find-toggle' + (pressed ? ' on' : '')} aria-pressed={pressed} title={title} aria-label={title} onClick={on}>
      {label}
    </button>
  );

  return (
    <div className="find-bar" role="search" aria-label="Find and replace" onKeyDown={onKeyDown}>
      <div className="find-row">
        <button
          type="button"
          className="find-expand"
          aria-label={form.replace ? 'Hide replace' : 'Show replace'}
          aria-expanded={form.replace}
          title="Replace (Ctrl+H)"
          onClick={() => setForm({ replace: !form.replace })}
        >
          <Icon name="chevron" size={14} className={form.replace ? 'open' : ''} />
        </button>
        <input
          ref={inputRef}
          className="find-input"
          placeholder="Find"
          aria-label="Find"
          aria-invalid={!!status.error || undefined}
          spellCheck={false}
          value={form.query}
          onChange={(e) => setForm({ query: e.target.value })}
        />
        {toggle('Aa', 'Match case (Alt+C)', form.caseSensitive, () => setForm({ caseSensitive: !form.caseSensitive }))}
        {toggle('ab', 'Whole word (Alt+W)', form.wholeWord, () => setForm({ wholeWord: !form.wholeWord }))}
        {toggle('.*', 'Regular expression (Alt+R)', form.regex, () => setForm({ regex: !form.regex }))}
        <select
          className="find-scope"
          aria-label="Search in"
          value={form.scope}
          onChange={(e) => setForm({ scope: e.target.value as FindForm['scope'] })}
          title="Where to search. “Whole file” also finds in other chapters (it searches the Markdown source)."
        >
          <option value="chapter">This chapter</option>
          <option value="file">Whole file</option>
        </select>
        <span className="find-status" role="status" aria-live="polite">
          {statusText}
        </span>
        {message && <span className="find-flash">{message}</span>}
        <button type="button" aria-label="Previous match" title="Previous match (Shift+F3)" disabled={!opts.query || busy} onClick={() => void step(-1)}>
          <Icon name="up" size={15} />
        </button>
        <button type="button" aria-label="Next match" title="Next match (F3)" disabled={!opts.query || busy} onClick={() => void step(1)}>
          <Icon name="down" size={15} />
        </button>
        <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {form.replace && (
        <div className="find-row">
          <span className="find-expand spacer" aria-hidden />
          <input
            className="find-input replace-input"
            placeholder="Replace with"
            aria-label="Replace with"
            spellCheck={false}
            value={form.replacement}
            onChange={(e) => setForm({ replacement: e.target.value })}
          />
          <button type="button" title="Replace this match (Enter)" disabled={!opts.query || status.count === 0 || busy} onClick={replaceOne}>
            Replace
          </button>
          <button
            type="button"
            title={form.scope === 'file' ? 'Replace in every chapter of the file' : 'Replace every match in this chapter'}
            disabled={!opts.query || busy || (form.scope === 'chapter' && status.count === 0)}
            onClick={() => void replaceAll()}
          >
            Replace All
          </button>
          {form.regex && <span className="muted small">$1, $&amp; and $&lt;name&gt; work in the replacement</span>}
        </div>
      )}
      {confirmAll && inFile && (
        <div className="find-row find-confirm" role="alert">
          <span>
            Replace {plural(inFile.total, 'match', 'matches')} in {plural(inFile.counts.filter((c) => c > 0).length, 'chapter')} of {fileName}? This is saved to the file right away.
          </span>
          <button type="button" onClick={() => setConfirmAll(false)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void replaceAll()}>
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
