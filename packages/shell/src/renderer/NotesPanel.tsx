import { useMemo, useState } from 'react';
import { queryNotes, STANDARD_TOPICS, type NoteStatus, type NoteTarget, type NoteView } from '@cadrel/kernel';
import { ago } from './format';

const api = window.cadrel.studio;

export interface NotesPanelProps {
  notes: NoteView[];
  /** Where a new note goes; omit for a read-only list. */
  addTo?: { projectId: string | null; label: string };
  /** Names for the project each note is on (shown when notes from several projects are listed). */
  projectName?: (id: string) => string | null;
  /** Runs a change and refreshes. */
  act: <T>(job: () => Promise<T>) => Promise<{ ok: boolean }>;
  /** Jump to the module that owns a note (Write's manuscript notes are changed there). */
  onOpenModule: (module: string) => void;
  target?: NoteTarget | null;
}

const MODULE_NAMES: Record<string, string> = { write: 'Write', market: 'Market' };

function NoteCard({ n, projectName, act, onOpenModule }: { n: NoteView; projectName?: (id: string) => string | null; act: NotesPanelProps['act']; onOpenModule: (m: string) => void }) {
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const mine = n.source === 'studio';
  const open = n.status === 'open';
  const mod = n.target?.module;
  const where = [n.projectId ? projectName?.(n.projectId) : null, n.target?.label].filter(Boolean).join(' · ');
  return (
    <li className={`note${open ? '' : ' done'}`}>
      <div className="note-meta">
        <strong>{n.author}</strong>
        {n.origin === 'ai' && <span className="chip ai">AI</span>}
        {n.category && <span className="chip">{n.category}</span>}
        {n.kind === 'suggestion' && <span className="chip">suggestion</span>}
        {!open && <span className="chip">{n.status}</span>}
        <span className="muted small">{ago(Date.parse(n.updatedAt), Date.now())}</span>
      </div>
      {where && <div className="note-where muted small">{where}</div>}
      {n.target?.anchor?.quote && <blockquote className="note-quote">{n.target.anchor.quote}</blockquote>}
      <p className="note-body">{n.body}</p>
      {n.replacement !== undefined && <p className="note-body muted">Instead: <q>{n.replacement}</q></p>}
      {n.replies.map((r) => (
        <p key={r.id} className="note-reply"><strong>{r.author}</strong> {r.body}</p>
      ))}
      <div className="note-actions">
        {mine && open && <button type="button" onClick={() => void act(() => api.setNoteStatus(n.id, 'resolved'))}>Resolve</button>}
        {mine && !open && <button type="button" onClick={() => void act(() => api.setNoteStatus(n.id, 'open'))}>Reopen</button>}
        {mine && <button type="button" onClick={() => setReplying((v) => !v)}>Reply</button>}
        {mine && <button type="button" className="quiet" onClick={() => void act(() => api.deleteNote(n.id))}>Delete</button>}
        {!mine && mod && <button type="button" onClick={() => onOpenModule(mod)}>Open in {MODULE_NAMES[mod] ?? mod}</button>}
      </div>
      {replying && (
        <form
          className="note-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.replyToNote(n.id, reply)).then((r) => {
              if (r.ok) {
                setReply('');
                setReplying(false);
              }
            });
          }}
        >
          <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" aria-label="Reply" autoFocus />
          <button type="submit" className="primary" disabled={!reply.trim()}>Send</button>
        </form>
      )}
    </li>
  );
}

/** The list of notes with its filters, and (when `addTo` is given) a box to write a new one. The same panel serves a project, a module record and the whole studio. */
export function NotesPanel({ notes, addTo, projectName, act, onOpenModule, target }: NotesPanelProps) {
  const [status, setStatus] = useState<NoteStatus | 'any'>('open');
  const [text, setText] = useState('');
  const [mod, setMod] = useState('');
  const [body, setBody] = useState('');
  const [topic, setTopic] = useState('');

  const modules = useMemo(() => [...new Set(notes.map((n) => n.target?.module).filter((m): m is string => !!m))].sort(), [notes]);
  const shown = useMemo(() => queryNotes(notes, { status, text: text.trim() || undefined, module: mod || undefined }), [notes, status, text, mod]);
  const topics = useMemo(() => [...new Set([...STANDARD_TOPICS, ...notes.map((n) => n.category).filter((c): c is string => !!c)])], [notes]);

  return (
    <div className="notes-panel">
      {addTo && (
        <form
          className="note-new"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.addNote({ projectId: addTo.projectId, body, target: target ?? null, category: topic || undefined })).then((r) => {
              if (r.ok) {
                setBody('');
                setTopic('');
              }
            });
          }}
        >
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={`Add a note on ${addTo.label}…`} aria-label="New note" />
          <div className="note-new-row">
            <input list="note-topics" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (optional)" aria-label="Topic" />
            <datalist id="note-topics">{topics.map((t) => <option key={t} value={t} />)}</datalist>
            <button type="submit" className="primary" disabled={!body.trim()}>Add note</button>
          </div>
        </form>
      )}
      <div className="note-filters" role="group" aria-label="Filter notes">
        <select value={status} onChange={(e) => setStatus(e.target.value as NoteStatus | 'any')} aria-label="Status">
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="any">All</option>
        </select>
        {modules.length > 1 && (
          <select value={mod} onChange={(e) => setMod(e.target.value)} aria-label="Module">
            <option value="">Everywhere</option>
            {modules.map((m) => <option key={m} value={m}>{MODULE_NAMES[m] ?? m}</option>)}
          </select>
        )}
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search notes" aria-label="Search notes" />
      </div>
      {shown.length === 0 ? (
        <p className="muted">{notes.length === 0 ? 'No notes yet.' : 'No notes match.'}</p>
      ) : (
        <ul className="notes">
          {shown.map((n) => <NoteCard key={n.id} n={n} projectName={projectName} act={act} onOpenModule={onOpenModule} />)}
        </ul>
      )}
    </div>
  );
}
