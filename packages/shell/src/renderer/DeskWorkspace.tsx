import { Fragment, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { DeskChapter, DeskNote, DeskText, NewDeskNote } from '../shared/api';

/** Text the editor has selected in a chapter, ready to become a note. */
export interface Selected {
  chapter: number;
  quote: string;
  before: string;
  after: string;
}

const CONTEXT = 30;
const EDIT_TYPES = ['developmental', 'line', 'copy', 'proof'] as const;
const TYPE_NAME: Record<string, string> = { developmental: 'Developmental', line: 'Line', copy: 'Copy', proof: 'Proof' };
const SOURCE_NAME: Record<DeskNote['origin'], string> = { human: 'Editor', ai: 'AI', outside: 'Outside editor' };

/** The chapter text, paragraph by paragraph, with the notes' text marked. Selecting text offers it to the notes panel. */
export function ManuscriptPane({ chapter, notes, focus, onFocus, picked, onPick }: { chapter: DeskChapter; notes: DeskNote[]; focus: string | null; onFocus: (id: string | null) => void; picked: Selected | null; onPick: (p: Selected | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const paragraphs = useMemo(() => {
    const out: { start: number; text: string }[] = [];
    let at = 0;
    for (const line of chapter.text.split('\n')) {
      out.push({ start: at, text: line });
      at += line.length + 1;
    }
    return out;
  }, [chapter.text]);
  const placed = notes.filter((n) => n.state !== 'gone' && n.start >= 0 && n.end > n.start);

  const onUp = (_e: MouseEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !ref.current) return;
    const at = (node: Node | null, off: number): number | null => {
      const el = node instanceof Element ? node : node?.parentElement;
      const span = el?.closest<HTMLElement>('[data-s]');
      if (!span || !ref.current!.contains(span)) return null;
      return Number(span.dataset.s) + (node instanceof Text ? off : 0);
    };
    let a = at(sel.anchorNode, sel.anchorOffset);
    let b = at(sel.focusNode, sel.focusOffset);
    if (a === null || b === null) return;
    if (a > b) [a, b] = [b, a];
    const para = paragraphs.find((p) => a! >= p.start && a! <= p.start + p.text.length);
    if (!para) return;
    b = Math.min(b, para.start + para.text.length); // a note stays inside one paragraph, as in Write
    const quote = chapter.text.slice(a, b);
    if (!quote.trim()) return;
    onPick({ chapter: chapter.index, quote, before: chapter.text.slice(Math.max(para.start, a - CONTEXT), a), after: chapter.text.slice(b, Math.min(para.start + para.text.length, b + CONTEXT)) });
  };

  return (
    <article className="desk-text" ref={ref} onMouseUp={onUp} aria-label={chapter.title || `Chapter ${chapter.index + 1}`}>
      <h3>{chapter.title || `Chapter ${chapter.index + 1}`} <span className="muted small">{chapter.words.toLocaleString()} words</span></h3>
      <p className="muted small">Select text to comment on it or suggest a change. The text itself is the author’s and is not changed here.</p>
      {paragraphs.map((p, i) => {
        if (!p.text) return null;
        const end = p.start + p.text.length;
        const here = placed.filter((n) => n.start < end && n.end > p.start);
        const cuts = new Set([p.start, end]);
        for (const n of here) {
          cuts.add(Math.max(p.start, n.start));
          cuts.add(Math.min(end, n.end));
        }
        const marks = [...cuts].sort((x, y) => x - y);
        return (
          <p key={i} className="desk-para">
            {marks.slice(0, -1).map((s, k) => {
              const e = marks[k + 1]!;
              const covering = here.filter((n) => n.start <= s && n.end >= e);
              const top = covering.find((n) => n.id === focus) ?? covering[covering.length - 1];
              return (
                <span
                  key={k}
                  data-s={s}
                  className={top ? `desk-mark ${top.kind} ${top.status}${top.id === focus ? ' focus' : ''}` : undefined}
                  onClick={top ? () => onFocus(top.id) : undefined}
                  title={top ? `${top.kind === 'suggestion' ? 'Suggestion' : 'Comment'}: ${top.body || top.replacement || ''}` : undefined}
                >
                  {chapter.text.slice(s, e)}
                </span>
              );
            })}
          </p>
        );
      })}
    </article>
  );
}

type StatusFilter = 'open' | 'all' | 'accepted' | 'rejected' | 'resolved';

/** The notes panel: add a note to the selected text, filter, and decide, tag, reply to or remove each. */
export function DeskNotes(p: {
  text: DeskText;
  chapter: number;
  picked: Selected | null;
  focus: string | null;
  onFocus: (id: string, chapter?: number) => void;
  onClearPick: () => void;
  onAdd: (n: NewDeskNote) => void;
  onStatus: (id: string, s: DeskNote['status']) => void;
  onTag: (id: string, t: { editType?: string | null; round?: string | null }) => void;
  onReply: (id: string, body: string) => void;
  onRemove: (id: string) => void;
}) {
  const [status, setStatus] = useState<StatusFilter>('open');
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [round, setRound] = useState('');
  const [attention, setAttention] = useState(false);
  const [here, setHere] = useState(false);

  const shown = p.text.notes.filter(
    (n) =>
      (status === 'all' || n.status === status) &&
      (!type || (type === 'untagged' ? !n.editType : n.editType === type)) &&
      (!source || n.origin === source) &&
      (!round || (round === '-' ? !n.round : n.round === round)) &&
      (!attention || n.state !== 'same') &&
      (!here || n.chapter === p.chapter)
  );
  const needAttention = p.text.notes.filter((n) => n.state !== 'same' && n.status === 'open').length;

  return (
    <aside className="desk-notes" aria-label="Notes">
      {p.picked && <AddNote key={p.picked.quote + p.picked.before} picked={p.picked} rounds={p.text.rounds} onAdd={p.onAdd} onCancel={p.onClearPick} />}
      <div className="desk-filters" role="group" aria-label="Filter notes">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="open">Open</option>
          <option value="all">All</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="resolved">Resolved</option>
        </select>
        <select aria-label="Edit type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Any type</option>
          {EDIT_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
          <option value="untagged">Untagged</option>
        </select>
        <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Any source</option>
          <option value="human">Editor</option>
          <option value="ai">AI</option>
          <option value="outside">Outside editor</option>
        </select>
        <select aria-label="Round" value={round} onChange={(e) => setRound(e.target.value)}>
          <option value="">Any round</option>
          {p.text.rounds.map((r) => <option key={r} value={r}>{r}</option>)}
          <option value="-">No round</option>
        </select>
        <label className="check"><input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} /> This chapter</label>
        <label className="check" title="Notes whose text has moved or been cut since they were written"><input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} /> Needs attention{needAttention ? ` (${needAttention})` : ''}</label>
      </div>
      <p className="muted small" aria-live="polite">{shown.length} of {p.text.notes.length} notes</p>
      <ul className="plain desk-list">
        {shown.map((n) => <NoteCard key={n.id} n={n} me={p.text.me} focus={p.focus === n.id} onFocus={p.onFocus} onStatus={p.onStatus} onTag={p.onTag} onReply={p.onReply} onRemove={p.onRemove} />)}
        {!shown.length && <li className="muted small">{p.text.notes.length ? 'No notes match these filters.' : 'No notes yet. Select some text in the manuscript to add one.'}</li>}
      </ul>
    </aside>
  );
}

function AddNote({ picked, rounds, onAdd, onCancel }: { picked: Selected; rounds: string[]; onAdd: (n: NewDeskNote) => void; onCancel: () => void }) {
  const remembered = (() => {
    try {
      return localStorage.getItem('cadrel.desk.round') ?? '';
    } catch {
      return '';
    }
  })();
  const [kind, setKind] = useState<'comment' | 'suggestion'>('comment');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState(picked.quote);
  const [category, setCategory] = useState('');
  const [editType, setEditType] = useState('');
  const [round, setRound] = useState(remembered || rounds[rounds.length - 1] || '');
  const ok = kind === 'comment' ? body.trim().length > 0 : replacement !== picked.quote;
  return (
    <form
      className="card desk-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        try {
          localStorage.setItem('cadrel.desk.round', round);
        } catch {
          /* the round is just not remembered */
        }
        onAdd({ kind, quote: picked.quote, before: picked.before, after: picked.after, chapter: picked.chapter, body: body.trim(), ...(kind === 'suggestion' ? { replacement } : {}), ...(category.trim() ? { category: category.trim() } : {}), ...(editType ? { editType } : {}), ...(round.trim() ? { round: round.trim() } : {}) });
      }}
    >
      <p className="small"><span className="muted">On</span> “{picked.quote.length > 120 ? picked.quote.slice(0, 120) + '…' : picked.quote}”</p>
      <div className="seg" role="group" aria-label="Kind of note">
        <button type="button" aria-pressed={kind === 'comment'} onClick={() => setKind('comment')}>Comment</button>
        <button type="button" aria-pressed={kind === 'suggestion'} onClick={() => setKind('suggestion')}>Suggest a change</button>
      </div>
      {kind === 'suggestion' && (
        <label className="field"><span className="field-label">Replace with (leave empty to delete)</span>
          <textarea rows={2} value={replacement} onChange={(e) => setReplacement(e.target.value.replace(/\n/g, ' '))} />
        </label>
      )}
      <label className="field"><span className="field-label">{kind === 'comment' ? 'Comment' : 'Why (optional)'}</span>
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      </label>
      <div className="row3">
        <label className="field"><span className="field-label">Edit type</span>
          <select value={editType} onChange={(e) => setEditType(e.target.value)}>
            <option value="">None</option>
            {EDIT_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Topic</span>
          <input list="desk-topics" value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} placeholder="pacing, spelling…" />
        </label>
        <label className="field"><span className="field-label">Round</span>
          <input list="desk-rounds" value={round} maxLength={40} onChange={(e) => setRound(e.target.value)} placeholder="First read" />
        </label>
      </div>
      <datalist id="desk-topics">{['pacing', 'continuity', 'dialogue', 'character', 'plot', 'style', 'rhythm', 'clarity', 'spelling', 'grammar', 'punctuation'].map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="desk-rounds">{rounds.map((r) => <option key={r} value={r} />)}</datalist>
      <div className="actions">
        <button type="submit" className="primary" disabled={!ok}>Add note</button>
        <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function NoteCard({ n, me, focus, onFocus, onStatus, onTag, onReply, onRemove }: { n: DeskNote; me: string; focus: boolean } & Pick2) {
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const mine = n.origin !== 'ai' && n.author === me;
  return (
    <li className={'desk-note ' + n.status + (focus ? ' focus' : '')} id={`note-${n.id}`}>
      <button type="button" className="desk-quote" onClick={() => onFocus(n.id, n.chapter)} title="Show it in the manuscript">“{n.quote.length > 90 ? n.quote.slice(0, 90) + '…' : n.quote}”</button>
      <div className="small">
        <span className="chip">{n.kind === 'suggestion' ? 'Suggestion' : 'Comment'}</span>{' '}
        {n.editType && <span className="chip">{TYPE_NAME[n.editType]}</span>}{' '}
        {n.category && <span className="chip">{n.category}</span>}{' '}
        {n.round && <span className="chip" title="Editing round">{n.round}</span>}{' '}
        {n.state === 'moved' && <span className="chip warn" title="The text has moved since this was written">Moved</span>}{' '}
        {n.state === 'gone' && <span className="chip warn" title="The text was cut or rewritten">Text changed</span>}{' '}
        {n.status !== 'open' && <span className="chip">{n.status}</span>}
      </div>
      {n.kind === 'suggestion' && <p className="small desk-sug"><del>{n.quote}</del> {n.replacement ? <ins>{n.replacement}</ins> : <em>(delete)</em>}</p>}
      {n.body && <p>{n.body}</p>}
      <p className="muted small">{SOURCE_NAME[n.origin]} · {n.author} · {n.createdAt.slice(0, 10)}</p>
      {n.replies.map((r, i) => <p key={i} className="small desk-reply"><strong>{r.author}:</strong> {r.body}</p>)}
      <div className="actions">
        {n.status === 'open' ? (
          <Fragment>
            {n.kind === 'suggestion' && <button type="button" onClick={() => onStatus(n.id, 'accepted')} title="Mark it accepted. The author makes the change in the text.">Accept</button>}
            {n.kind === 'suggestion' && <button type="button" onClick={() => onStatus(n.id, 'rejected')}>Reject</button>}
            <button type="button" onClick={() => onStatus(n.id, 'resolved')}>Resolve</button>
          </Fragment>
        ) : (
          <button type="button" onClick={() => onStatus(n.id, 'open')}>Reopen</button>
        )}
        <button type="button" className="link small" onClick={() => setReplying((v) => !v)}>Reply</button>
        {mine && <button type="button" className="quiet" onClick={() => onRemove(n.id)}>Remove</button>}
      </div>
      <div className="desk-tags small">
        <select aria-label="Edit type" value={n.editType ?? ''} onChange={(e) => onTag(n.id, { editType: e.target.value || null })}>
          <option value="">No type</option>
          {EDIT_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
        </select>
        <input aria-label="Round" defaultValue={n.round ?? ''} maxLength={40} placeholder="Round" onBlur={(e) => { if ((e.target.value.trim() || undefined) !== n.round) onTag(n.id, { round: e.target.value.trim() || null }); }} />
      </div>
      {replying && (
        <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) { onReply(n.id, reply.trim()); setReply(''); setReplying(false); } }}>
          <textarea rows={2} aria-label="Reply" value={reply} onChange={(e) => setReply(e.target.value)} autoFocus />
          <button type="submit" disabled={!reply.trim()}>Send reply</button>
        </form>
      )}
    </li>
  );
}

type Pick2 = Pick<Parameters<typeof DeskNotes>[0], 'onFocus' | 'onStatus' | 'onTag' | 'onReply' | 'onRemove'>;
